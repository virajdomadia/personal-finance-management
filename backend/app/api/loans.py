"""A loan's figures beyond its own balance: the EMIs recorded, and loans paid from a card.

An EMI is one `emi` transaction: its account pays the whole amount, the loan (`to_account_id`) is
repaid the amount minus `interest`, and only the interest counts as spending.
"""

from collections.abc import Iterable
from decimal import ROUND_HALF_UP, Decimal
from typing import NamedTuple

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.balances import balance_of, load_flows
from app.models.account import Account
from app.models.transaction import Transaction

PAISE = Decimal("0.01")


class NextEmi(BaseModel):
    amount: str
    # Null when there's no rate and no EMI count to work the split out from.
    interest: str | None
    principal: str | None


class Book(NamedTuple):
    """Everything an account's response needs that isn't on its own row."""

    flows: dict[int, Decimal]
    emis_recorded: dict[int, int]  # by loan id
    linked_owed: dict[int, Decimal]  # what active loans paid from each account still owe


def _round(value: Decimal) -> Decimal:
    return value.quantize(PAISE, rounding=ROUND_HALF_UP)


def emis_recorded(db: Session, user_id: int) -> dict[int, int]:
    rows = db.execute(
        select(Transaction.to_account_id, func.count())
        .where(Transaction.user_id == user_id, Transaction.type == "emi")
        .group_by(Transaction.to_account_id)
    )
    return {loan_id: count for loan_id, count in rows if loan_id is not None}


def linked_owed(accounts: Iterable[Account], flows: dict[int, Decimal]) -> dict[int, Decimal]:
    owed: dict[int, Decimal] = {}
    for a in accounts:
        if a.type == "loan" and a.archived_at is None and a.pay_from_id is not None:
            owed[a.pay_from_id] = owed.get(a.pay_from_id, Decimal(0)) + balance_of(a, flows)
    return owed


def load_book(db: Session, user_id: int, accounts: Iterable[Account] | None = None) -> Book:
    if accounts is None:
        accounts = db.scalars(select(Account).where(Account.user_id == user_id)).all()
    flows = load_flows(db, user_id)
    return Book(flows, emis_recorded(db, user_id), linked_owed(accounts, flows))


def emis_left(account: Account, book: Book) -> int | None:
    if account.emis_at_opening is None:
        return None
    return max(account.emis_at_opening - book.emis_recorded.get(account.id, 0), 0)


def emis_at_opening(left: int | None, account: Account, book: Book) -> int | None:
    """The stored count that makes `account` show `left` EMIs, given the EMIs already recorded."""
    return None if left is None else left + book.emis_recorded.get(account.id, 0)


def next_emi(account: Account, book: Book) -> NextEmi | None:
    emi = account.emi_amount
    owed = balance_of(account, book.flows)
    if account.type != "loan" or emi is None or owed <= 0:
        return None

    left = emis_left(account, book)
    interest: Decimal | None = None
    if account.interest_rate is not None:
        interest = _round(owed * account.interest_rate / 1200)
    elif left:
        # Without a rate, what's still to be paid beyond the principal, spread over the EMIs left.
        interest = max(_round((left * emi - owed) / left), Decimal(0))

    if interest is None:
        return NextEmi(amount=f"{emi:.2f}", interest=None, principal=None)
    amount = min(emi, owed + interest)  # the final EMI clears what's left
    interest = min(interest, amount)  # an EMI too small to cover the interest repays nothing
    return NextEmi(
        amount=f"{amount:.2f}", interest=f"{interest:.2f}", principal=f"{amount - interest:.2f}"
    )
