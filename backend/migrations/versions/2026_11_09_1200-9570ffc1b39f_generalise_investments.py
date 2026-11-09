"""generalise the stock tables into instruments, investment trades and prices

Written by hand: autogenerate can't see renames, and would drop and recreate the tables,
losing every stock row. Upgrading keeps every row, id and figure:

1. Renames the tables, the `stock_id` columns, the id sequences, and every pk, fk, uq and ix
   to what the naming convention gives the new tables.
2. Adds `instruments.kind` ('stock' for every existing row) and makes the symbol unique per
   (user, kind) instead of per user.
3. Widens `quantity` to Numeric(18,3) and both `price` columns to Numeric(14,4).
4. Adds `investment_trades.amount`, backfilled exactly as the old code computed it:
   buy = quantity * price + charges, sell = quantity * price - charges.
5. Creates `sips`, and links trades to SIPs and auto-recorded NAVs to their trades.

Downgrading refuses to run while any mutual fund data exists, since the old tables can't hold
it. Otherwise it reverses every step exactly.

Revision ID: 9570ffc1b39f
Revises: 65f46a0f545a
Create Date: 2026-11-09 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "9570ffc1b39f"
down_revision: str | Sequence[str] | None = "65f46a0f545a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = [
    ("stocks", "instruments"),
    ("stock_trades", "investment_trades"),
    ("stock_prices", "instrument_prices"),
]
# (table after the rename, old name, new name)
CONSTRAINTS = [
    ("instruments", "pk_stocks", "pk_instruments"),
    ("instruments", "fk_stocks_user_id_users", "fk_instruments_user_id_users"),
    ("instruments", "uq_stocks_user_id", "uq_instruments_user_id"),
    ("investment_trades", "pk_stock_trades", "pk_investment_trades"),
    ("investment_trades", "fk_stock_trades_user_id_users", "fk_investment_trades_user_id_users"),
    (
        "investment_trades",
        "fk_stock_trades_stock_id_stocks",
        "fk_investment_trades_instrument_id_instruments",
    ),
    (
        "investment_trades",
        "fk_stock_trades_account_id_accounts",
        "fk_investment_trades_account_id_accounts",
    ),
    ("instrument_prices", "pk_stock_prices", "pk_instrument_prices"),
    ("instrument_prices", "fk_stock_prices_user_id_users", "fk_instrument_prices_user_id_users"),
    (
        "instrument_prices",
        "fk_stock_prices_stock_id_stocks",
        "fk_instrument_prices_instrument_id_instruments",
    ),
]
INDEXES = [
    ("ix_stocks_user_id", "ix_instruments_user_id"),
    ("ix_stock_trades_user_id", "ix_investment_trades_user_id"),
    ("ix_stock_trades_stock_id", "ix_investment_trades_instrument_id"),
    ("ix_stock_trades_account_id", "ix_investment_trades_account_id"),
    ("ix_stock_prices_user_id", "ix_instrument_prices_user_id"),
    ("ix_stock_prices_stock_id", "ix_instrument_prices_instrument_id"),
]


def _rename_tables(forward: bool) -> None:
    for old, new in TABLES:
        src, dst = (old, new) if forward else (new, old)
        op.rename_table(src, dst)
        op.execute(f"ALTER SEQUENCE {src}_id_seq RENAME TO {dst}_id_seq")


def _rename_inside(forward: bool) -> None:
    """Columns, constraints and indexes, while the tables have their new names.

    Postgres renames a primary key's index along with the constraint.
    """
    column = ("stock_id", "instrument_id") if forward else ("instrument_id", "stock_id")
    for table in ("investment_trades", "instrument_prices"):
        op.alter_column(table, column[0], new_column_name=column[1])
    for table, old, new in CONSTRAINTS:
        src, dst = (old, new) if forward else (new, old)
        op.execute(f"ALTER TABLE {table} RENAME CONSTRAINT {src} TO {dst}")
    for old, new in INDEXES:
        src, dst = (old, new) if forward else (new, old)
        op.execute(f"ALTER INDEX {src} RENAME TO {dst}")


def upgrade() -> None:
    # 1. Renames.
    _rename_tables(forward=True)
    _rename_inside(forward=True)

    # 2. Every existing instrument is a stock; symbols are unique per user and kind.
    op.add_column(
        "instruments",
        sa.Column("kind", sa.String(length=12), server_default="stock", nullable=False),
    )
    op.alter_column("instruments", "kind", server_default=None)
    op.drop_constraint("uq_instruments_user_id", "instruments", type_="unique")
    op.create_unique_constraint(
        "uq_instruments_user_id", "instruments", ["user_id", "kind", "symbol"]
    )

    # 3. Fractional units and 4-decimal NAVs. Widening keeps every value exactly.
    op.alter_column(
        "investment_trades",
        "quantity",
        type_=sa.Numeric(precision=18, scale=3),
        existing_type=sa.Integer(),
        existing_nullable=False,
        postgresql_using="quantity::numeric(18, 3)",
    )
    for table in ("investment_trades", "instrument_prices"):
        op.alter_column(
            table,
            "price",
            type_=sa.Numeric(precision=14, scale=4),
            existing_type=sa.Numeric(precision=14, scale=2),
            existing_nullable=False,
        )

    # 4. The money each trade moved, as the old code computed it. Exact to the paisa for whole
    # shares at 2-decimal prices, so round() only fixes the scale.
    op.add_column(
        "investment_trades",
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=True),
    )
    op.execute(
        "UPDATE investment_trades SET amount = CASE side"
        " WHEN 'buy' THEN round(quantity * price + charges, 2)"
        " ELSE round(quantity * price - charges, 2) END"
    )
    op.alter_column(
        "investment_trades",
        "amount",
        existing_type=sa.Numeric(precision=14, scale=2),
        nullable=False,
    )

    # 5. SIPs, and the links from trades to SIPs and from auto-recorded NAVs to trades.
    op.create_table(
        "sips",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("day", sa.Integer(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_sips_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["instrument_id"], ["instruments.id"], name=op.f("fk_sips_instrument_id_instruments")
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_sips_user_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sips")),
    )
    op.create_index(op.f("ix_sips_account_id"), "sips", ["account_id"], unique=False)
    op.create_index(op.f("ix_sips_instrument_id"), "sips", ["instrument_id"], unique=False)
    op.create_index(op.f("ix_sips_user_id"), "sips", ["user_id"], unique=False)

    op.add_column("investment_trades", sa.Column("sip_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_investment_trades_sip_id_sips"), "investment_trades", "sips", ["sip_id"], ["id"]
    )
    op.create_index(
        op.f("ix_investment_trades_sip_id"), "investment_trades", ["sip_id"], unique=False
    )

    op.add_column("instrument_prices", sa.Column("trade_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        op.f("fk_instrument_prices_trade_id_investment_trades"),
        "instrument_prices",
        "investment_trades",
        ["trade_id"],
        ["id"],
    )
    op.create_index(
        op.f("ix_instrument_prices_trade_id"), "instrument_prices", ["trade_id"], unique=False
    )


def downgrade() -> None:
    # The stock-only tables can't hold funds or fractional units. Refuse before touching anything.
    bind = op.get_bind()
    fund = bind.execute(sa.text("SELECT 1 FROM instruments WHERE kind <> 'stock' LIMIT 1"))
    fraction = bind.execute(
        sa.text("SELECT 1 FROM investment_trades WHERE quantity <> trunc(quantity) LIMIT 1")
    )
    if fund.first() is not None or fraction.first() is not None:
        raise RuntimeError("Mutual fund data exists; remove it before downgrading.")

    # 5.
    op.drop_index(op.f("ix_instrument_prices_trade_id"), table_name="instrument_prices")
    op.drop_constraint(
        op.f("fk_instrument_prices_trade_id_investment_trades"),
        "instrument_prices",
        type_="foreignkey",
    )
    op.drop_column("instrument_prices", "trade_id")
    op.drop_index(op.f("ix_investment_trades_sip_id"), table_name="investment_trades")
    op.drop_constraint(
        op.f("fk_investment_trades_sip_id_sips"), "investment_trades", type_="foreignkey"
    )
    op.drop_column("investment_trades", "sip_id")
    op.drop_index(op.f("ix_sips_user_id"), table_name="sips")
    op.drop_index(op.f("ix_sips_instrument_id"), table_name="sips")
    op.drop_index(op.f("ix_sips_account_id"), table_name="sips")
    op.drop_table("sips")

    # 4.
    op.drop_column("investment_trades", "amount")

    # 3. Exact: only whole quantities and 2-decimal prices remain (stocks only).
    for table in ("instrument_prices", "investment_trades"):
        op.alter_column(
            table,
            "price",
            type_=sa.Numeric(precision=14, scale=2),
            existing_type=sa.Numeric(precision=14, scale=4),
            existing_nullable=False,
        )
    op.alter_column(
        "investment_trades",
        "quantity",
        type_=sa.Integer(),
        existing_type=sa.Numeric(precision=18, scale=3),
        existing_nullable=False,
        postgresql_using="quantity::integer",
    )

    # 2.
    op.drop_constraint("uq_instruments_user_id", "instruments", type_="unique")
    op.create_unique_constraint("uq_instruments_user_id", "instruments", ["user_id", "symbol"])
    op.drop_column("instruments", "kind")

    # 1.
    _rename_inside(forward=False)
    _rename_tables(forward=False)
