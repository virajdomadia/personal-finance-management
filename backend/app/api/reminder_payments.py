"""The payments that settle each reminder: the ones recorded through it, plus matching payments
recorded some other way (`app.api.recurring.settle_unlinked`). Every place that works out what a
reminder still asks for loads them here, so the reminders list, the next 30 days, safe to spend
and SMS matching all agree."""

from collections import defaultdict
from datetime import date
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.recurring import Money, TemplateRow, settle_unlinked
from app.models.insurance import InsurancePolicy
from app.models.recurring import RecurringSkip, RecurringTemplate
from app.models.sms import SmsEntry
from app.models.transaction import Transaction


class ReminderPayments(NamedTuple):
    paid: dict[int, list[date]]  # linked and matched payment dates, per reminder
    linked: dict[int, list[date]]  # only the payments recorded through the reminder
    skips: dict[int, set[date]]


def _row(t: RecurringTemplate) -> TemplateRow:
    return TemplateRow(
        t.id, t.frequency, t.day, t.month, t.start_date, t.end_date, t.remind_days, t.active
    )


def _money(row: RecurringTemplate | Transaction) -> Money:
    return Money(row.type, row.account_id, row.to_account_id, row.amount, row.category)


def load_reminder_payments(db: Session, user_id: int) -> ReminderPayments:
    linked: dict[int, list[date]] = defaultdict(list)
    for template_id, day in db.execute(
        select(Transaction.recurring_template_id, Transaction.date).where(
            Transaction.user_id == user_id, Transaction.recurring_template_id.is_not(None)
        )
    ):
        linked[template_id].append(day)
    skips: dict[int, set[date]] = defaultdict(set)
    for template_id, occurrence in db.execute(
        select(RecurringSkip.template_id, RecurringSkip.occurrence).where(
            RecurringSkip.user_id == user_id
        )
    ):
        skips[template_id].add(occurrence)

    # A policy's reminder moves only through renewing the policy, so it never takes a match.
    policies = select(InsurancePolicy.template_id).where(
        InsurancePolicy.user_id == user_id, InsurancePolicy.template_id.is_not(None)
    )
    templates = list(
        db.scalars(
            select(RecurringTemplate)
            .where(
                RecurringTemplate.user_id == user_id,
                RecurringTemplate.active.is_(True),
                RecurringTemplate.id.not_in(policies),
            )
            .order_by(RecurringTemplate.id)
        )
    )
    paid: dict[int, list[date]] = defaultdict(list, {k: list(v) for k, v in linked.items()})
    # A bank message still waiting in review is the owner's to place: the review asks whether
    # it pays a reminder, so it doesn't settle one on its own first.
    in_review = select(SmsEntry.transaction_id).where(
        SmsEntry.user_id == user_id,
        SmsEntry.status.in_(("review", "draft")),
        SmsEntry.transaction_id.is_not(None),
    )
    if templates:
        unlinked = db.scalars(
            select(Transaction).where(
                Transaction.user_id == user_id,
                Transaction.recurring_template_id.is_(None),
                Transaction.id.not_in(in_review),
                Transaction.account_id.in_({t.account_id for t in templates}),
                Transaction.amount.in_({t.amount for t in templates}),
                Transaction.date >= min(t.start_date for t in templates),
            )
        )
        settled = settle_unlinked(
            [(_row(t), _money(t)) for t in templates],
            linked,
            skips,
            [(tx.date, _money(tx)) for tx in unlinked],
        )
        paid.update(settled)
    return ReminderPayments(paid, linked, skips)
