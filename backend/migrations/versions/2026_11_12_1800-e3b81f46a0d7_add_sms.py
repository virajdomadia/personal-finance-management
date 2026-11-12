"""add sms entries, payee rules, account identifiers and samples

Adds the SMS tables plus `transactions.source` (existing rows become "manual") and
`investment_trades.estimated` (existing rows become false). Downgrading drops them all; the SMS
history is discarded, and transactions and trades made from SMS stay as ordinary rows.

Revision ID: e3b81f46a0d7
Revises: c7e2a95d1b48
Create Date: 2026-11-12 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e3b81f46a0d7"
down_revision: str | Sequence[str] | None = "c7e2a95d1b48"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sms_samples",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("sender", sa.String(length=20), nullable=False),
        sa.Column("text", sa.String(length=500), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_sms_samples_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sms_samples")),
    )
    op.create_table(
        "account_identifiers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("last4", sa.String(length=4), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_account_identifiers_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_account_identifiers_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_account_identifiers")),
        sa.UniqueConstraint("account_id", "last4", name=op.f("uq_account_identifiers_account_id")),
    )
    op.create_index(
        op.f("ix_account_identifiers_account_id"),
        "account_identifiers",
        ["account_id"],
        unique=False,
    )
    op.create_table(
        "payee_rules",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("payee_key", sa.String(length=120), nullable=False),
        sa.Column("display", sa.String(length=120), nullable=False),
        sa.Column("category", sa.String(length=40), nullable=True),
        sa.Column("to_account_id", sa.Integer(), nullable=True),
        sa.Column("template_id", sa.Integer(), nullable=True),
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
            ["template_id"],
            ["recurring_templates.id"],
            name=op.f("fk_payee_rules_template_id_recurring_templates"),
        ),
        sa.ForeignKeyConstraint(
            ["to_account_id"], ["accounts.id"], name=op.f("fk_payee_rules_to_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_payee_rules_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payee_rules")),
        sa.UniqueConstraint("user_id", "payee_key", name=op.f("uq_payee_rules_user_id")),
    )
    op.create_table(
        "sms_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("hash", sa.String(length=64), nullable=False),
        sa.Column("sender", sa.String(length=20), nullable=False),
        sa.Column("bank", sa.String(length=30), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("last4", sa.String(length=4), nullable=True),
        sa.Column("payee", sa.String(length=120), nullable=True),
        sa.Column("payee_key", sa.String(length=120), nullable=True),
        sa.Column("ref", sa.String(length=40), nullable=True),
        sa.Column("balance", sa.Numeric(precision=14, scale=2), nullable=True),
        sa.Column("isin", sa.String(length=12), nullable=True),
        sa.Column("quantity", sa.Numeric(precision=24, scale=8), nullable=True),
        sa.Column("due_date", sa.Date(), nullable=True),
        sa.Column("account_id", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("reason", sa.String(length=20), nullable=True),
        sa.Column("message", sa.String(length=200), nullable=True),
        sa.Column("candidates", sa.JSON(), nullable=True),
        sa.Column("transaction_id", sa.Integer(), nullable=True),
        sa.Column("trade_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_sms_entries_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["trade_id"],
            ["investment_trades.id"],
            name=op.f("fk_sms_entries_trade_id_investment_trades"),
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            name=op.f("fk_sms_entries_transaction_id_transactions"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_sms_entries_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sms_entries")),
        sa.UniqueConstraint("user_id", "hash", name=op.f("uq_sms_entries_user_id")),
    )
    op.create_index(
        op.f("ix_sms_entries_transaction_id"), "sms_entries", ["transaction_id"], unique=False
    )
    op.create_index(op.f("ix_sms_entries_user_id"), "sms_entries", ["user_id"], unique=False)
    op.create_index(op.f("ix_sms_entries_trade_id"), "sms_entries", ["trade_id"], unique=False)
    op.create_index("ix_sms_entries_user_id_ref", "sms_entries", ["user_id", "ref"], unique=False)
    op.create_index(
        "ix_sms_entries_user_id_status", "sms_entries", ["user_id", "status"], unique=False
    )
    op.add_column(
        "investment_trades",
        sa.Column("estimated", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "transactions",
        sa.Column("source", sa.String(length=10), server_default="manual", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("transactions", "source")
    op.drop_column("investment_trades", "estimated")
    op.drop_index("ix_sms_entries_user_id_status", table_name="sms_entries")
    op.drop_index("ix_sms_entries_user_id_ref", table_name="sms_entries")
    op.drop_index(op.f("ix_sms_entries_trade_id"), table_name="sms_entries")
    op.drop_index(op.f("ix_sms_entries_user_id"), table_name="sms_entries")
    op.drop_index(op.f("ix_sms_entries_transaction_id"), table_name="sms_entries")
    op.drop_table("sms_entries")
    op.drop_table("payee_rules")
    op.drop_index(op.f("ix_account_identifiers_account_id"), table_name="account_identifiers")
    op.drop_table("account_identifiers")
    op.drop_table("sms_samples")
