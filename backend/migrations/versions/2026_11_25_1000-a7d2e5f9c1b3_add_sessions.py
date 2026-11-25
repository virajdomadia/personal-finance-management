"""add sessions: one row per sign-in, so logout revokes that sign-in's token alone

A session token carries its `sessions.id`; logout deletes the row. Tokens issued before this
migration name no session and stay valid until they expire (30 days) or the owner signs out
everywhere, which bumps `users.session_version` as before.

Revision ID: a7d2e5f9c1b3
Revises: f3c7a9e1d4b8
Create Date: 2026-11-25 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7d2e5f9c1b3"
down_revision: str | Sequence[str] | None = "f3c7a9e1d4b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_sessions_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sessions")),
    )
    op.create_index(op.f("ix_sessions_user_id"), "sessions", ["user_id"])


def downgrade() -> None:
    # Session tokens stop working on the old code, which reads only the older token layout:
    # everyone signed in since this migration signs in again.
    op.drop_index(op.f("ix_sessions_user_id"), table_name="sessions")
    op.drop_table("sessions")
