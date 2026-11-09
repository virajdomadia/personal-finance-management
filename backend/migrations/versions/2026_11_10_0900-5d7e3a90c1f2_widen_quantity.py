"""widen quantity to 8 decimals for crypto

Crypto is held in fractions as small as 0.00000001, so `investment_trades.quantity` goes from
Numeric(18,3) to Numeric(24,8). Widening keeps every value exactly.

Downgrading refuses to run while any crypto instrument exists or any quantity has more than
3 decimals, since the narrower column can't hold them.

Revision ID: 5d7e3a90c1f2
Revises: 3b8f2c61a7d4
Create Date: 2026-11-10 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "5d7e3a90c1f2"
down_revision: str | Sequence[str] | None = "3b8f2c61a7d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "investment_trades",
        "quantity",
        type_=sa.Numeric(precision=24, scale=8),
        existing_type=sa.Numeric(precision=18, scale=3),
        existing_nullable=False,
        postgresql_using="quantity::numeric(24,8)",
    )


def downgrade() -> None:
    # Refuse before touching anything: rounding would silently change a holding.
    bind = op.get_bind()
    crypto = bind.execute(sa.text("SELECT 1 FROM instruments WHERE kind = 'crypto' LIMIT 1"))
    fine = bind.execute(
        sa.text("SELECT 1 FROM investment_trades WHERE quantity <> round(quantity, 3) LIMIT 1")
    )
    if crypto.first() is not None or fine.first() is not None:
        raise RuntimeError("Crypto data exists; remove it before downgrading.")

    op.alter_column(
        "investment_trades",
        "quantity",
        type_=sa.Numeric(precision=18, scale=3),
        existing_type=sa.Numeric(precision=24, scale=8),
        existing_nullable=False,
        postgresql_using="quantity::numeric(18,3)",
    )
