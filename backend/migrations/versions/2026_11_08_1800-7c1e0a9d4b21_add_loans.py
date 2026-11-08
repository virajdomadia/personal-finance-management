"""add loans

Revision ID: 7c1e0a9d4b21
Revises: 2e2a3dd704fc
Create Date: 2026-11-08 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7c1e0a9d4b21"
down_revision: str | Sequence[str] | None = "2e2a3dd704fc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("accounts", sa.Column("interest_rate", sa.Numeric(5, 2), nullable=True))
    op.add_column("accounts", sa.Column("emi_amount", sa.Numeric(14, 2), nullable=True))
    op.add_column("accounts", sa.Column("emis_at_opening", sa.Integer(), nullable=True))
    op.add_column("accounts", sa.Column("pay_from_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_accounts_pay_from_id_accounts"), "accounts", "accounts", ["pay_from_id"], ["id"]
    )
    op.add_column("transactions", sa.Column("interest", sa.Numeric(14, 2), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("transactions", "interest")
    op.drop_constraint(op.f("fk_accounts_pay_from_id_accounts"), "accounts", type_="foreignkey")
    op.drop_column("accounts", "pay_from_id")
    op.drop_column("accounts", "emis_at_opening")
    op.drop_column("accounts", "emi_amount")
    op.drop_column("accounts", "interest_rate")
