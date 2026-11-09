"""Mutual fund purchases and redemptions. Each moves its bank account's cash by its `amount`
(see `balances.load_movements`), except existing units (`opening`), which move none.

A purchase or redemption that isn't existing units also records its NAV as that day's price,
linked to the trade (`sync_trade_nav`), unless the fund already has a NAV on that date.
"""

from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import TradeRow, fmt_nav, fmt_units, load_trade_rows, replay
from app.api.routes.accounts import MAX_ID, MAX_MONEY, Flag, Money, field_error, fmt
from app.api.routes.dashboard import today_india
from app.api.routes.funds import (
    MAX_NAV,
    MUTUAL_FUND,
    NAV_RULE,
    UNITS_RULE,
    Nav,
    Units,
    get_owned_fund,
)
from app.api.routes.transactions import Day, Note, lock_accounts
from app.api.trade_checks import (
    NEW_ID,
    ShortMessages,
    check_cash_and_holdings,
    check_delete,
    lock_trade,
    require_active,
)
from app.db.session import DbSession
from app.models.account import Account
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade, Sip

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

_CHOOSE_FUND = "Choose a fund."
_CHOOSE_BANK = "Choose a bank account."
_CHOOSE_SIDE = "Choose purchase or redemption."
_CHOOSE_SIP = "Choose a SIP for this fund."
# A purchase's units × NAV may differ this much from what was invested (amount − charges).
_MATCH_TOLERANCE = Decimal("1.00")
FUND_SHORT = ShortMessages(
    kind=MUTUAL_FUND,
    field="units",
    own="You'd be redeeming more {symbol} units than you held on {day}.",
    other="This would leave the redemption of {symbol} on {day} redeeming more than was held.",
)


def _id(message: str) -> Any:
    def check(value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise PydanticCustomError("ref", message)
        return value

    return check


def _side(value: Any) -> str | None:
    if value is not None and value not in ("buy", "sell"):
        raise PydanticCustomError("side", _CHOOSE_SIDE)
    return value


FundRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_FUND))]
BankRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_BANK))]
SipRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_SIP))]
Side = Annotated[str | None, BeforeValidator(_side)]


class FundTradeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    fund_id: FundRef = None
    account_id: BankRef = None
    side: Side = None
    date: Day = None
    units: Units = None
    nav: Nav = None  # required unless `opening`, and ignored when it is
    charges: Money = None
    amount: Money = None
    opening: Flag = False
    sip_id: SipRef = None
    note: Note = None


class FundTradeUpdate(BaseModel):
    """Create's fields, all optional, minus `side` and `opening`, which can't change."""

    model_config = ConfigDict(extra="forbid")

    fund_id: FundRef = None
    account_id: BankRef = None
    date: Day = None
    units: Units = None
    nav: Nav = None
    charges: Money = None
    amount: Money = None
    sip_id: SipRef = None
    note: Note = None


class FundTrade(BaseModel):
    id: int
    fund_id: int
    symbol: str
    account_id: int
    account_name: str
    side: str
    date: str
    units: str
    nav: str  # for existing units, the average purchase NAV
    charges: str
    amount: str  # what left the bank (purchase) or came into it (redemption)
    opening: bool
    sip_id: int | None
    note: str | None
    realised: str | None  # redemptions only


class FundTradeList(BaseModel):
    trades: list[FundTrade]


def sync_trade_nav(db: Session, trade: InvestmentTrade) -> None:
    """Keep the NAV a fund trade recorded in step with the trade (see the module docstring).

    If another NAV row exists for the trade's fund and date, the trade's own row goes. Otherwise
    it is created or updated with the trade's date and NAV. Existing units record no NAV.
    """
    if trade.opening:
        return
    linked = db.scalars(select(InstrumentPrice).where(InstrumentPrice.trade_id == trade.id)).all()
    other = db.scalar(
        select(InstrumentPrice.id)
        .where(
            InstrumentPrice.user_id == trade.user_id,
            InstrumentPrice.instrument_id == trade.instrument_id,
            InstrumentPrice.date == trade.date,
            (InstrumentPrice.trade_id.is_(None)) | (InstrumentPrice.trade_id != trade.id),
        )
        .limit(1)
    )
    if other is not None:
        for row in linked:
            db.delete(row)
        return
    if not linked:
        db.add(
            InstrumentPrice(
                user_id=trade.user_id,
                instrument_id=trade.instrument_id,
                date=trade.date,
                price=trade.price,
                trade_id=trade.id,
            )
        )
        return
    row, *extra = linked
    row.instrument_id, row.date, row.price = trade.instrument_id, trade.date, trade.price
    for duplicate in extra:
        db.delete(duplicate)


def _price(values: dict[str, Any]) -> Decimal:
    """The NAV stored: the one given, or for existing units the average, amount ÷ units."""
    if values["opening"]:
        return (values["amount"] / values["units"]).quantize(
            Decimal("0.0001"), rounding=ROUND_HALF_UP
        )
    return values["nav"]


