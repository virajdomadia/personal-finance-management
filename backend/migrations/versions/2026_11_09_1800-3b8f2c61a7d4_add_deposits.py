"""add PPF and recurring deposit columns to accounts

Adds four nullable columns: `opened_on`, `deposit_amount`, `tenure_months` and
`deposits_at_opening`. Downgrading refuses to run while any PPF or RD account exists, since
the old schema can't hold them, then drops the columns.

Revision ID: 3b8f2c61a7d4
Revises: 9570ffc1b39f
Create Date: 2026-11-09 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3b8f2c61a7d4"
down_revision: str | Sequence[str] | None = "9570ffc1b39f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("opened_on", sa.Date(), nullable=True))
    op.add_column("accounts", sa.Column("deposit_amount", sa.Numeric(14, 2), nullable=True))
    op.add_column("accounts", sa.Column("tenure_months", sa.Integer(), nullable=True))
    op.add_column("accounts", sa.Column("deposits_at_opening", sa.Integer(), nullable=True))


def downgrade() -> None:
    found = op.get_bind().execute(
        sa.text("SELECT 1 FROM accounts WHERE type IN ('ppf', 'rd') LIMIT 1")
    )
    if found.first() is not None:
        raise RuntimeError("PPF or RD accounts exist; remove them before downgrading.")
    op.drop_column("accounts", "deposits_at_opening")
    op.drop_column("accounts", "tenure_months")
    op.drop_column("accounts", "deposit_amount")
    op.drop_column("accounts", "opened_on")
