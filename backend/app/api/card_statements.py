"""Where a credit card's bill stands: its latest statement, and what was paid toward it since.

Shared by the statements screen, the dashboard's card bill and the next 30 days, so they agree.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Literal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models.card_statement import CardStatement
from app.models.sms import SmsEntry
from app.models.transaction import Transaction

ZERO = Decimal("0.00")
Status = Literal["paid", "minimum_paid", "part_paid", "unpaid"]


@dataclass(frozen=True)
class Standing:
    statement: CardStatement
    paid: Decimal  # paid or credited to the card since the statement
    left: Decimal  # of the total, never below 0
    extra: Decimal  # paid beyond the total; it counts toward the next bill
    minimum_left: Decimal | None  # of the minimum, never below 0; None without a minimum
    status: Status
    overdue: bool  # something is still owed and the due date has passed


def latest_statement(db: Session, user_id: int, card_id: int) -> CardStatement | None:
    return db.scalar(
        select(CardStatement)
        .where(CardStatement.user_id == user_id, CardStatement.account_id == card_id)
        .order_by(CardStatement.statement_date.desc(), CardStatement.id.desc())
        .limit(1)
    )


def paid_since(db: Session, user_id: int, card_id: int, since: date) -> Decimal:
    """Payments into the card, and refunds or other credits to it, dated on or after `since`.
    A payment the day the statement arrives pays it: made before, the statement would have asked
    less."""
    total = db.scalar(
        select(func.coalesce(func.sum(Transaction.amount), 0)).where(
            Transaction.user_id == user_id,
            or_(
                and_(Transaction.type == "transfer", Transaction.to_account_id == card_id),
                and_(
                    Transaction.type.in_(("income", "refund")),
                    Transaction.account_id == card_id,
                ),
            ),
            Transaction.date >= since,
        )
    )
    return Decimal(total or 0)


def standing(db: Session, user_id: int, statement: CardStatement, today: date) -> Standing:
    paid = paid_since(db, user_id, statement.account_id, statement.statement_date)
    total, minimum = statement.total_due, statement.minimum_due
    left = max(total - paid, ZERO)
    minimum_left = None if minimum is None else max(minimum - paid, ZERO)
    status: Status
    if left == 0:
        status = "paid"
    elif minimum is not None and paid >= minimum:
        status = "minimum_paid"
    elif paid > 0:
        status = "part_paid"
    else:
        status = "unpaid"
    return Standing(
        statement,
        paid,
        left,
        max(paid - total, ZERO),
        minimum_left,
        status,
        left > 0 and today > statement.due_date,
    )


def unbilled(db: Session, user_id: int, card_id: int, after: date | None) -> Decimal:
    """Charged to the card after its latest statement (`after`), so on the next bill: spending,
    EMIs and transfers out of the card. Everything, when there is no statement yet."""
    query = select(func.coalesce(func.sum(Transaction.amount), 0)).where(
        Transaction.user_id == user_id,
        Transaction.account_id == card_id,
        Transaction.type.in_(("expense", "emi", "transfer")),
    )
    if after is not None:
        query = query.where(Transaction.date > after)
    return Decimal(db.scalar(query) or 0)


def record_from_sms(db: Session, user_id: int, entry: SmsEntry) -> None:
    """A statement SMS fills in that card's statement for its date, or updates the one it filled
    before. One the owner entered or corrected is left as it is."""
    if entry.account_id is None or entry.amount is None or entry.due_date is None:
        return
    # A minimum read as more than the total is a misread, so it's left out.
    minimum = entry.minimum_due
    if minimum is not None and minimum > entry.amount:
        minimum = None
    existing = db.scalar(
        select(CardStatement).where(
            CardStatement.user_id == user_id,
            CardStatement.account_id == entry.account_id,
            CardStatement.statement_date == entry.occurred_on,
        )
    )
    if existing is None:
        db.add(
            CardStatement(
                user_id=user_id,
                account_id=entry.account_id,
                statement_date=entry.occurred_on,
                total_due=entry.amount,
                minimum_due=minimum,
                due_date=entry.due_date,
                source="sms",
            )
        )
    elif existing.source == "sms":
        existing.total_due = entry.amount
        existing.minimum_due = minimum
        existing.due_date = entry.due_date
