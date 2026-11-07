import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal, get_args

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import select

from app.api.deps import CurrentUser, get_current_user
from app.db.session import DbSession
from app.models.account import Account

router = APIRouter(prefix="/accounts", tags=["accounts"], dependencies=[Depends(get_current_user)])

AccountType = Literal["bank", "credit_card", "cash", "broker", "wallet"]
BankKind = Literal["savings", "salary", "current"]

TYPE_ORDER = {"bank": 0, "credit_card": 1, "cash": 2, "broker": 3, "wallet": 4}
HAVE_TYPES = {"bank", "cash", "broker", "wallet"}

# Optional details each type may carry; a non-null value for any other detail is rejected.
DETAILS = {"institution", "bank_kind", "last4", "credit_limit", "statement_day", "due_day"}
APPLICABLE = {
    "bank": {"institution", "bank_kind", "last4"},
    "credit_card": {"institution", "last4", "credit_limit", "statement_day", "due_day"},
    "cash": set(),
    "broker": {"institution"},
    "wallet": {"institution"},
}
MAX_ID = 2147483647  # the largest value of an integer primary key
CAN_BE_NEGATIVE = {"bank", "broker", "credit_card"}


def _reject(code: str, message: str) -> PydanticCustomError:
    return PydanticCustomError(code, message)


_AMOUNT = re.compile(r"[+-]?[0-9]+(\.[0-9]+)?")
_LAST4 = re.compile(r"[0-9]{4}")
_MAX_MONEY = Decimal(10) ** 12
_MAX_AMOUNT_TEXT = 40
_CHOOSE_KIND = "Choose a kind of account."


def _money(value: Any) -> Decimal | None:
    # Text only: a JSON number would already be a binary float by the time it reaches us.
    if value is None:
        return None
    text = value.strip() if isinstance(value, str) else ""
    # The length cap keeps Decimal() away from absurd input; real amounts are under 20 characters.
    match = _AMOUNT.fullmatch(text) if len(text) <= _MAX_AMOUNT_TEXT else None
    if match is None:
        raise _reject("amount", "Enter an amount, like 1234.50.")
    fraction = (match.group(1) or ".")[1:].rstrip("0")  # counted on the text, not a rounded value
    if len(fraction) > 2:
        raise _reject("amount_decimals", "Use at most 2 decimal places.")
    amount = Decimal(text)
    if abs(amount) >= _MAX_MONEY:
        raise _reject("amount_large", "Amount must be under ₹10,00,00,00,00,000.")
    return amount


def _text(value: Any, message: str) -> str | None:
    # Trims; blank becomes None so validate_rules can report a missing name.
    if value is None:
        return None
    if not isinstance(value, str):
        raise _reject("text", message)
    value = value.strip()
    if "\0" in value:
        raise _reject("text_null", "Remove the unusual character.")
    if len(value) > 60:
        raise _reject("text_long", "Use 60 characters or fewer.")
    return value or None


def _last4(value: Any) -> str | None:
    if value is None:
        return None
    text = value.strip() if isinstance(value, str) else ""
    if not _LAST4.fullmatch(text):
        raise _reject("last4", "Enter exactly 4 digits.")
    return text


