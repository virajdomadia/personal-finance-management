"""Which tables a user's backup holds, worked out from the SQLAlchemy metadata.

- A table with a `user_id` column is the user's: its rows are `WHERE user_id = :me`.
- A table without one whose foreign key points at a user's table is owned through that parent.
- `EXCLUDED` lists the rest, each with the reason it stays out.

Anything else is unclassified, and tests/test_export_coverage.py fails, so a new table can't be
left out of backups by accident. See docs/superpowers/specs/2026-11-13-export-backup-design.md.
"""

from dataclasses import dataclass, field

from sqlalchemy import JSON, Column, ForeignKeyConstraint, MetaData, Table

EXCLUDED: dict[str, str] = {
    "users": "login identity (email, Google id, session version); restore targets a user by email",
    "market_codes": "shared public market data, the same for every user and refreshed nightly",
}

USERS = "users"


def user_columns(table: Table) -> list[Column]:
    """Columns that point at `users.id`; a backup leaves them out and restore sets them."""
    return [c for c in table.columns if any(fk.column.table.name == USERS for fk in c.foreign_keys)]


def json_columns(table: Table) -> list[str]:
    return [c.name for c in table.columns if isinstance(c.type, JSON)]


@dataclass
class Plan:
    """The exported tables in insert order, how each is owned, and what's wrong."""

    exported: list[Table] = field(default_factory=list)
    # A child table's name -> the foreign key column that ties it to its owned parent.
    owned_through: dict[str, Column] = field(default_factory=dict)
    excluded: dict[str, str] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)


def plan(metadata: MetaData) -> Plan:
    found = Plan()
    owned: set[str] = set()
    for table in metadata.sorted_tables:  # parents before children
        if table.name in EXCLUDED:
            found.excluded[table.name] = EXCLUDED[table.name]
        elif "user_id" in table.columns:
            owned.add(table.name)
            found.exported.append(table)
        else:
            parent = _owning_column(table, owned)
            if parent is None:
                found.problems.append(
                    f"{table.name}: no user_id and no foreign key to a user's table; "
                    "export it or add it to EXCLUDED with a reason"
                )
            else:
                owned.add(table.name)
                found.owned_through[table.name] = parent
                found.exported.append(table)
    for table in found.exported:
        found.problems.extend(_remap_problems(table, owned))
    return found


def _owning_column(table: Table, owned: set[str]) -> Column | None:
    candidates = [
        c
        for c in table.columns
        for fk in c.foreign_keys
        if fk.column.table.name in owned and fk.column.primary_key
    ]
    candidates.sort(key=lambda c: c.nullable)  # a required parent first
    return candidates[0] if candidates else None


def _remap_problems(table: Table, owned: set[str]) -> list[str]:
    from app.export.backup import JSON_ID_FIELDS  # it imports this module

    problems = []
    if [c.name for c in table.primary_key.columns] != ["id"]:
        problems.append(f"{table.name}: restore needs a single `id` primary key")
    fk_columns = set()
    for constraint in table.constraints:
        if not isinstance(constraint, ForeignKeyConstraint):
            continue
        for column, element in zip(constraint.columns, constraint.elements, strict=True):
            fk_columns.add(column.name)
            target = element.column.table.name
            if target != USERS and target not in owned:
                problems.append(
                    f"{table.name}.{column.name} points at {target}, which isn't exported; "
                    "restore couldn't remap it"
                )
    for column in table.columns:
        if column.name.endswith("_id") and column.name not in fk_columns:
            problems.append(
                f"{table.name}.{column.name} looks like an id but isn't a foreign key; "
                "restore wouldn't remap it"
            )
    for name in json_columns(table):
        if (table.name, name) not in JSON_ID_FIELDS:
            problems.append(
                f"{table.name}.{name} is JSON; say in JSON_ID_FIELDS which ids it holds"
            )
    return problems