def _columns(values: dict[str, Any], price: Decimal) -> dict[str, Any]:
    return {
        "instrument_id": values["fund_id"],
        "account_id": values["account_id"],
        "side": values["side"],
        "date": values["date"],
        "quantity": values["units"],
        "price": price,
        "charges": values["charges"],
        "amount": values["amount"],
        "opening": values["opening"],
        "sip_id": values["sip_id"],
        "note": values["note"],
    }


def _response(
    t: InvestmentTrade, fund: Instrument, account: Account, realised: dict[int, Decimal]
) -> FundTrade:
    gain = realised.get(t.id) if t.side == "sell" else None
    return FundTrade(
        id=t.id,
        fund_id=t.instrument_id,
        symbol=fund.symbol,
        account_id=t.account_id,
        account_name=account.name,
        side=t.side,
        date=t.date.isoformat(),
        units=fmt_units(t.quantity),
        nav=fmt_nav(t.price),
        charges=fmt(t.charges),
        amount=fmt(t.amount),
        opening=t.opening,
        sip_id=t.sip_id,
        note=t.note,
        realised=None if gain is None else fmt(gain),
    )


def _saved_response(db: Session, user_id: int, t: InvestmentTrade, account: Account) -> FundTrade:
    realised = replay(load_trade_rows(db, user_id)).realised_by_sell
    fund = db.get(Instrument, t.instrument_id)
    assert fund is not None
    return _response(t, fund, account, realised)


def _validate_fields(values: dict[str, Any]) -> None:
    errors = []
    if values["fund_id"] is None:
        errors.append(field_error("fund_id", _CHOOSE_FUND))
    if values["account_id"] is None:
        errors.append(field_error("account_id", _CHOOSE_BANK))
    if values["side"] is None:
        errors.append(field_error("side", _CHOOSE_SIDE))
    day = values["date"]
    if day is None:
        errors.append(field_error("date", "Choose a date."))
    elif day > today_india():
        errors.append(field_error("date", "The date can't be in the future."))
    if values["units"] is None:
        errors.append(field_error("units", UNITS_RULE))
    if values["nav"] is None and not values["opening"]:
        errors.append(field_error("nav", NAV_RULE))
    amount, charges = values["amount"], values["charges"]
    if amount is None:
        errors.append(field_error("amount", "Enter the amount."))
    elif amount <= 0:
        errors.append(field_error("amount", "Amount must be greater than 0."))
    if charges < 0:
        errors.append(field_error("charges", "Charges can't be negative."))
    elif amount is not None and amount > 0 and charges >= amount:
        errors.append(field_error("charges", "Charges can't be more than the amount."))
    if errors:
        raise RequestValidationError(errors)


def _fund_and_account(
    db: Session, user_id: int, values: dict[str, Any], accounts: dict[int, Account]
) -> tuple[Instrument, Account]:
    errors = []
    fund = None
    try:
        fund = get_owned_fund(db, user_id, values["fund_id"])
    except HTTPException:  # someone else's fund, or a stock, is reported like a missing one
        errors.append(field_error("fund_id", _CHOOSE_FUND))
    account = accounts.get(values["account_id"])
    if account is None or account.type != "bank":
        errors.append(field_error("account_id", _CHOOSE_BANK))
    elif account.archived_at is not None:
        errors.append(
            field_error("account_id", f"{account.name} is archived. Restore it to use it.")
        )
    if errors:
        raise RequestValidationError(errors)
    assert fund is not None and account is not None
    return fund, account


def _check_sip(db: Session, user_id: int, values: dict[str, Any]) -> None:
    sip_id = values["sip_id"]
    if sip_id is None:
        return
    found = None
    if values["side"] == "buy" and 1 <= sip_id <= MAX_ID:
        found = db.scalar(
            select(Sip.id).where(
                Sip.id == sip_id, Sip.user_id == user_id, Sip.instrument_id == values["fund_id"]
            )
        )
    if found is None:
        raise RequestValidationError([field_error("sip_id", _CHOOSE_SIP)])


def _check_amounts(values: dict[str, Any]) -> Decimal:
    """The units, NAV and amount fit together and can be stored. Returns the NAV to store."""
    units = values["units"]
    if values["opening"]:
        price = _price(values)
        if price == 0:
            message = "That's too little for that many units."
            raise RequestValidationError([field_error("amount", message)])
        if price >= MAX_NAV:
            raise RequestValidationError(
                [field_error("units", "That's too few units for that amount.")]
            )
        return price
    nav = values["nav"]
    worth = units * nav
    if worth >= MAX_MONEY:
        raise RequestValidationError([field_error("nav", "This transaction is too large.")])
    invested = values["amount"] - values["charges"]
    if values["side"] == "buy" and abs(worth - invested) > _MATCH_TOLERANCE:
        message = "Units × NAV doesn't match the amount. Check the units and NAV."
        raise RequestValidationError([field_error("units", message)])
    return nav


