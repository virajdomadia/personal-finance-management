"""add family members: users gain owner_id and name

A family member is a user with no login whose `owner_id` is the signed-in user who manages
them. Downgrading refuses to run while any member exists, since the old schema can't tell
them apart from real users, then drops the columns.

Revision ID: b7d2e4f6a813
Revises: a1c3e5f7b902
Create Date: 2026-11-16 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7d2e4f6a813"
down_revision: str | Sequence[str] | None = "a1c3e5f7b902"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("owner_id", sa.Integer(), nullable=True))
    op.add_column("users", sa.Column("name", sa.String(40), nullable=True))
    op.create_foreign_key(op.f("fk_users_owner_id_users"), "users", "users", ["owner_id"], ["id"])
    op.create_index(op.f("ix_users_owner_id"), "users", ["owner_id"], unique=False)


def downgrade() -> None:
    found = op.get_bind().execute(sa.text("SELECT 1 FROM users WHERE owner_id IS NOT NULL LIMIT 1"))
    if found.first() is not None:
        raise RuntimeError("Family members exist; remove them before downgrading.")
    op.drop_index(op.f("ix_users_owner_id"), table_name="users")
    op.drop_constraint(op.f("fk_users_owner_id_users"), "users", type_="foreignkey")
    op.drop_column("users", "name")
    op.drop_column("users", "owner_id")
