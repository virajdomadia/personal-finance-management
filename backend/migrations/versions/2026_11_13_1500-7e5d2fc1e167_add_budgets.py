"""add monthly budgets per expense category

Adds `budgets`: one row per change to a category's monthly budget, applying from its
`effective_from` month (a NULL amount ends the budget from that month). Nothing is seeded.

Downgrading is refused while any budget exists, because the old schema has nowhere to keep it.

Revision ID: 7e5d2fc1e167
Revises: 2d46fef3dab4
Create Date: 2026-11-13 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7e5d2fc1e167"
down_revision: str | Sequence[str] | None = "2d46fef3dab4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "budgets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("category_id", sa.Integer(), nullable=False),
        sa.Column(
            "kind", sa.String(length=10), server_default=sa.text("'expense'"), nullable=False
        ),
        sa.Column("effective_from", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("amount IS NULL OR amount > 0", name=op.f("ck_budgets_amount_positive")),
        sa.CheckConstraint("kind = 'expense'", name=op.f("ck_budgets_kind")),
        sa.ForeignKeyConstraint(
            ["category_id", "user_id", "kind"],
            ["categories.id", "categories.user_id", "categories.kind"],
            name=op.f("fk_budgets_category_id_categories"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_budgets_user_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_budgets")),
        sa.UniqueConstraint(
            "user_id", "category_id", "effective_from", name=op.f("uq_budgets_user_id")
        ),
    )
    op.create_index(op.f("ix_budgets_user_id"), "budgets", ["user_id"])


def downgrade() -> None:
    # Refuse before touching anything: the old schema has nowhere to keep these rows.
    if op.get_bind().execute(sa.text("SELECT 1 FROM budgets LIMIT 1")).first() is not None:
        raise RuntimeError("Budget data exists; remove it before downgrading.")
    op.drop_index(op.f("ix_budgets_user_id"), table_name="budgets")
    op.drop_table("budgets")
