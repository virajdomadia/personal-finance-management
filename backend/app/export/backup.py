"""A user's whole backup as one JSON document, and loading one back in.

Format (see backend/README.md): `format`, `format_version`, `alembic_revision`, `exported_at`,
`user.email` and `tables`, a list of rows per table keyed by column name. Decimals are strings,
dates and times ISO 8601. Columns that point at `users.id` are left out. The download is gzipped.

Restore inserts every row afresh, one batch per table in the backup's id order, so the database
gives each one a new id, and every foreign key is mapped from the old ids to the new ones. It runs
in the caller's transaction.
"""

import datetime as dt
import gzip
import json
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Column,
    Date,
    DateTime,
    ForeignKeyConstraint,
    Numeric,
    Select,
    Table,
    bindparam,
    delete,
    func,
    inspect,
    select,
    text,
    update,
)
from sqlalchemy.orm import Session

from app.db.base import Base
from app.export.tables import Plan, json_columns, plan, user_columns
from app.models.market import MarketCode
from app.models.user import User

FORMAT = "pfm-backup"
FORMAT_VERSION = 1
GZIP_MAGIC = b"\x1f\x8b"

# Maps a backup's old id in a table to the restored row's new id, or None.
IdLookup = Callable[[str, Any], int | None]

# sms_entries.candidates: [{"kind", "id", "label", ...}]. "market" points at the shared
# market_codes, whose ids differ between databases, so its kind and code travel with it.
CANDIDATE_TABLES = {
    "transaction": "transactions",
    "account": "accounts",
    "emi": "accounts",
    "sip": "sips",
    "template": "recurring_templates",
    "stock": "instruments",
}
MARKET = "market"


class RestoreError(ValueError):
    pass


def _dump_candidates(value: Any, db: Session) -> Any:
    markets = [c.get("id") for c in value or [] if isinstance(c, dict) and c.get("kind") == MARKET]
    if not markets:
        return value
    codes = {m.id: m for m in db.scalars(select(MarketCode).where(MarketCode.id.in_(markets)))}
    out = []
    for choice in value:
        found = codes.get(choice.get("id")) if choice.get("kind") == MARKET else None
        if found is not None:
            choice = {**choice, "market_kind": found.kind, "market_code": found.code}
        out.append(choice)
    return out


def _restore_candidates(value: Any, new_id: IdLookup, db: Session) -> Any:
    if not value:
        return value
    out = []
    for choice in value:
        kind = choice.get("kind")
        if kind == MARKET:
            market = db.scalar(
                select(MarketCode.id).where(
                    MarketCode.kind == choice.get("market_kind"),
                    MarketCode.code == choice.get("market_code"),
                )
            )
            if market is not None:  # not in this database's market list: dropped
                kept = {k: v for k, v in choice.items() if k not in ("market_kind", "market_code")}
                out.append({**kept, "id": market})
        elif kind in CANDIDATE_TABLES:
            mapped = new_id(CANDIDATE_TABLES[kind], choice.get("id"))
            if mapped is not None:  # a choice whose row is gone is dropped
                out.append({**choice, "id": mapped})
        else:
            raise RestoreError(f"sms_entries.candidates has an unknown kind {kind!r}")
    return out or None


@dataclass(frozen=True)
class JsonIds:
    """How a JSON column's ids leave a backup and come back."""

    dump: Callable[[Any, Session], Any]
    restore: Callable[[Any, IdLookup, Session], Any]


# Every JSON column of an exported table, and how its ids travel (None: it holds no ids).
JSON_ID_FIELDS: dict[tuple[str, str], JsonIds | None] = {
    ("sms_entries", "candidates"): JsonIds(_dump_candidates, _restore_candidates),
}


def _metadata_plan() -> Plan:
    import app.models  # noqa: F401  (registers every model)

    return plan(Base.metadata)


def alembic_revision(db: Session) -> str | None:
    if not inspect(db.connection()).has_table("alembic_version"):
        return None
    return db.scalar(text("SELECT version_num FROM alembic_version"))


