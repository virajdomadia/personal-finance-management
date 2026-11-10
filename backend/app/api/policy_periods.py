"""A policy period and the payment that paid it.

A period with a transaction reads its premium and paid date from that transaction, so editing the
payment keeps the period in step; the period's own columns are only a snapshot. Deleting the payment
of the latest period undoes that renewal. Kept apart from the routes so that both the transaction
and the policy routes can use it.
"""

from collections.abc import Iterable
from datetime import date
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.insurance import InsurancePolicy, PolicyPeriod
from app.models.recurring import RecurringTemplate
from app.models.transaction import Transaction

KEPT = "This payment renewed an insurance policy, so it stays."
LINKED = "This payment belongs to a policy period."


def payments(
    db: Session, user_id: int, periods: Iterable[PolicyPeriod]
) -> dict[int, tuple[Decimal, date]]:
    """Each period's (premium, paid on), by period id, from its transaction when it has one."""
    rows = list(periods)
    linked = [p.transaction_id for p in rows if p.transaction_id is not None]
    paid: dict[int, tuple[Decimal, date]] = {}
    if linked:
        paid = {
            id_: (amount, day)
            for id_, amount, day in db.execute(
                select(Transaction.id, Transaction.amount, Transaction.date).where(
                    Transaction.user_id == user_id, Transaction.id.in_(linked)
                )
            )
        }
    return {p.id: paid.get(p.transaction_id or 0, (p.premium, p.paid_on)) for p in rows}


def period_of(db: Session, transaction_id: int) -> PolicyPeriod | None:
    return db.scalar(select(PolicyPeriod).where(PolicyPeriod.transaction_id == transaction_id))


def undo_renewal(db: Session, user_id: int, tx: Transaction) -> None:
    """Before `tx` is deleted: if it paid the policy's latest period, step the policy back one.

    The period row goes, and the policy and its reminder return to the previous period. A payment
    of an earlier period, or of the only one, can't be deleted (409).
    """
    period = period_of(db, tx.id)
    if period is None:
        return
    policy = db.scalar(
        select(InsurancePolicy)
        .where(InsurancePolicy.id == period.policy_id, InsurancePolicy.user_id == user_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    template = None
    if policy is not None:
        template = db.scalar(
            select(RecurringTemplate)
            .where(RecurringTemplate.id == policy.template_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    periods = list(
        db.scalars(
            select(PolicyPeriod)
            .where(PolicyPeriod.policy_id == period.policy_id)
            .order_by(PolicyPeriod.period_start, PolicyPeriod.id)
        )
    )
    if policy is None or template is None or len(periods) < 2 or periods[-1].id != period.id:
        raise HTTPException(status.HTTP_409_CONFLICT, KEPT)
    previous = periods[-2]
    premium, _ = payments(db, user_id, [previous])[previous.id]
    policy.period_start = previous.period_start
    policy.period_end = previous.period_end
    policy.premium = premium
    policy.sum_insured = previous.sum_insured
    # The reminder keeps its account; its renewal date and amount go back.
    template.amount = premium
    template.day = previous.period_end.day
    template.month = previous.period_end.month
    template.start_date = previous.period_end
    db.delete(period)
    db.flush()
