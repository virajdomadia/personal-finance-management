"""add market codes, instrument source codes and price sources

Adds the shared `market_codes` table, `instruments.source_code` and `instrument_prices.source`
(existing rows become "manual"). Downgrading deletes the "auto" price rows first, so only typed
prices survive, then drops them; linked source codes are discarded.

Revision ID: c7e2a95d1b48
Revises: a1d4f7c92b36
Create Date: 2026-11-12 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7e2a95d1b48"
down_revision: str | Sequence[str] | None = "a1d4f7c92b36"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "market_codes",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("code", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("isin", sa.String(length=12), nullable=True),
        sa.Column("price", sa.Numeric(precision=14, scale=4), nullable=True),
        sa.Column("price_date", sa.Date(), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_market_codes")),
        sa.UniqueConstraint("kind", "code", name=op.f("uq_market_codes_kind")),
    )
    op.create_index("ix_market_codes_kind_name", "market_codes", ["kind", "name"])
    op.add_column("instruments", sa.Column("source_code", sa.String(length=40), nullable=True))
    op.add_column(
        "instrument_prices",
        sa.Column("source", sa.String(length=10), server_default="manual", nullable=False),
    )


def downgrade() -> None:
    op.execute("DELETE FROM instrument_prices WHERE source = 'auto'")
    op.drop_column("instrument_prices", "source")
    op.drop_column("instruments", "source_code")
    op.drop_index("ix_market_codes_kind_name", table_name="market_codes")
    op.drop_table("market_codes")
