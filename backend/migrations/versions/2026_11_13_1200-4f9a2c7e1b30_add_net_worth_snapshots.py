"""add net worth snapshots

Adds `net_worth_snapshots`: one row per user per India date with the dashboard's net worth, have,
owe and asset split, and whether the row is a backfilled estimate. Downgrading refuses to run while
any snapshot exists (past days can't be worked out again), then drops the table.

Revision ID: 4f9a2c7e1b30
Revises: 2d46fef3dab4
Create Date: 2026-11-13 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "4f9a2c7e1b30"
down_revision: str | Sequence[str] | None = "2d46fef3dab4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FIGURES = (
    "net_worth",
    "total_have",
    "total_owe",
    "bank_cash",
    "deposits",
    "stocks",
    "funds",
    "crypto",
)


def upgrade() -> None:
    op.create_table(
        "net_worth_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        *(sa.Column(name, sa.Numeric(precision=16, scale=2), nullable=False) for name in FIGURES),
        sa.Column("estimated", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_net_worth_snapshots_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_net_worth_snapshots")),
        sa.UniqueConstraint("user_id", "date", name=op.f("uq_net_worth_snapshots_user_id")),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.execute(sa.text("SELECT 1 FROM net_worth_snapshots LIMIT 1")).first() is not None:
        raise RuntimeError("Net worth history exists; remove it before downgrading.")
    op.drop_table("net_worth_snapshots")
