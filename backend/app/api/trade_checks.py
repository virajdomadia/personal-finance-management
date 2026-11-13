"""Checks shared by every kind of investment trade (stock trades and fund transactions).

Every save (create, edit, delete) replays the user's trades of that kind with the change applied,
and is refused if any sell would then sell more than was held on its date.
"""

from collections.abc import Callable
from datetime import date
from typing import NamedTuple

from fastapi import HTTPException, status
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.balances import Movement, load_movements
from app.api.portfolio import TradeRow, load_kinds, load_trade_rows, replay, trade_cash
from app.api.routes.accounts import MAX_ID, field_error
from app.api.routes.transactions import balance_problem, lock_accounts
from app.models.account import Account
from app.models.investment import Instrument, InvestmentTrade

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# A trade being created has no id yet. This one sorts after every real id on the same date.
NEW_ID = MAX_ID + 1


def create_with_first_trade[T](
    db: Session,
    check_trade_fields: Callable[[], None],
    add_instrument: Callable[[], Instrument],
    save_trade: Callable[[Instrument], T],
) -> tuple[Instrument, T]:
    """A new instrument and its first trade, committed together or not at all.

    The trade's own field rules are checked first, so that a form with a bad name and a missing
    price hears about both. `add_instrument` adds and flushes the instrument; `save_trade` runs
    the kind's save checks against it, adds the trade and commits. Any refusal rolls both back.
    """
    try:
        try:
            check_trade_fields()
            trade_errors: list = []
        except RequestValidationError as err:
            trade_errors = list(err.errors())
        try:
            instrument = add_instrument()
        except RequestValidationError as err:
            raise RequestValidationError([*err.errors(), *trade_errors]) from None
        if trade_errors:
            raise RequestValidationError(trade_errors)
        return instrument, save_trade(instrument)
    except Exception:
        db.rollback()
        raise


class ShortMessages(NamedTuple):
    """How a kind of trade words a shortfall. `{symbol}` and `{day}` are filled in."""

    kind: str  # only shortfalls among instruments of this kind are checked
    field: str  # where the saved trade's own shortfall is reported
    own: str  # the trade being saved sells more than was held (422 on `field`)
    other: str  # the change leaves another, later sell short (409)


def day_text(d: date) -> str:
    """Like "12 Jan 2026"."""
    return f"{d.day} {_MONTHS[d.month - 1]} {d.year}"


def get_owned_trade(db: Session, user_id: int, id: int, kind: str) -> InvestmentTrade:
    """The user's trade of this kind with this id. Another kind's isn't found, like a stranger's."""
    # Ids outside the column's range can't exist; asking the database would be a 500.
    trade = None
    if 1 <= id <= MAX_ID:
        trade = db.scalar(
            select(InvestmentTrade)
            .join(Instrument, Instrument.id == InvestmentTrade.instrument_id)
            .where(
                InvestmentTrade.id == id,
                InvestmentTrade.user_id == user_id,
                Instrument.kind == kind,
            )
        )
    if trade is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trade not found.")
    return trade


def lock_trade(
    db: Session, user_id: int, id: int, kind: str, other_ids: list[int] | None = None
) -> tuple[InvestmentTrade, dict[int, Account]]:
    """The trade, re-read after its account (and `other_ids`) are locked.

    Read before the lock, the trade could have been moved to another account meanwhile, and that
    account's balance would then be checked unlocked. If it moved, start over with the new one.
    """
    others = other_ids or []
    account_id = get_owned_trade(db, user_id, id, kind).account_id
    while True:
        accounts = lock_accounts(db, user_id, [account_id, *others])
        trade = db.scalar(
            select(InvestmentTrade)
            .where(InvestmentTrade.id == id, InvestmentTrade.user_id == user_id)
            .execution_options(populate_existing=True)
        )
        if trade is None:  # deleted meanwhile
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Trade not found.")
        if trade.account_id == account_id:
            return trade, accounts
        account_id = trade.account_id
        db.rollback()  # nothing is written yet; this only lets go of the locks taken above


def require_active(accounts: dict[int, Account], ids: list[int | None]) -> None:
    for account_id in ids:
        account = None if account_id is None else accounts.get(account_id)
        if account is not None and account.archived_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"Restore {account.name} before changing this trade."
            )


def shortfall_check(
    db: Session,
    user_id: int,
    rows: list[TradeRow],
    saving_id: int | None,
    messages: ShortMessages,
) -> None:
    """Refuse the change if, with it applied (`rows`), any sell of this kind sells more than held.

    Other kinds are left out: this change can't have made them short, and their shortfall would
    be worded for the wrong kind.
    """
    kinds = load_kinds(db, user_id)
    short = replay(r for r in rows if kinds.get(r.instrument_id) == messages.kind).shortfall
    if short is None:
        return
    symbol = db.scalar(select(Instrument.symbol).where(Instrument.id == short.instrument_id))
    words = {"symbol": symbol, "day": day_text(short.date)}
    if short.id == saving_id:
        raise RequestValidationError([field_error(messages.field, messages.own.format(**words))])
    raise HTTPException(status.HTTP_409_CONFLICT, messages.other.format(**words))


def check_cash_and_holdings(
    db: Session,
    user_id: int,
    accounts: dict[int, Account],
    row: TradeRow,
    existing_id: int | None,
    money_field: str,
    short_messages: ShortMessages,
) -> None:
    """The balance check (reported on `money_field`), then the shortfall check, for a save of
    `row`, which replaces the trade `existing_id` (None for a create)."""
    before = load_movements(db, user_id)
    after = [m for m in before if existing_id is None or m.id != -existing_id]
    if not row.opening:
        after.append(Movement(-row.id, row.side, abs(trade_cash(row)), row.account_id, None))
    problem = balance_problem(accounts, before, after)
    if problem:
        raise RequestValidationError([field_error(money_field, problem)])

    rows = [r for r in load_trade_rows(db, user_id) if r.id != existing_id]
    shortfall_check(db, user_id, [*rows, row], row.id, short_messages)


def check_delete(
    db: Session,
    user_id: int,
    accounts: dict[int, Account],
    trade: InvestmentTrade,
    short_messages: ShortMessages,
) -> None:
    """Whether `trade` (locked, with `accounts`) can be deleted: its account must be active, no
    later sell may be left short, and the account's balance must stay allowed."""
    require_active(accounts, [trade.account_id])
    rows = [r for r in load_trade_rows(db, user_id) if r.id != trade.id]
    shortfall_check(db, user_id, rows, None, short_messages)
    before = load_movements(db, user_id)
    problem = balance_problem(accounts, before, [m for m in before if m.id != -trade.id])
    if problem:
        raise HTTPException(status.HTTP_409_CONFLICT, problem)
