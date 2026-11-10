"""add recurring templates, skips, insurance policies and policy periods

Adds `recurring_templates`, `recurring_skips`, `insurance_policies` and `policy_periods`, and a
nullable `transactions.recurring_template_id`. Downgrading refuses to run while any of the four
new tables has a row, then drops them and the column.

Revision ID: 8e4c1b7a2d95
Revises: 5d7e3a90c1f2
Create Date: 2026-11-10 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8e4c1b7a2d95"
down_revision: str | Sequence[str] | None = "5d7e3a90c1f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_TABLES = ("policy_periods", "insurance_policies", "recurring_skips", "recurring_templates")


def upgrade() -> None:
    op.create_table(
        "recurring_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("to_account_id", sa.Integer(), nullable=True),
        sa.Column("category", sa.String(length=40), nullable=True),
        sa.Column("note", sa.String(length=200), nullable=True),
        sa.Column("frequency", sa.String(length=10), nullable=False),
        sa.Column("day", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("remind_days", sa.Integer(), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["account_id"], ["accounts.id"], name=op.f("fk_recurring_templates_account_id_accounts")
        ),
        sa.ForeignKeyConstraint(
            ["to_account_id"],
            ["accounts.id"],
            name=op.f("fk_recurring_templates_to_account_id_accounts"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_recurring_templates_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurring_templates")),
    )
    op.create_index(
        op.f("ix_recurring_templates_account_id"), "recurring_templates", ["account_id"]
    )
    op.create_index(op.f("ix_recurring_templates_user_id"), "recurring_templates", ["user_id"])

    op.create_table(
        "recurring_skips",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("template_id", sa.Integer(), nullable=False),
        sa.Column("occurrence", sa.Date(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["template_id"],
            ["recurring_templates.id"],
            name=op.f("fk_recurring_skips_template_id_recurring_templates"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_recurring_skips_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurring_skips")),
        sa.UniqueConstraint(
            "template_id", "occurrence", name=op.f("uq_recurring_skips_template_id")
        ),
    )
    op.create_index(op.f("ix_recurring_skips_template_id"), "recurring_skips", ["template_id"])

    op.create_table(
        "insurance_policies",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("insurer", sa.String(length=60), nullable=False),
        sa.Column("plan", sa.String(length=100), nullable=False),
        sa.Column("policy_number", sa.String(length=40), nullable=False),
        sa.Column("insured", sa.String(length=100), nullable=False),
        sa.Column("sum_insured", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("premium", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("template_id", sa.Integer(), nullable=False),
        sa.Column("funded_by_id", sa.Integer(), nullable=True),
        sa.Column("details", sa.String(length=2000), nullable=True),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["funded_by_id"],
            ["accounts.id"],
            name=op.f("fk_insurance_policies_funded_by_id_accounts"),
        ),
        sa.ForeignKeyConstraint(
            ["template_id"],
            ["recurring_templates.id"],
            name=op.f("fk_insurance_policies_template_id_recurring_templates"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_insurance_policies_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_insurance_policies")),
        sa.UniqueConstraint("template_id", name=op.f("uq_insurance_policies_template_id")),
    )
    op.create_index(op.f("ix_insurance_policies_user_id"), "insurance_policies", ["user_id"])

    op.create_table(
        "policy_periods",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("policy_id", sa.Integer(), nullable=False),
        sa.Column("period_start", sa.Date(), nullable=False),
        sa.Column("period_end", sa.Date(), nullable=False),
        sa.Column("premium", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("sum_insured", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("paid_on", sa.Date(), nullable=False),
        sa.Column("transaction_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["policy_id"],
            ["insurance_policies.id"],
            name=op.f("fk_policy_periods_policy_id_insurance_policies"),
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            name=op.f("fk_policy_periods_transaction_id_transactions"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_policy_periods_user_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_policy_periods")),
        sa.UniqueConstraint("transaction_id", name=op.f("uq_policy_periods_transaction_id")),
    )
    op.create_index(op.f("ix_policy_periods_policy_id"), "policy_periods", ["policy_id"])

    op.add_column("transactions", sa.Column("recurring_template_id", sa.Integer(), nullable=True))
    op.create_index(
        op.f("ix_transactions_recurring_template_id"), "transactions", ["recurring_template_id"]
    )
    op.create_foreign_key(
        op.f("fk_transactions_recurring_template_id_recurring_templates"),
        "transactions",
        "recurring_templates",
        ["recurring_template_id"],
        ["id"],
    )


def downgrade() -> None:
    # Refuse before touching anything: the old schema has nowhere to keep these rows.
    bind = op.get_bind()
    for table in NEW_TABLES:
        if bind.execute(sa.text(f"SELECT 1 FROM {table} LIMIT 1")).first() is not None:
            raise RuntimeError("Recurring or insurance data exists; remove it before downgrading.")

    op.drop_constraint(
        op.f("fk_transactions_recurring_template_id_recurring_templates"),
        "transactions",
        type_="foreignkey",
    )
    op.drop_index(op.f("ix_transactions_recurring_template_id"), table_name="transactions")
    op.drop_column("transactions", "recurring_template_id")

    op.drop_index(op.f("ix_policy_periods_policy_id"), table_name="policy_periods")
    op.drop_table("policy_periods")
    op.drop_index(op.f("ix_insurance_policies_user_id"), table_name="insurance_policies")
    op.drop_table("insurance_policies")
    op.drop_index(op.f("ix_recurring_skips_template_id"), table_name="recurring_skips")
    op.drop_table("recurring_skips")
    op.drop_index(op.f("ix_recurring_templates_user_id"), table_name="recurring_templates")
    op.drop_index(op.f("ix_recurring_templates_account_id"), table_name="recurring_templates")
    op.drop_table("recurring_templates")
