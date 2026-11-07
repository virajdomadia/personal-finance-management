"""An account's balance is its opening balance plus the money its transactions moved.

Summed in Python with Decimal rather than SQL SUM, because the test database (SQLite) stores
numerics as floats.
"""

from collections.abc import Iterable
from decimal import Decimal
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.transaction import Transaction


class Movement(NamedTuple):
    id: int
    type: str
    amount: Decimal
    account_id: int
    to_account_id: int | None


def load_movements(db: Session, user_id: int) -> list[Movement]:
    rows = db.execute(
        select(
            Transaction.id,
            Transaction.type,
            Transaction.amount,
            Transaction.account_id,
            Transaction.to_account_id,
        ).where(Transaction.user_id == user_id)
    )
    return [Movement(*row) for row in rows]


def net_flows(movements: Iterable[Movement]) -> dict[int, Decimal]:
    """Money into each account minus money out of it, by account id."""
    flows: dict[int, Decimal] = {}

    def add(account_id: int, amount: Decimal) -> None:
        flows[account_id] = flows.get(account_id, Decimal(0)) + amount

    for movement in movements:
        if movement.type == "income":
            add(movement.account_id, movement.amount)
        else:
            add(movement.account_id, -movement.amount)
        if movement.to_account_id is not None:
            add(movement.to_account_id, movement.amount)
    return flows


def load_flows(db: Session, user_id: int) -> dict[int, Decimal]:
    return net_flows(load_movements(db, user_id))


def balance_of(account: Account, flows: dict[int, Decimal]) -> Decimal:
    # A card's balance is what's owed, so money coming into the card lowers it.
    flow = flows.get(account.id, Decimal(0))
    opening = account.opening_balance
    return opening - flow if account.type == "credit_card" else opening + flow


def opening_for(account: Account, balance: Decimal, flows: dict[int, Decimal]) -> Decimal:
    """The opening balance that makes `account` show `balance`, with its transactions unchanged."""
    flow = flows.get(account.id, Decimal(0))
    return balance + flow if account.type == "credit_card" else balance - flow