def _save_checks(
    db: Session,
    user_id: int,
    accounts: dict[int, Account],
    values: dict[str, Any],
    existing_id: int | None,
) -> tuple[Account, Decimal]:
    """Checks for a create or an edit, in order. `values` is the whole trade after the change.

    Returns the bank account and the NAV to store.
    """
    _validate_fields(values)
    fund, account = _fund_and_account(db, user_id, values, accounts)
    if values["side"] == "sell" and values["opening"]:
        message = "Only a purchase can be existing units."
        raise RequestValidationError([field_error("opening", message)])
    _check_sip(db, user_id, values)
    price = _check_amounts(values)
    row = TradeRow(
        existing_id or NEW_ID,
        fund.id,
        account.id,
        values["side"],
        values["date"],
        values["units"],
        price,
        values["charges"],
        values["opening"],
        values["amount"],
    )
    check_cash_and_holdings(db, user_id, accounts, row, existing_id, "amount", FUND_SHORT)
    return account, price


@router.get("/fund-trades")
def list_fund_trades(
    user: CurrentUser,
    db: DbSession,
    fund_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
    account_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
    sip_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
) -> FundTradeList:
    query = (
        select(InvestmentTrade)
        .join(Instrument, Instrument.id == InvestmentTrade.instrument_id)
        .where(InvestmentTrade.user_id == user.id, Instrument.kind == MUTUAL_FUND)
    )
    if fund_id is not None:
        query = query.where(InvestmentTrade.instrument_id == fund_id)
    if account_id is not None:
        query = query.where(InvestmentTrade.account_id == account_id)
    if sip_id is not None:
        query = query.where(InvestmentTrade.sip_id == sip_id)
    found = db.scalars(query.order_by(InvestmentTrade.date.desc(), InvestmentTrade.id.desc())).all()
    # Realised P&L depends on every earlier trade of the holding, so replay them all.
    realised = replay(load_trade_rows(db, user.id)).realised_by_sell
    funds = {
        f.id: f
        for f in db.scalars(
            select(Instrument).where(Instrument.user_id == user.id, Instrument.kind == MUTUAL_FUND)
        )
    }
    accounts = {a.id: a for a in db.scalars(select(Account).where(Account.user_id == user.id))}
    return FundTradeList(
        trades=[
            _response(t, funds[t.instrument_id], accounts[t.account_id], realised) for t in found
        ]
    )


def _defaults(values: dict[str, Any]) -> dict[str, Any]:
    if values.get("charges") is None:
        values["charges"] = Decimal(0)
    return values


@router.post("/fund-trades", status_code=status.HTTP_201_CREATED)
def create_fund_trade(body: FundTradeCreate, user: CurrentUser, db: DbSession) -> FundTrade:
    values = _defaults(body.model_dump())
    accounts = lock_accounts(db, user.id, [values["account_id"]])
    account, price = _save_checks(db, user.id, accounts, values, existing_id=None)
    trade = InvestmentTrade(user_id=user.id, **_columns(values, price))
    db.add(trade)
    db.flush()  # gives the trade its id, for its NAV row
    sync_trade_nav(db, trade)
    db.commit()
    return _saved_response(db, user.id, trade, account)


@router.patch("/fund-trades/{id}")
def update_fund_trade(
    id: int, body: FundTradeUpdate, user: CurrentUser, db: DbSession
) -> FundTrade:
    changes = body.model_dump(exclude_unset=True)
    # The old account is locked too, because moving a trade changes its cash as well.
    moved_to = [changes["account_id"]] if changes.get("account_id") is not None else []
    trade, accounts = lock_trade(db, user.id, id, MUTUAL_FUND, moved_to)
    if "charges" in changes:
        _defaults(changes)
    values: dict[str, Any] = {
        "fund_id": trade.instrument_id,
        "account_id": trade.account_id,
        "side": trade.side,
        "date": trade.date,
        "units": trade.quantity,
        "nav": trade.price,
        "charges": trade.charges,
        "amount": trade.amount,
        "opening": trade.opening,
        "sip_id": trade.sip_id,
        "note": trade.note,
        **changes,
    }
    require_active(accounts, [trade.account_id, values["account_id"]])
    account, price = _save_checks(db, user.id, accounts, values, existing_id=trade.id)
    for field, value in _columns(values, price).items():
        setattr(trade, field, value)
    db.flush()
    sync_trade_nav(db, trade)
    db.commit()
    return _saved_response(db, user.id, trade, account)


@router.delete("/fund-trades/{id}")
def delete_fund_trade(id: int, user: CurrentUser, db: DbSession) -> dict[str, int]:
    trade, accounts = lock_trade(db, user.id, id, MUTUAL_FUND)
    check_delete(db, user.id, accounts, trade, FUND_SHORT)
    # Its auto-recorded NAV goes with it; NAVs entered by hand stay.
    db.execute(delete(InstrumentPrice).where(InstrumentPrice.trade_id == trade.id))
    db.delete(trade)
    db.commit()
    return {"id": id}

