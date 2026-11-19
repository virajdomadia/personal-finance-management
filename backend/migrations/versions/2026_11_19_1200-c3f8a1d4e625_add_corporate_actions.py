"""add corporate actions, trade basis date, and instrument action bookkeeping

`investment_trades.basis_date` is the India-time day quantity and price were last entered; it
starts as the day the row was last updated. `corporate_actions` is shared market data;
`stock_actions` and `dividend_links` are per user.

Revision ID: c3f8a1d4e625
Revises: b7d2e4f6a813
Create Date: 2026-11-19 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c3f8a1d4e625"
down_revision: str | Sequence[str] | None = "b7d2e4f6a813"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _stamp(name: str) -> sa.Column:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    op.add_column("investment_trades", sa.Column("basis_date", sa.Date(), nullable=True))
    op.execute(
        "UPDATE investment_trades SET basis_date = (updated_at AT TIME ZONE 'Asia/Kolkata')::date"
    )
    op.alter_column("investment_trades", "basis_date", nullable=False)
    op.add_column(
        "instruments", sa.Column("actions_backfilled_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("instruments", sa.Column("suspect_drop_on", sa.Date(), nullable=True))

    op.create_table(
        "corporate_actions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(20), nullable=False),
        sa.Column("isin", sa.String(12), nullable=True),
        sa.Column("kind", sa.String(14), nullable=False),
        sa.Column("ex_date", sa.Date(), nullable=False),
        sa.Column("record_date", sa.Date(), nullable=True),
        sa.Column("ratio_new", sa.Numeric(14, 6), nullable=True),
        sa.Column("ratio_old", sa.Numeric(14, 6), nullable=True),
        sa.Column("amount_per_share", sa.Numeric(14, 4), nullable=True),
        sa.Column("purpose", sa.String(300), nullable=False),
        sa.Column("purpose_key", sa.String(300), nullable=False),
        sa.Column("source", sa.String(4), nullable=False),
        _stamp("created_at"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_corporate_actions")),
        sa.UniqueConstraint(
            "symbol",
            "kind",
            "ex_date",
            "purpose_key",
            name=op.f("uq_corporate_actions_symbol_kind_ex_date_purpose_key"),
        ),
    )
    op.create_table(
        "stock_actions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("corporate_action_id", sa.Integer(), nullable=True),
        sa.Column("kind", sa.String(14), nullable=False),
        sa.Column("ex_date", sa.Date(), nullable=False),
        sa.Column("ratio_new", sa.Numeric(14, 6), nullable=True),
        sa.Column("ratio_old", sa.Numeric(14, 6), nullable=True),
        sa.Column("amount_per_share", sa.Numeric(14, 4), nullable=True),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("target_instrument_id", sa.Integer(), nullable=True),
        sa.Column("cost_share_pct", sa.Numeric(7, 4), nullable=True),
        _stamp("created_at"),
        _stamp("updated_at"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_stock_actions_user_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["instrument_id"],
            ["instruments.id"],
            name=op.f("fk_stock_actions_instrument_id_instruments"),
        ),
        sa.ForeignKeyConstraint(
            ["corporate_action_id"],
            ["corporate_actions.id"],
            name=op.f("fk_stock_actions_corporate_action_id_corporate_actions"),
        ),
        sa.ForeignKeyConstraint(
            ["target_instrument_id"],
            ["instruments.id"],
            name=op.f("fk_stock_actions_target_instrument_id_instruments"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stock_actions")),
        sa.UniqueConstraint(
            "user_id",
            "instrument_id",
            "corporate_action_id",
            name=op.f("uq_stock_actions_user_id_instrument_id_corporate_action_id"),
        ),
    )
    op.create_index(op.f("ix_stock_actions_user_id"), "stock_actions", ["user_id"])
    op.create_index(op.f("ix_stock_actions_instrument_id"), "stock_actions", ["instrument_id"])
    op.create_index(
        op.f("ix_stock_actions_corporate_action_id"), "stock_actions", ["corporate_action_id"]
    )
    op.create_index(
        op.f("ix_stock_actions_target_instrument_id"), "stock_actions", ["target_instrument_id"]
    )
    op.create_table(
        "dividend_links",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("stock_action_id", sa.Integer(), nullable=False),
        sa.Column("transaction_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_dividend_links_user_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["stock_action_id"],
            ["stock_actions.id"],
            name=op.f("fk_dividend_links_stock_action_id_stock_actions"),
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            name=op.f("fk_dividend_links_transaction_id_transactions"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dividend_links")),
        sa.UniqueConstraint(
            "stock_action_id",
            "transaction_id",
            name=op.f("uq_dividend_links_stock_action_id_transaction_id"),
        ),
    )
    op.create_index(op.f("ix_dividend_links_user_id"), "dividend_links", ["user_id"])
    op.create_index(
        op.f("ix_dividend_links_stock_action_id"), "dividend_links", ["stock_action_id"]
    )
    op.create_index(op.f("ix_dividend_links_transaction_id"), "dividend_links", ["transaction_id"])


def downgrade() -> None:
    op.drop_table("dividend_links")
    op.drop_table("stock_actions")
    op.drop_table("corporate_actions")
    op.drop_column("instruments", "suspect_drop_on")
    op.drop_column("instruments", "actions_backfilled_at")
    op.drop_column("investment_trades", "basis_date")