def owned_rows(table: Table, found: Plan, user_id: int) -> Select:
    """The rows of `table` that belong to the user."""
    return select(table).where(_owner_clause(table, found, user_id))


def _owner_clause(table: Table, found: Plan, user_id: int) -> Any:
    if "user_id" in table.columns:
        return table.c.user_id == user_id
    column = found.owned_through[table.name]
    (fk,) = column.foreign_keys
    parent = fk.column.table
    return column.in_(select(fk.column).where(_owner_clause(parent, found, user_id)))


def _to_json(value: Any) -> Any:
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, dt.datetime | dt.date):
        return value.isoformat()
    return value


def _from_json(column: Any, value: Any) -> Any:
    if value is None:
        return None
    kind = column.type
    try:
        if isinstance(kind, Numeric) and kind.asdecimal:
            return Decimal(value)
        if isinstance(kind, DateTime):
            return dt.datetime.fromisoformat(value)
        if isinstance(kind, Date):
            return dt.date.fromisoformat(value)
    except (ArithmeticError, TypeError, ValueError) as error:
        raise RestoreError(
            f"{column.table.name}.{column.name} has a bad value {value!r}"
        ) from error
    return value


def dump(db: Session, user: User) -> dict[str, Any]:
    found = _metadata_plan()
    tables: dict[str, list[dict[str, Any]]] = {}
    for table in found.exported:
        skip = {c.name for c in user_columns(table)}
        hooks = {
            name: hook
            for name in json_columns(table)
            if (hook := JSON_ID_FIELDS[(table.name, name)]) is not None
        }
        pk = list(table.primary_key.columns)
        rows = db.execute(owned_rows(table, found, user.id).order_by(*pk)).mappings()
        tables[table.name] = [
            {
                k: hooks[k].dump(v, db) if k in hooks and v is not None else _to_json(v)
                for k, v in row.items()
                if k not in skip
            }
            for row in rows
        ]
    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "alembic_revision": alembic_revision(db),
        "exported_at": dt.datetime.now(dt.UTC).isoformat(),
        "user": {"email": user.email},
        "tables": tables,
    }


def encode(document: dict[str, Any]) -> tuple[bytes, int]:
    """The backup as compact JSON, gzipped, and its size before compressing. Compressed, years of
    prices and SMS stay well under Vercel's 4.5 MB response limit."""
    raw = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return gzip.compress(raw, compresslevel=9, mtime=0), len(raw)


