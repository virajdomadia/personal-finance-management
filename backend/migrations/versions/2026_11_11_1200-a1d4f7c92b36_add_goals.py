"""add goals, goal earmarks and goal holdings

Adds `goals`, `goal_earmarks` and `goal_holdings`. Downgrading refuses to run while any of the
three has a row, then drops them.

Revision ID: a1d4f7c92b36
Revises: 8e4c1b7a2d95
Create Date: 2026-11-11 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1d4f7c92b36"
down_revision: str | Sequence[str] | None = "8e4c1b7a2d95"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_TABLES = ("goal_holdings", "goal_earmarks", "goals")


def upgrade() -> None:
    op.create_table(
        "goals",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("target_amount", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("ef_months", sa.Integer(), nullable=True),
        sa.Column("ef_monthly_override", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("monthly_amount", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("reminder_day", sa.Integer(), nullable=True),
        sa.Column("reminder_start", sa.Date(), nullable=True),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name=op.f("fk_goals_user_id_users")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goals")),
    )
    op.create_index(op.f("ix_goals_user_id"), "goals", ["user_id"])
    op.create_index(
        "uq_goals_one_emergency",
        "goals",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'emergency' AND archived_at IS NULL"),
        sqlite_where=sa.text("kind = 'emergency' AND archived_at IS NULL"),
    )

    op.create_table(
        "goal_earmarks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("goal_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("amount <> 0", name=op.f("ck_goal_earmarks_amount_nonzero")),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_goal_earmarks_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["goal_id"], ["goals.id"], name=op.f("fk_goal_earmarks_goal_id_goals")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_goal_earmarks_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goal_earmarks")),
    )
    op.create_index(op.f("ix_goal_earmarks_account_id"), "goal_earmarks", ["account_id"])
    op.create_index(op.f("ix_goal_earmarks_goal_id"), "goal_earmarks", ["goal_id"])

    op.create_table(
        "goal_holdings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("goal_id", sa.Integer(), nullable=False),
        sa.Column("instrument_id", sa.Integer(), nullable=True),
        sa.Column("account_id", sa.Integer(), nullable=True),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "(instrument_id IS NULL) <> (account_id IS NULL)",
            name=op.f("ck_goal_holdings_exactly_one_target"),
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_goal_holdings_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["goal_id"], ["goals.id"], name=op.f("fk_goal_holdings_goal_id_goals")
        ),
        sa.ForeignKeyConstraint(
            ["instrument_id"],
            ["instruments.id"],
            name=op.f("fk_goal_holdings_instrument_id_instruments"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_goal_holdings_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_goal_holdings")),
    )
    op.create_index(op.f("ix_goal_holdings_goal_id"), "goal_holdings", ["goal_id"])
    op.create_index(
        "uq_goal_holdings_active_instrument",
        "goal_holdings",
        ["instrument_id"],
        unique=True,
        postgresql_where=sa.text("active"),
        sqlite_where=sa.text("active"),
    )
    op.create_index(
        "uq_goal_holdings_active_account",
        "goal_holdings",
        ["account_id"],
        unique=True,
        postgresql_where=sa.text("active"),
        sqlite_where=sa.text("active"),
    )


def downgrade() -> None:
    # Refuse before touching anything: the old schema has nowhere to keep these rows.
    bind = op.get_bind()
    for table in NEW_TABLES:
        if bind.execute(sa.text(f"SELECT 1 FROM {table} LIMIT 1")).first() is not None:
            raise RuntimeError("Goal data exists; remove it before downgrading.")

    op.drop_index("uq_goal_holdings_active_account", table_name="goal_holdings")
    op.drop_index("uq_goal_holdings_active_instrument", table_name="goal_holdings")
    op.drop_index(op.f("ix_goal_holdings_goal_id"), table_name="goal_holdings")
    op.drop_table("goal_holdings")
    op.drop_index(op.f("ix_goal_earmarks_goal_id"), table_name="goal_earmarks")
    op.drop_index(op.f("ix_goal_earmarks_account_id"), table_name="goal_earmarks")
    op.drop_table("goal_earmarks")
    op.drop_index("uq_goals_one_emergency", table_name="goals")
    op.drop_index(op.f("ix_goals_user_id"), table_name="goals")
    op.drop_table("goals")
