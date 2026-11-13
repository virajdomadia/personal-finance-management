"""A user's whole backup as one JSON document, and loading one back in.

Format (see backend/README.md): `format`, `format_version`, `alembic_revision`, `exported_at`,
`user.email` and `tables`, a list of rows per table keyed by column name. Decimals are strings,
dates and times ISO 8601. Columns that point at `users.id` are left out.

Restore inserts every row afresh, so the database gives each one a new id, and every foreign
key is mapped from the old ids to the new ones. It runs in the caller's transaction.
"""

import datetime as dt
from collections.abc import Callable
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKeyConstraint,
    Numeric,
    Select,
    Table,
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
from app.models.user import User

FORMAT = "pfm-backup"
FORMAT_VERSION = 1

# Where a JSON column hides ids: (table, column) -> a function turning the stored value into
# its restored one, given a lookup `new_id(table, old_id) -> new id or None`.
IdLookup = Callable[[str, int], int | None]

# sms_entries.candidates: [{"kind", "id", "label", ...}]. "market" is the shared market_codes.
CANDIDATE_TABLES = {
    "transaction": "transactions",
    "account": "accounts",
    "emi": "accounts",
    "sip": "sips",
    "template": "recurring_templates",
    "stock": "instruments",
}
KEPT_CANDIDATES = {"market"}


def _candidates(value: Any, new_id: IdLookup) -> Any:
    if not value:
        return value
    out = []
    for choice in value:
        kind = choice.get("kind")
        if kind in KEPT_CANDIDATES:
            out.append(choice)
        elif kind in CANDIDATE_TABLES:
            mapped = new_id(CANDIDATE_TABLES[kind], choice.get("id"))
            if mapped is not None:  # a choice whose row is gone is dropped
                out.append({**choice, "id": mapped})
        else:
            raise RestoreError(f"sms_entries.candidates has an unknown kind {kind!r}")
    return out or None


JSON_ID_FIELDS: dict[tuple[str, str], Callable[[Any, IdLookup], Any] | None] = {
    ("sms_entries", "candidates"): _candidates,
}


class RestoreError(ValueError):
    pass


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
    if isinstance(kind, Numeric) and kind.asdecimal:
        return Decimal(value)
    if isinstance(kind, DateTime):
        return dt.datetime.fromisoformat(value)
    if isinstance(kind, Date):
        return dt.date.fromisoformat(value)
    return value


def dump(db: Session, user: User) -> dict[str, Any]:
    found = _metadata_plan()
    tables: dict[str, list[dict[str, Any]]] = {}
    for table in found.exported:
        skip = {c.name for c in user_columns(table)}
        pk = list(table.primary_key.columns)
        rows = db.execute(owned_rows(table, found, user.id).order_by(*pk)).mappings()
        tables[table.name] = [
            {k: _to_json(v) for k, v in row.items() if k not in skip} for row in rows
        ]
    return {
        "format": FORMAT,
        "format_version": FORMAT_VERSION,
        "alembic_revision": alembic_revision(db),
        "exported_at": dt.datetime.now(dt.UTC).isoformat(),
        "user": {"email": user.email},
        "tables": tables,
    }


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


def check(document: dict[str, Any], db: Session) -> None:
    if document.get("format") != FORMAT:
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
    known = {t.name for t in _metadata_plan().exported}
    unknown = sorted(set(document.get("tables", {})) - known)
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
        rows = document.get("tables", {}).get(table.name, [])
        ids[table.name] = {}
        for row in _parents_first(table, rows):
            ids[table.name][row["id"]] = _insert(db, table, row, user.id, ids)
            inserted += 1
    _remap_json(db, found, document, ids)
    return inserted


def _parents_first(table: Table, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows in id order, except a row that points at another row of this table waits for it."""
    refs = [c.name for c in table.columns if _points_at(c, table)]
    pending = sorted(rows, key=lambda r: r["id"])
    if not refs:
        return pending
    present = {r["id"] for r in rows}
    done: set[int] = set()
    ordered: list[dict[str, Any]] = []
    while pending:
        waiting = []
        for row in pending:
            needs = {row.get(c) for c in refs} & present
            if needs <= done | {row["id"]}:
                ordered.append(row)
                done.add(row["id"])
            else:
                waiting.append(row)
        if len(waiting) == len(pending):
            raise RestoreError(f"{table.name} has rows that point at each other in a loop")
        pending = waiting
    return ordered


def _insert(
    db: Session, table: Table, row: dict[str, Any], user_id: int, ids: dict[str, dict[int, int]]
) -> int:
    unknown = set(row) - set(table.columns.keys())
    if unknown:
        raise RestoreError(f"{table.name} has columns this code doesn't know: {sorted(unknown)}")
    values = {
        name: _from_json(table.columns[name], value) for name, value in row.items() if name != "id"
    }
    for column in user_columns(table):
        values[column.name] = user_id
    for constraint in table.constraints:
        if not isinstance(constraint, ForeignKeyConstraint):
            continue
        for column, element in zip(constraint.columns, constraint.elements, strict=True):
            target = element.column
            if target.table.name == "users" or not target.primary_key:
                continue  # user columns are set above; other parts of a composite key copy over
            old = values.get(column.name)
            if old is None:
                continue
            new = ids.get(target.table.name, {}).get(old)
            if new is None:
                raise RestoreError(
                    f"{table.name} row {row['id']}: {column.name} points at "
                    f"{target.table.name} {old}, which isn't in the backup"
                )
            values[column.name] = new
    for name in json_columns(table):
        values[name] = None if name not in row else values[name]
    result = db.execute(table.insert().values(values))
    (new_id,) = result.inserted_primary_key or (None,)
    if new_id is None:
        raise RestoreError(f"{table.name}: the database gave no id for row {row['id']}")
    return int(new_id)


def _remap_json(
    db: Session, found: Plan, document: dict[str, Any], ids: dict[str, dict[int, int]]
) -> None:
    """JSON columns go in after every row exists, since they may point anywhere."""

    def new_id(table: str, old: Any) -> int | None:
        return ids.get(table, {}).get(old) if isinstance(old, int) else None

    for table in found.exported:
        for name in json_columns(table):
            convert = JSON_ID_FIELDS[(table.name, name)]
            for row in document.get("tables", {}).get(table.name, []):
                value = row.get(name)
                if value is None:
                    continue
                if convert is not None:
                    value = convert(value, new_id)
                db.execute(
                    update(table)
                    .where(table.c.id == ids[table.name][row["id"]])
                    .values({name: value})
                )
