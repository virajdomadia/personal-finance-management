"""SIPs: a standing monthly instruction that reminds the owner and never posts on its own.

What is due is worked out from the fund purchases recorded (`app.api.sips`); recording an
instalment is an ordinary fund purchase linked to the SIP.
"""

from collections import Counter
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import MAX_ID, Flag, Money, field_error, fmt
from app.api.routes.dashboard import today_india
from app.api.routes.funds import get_owned_fund
from app.api.routes.stocks import Deleted
from app.api.routes.transactions import Day, lock_accounts
from app.api.sips import load_due
from app.db.session import DbSession
from app.models.account import Account
from app.models.investment import Instrument, InvestmentTrade, Sip

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

_CHOOSE_FUND = "Choose a fund."
_CHOOSE_BANK = "Choose a bank account."
_NO_AMOUNT = "Enter the SIP amount."
_BAD_DAY = "Choose a day from 1 to 31."
_NO_START = "Choose the first instalment's date."


def _id(message: str) -> Any:
    def check(value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise PydanticCustomError("ref", message)
        return value

    return check


def _day(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 31:
        raise PydanticCustomError("day", _BAD_DAY)
    return value


FundRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_FUND))]
BankRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_BANK))]
DebitDay = Annotated[int | None, BeforeValidator(_day)]


class SipCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    fund_id: FundRef = None
    account_id: BankRef = None
    amount: Money = None
    day: DebitDay = None
    start_date: Day = None


class SipUpdate(BaseModel):
    """What can change. The fund and the start date can't."""

    model_config = ConfigDict(extra="forbid")

    account_id: BankRef = None
    amount: Money = None
    day: DebitDay = None
    active: Flag = True


class SipResponse(BaseModel):
    id: int
    fund_id: int
    symbol: str
    fund_name: str
    account_id: int
    account_name: str
    amount: str
    day: int
    start_date: str
    active: bool
    instalments: int
    due: list[str]
    due_date: str | None  # the first of `due`


class SipList(BaseModel):
    sips: list[SipResponse]


def _responses(db: Session, user_id: int, ids: list[int] | None = None) -> list[SipResponse]:
    """The user's SIPs (or just `ids`), by fund name then id."""
    query = (
        select(Sip, Instrument, Account)
        .join(Instrument, Instrument.id == Sip.instrument_id)
        .join(Account, Account.id == Sip.account_id)
        .where(Sip.user_id == user_id)
        .order_by(Instrument.name, Sip.id)
    )
    if ids is not None:
        query = query.where(Sip.id.in_(ids))
    rows = db.execute(query).all()
    counts = Counter(
        dict(
            db.execute(
                select(InvestmentTrade.sip_id, func.count())
                .where(InvestmentTrade.user_id == user_id, InvestmentTrade.sip_id.is_not(None))
                .group_by(InvestmentTrade.sip_id)
            ).all()
        )
    )
    due = load_due(db, user_id, today_india())
    return [
        SipResponse(
            id=s.id,
            fund_id=f.id,
            symbol=f.symbol,
            fund_name=f.name,
            account_id=a.id,
            account_name=a.name,
            amount=fmt(s.amount),
            day=s.day,
            start_date=s.start_date.isoformat(),
            active=s.active,
            instalments=counts[s.id],
            due=[d.isoformat() for d in due[s.id]],
            due_date=due[s.id][0].isoformat() if due[s.id] else None,
        )
        for s, f, a in rows
    ]


def due_sip_list(db: Session, user_id: int) -> list[SipResponse]:
    """The SIPs with something due, the one waiting longest first."""
    waiting = [s for s in _responses(db, user_id) if s.due_date is not None]
    return sorted(waiting, key=lambda s: (s.due_date or "", s.id))


def _owned_sip(db: Session, user_id: int, id: int) -> Sip:
    sip = None
    if 1 <= id <= MAX_ID:
        sip = db.scalar(select(Sip).where(Sip.id == id, Sip.user_id == user_id))
    if sip is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SIP not found.")
    return sip


