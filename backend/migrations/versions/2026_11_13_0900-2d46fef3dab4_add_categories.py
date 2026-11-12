"""add managed categories and the (user_id, date) index on transactions

Adds `categories`, the registry of the category names transactions, recurring templates and
payee rules carry, and seeds it for every existing user: the defaults, then every category
already used, case-insensitive duplicates collapsed (a default's spelling wins, then the first
one found). Templates and payee rules spelled differently are rewritten to the kept spelling.

Downgrading drops the table and the index. The names stay on the transactions; icons, colours,
nesting, archiving and merges are lost.

Revision ID: 2d46fef3dab4
Revises: e3b81f46a0d7
Create Date: 2026-11-13 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2d46fef3dab4"
down_revision: str | Sequence[str] | None = "e3b81f46a0d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The defaults as of this migration: (name, icon, colour). Frozen here on purpose.
DEFAULTS: dict[str, list[tuple[str, str, str]]] = {
    "income": [
        ("Salary", "salary", "#2e9e5b"),
        ("Business", "business", "#1f7a8c"),
        ("Interest", "interest", "#4cb944"),
        ("Dividends", "dividends", "#5c80bc"),
        ("Refund", "refund", "#669bbc"),
        ("Gift", "gift", "#a06cd5"),
        ("Other", "other", "#8a8a8a"),
    ],
    "expense": [
        ("Groceries", "groceries", "#4cb944"),
        ("Food and dining", "food", "#f3a712"),
        ("Transport", "transport", "#5c80bc"),
        ("Fuel", "fuel", "#e4572e"),
        ("Housing", "home", "#8d6a9f"),
        ("Utilities", "utilities", "#2ec4b6"),
        ("Shopping", "shopping", "#db5375"),
        ("Health", "health", "#e63946"),
        ("Entertainment", "entertainment", "#a06cd5"),
        ("Education", "education", "#1f7a8c"),
        ("Insurance", "insurance", "#29335c"),
        ("Loan payments", "loan", "#6c757d"),
        ("Travel", "travel", "#ff9f1c"),
        ("Gifts and donations", "gift", "#c77dff"),
        ("Fees and charges", "fees", "#b5651d"),
        ("Other", "other", "#8a8a8a"),
        ("Loan interest", "loan", "#495057"),
    ],
}
KIND_OF_TYPE = {"income": "income", "expense": "expense", "emi": "expense"}


def _key(name: str) -> str:
    return name.casefold()[:40]


def seed(bind: sa.Connection) -> None:
    """Fills `categories` for every user and rewrites differently spelled references."""
    categories = sa.table(
        "categories",
        sa.column("user_id", sa.Integer),
        sa.column("kind", sa.String),
        sa.column("name", sa.String),
        sa.column("name_key", sa.String),
        sa.column("icon", sa.String),
        sa.column("colour", sa.String),
    )
    users = [row[0] for row in bind.execute(sa.text("SELECT id FROM users ORDER BY id"))]
    for user_id in users:
        _seed_user(bind, categories, user_id)


def _seed_user(bind: sa.Connection, categories: sa.TableClause, user_id: int) -> None:
    params = {"u": user_id}
    txs = bind.execute(
        sa.text(
            "SELECT id, type, category FROM transactions "
            "WHERE user_id = :u AND category IS NOT NULL ORDER BY id"
        ),
        params,
    ).all()
    templates = bind.execute(
        sa.text(
            "SELECT id, type, category FROM recurring_templates "
            "WHERE user_id = :u AND category IS NOT NULL ORDER BY id"
        ),
        params,
    ).all()
    rules = bind.execute(
        sa.text(
            "SELECT id, category FROM payee_rules "
            "WHERE user_id = :u AND category IS NOT NULL ORDER BY id"
        ),
        params,
    ).all()

    # kind -> name_key -> (name, icon, colour); insertion order is the seeding order.
    known: dict[str, dict[str, tuple[str, str | None, str | None]]] = {
        kind: {_key(name): (name, icon, colour) for name, icon, colour in rows}
        for kind, rows in DEFAULTS.items()
    }

    def add(kind: str, name: str) -> None:
        known[kind].setdefault(_key(name), (name, None, None))

    for _, type_, name in [*txs, *templates]:
        kind = KIND_OF_TYPE.get(type_)
        if kind is not None:
            add(kind, name)

    def rule_kind(name: str) -> str:
        key = _key(name)
        return "income" if key in known["income"] and key not in known["expense"] else "expense"

    for _, name in rules:
        add(rule_kind(name), name)

    rows = [
        {
            "user_id": user_id,
            "kind": kind,
            "name": name,
            "name_key": key,
            "icon": icon,
            "colour": colour,
        }
        for kind, entries in known.items()
        for key, (name, icon, colour) in entries.items()
    ]
    if rows:
        bind.execute(categories.insert(), rows)

    def spelling(kind: str, name: str) -> str:
        return known[kind][_key(name)][0]

    for table, found in (("transactions", txs), ("recurring_templates", templates)):
        for id_, type_, name in found:
            kind = KIND_OF_TYPE.get(type_)
            if kind is not None and spelling(kind, name) != name:
                bind.execute(
                    sa.text(f"UPDATE {table} SET category = :c WHERE id = :i"),
                    {"c": spelling(kind, name), "i": id_},
                )
    for id_, name in rules:
        kept = spelling(rule_kind(name), name)
        if kept != name:
            bind.execute(
                sa.text("UPDATE payee_rules SET category = :c WHERE id = :i"),
                {"c": kept, "i": id_},
            )


def upgrade() -> None:
    op.create_table(
        "categories",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("name_key", sa.String(length=40), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=True),
        sa.Column("merged_into_id", sa.Integer(), nullable=True),
        sa.Column("icon", sa.String(length=20), nullable=True),
        sa.Column("colour", sa.String(length=7), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("kind IN ('income', 'expense')", name=op.f("ck_categories_kind")),
        sa.CheckConstraint(
            "merged_into_id <> id", name=op.f("ck_categories_not_merged_into_itself")
        ),
        sa.CheckConstraint("parent_id <> id", name=op.f("ck_categories_not_own_parent")),
        sa.ForeignKeyConstraint(
            ["merged_into_id", "user_id", "kind"],
            ["categories.id", "categories.user_id", "categories.kind"],
            name=op.f("fk_categories_merged_into_id_categories"),
        ),
        sa.ForeignKeyConstraint(
            ["parent_id", "user_id", "kind"],
            ["categories.id", "categories.user_id", "categories.kind"],
            name=op.f("fk_categories_parent_id_categories"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_categories_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_categories")),
        sa.UniqueConstraint("id", "user_id", "kind", name=op.f("uq_categories_id")),
    )
    op.create_index(op.f("ix_categories_user_id"), "categories", ["user_id"])
    op.create_index(
        "uq_categories_live_name",
        "categories",
        ["user_id", "kind", "name_key"],
        unique=True,
        postgresql_where=sa.text("merged_into_id IS NULL"),
        sqlite_where=sa.text("merged_into_id IS NULL"),
    )
    op.create_index("ix_transactions_user_id_date", "transactions", ["user_id", "date"])
    seed(op.get_bind())


def downgrade() -> None:
    op.drop_index("ix_transactions_user_id_date", table_name="transactions")
    op.drop_index("uq_categories_live_name", table_name="categories")
    op.drop_index(op.f("ix_categories_user_id"), table_name="categories")
    op.drop_table("categories")
