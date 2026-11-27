"""add transactions.split_of_id: the extra parts of a split bill point at the original

Revision ID: c5f1a8d3e2b7
Revises: b4e8c2a6d9f1
Create Date: 2026-11-27 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c5f1a8d3e2b7"
down_revision: str | Sequence[str] | None = "b4e8c2a6d9f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("transactions", sa.Column("split_of_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_transactions_split_of_id_transactions"),
        "transactions",
        "transactions",
        ["split_of_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        op.f("ix_transactions_split_of_id"), "transactions", ["split_of_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_transactions_split_of_id"), table_name="transactions")
    op.drop_constraint(
        op.f("fk_transactions_split_of_id_transactions"), "transactions", type_="foreignkey"
    )
    op.drop_column("transactions", "split_of_id")