def _check_amount(amount: Decimal | None, errors: list[Any]) -> None:
    if amount is None:
        errors.append(field_error("amount", _NO_AMOUNT))
    elif amount <= 0:
        errors.append(field_error("amount", "Amount must be greater than 0."))


def _check_bank(account: Account | None, errors: list[Any]) -> None:
    if account is None or account.type != "bank":
        errors.append(field_error("account_id", _CHOOSE_BANK))
    elif account.archived_at is not None:
        errors.append(
            field_error("account_id", f"{account.name} is archived. Restore it to use it.")
        )


@router.get("/sips")
def list_sips(
    user: CurrentUser,
    db: DbSession,
    fund_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
) -> SipList:
    sips = _responses(db, user.id)
    return SipList(sips=[s for s in sips if fund_id is None or s.fund_id == fund_id])


@router.post("/sips", status_code=status.HTTP_201_CREATED)
def create_sip(body: SipCreate, user: CurrentUser, db: DbSession) -> SipResponse:
    errors: list[Any] = []
    fund = None
    if body.fund_id is None:
        errors.append(field_error("fund_id", _CHOOSE_FUND))
    else:
        try:
            fund = get_owned_fund(db, user.id, body.fund_id)
        except HTTPException:  # someone else's fund, or a stock, is reported like a missing one
            errors.append(field_error("fund_id", _CHOOSE_FUND))
    accounts = lock_accounts(db, user.id, [body.account_id])
    if body.account_id is None:
        errors.append(field_error("account_id", _CHOOSE_BANK))
    else:
        _check_bank(accounts.get(body.account_id), errors)
    _check_amount(body.amount, errors)
    if body.day is None:
        errors.append(field_error("day", _BAD_DAY))
    if body.start_date is None:
        errors.append(field_error("start_date", _NO_START))
    if errors:
        raise RequestValidationError(errors)
    assert fund is not None and body.account_id is not None
    assert body.amount is not None and body.day is not None and body.start_date is not None
    sip = Sip(
        user_id=user.id,
        instrument_id=fund.id,
        account_id=body.account_id,
        amount=body.amount,
        day=body.day,
        start_date=body.start_date,
    )
    db.add(sip)
    db.commit()
    return _responses(db, user.id, [sip.id])[0]


@router.patch("/sips/{id}")
def update_sip(id: int, body: SipUpdate, user: CurrentUser, db: DbSession) -> SipResponse:
    changes = body.model_dump(exclude_unset=True)
    moved_to = changes.get("account_id")
    sip = _owned_sip(db, user.id, id)
    # The SIP's own bank is locked too, so it can't be archived while the SIP is being saved.
    accounts = lock_accounts(db, user.id, [sip.account_id, moved_to])
    errors: list[Any] = []
    if "account_id" in changes:
        if moved_to is None:
            errors.append(field_error("account_id", _CHOOSE_BANK))
        else:
            _check_bank(accounts.get(moved_to), errors)
    elif changes.get("active", sip.active):
        # A SIP that will be active needs an active bank, wherever it came from.
        _check_bank(accounts.get(sip.account_id), errors)
    if "amount" in changes:
        _check_amount(changes["amount"], errors)
    if "day" in changes and changes["day"] is None:
        errors.append(field_error("day", _BAD_DAY))
    if errors:
        raise RequestValidationError(errors)
    for field, value in changes.items():
        setattr(sip, field, value)
    db.commit()
    return _responses(db, user.id, [sip.id])[0]


def _instalments(db: Session, sip: Sip) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(InvestmentTrade)
            .where(InvestmentTrade.sip_id == sip.id)
        )
        or 0
    )


@router.delete("/sips/{id}")
def delete_sip(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    sip = _owned_sip(db, user.id, id)
    # Locking the row makes a purchase linking to it wait, so the count below stays true.
    db.execute(select(Sip.id).where(Sip.id == sip.id).with_for_update())
    stopped = HTTPException(status.HTTP_409_CONFLICT, "This SIP has instalments. Stop it instead.")
    if _instalments(db, sip):
        raise stopped
    try:
        db.delete(sip)
        db.commit()
    except IntegrityError:  # an instalment was recorded after all
        db.rollback()
        raise stopped from None
    return Deleted(id=id)