def _day(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 31:
        raise _reject("day", "Enter a day from 1 to 31.")
    return value


def _choice(options: tuple[str, ...]) -> Any:
    def check(value: Any) -> Any:
        if value is not None and value not in options:
            raise _reject("choice", _CHOOSE_KIND)
        return value

    return check


Money = Annotated[Decimal | None, BeforeValidator(_money)]
Name = Annotated[str | None, BeforeValidator(lambda v: _text(v, "Enter a name."))]
Institution = Annotated[
    str | None, BeforeValidator(lambda v: _text(v, "Use 60 characters or fewer."))
]
Last4 = Annotated[str | None, BeforeValidator(_last4)]
Day = Annotated[int | None, BeforeValidator(_day)]
Kind = Annotated[AccountType | None, BeforeValidator(_choice(get_args(AccountType)))]
Bank = Annotated[BankKind | None, BeforeValidator(_choice(get_args(BankKind)))]


class AccountCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that validate_rules reports them like any other rule.
    type: Kind = None
    name: Name = None
    balance: Money = None
    institution: Institution = None
    bank_kind: Bank = None
    last4: Last4 = None
    credit_limit: Money = None
    statement_day: Day = None
    due_day: Day = None


class AccountUpdate(BaseModel):
    """Create's fields, all optional, minus `type`; extras are forbidden, so type can't change."""

    model_config = ConfigDict(extra="forbid")

    name: Name = None
    balance: Money = None
    institution: Institution = None
    bank_kind: Bank = None
    last4: Last4 = None
    credit_limit: Money = None
    statement_day: Day = None
    due_day: Day = None


class AccountResponse(BaseModel):
    id: int
    type: str
    name: str
    balance: str
    institution: str | None
    bank_kind: str | None
    last4: str | None
    credit_limit: str | None
    available_credit: str | None
    statement_day: int | None
    due_day: int | None
    archived: bool


class AccountList(BaseModel):
    accounts: list[AccountResponse]
    total_have: str
    total_owe: str


def _fail(field: str, message: str) -> dict[str, Any]:
    return {"loc": ("body", field), "msg": message, "type": "value_error"}


def validate_rules(values: dict[str, Any]) -> None:
    """The per-type rules, applied to a whole account's values (create now, PATCH later)."""
    errors: list[dict[str, Any]] = []
    type_ = values["type"]

    if type_ is None:
        errors.append(_fail("type", _CHOOSE_KIND))
    if values.get("name") is None:
        errors.append(_fail("name", "Enter a name."))
    balance = values.get("balance")
    if balance is None:
        errors.append(_fail("balance", "Enter a balance."))
    elif type_ is not None and balance < 0 and type_ not in CAN_BE_NEGATIVE:
        errors.append(_fail("balance", "Balance cannot be negative for this account type."))

    if type_ is None:
        raise RequestValidationError(errors)

    for field in sorted(DETAILS - APPLICABLE[type_]):
        if values.get(field) is not None:
            errors.append(_fail(field, "Not applicable to this account type."))
    if type_ == "bank" and values.get("bank_kind") is None:
        errors.append(_fail("bank_kind", _CHOOSE_KIND))
    limit = values.get("credit_limit")
    if limit is not None and limit <= 0:
        errors.append(_fail("credit_limit", "Credit limit must be greater than 0."))

    if errors:
        raise RequestValidationError(errors)


def _fmt(value: Decimal) -> str:
    return f"{value + 0:.2f}"  # + 0 turns a negative zero into zero


def to_response(account: Account) -> AccountResponse:
    limit = account.credit_limit
    return AccountResponse(
        id=account.id,
        type=account.type,
        name=account.name,
        balance=_fmt(account.opening_balance),
        institution=account.institution,
        bank_kind=account.bank_kind,
        last4=account.last4,
        credit_limit=None if limit is None else _fmt(limit),
        available_credit=None if limit is None else _fmt(limit - account.opening_balance),
        statement_day=account.statement_day,
        due_day=account.due_day,
        archived=account.archived_at is not None,
    )


@router.get("")
def list_accounts(user: CurrentUser, db: DbSession, archived: bool = False) -> AccountList:
    accounts = db.scalars(select(Account).where(Account.user_id == user.id)).all()
    active = [a for a in accounts if a.archived_at is None]
    shown = [a for a in accounts if (a.archived_at is not None) == archived]
    shown.sort(key=lambda a: (TYPE_ORDER[a.type], a.name.casefold(), a.id))
    have = sum((a.opening_balance for a in active if a.type in HAVE_TYPES), Decimal(0))
    owe = sum((a.opening_balance for a in active if a.type == "credit_card"), Decimal(0))
    return AccountList(
        accounts=[to_response(a) for a in shown], total_have=_fmt(have), total_owe=_fmt(owe)
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_account(body: AccountCreate, user: CurrentUser, db: DbSession) -> AccountResponse:
    values = body.model_dump()
    validate_rules(values)
    account = Account(
        user_id=user.id,
        type=values["type"],
        name=values["name"],
        opening_balance=values["balance"],
        **{field: values[field] for field in DETAILS},
    )
    db.add(account)
    db.commit()
    return to_response(account)


def _get_owned(db: DbSession, user: CurrentUser, id: int) -> Account:
    # Ids outside the column's range can't exist; asking the database would be a 500.
    account = None
    if 1 <= id <= MAX_ID:
        account = db.scalar(select(Account).where(Account.id == id, Account.user_id == user.id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    return account


@router.patch("/{id}")
def update_account(
    id: int, body: AccountUpdate, user: CurrentUser, db: DbSession
) -> AccountResponse:
    account = _get_owned(db, user, id)
    if account.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Restore this account before editing it.")
    values = {
        "type": account.type,
        "balance": account.opening_balance,
        **{field: getattr(account, field) for field in DETAILS},
        "name": account.name,
    }
    values.update(body.model_dump(exclude_unset=True))
    validate_rules(values)
    account.name = values["name"]
    account.opening_balance = values["balance"]
    for field in DETAILS:
        setattr(account, field, values[field])
    db.commit()
    return to_response(account)


@router.post("/{id}/archive")
def archive_account(id: int, user: CurrentUser, db: DbSession) -> AccountResponse:
    account = _get_owned(db, user, id)
    if account.archived_at is None:
        account.archived_at = datetime.now(UTC)
        db.commit()
    return to_response(account)


@router.post("/{id}/restore")
def restore_account(id: int, user: CurrentUser, db: DbSession) -> AccountResponse:
    account = _get_owned(db, user, id)
    if account.archived_at is not None:
        account.archived_at = None
        db.commit()
    return to_response(account)
