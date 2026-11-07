from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator
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
CAN_BE_NEGATIVE = {"bank", "broker", "credit_card"}


def _text_only(value: Any) -> Any:
    # A JSON number would already be a binary float by the time it reaches us.
    if value is not None and not isinstance(value, str):
        raise ValueError('Send money as a string, like "1234.50".')
    return value


Money = Annotated[
    Decimal,
    BeforeValidator(_text_only),
    Field(max_digits=14, decimal_places=2),
]
Day = Annotated[int, Field(strict=True, ge=1, le=31)]


class AccountCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    type: AccountType
    # Required fields are optional here so that validate_rules reports them like any other rule.
    name: str | None = Field(default=None, min_length=1, max_length=60)
    balance: Money | None = None
    institution: str | None = Field(default=None, max_length=60)
    bank_kind: BankKind | None = None
    last4: str | None = Field(default=None, pattern=r"^[0-9]{4}$")
    credit_limit: Money | None = None
    statement_day: Day | None = None
    due_day: Day | None = None

    @field_validator("institution")
    @classmethod
    def blank_institution_is_none(cls, value: str | None) -> str | None:
        return value or None


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

    if values.get("name") is None:
        errors.append(_fail("name", "Field required"))
    balance = values.get("balance")
    if balance is None:
        errors.append(_fail("balance", "Field required"))
    elif balance < 0 and type_ not in CAN_BE_NEGATIVE:
        errors.append(_fail("balance", "Balance cannot be negative for this account type."))

    for field in sorted(DETAILS - APPLICABLE[type_]):
        if values.get(field) is not None:
            errors.append(_fail(field, "Not applicable to this account type."))
    if type_ == "bank" and values.get("bank_kind") is None:
        errors.append(_fail("bank_kind", "Field required"))
    limit = values.get("credit_limit")
    if limit is not None and limit <= 0:
        errors.append(_fail("credit_limit", "Credit limit must be greater than 0."))

    if errors:
        raise RequestValidationError(errors)


def _money(value: Decimal) -> str:
    return f"{value + 0:.2f}"  # + 0 turns a negative zero into zero


def to_response(account: Account) -> AccountResponse:
    limit = account.credit_limit
    return AccountResponse(
        id=account.id,
        type=account.type,
        name=account.name,
        balance=_money(account.opening_balance),
        institution=account.institution,
        bank_kind=account.bank_kind,
        last4=account.last4,
        credit_limit=None if limit is None else _money(limit),
        available_credit=None if limit is None else _money(limit - account.opening_balance),
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
        accounts=[to_response(a) for a in shown], total_have=_money(have), total_owe=_money(owe)
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
