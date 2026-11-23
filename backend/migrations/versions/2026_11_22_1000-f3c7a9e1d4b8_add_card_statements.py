"""add card statements, and a statement SMS's minimum due

`card_statements` holds each credit card statement: its date, total and minimum due, and due date,
read from an SMS or entered by hand. Every statement SMS already recorded is copied in (the latest
message for a card and date wins), so the card bills work as before. `sms_entries.minimum_due` is
the minimum a statement SMS gives, when it gives one.

Revision ID: f3c7a9e1d4b8
Revises: e8b4d1f6a2c7
Create Date: 2026-11-22 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f3c7a9e1d4b8"
down_revision: str | Sequence[str] | None = "e8b4d1f6a2c7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _stamp(name: str) -> sa.Column:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    op.add_column("sms_entries", sa.Column("minimum_due", sa.Numeric(14, 2), nullable=True))
    op.create_table(
        "card_statements",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("statement_date", sa.Date(), nullable=False),
        sa.Column("total_due", sa.Numeric(14, 2), nullable=False),
        sa.Column("minimum_due", sa.Numeric(14, 2), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("source", sa.String(10), nullable=False),
        _stamp("created_at"),
        _stamp("updated_at"),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_card_statements_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_card_statements_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_card_statements")),
        sa.UniqueConstraint(
            "account_id", "statement_date", name=op.f("uq_card_statements_account_id")
        ),
    )
    op.create_index(op.f("ix_card_statements_user_id"), "card_statements", ["user_id"])
    op.create_index(op.f("ix_card_statements_account_id"), "card_statements", ["account_id"])
    # The statements already recorded from SMS: the latest message for a card and date.
    op.execute(
        """
        INSERT INTO card_statements
            (user_id, account_id, statement_date, total_due, due_date, source)
        SELECT e.user_id, e.account_id, e.occurred_on, e.amount, e.due_date, 'sms'
        FROM sms_entries e
        WHERE e.kind = 'card_statement'
          AND e.status = 'recorded'
          AND e.account_id IS NOT NULL
          AND e.amount IS NOT NULL
          AND e.due_date IS NOT NULL
          AND e.id = (
              SELECT max(f.id) FROM sms_entries f
              WHERE f.kind = 'card_statement'
                AND f.status = 'recorded'
                AND f.account_id = e.account_id
                AND f.occurred_on = e.occurred_on
                AND f.amount IS NOT NULL
                AND f.due_date IS NOT NULL
          )
        """
    )


def downgrade() -> None:
    # Refuse before touching anything: a statement entered by hand exists nowhere else.
    manual = op.get_bind().execute(
        sa.text("SELECT 1 FROM card_statements WHERE source = 'manual' LIMIT 1")
    )
    if manual.first() is not None:
        raise RuntimeError("Statements entered by hand exist; delete them before downgrading.")
    op.drop_index(op.f("ix_card_statements_account_id"), table_name="card_statements")
    op.drop_index(op.f("ix_card_statements_user_id"), table_name="card_statements")
    op.drop_table("card_statements")
    op.drop_column("sms_entries", "minimum_due")
