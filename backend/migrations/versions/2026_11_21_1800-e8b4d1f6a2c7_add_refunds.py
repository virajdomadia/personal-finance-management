"""add refunds: a transaction type, and the purchase a refund belongs to

`transactions.refund_of_id` links a refund to the expense it gives money back for. Deleting the
expense leaves the refund unlinked (ON DELETE SET NULL). The type itself is a string column, so
"refund" needs no schema change.

Revision ID: e8b4d1f6a2c7
Revises: d5a9c2e7f314
Create Date: 2026-11-21 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e8b4d1f6a2c7"
down_revision: str | Sequence[str] | None = "d5a9c2e7f314"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("transactions", sa.Column("refund_of_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_transactions_refund_of_id_transactions"),
        "transactions",
        "transactions",
        ["refund_of_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_transactions_refund_of_id"), "transactions", ["refund_of_id"], unique=False
    )


def downgrade() -> None:
    # Refuse before touching anything: a refund would become a type the old code can't read.
    found = op.get_bind().execute(
        sa.text("SELECT 1 FROM transactions WHERE type = 'refund' LIMIT 1")
    )
    if found.first() is not None:
        raise RuntimeError("Refunds exist; delete them before downgrading.")
    op.drop_index(op.f("ix_transactions_refund_of_id"), table_name="transactions")
    op.drop_constraint(
        op.f("fk_transactions_refund_of_id_transactions"), "transactions", type_="foreignkey"
    )
    op.drop_column("transactions", "refund_of_id")
