"""add fixed deposit columns to accounts

Adds two nullable columns for fixed deposits (type `fd`): `matures_on` and `fd_payout`
("cumulative", "monthly" or "quarterly"). Downgrading refuses to run while any FD exists,
since the old schema can't hold them, then drops the columns.

Revision ID: a1c3e5f7b902
Revises: 7e5d2fc1e167
Create Date: 2026-11-16 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1c3e5f7b902"
down_revision: str | Sequence[str] | None = "7e5d2fc1e167"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("matures_on", sa.Date(), nullable=True))
    op.add_column("accounts", sa.Column("fd_payout", sa.String(20), nullable=True))


def downgrade() -> None:
    found = op.get_bind().execute(sa.text("SELECT 1 FROM accounts WHERE type = 'fd' LIMIT 1"))
    if found.first() is not None:
        raise RuntimeError("Fixed deposits exist; remove them before downgrading.")
    op.drop_column("accounts", "fd_payout")
    op.drop_column("accounts", "matures_on")
