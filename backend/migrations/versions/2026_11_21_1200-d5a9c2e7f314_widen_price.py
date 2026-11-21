"""widen prices to 10 decimals

A coin can be priced at a fraction of a paisa (₹0.00084), which 4 decimals rounded to ₹0.0008 or,
under ₹0.00005, to nothing. Trade prices, recorded prices and market prices keep 10 decimals now;
the largest price is unchanged (under 10^10).

Revision ID: d5a9c2e7f314
Revises: c3f8a1d4e625
Create Date: 2026-11-21 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d5a9c2e7f314"
down_revision: str | Sequence[str] | None = "c3f8a1d4e625"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (table, column, nullable)
PRICES = (
    ("investment_trades", "price", False),
    ("instrument_prices", "price", False),
    ("market_codes", "price", True),
)


def _alter(old: sa.Numeric, new: sa.Numeric, cast: str) -> None:
    for table, column, nullable in PRICES:
        op.alter_column(
            table,
            column,
            type_=new,
            existing_type=old,
            existing_nullable=nullable,
            postgresql_using=f"{column}::{cast}",
        )


def upgrade() -> None:
    _alter(sa.Numeric(precision=14, scale=4), sa.Numeric(precision=20, scale=10), "numeric(20,10)")


def downgrade() -> None:
    # Refuse before touching anything: rounding would silently change a holding's value.
    bind = op.get_bind()
    for table, column, _ in PRICES:
        finer = bind.execute(
            sa.text(f"SELECT 1 FROM {table} WHERE {column} <> round({column}, 4) LIMIT 1")
        )
        if finer.first() is not None:
            raise RuntimeError("A price has more than 4 decimals; remove it before downgrading.")
    _alter(sa.Numeric(precision=20, scale=10), sa.Numeric(precision=14, scale=4), "numeric(14,4)")
