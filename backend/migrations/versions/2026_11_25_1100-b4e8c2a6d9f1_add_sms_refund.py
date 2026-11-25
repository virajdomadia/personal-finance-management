"""add sms_entries.refund: a credit the phone read as a refund or reversal

Such a credit, and any credit onto a credit card, is now recorded as a refund (it lowers
spending) instead of income. Existing entries are left as they were (false).

Revision ID: b4e8c2a6d9f1
Revises: a7d2e5f9c1b3
Create Date: 2026-11-25 11:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4e8c2a6d9f1"
down_revision: str | Sequence[str] | None = "a7d2e5f9c1b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sms_entries",
        sa.Column("refund", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("sms_entries", "refund")