def decode(data: bytes) -> dict[str, Any]:
    """A backup from a .json or .json.gz file, told apart by its first bytes."""
    try:
        if data[:2] == GZIP_MAGIC:
            data = gzip.decompress(data)
        document = json.loads(data.decode("utf-8"))
    except (OSError, EOFError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RestoreError(f"This file isn't a readable backup: {error}") from error
    if not isinstance(document, dict):
        raise RestoreError("This file isn't a readable backup: it isn't a JSON object.")
    return document


def row_counts(db: Session, user_id: int) -> dict[str, int]:
    found = _metadata_plan()
    counts = {}
    for table in found.exported:
        query = select(func.count()).select_from(owned_rows(table, found, user_id).subquery())
        counts[table.name] = db.scalar(query) or 0
    return counts


def delete_user_data(db: Session, user_id: int) -> None:
    """Deletes every row the user owns, children first. Rows of one table that point at each
    other (a category merged into another) go in one statement, which the database checks as a
    whole."""
    found = _metadata_plan()
    for table in reversed(found.exported):
        db.execute(delete(table).where(_owner_clause(table, found, user_id)))


def _points_at(column: Any, table: Table) -> bool:
    return any(fk.column.table is table and fk.column.primary_key for fk in column.foreign_keys)


def check_shape(document: Any) -> None:
    """`tables` is an object of lists of objects, each with a whole-number id, unique per table."""
    tables = document.get("tables")
    if not isinstance(tables, dict):
        raise RestoreError("The backup's `tables` must be an object of table name to rows.")
    for name, rows in tables.items():
        if not isinstance(rows, list):
            raise RestoreError(f"The backup's {name} must be a list of rows.")
        seen: set[int] = set()
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise RestoreError(f"{name} row {index + 1} isn't an object.")
            id_ = row.get("id")
            if not isinstance(id_, int) or isinstance(id_, bool):
                raise RestoreError(f"{name} row {index + 1} has no whole-number id.")
            if id_ in seen:
                raise RestoreError(f"{name} has id {id_} twice.")
            seen.add(id_)
            choices = row.get("candidates") if name == "sms_entries" else None
            if choices is not None and (
                not isinstance(choices, list) or not all(isinstance(c, dict) for c in choices)
            ):
                raise RestoreError(f"sms_entries id {id_}: candidates must be a list of objects.")


def check(document: dict[str, Any], db: Session) -> None:
    if not isinstance(document, dict) or document.get("format") != FORMAT:
        raise RestoreError("This isn't a Personal Finance Manager backup.")
    version = document.get("format_version")
    if not isinstance(version, int) or version > FORMAT_VERSION:
        raise RestoreError(
            f"This backup is format version {version}; this code reads up to {FORMAT_VERSION}."
        )
    theirs, ours = document.get("alembic_revision"), alembic_revision(db)
    if theirs != ours:
        raise RestoreError(
            f"This backup was made at schema revision {theirs} but the database is at {ours}. "
            f"Restore it into a database migrated to {theirs} (alembic upgrade {theirs}), "
            "then upgrade."
        )
    check_shape(document)
    known = {t.name for t in _metadata_plan().exported}
    unknown = sorted(set(document["tables"]) - known)
    if unknown:
        raise RestoreError(f"The backup has tables this code doesn't know: {', '.join(unknown)}")


def restore(db: Session, user: User, document: dict[str, Any], replace: bool = False) -> int:
    """Loads `document` into `user`. Doesn't commit. Returns the number of rows inserted."""
    check(document, db)
    found = _metadata_plan()
    if replace:
        delete_user_data(db, user.id)
    else:
        existing = {name: n for name, n in row_counts(db, user.id).items() if n}
        if existing:
            listed = ", ".join(f"{name} ({n})" for name, n in existing.items())
            raise RestoreError(
                f"{user.email} already has data: {listed}. "
                "Use --replace to delete it first and load the backup instead."
            )
    ids: dict[str, dict[int, int]] = {}
    inserted = 0
    for table in found.exported:
        rows = sorted(document["tables"].get(table.name, []), key=lambda r: r["id"])
        ids[table.name] = {}
        inserted += _insert_table(db, table, rows, user.id, ids)
    _remap_json(db, found, document, ids)
    return inserted


def self_refs(table: Table) -> tuple[list[str], list[str]]:
    """A table's columns that point at its own rows: (set on insert, filled in afterwards).

    Most go in NULL and are filled in once every row exists, so rows keep the backup's order and
    may point at each other in a loop. A column a partial unique index depends on (a merged
    category frees its name) must be right from the start, so those rows wait for their target."""
    refs = [c.name for c in table.columns if _points_at(c, table)]
    guarded: set[str] = set()
    for index in table.indexes:
        if not index.unique:
            continue
        for options in index.dialect_options.values():
            where = options.get("where") if hasattr(options, "get") else None
            if where is not None:
                guarded |= {name for name in refs if name in str(where)}
    return [n for n in refs if n in guarded], [n for n in refs if n not in guarded]


def _waves(table: Table, rows: list[dict[str, Any]], now: list[str]) -> list[list[dict]]:
    """Rows in id order, split so a row whose `now` column points at another row of this table
    goes in a later batch than that row."""
    if not now:
        return [rows]
    present = {r["id"] for r in rows}
    done: set[int] = set()
    pending, waves = rows, []
    while pending:
        wave = [r for r in pending if ({r.get(c) for c in now} & present) <= done]
        if not wave:
            raise RestoreError(f"{table.name} has rows that point at each other in a loop")
        waves.append(wave)
        done |= {r["id"] for r in wave}
        pending = [r for r in pending if r["id"] not in done]
    return waves


def _foreign_targets(table: Table) -> dict[str, Column]:
    """Each column that holds another row's id, and the primary key it points at."""
    targets = {}
    for constraint in table.constraints:
        if not isinstance(constraint, ForeignKeyConstraint):
            continue
        for column, element in zip(constraint.columns, constraint.elements, strict=True):
            target = element.column
            if target.table.name != "users" and target.primary_key:
                targets[column.name] = target
    return targets


def _mapped(
    table: Table, targets: dict[str, Column], row: dict, name: str, ids: dict[str, dict[int, int]]
) -> int:
    target, old = targets[name], row[name]
    new = ids.get(target.table.name, {}).get(old)
    if new is None:
        raise RestoreError(
            f"{table.name} row {row['id']}: {name} points at "
            f"{target.table.name} {old}, which isn't in the backup"
        )
    return new


def _insert_table(
    db: Session,
    table: Table,
    rows: list[dict[str, Any]],
    user_id: int,
    ids: dict[str, dict[int, int]],
) -> int:
    if not rows:
        return 0
    now, later = self_refs(table)
    names = sorted({k for r in rows for k in r} - {"id"})
    unknown = set(names) - set(table.columns.keys())
    if unknown:
        raise RestoreError(f"{table.name} has columns this code doesn't know: {sorted(unknown)}")
    user = {c.name for c in user_columns(table)}
    names += sorted(user - set(names))
    blank = set(json_columns(table)) | set(later)  # filled in once every row exists
    targets = _foreign_targets(table)

    def values(row: dict[str, Any]) -> dict[str, Any]:
        out = {}
        for name in names:
            value = row.get(name)
            if name in user:
                value = user_id
            elif name in blank or value is None:
                value = None
            elif name in targets:
                value = _mapped(table, targets, row, name, ids)
            else:
                value = _from_json(table.columns[name], value)
            out[name] = value
        return out

    statement = table.insert().returning(table.c.id, sort_by_parameter_order=True)
    for wave in _waves(table, rows, now):
        new_ids = list(db.scalars(statement, [values(r) for r in wave]))
        if len(new_ids) != len(wave):
            raise RestoreError(f"{table.name}: the database gave {len(new_ids)} ids")
        ids[table.name].update(zip((r["id"] for r in wave), new_ids, strict=True))
    for name in later:
        pairs = [
            {"_row": ids[table.name][r["id"]], "_to": _mapped(table, targets, r, name, ids)}
            for r in rows
            if r.get(name) is not None
        ]
        _fill(db, table, name, pairs)
    return len(rows)


def _fill(db: Session, table: Table, name: str, pairs: list[dict[str, Any]]) -> None:
    if pairs:
        values: dict[Any, Any] = {name: bindparam("_to")}
        # A column with an onupdate (updated_at = now()) would stamp the restored row as changed
        # today. Naming it in the SET, as itself, keeps the backed-up value.
        for column in table.columns:
            if column.onupdate is not None and column.name != name:
                values[column.name] = column
        db.connection().execute(
            update(table).where(table.c.id == bindparam("_row")).values(values),
            pairs,
        )


def _remap_json(
    db: Session, found: Plan, document: dict[str, Any], ids: dict[str, dict[int, int]]
) -> None:
    """JSON columns go in after every row exists, since they may point anywhere."""

    def new_id(table: str, old: Any) -> int | None:
        if not isinstance(old, int) or isinstance(old, bool):
            return None
        return ids.get(table, {}).get(old)

    for table in found.exported:
        for name in json_columns(table):
            hook = JSON_ID_FIELDS[(table.name, name)]
            pairs = []
            for row in document["tables"].get(table.name, []):
                value = row.get(name)
                if value is None:
                    continue
                if hook is not None:
                    value = hook.restore(value, new_id, db)
                pairs.append({"_row": ids[table.name][row["id"]], "_to": value})
            _fill(db, table, name, pairs)
