import calendar
import re
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Annotated, Any, Literal, get_args

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.balances import LIABILITY_TYPES, balance_of, opening_for
from app.api.dates import iso_date, today_india
from app.api.deposits import (
    PpfFigures,
    RdFigures,
    deposit_figures,
    rd_deposits_paid,
    rd_months_recorded,
)
from app.api.deps import CurrentUser, get_current_user
from app.api.loans import Book, NextEmi, emis_at_opening, emis_left, load_book, next_emi
from app.api.portfolio import fmt_coin, fmt_units, holds_units, investments_totals
from app.db.session import DbSession
from app.models.account import Account
from app.models.insurance import InsurancePolicy
from app.models.investment import Instrument, InvestmentTrade, Sip
from app.models.recurring import RecurringTemplate
from app.models.transaction import Transaction

if TYPE_CHECKING:
    from app.api.goals import GoalTags

router = APIRouter(prefix="/accounts", tags=["accounts"], dependencies=[Depends(get_current_user)])

AccountType = Literal["bank", "credit_card", "cash", "broker", "wallet", "ppf", "rd", "loan"]
BankKind = Literal["savings", "salary", "current"]

TYPE_ORDER = {
    "bank": 0,
    "credit_card": 1,
    "cash": 2,
    "broker": 3,
    "wallet": 4,
    "ppf": 5,
    "rd": 6,
    "loan": 7,
}
HAVE_TYPES = {"bank", "cash", "broker", "wallet", "ppf", "rd"}
DEPOSIT_TYPES = {"ppf", "rd"}

# Optional details each type may carry; a non-null value for any other detail is rejected.
# `emis_left` is stored as `emis_at_opening` (see app/api/loans.py); the rest are columns.
STORED = {
    "institution",
    "bank_kind",
    "last4",
    "credit_limit",
    "statement_day",
    "due_day",
    "interest_rate",
    "emi_amount",
    "pay_from_id",
    "opened_on",
    "deposit_amount",
    "tenure_months",
}
# `emis_left` and `deposits_paid` are stored as counts at opening (see loans.py, deposits.py).
DETAILS = STORED | {"emis_left", "deposits_paid"}
APPLICABLE = {
    "bank": {"institution", "bank_kind", "last4"},
    "credit_card": {"institution", "last4", "credit_limit", "statement_day", "due_day"},
    "cash": set(),
    "broker": {"institution"},
    "wallet": {"institution"},
    "ppf": {"institution", "interest_rate", "opened_on", "pay_from_id"},
    "rd": {
        "institution",
        "interest_rate",
        "opened_on",
        "pay_from_id",
        "deposit_amount",
        "due_day",
        "tenure_months",
        "deposits_paid",
    },
    "loan": {"institution", "due_day", "interest_rate", "emi_amount", "emis_left", "pay_from_id"},
}
MAX_ID = 2147483647  # the largest value of an integer primary key
CAN_BE_NEGATIVE = {"bank", "broker", "credit_card"}


def _reject(code: str, message: str) -> PydanticCustomError:
    return PydanticCustomError(code, message)


_AMOUNT = re.compile(r"[+-]?[0-9]+(\.[0-9]+)?")
_LAST4 = re.compile(r"[0-9]{4}")
MAX_MONEY = Decimal(10) ** 12
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
    if abs(amount) >= MAX_MONEY:
        raise _reject("amount_large", "Amount must be under ₹10,00,00,00,00,000.")
    return amount


def clean_text(value: Any, message: str, limit: int = 60) -> str | None:
    # Trims; blank becomes None so validate_rules can report a missing name.
    if value is None:
        return None
    if not isinstance(value, str):
        raise _reject("text", message)
    value = value.strip()
    if "\0" in value:
        raise _reject("text_null", "Remove the unusual character.")
    if len(value) > limit:
        raise _reject("text_long", f"Use {limit} characters or fewer.")
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


def _rate(value: Any) -> Decimal | None:
    message = "Enter a yearly rate from 0 to 100, like 10.5."
    try:
        rate = _money(value)
    except PydanticCustomError as error:
        if error.type == "amount_decimals":
            raise
        raise _reject("rate", message) from None
    if rate is not None and not 0 <= rate <= 100:
        raise _reject("rate", message)
    return rate


def _count(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 600:
        raise _reject("count", "Enter a number of EMIs from 1 to 600.")
    return value


def _tenure(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 120:
        raise _reject("tenure", "Enter the tenure in months, from 1 to 120.")
    return value


def _paid(value: Any) -> int | None:
    # The upper bound is the tenure, which validate_rules checks.
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 120:
        raise _reject("paid", "Enter the instalments paid so far, from 0 to the tenure.")
    return value


def _ref(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise _reject("account", "Choose an account.")
    return value


def _flag(value: Any) -> bool:
    if not isinstance(value, bool):
        raise _reject("flag", "Choose yes or no.")
    return value


def _choice(options: tuple[str, ...]) -> Any:
    def check(value: Any) -> Any:
        if value is not None and value not in options:
            raise _reject("choice", _CHOOSE_KIND)
        return value

    return check


Money = Annotated[Decimal | None, BeforeValidator(_money)]
Name = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, "Enter a name."))]
Institution = Annotated[
    str | None, BeforeValidator(lambda v: clean_text(v, "Use 60 characters or fewer."))
]
Last4 = Annotated[str | None, BeforeValidator(_last4)]
Day = Annotated[int | None, BeforeValidator(_day)]
Kind = Annotated[AccountType | None, BeforeValidator(_choice(get_args(AccountType)))]
Bank = Annotated[BankKind | None, BeforeValidator(_choice(get_args(BankKind)))]
Rate = Annotated[Decimal | None, BeforeValidator(_rate)]
Count = Annotated[int | None, BeforeValidator(_count)]
Ref = Annotated[int | None, BeforeValidator(_ref)]
Opened = Annotated[date | None, BeforeValidator(iso_date)]
Tenure = Annotated[int | None, BeforeValidator(_tenure)]
Paid = Annotated[int | None, BeforeValidator(_paid)]
Flag = Annotated[bool, BeforeValidator(_flag)]


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
    interest_rate: Rate = None
    emi_amount: Money = None
    emis_left: Count = None
    pay_from_id: Ref = None
    opened_on: Opened = None
    deposit_amount: Money = None
    tenure_months: Tenure = None
    deposits_paid: Paid = None
    # Loans paid from a card: the balance is already in the card's, so move it off the card.
    moved_from_card: Flag = False


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
    interest_rate: Rate = None
    emi_amount: Money = None
    emis_left: Count = None
    pay_from_id: Ref = None
    opened_on: Opened = None
    deposit_amount: Money = None
    tenure_months: Tenure = None
    deposits_paid: Paid = None


class GoalTag(BaseModel):
    """The active goal a holding is in."""

    id: int
    name: str


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
    interest_rate: str | None
    emi_amount: str | None
    emis_left: int | None
    pay_from_id: int | None
    next_emi: NextEmi | None
    archived: bool
    opened_on: str | None
    deposit_amount: str | None
    tenure_months: int | None
    deposit: PpfFigures | RdFigures | None
    set_aside: str  # what active goals have set aside here; `balance` stays the real balance
    free_balance: str  # balance - set_aside, negative when more is set aside than held
    in_goal: GoalTag | None  # a PPF or RD in an active goal


class AccountList(BaseModel):
    accounts: list[AccountResponse]
    total_have: str
    total_owe: str


def field_error(field: str, message: str) -> dict[str, Any]:
    return {"loc": ("body", field), "msg": message, "type": "value_error"}


def validate_rules(values: dict[str, Any], check_paid: bool = True) -> None:
    """The per-type rules, applied to a whole account's values (create now, PATCH later).

    `check_paid` is False for an edit that leaves the tenure and instalments paid alone: transfers
    recorded later can push the paid count past the tenure, and that must not block a rename.
    """
    errors: list[dict[str, Any]] = []
    type_ = values["type"]

    if type_ is None:
        errors.append(field_error("type", _CHOOSE_KIND))
    if values.get("name") is None:
        errors.append(field_error("name", "Enter a name."))
    balance = values.get("balance")
    if balance is None:
        errors.append(field_error("balance", "Enter a balance."))
    elif type_ is not None and balance < 0 and type_ not in CAN_BE_NEGATIVE:
        errors.append(field_error("balance", "Balance cannot be negative for this account type."))

    if type_ is None:
        raise RequestValidationError(errors)

    for field in sorted(DETAILS - APPLICABLE[type_]):
        if values.get(field) is not None:
            errors.append(field_error(field, "Not applicable to this account type."))
    if type_ == "bank" and values.get("bank_kind") is None:
        errors.append(field_error("bank_kind", _CHOOSE_KIND))
    limit = values.get("credit_limit")
    if limit is not None and limit <= 0:
        errors.append(field_error("credit_limit", "Credit limit must be greater than 0."))
    emi = values.get("emi_amount")
    if emi is not None and emi <= 0:
        errors.append(field_error("emi_amount", "EMI must be greater than 0."))

    if type_ in DEPOSIT_TYPES:
        errors.extend(_deposit_errors(values, type_, check_paid))

    if errors:
        raise RequestValidationError(errors)


_REQUIRED = {
    "interest_rate": "Enter the yearly interest rate.",
    "opened_on": "Choose the date it was opened.",
}
_RD_REQUIRED = {
    "pay_from_id": "Choose the bank the instalments come from.",
    "deposit_amount": "Enter the monthly instalment.",
    "due_day": "Choose the instalment day.",
    "tenure_months": "Enter the tenure in months, from 1 to 120.",
    "deposits_paid": "Enter the instalments paid so far, from 0 to the tenure.",
}


def _deposit_errors(
    values: dict[str, Any], type_: str, check_paid: bool = True
) -> list[dict[str, Any]]:
    errors = []
    required = _REQUIRED | (_RD_REQUIRED if type_ == "rd" else {})
    for field, message in required.items():
        if values.get(field) is None:
            errors.append(field_error(field, message))
    opened = values.get("opened_on")
    if opened is not None and opened > today_india():
        errors.append(field_error("opened_on", "The date can't be in the future."))
    amount = values.get("deposit_amount")
    if amount is not None and amount <= 0:
        errors.append(field_error("deposit_amount", "Instalment must be greater than 0."))
    paid, tenure = values.get("deposits_paid"), values.get("tenure_months")
    if check_paid and paid is not None and tenure is not None and paid > tenure:
        errors.append(field_error("deposits_paid", _RD_REQUIRED["deposits_paid"]))
    return errors


def fmt(value: Decimal) -> str:
    return f"{value + 0:.2f}"  # + 0 turns a negative zero into zero


def rupees(value: Decimal) -> str:
    """Money in a message, grouped the Indian way: ₹12,34,567.50, and ₹40,000 (no ".00")."""
    text = fmt(abs(value))
    whole, paise = text.split(".")
    head, groups = whole[:-3], [whole[-3:]]
    while head:
        groups.insert(0, head[-2:])
        head = head[:-2]
    sign = "-" if value < 0 and text != "0.00" else ""
    return f"{sign}₹{','.join(groups)}" + ("" if paise == "00" else f".{paise}")


def _money_text(value: Decimal | None) -> str | None:
    return None if value is None else fmt(value)


def goal_tag(tags: "GoalTags", key: tuple[str, int]) -> GoalTag | None:
    found = tags.holding_goal.get(key)
    return None if found is None else GoalTag(id=found[0], name=found[1])


def to_response(account: Account, book: Book, tags: "GoalTags") -> AccountResponse:
    from app.api.goals import free_balance  # it imports this module

    limit = account.credit_limit
    balance = balance_of(account, book.flows)
    # The bank blocks what loans paid from a card still owe out of that card's limit.
    blocked = book.linked_owed.get(account.id, Decimal(0))
    return AccountResponse(
        id=account.id,
        type=account.type,
        name=account.name,
        balance=fmt(balance),
        institution=account.institution,
        bank_kind=account.bank_kind,
        last4=account.last4,
        credit_limit=None if limit is None else fmt(limit),
        available_credit=None if limit is None else fmt(limit - balance - blocked),
        statement_day=account.statement_day,
        due_day=account.due_day,
        interest_rate=_money_text(account.interest_rate),
        emi_amount=_money_text(account.emi_amount),
        emis_left=emis_left(account, book),
        pay_from_id=account.pay_from_id,
        next_emi=next_emi(account, book),
        archived=account.archived_at is not None,
        opened_on=None if account.opened_on is None else account.opened_on.isoformat(),
        deposit_amount=_money_text(account.deposit_amount),
        tenure_months=account.tenure_months,
        deposit=deposit_figures(account, book, today_india()),
        set_aside=fmt(tags.set_aside_by_account.get(account.id, Decimal(0))),
        free_balance=fmt(free_balance(account, book.flows, tags.set_aside_by_account)),
        in_goal=goal_tag(tags, ("account", account.id)),
    )


def account_response(db: Session, user_id: int, account: Account) -> AccountResponse:
    """One account as the API shows it, with fresh balances and goal figures."""
    from app.api.goals import load_goal_tags  # it imports this module

    return to_response(account, load_book(db, user_id), load_goal_tags(db, user_id))


def list_sort_key(account: Account) -> tuple[int, str, int]:
    return (TYPE_ORDER[account.type], account.name.casefold(), account.id)


def totals(active: list[Account], flows: dict[int, Decimal]) -> tuple[Decimal, Decimal]:
    """(have, owe) over the given accounts, which the caller has already limited to active ones."""
    have = sum((balance_of(a, flows) for a in active if a.type in HAVE_TYPES), Decimal(0))
    owe = sum((balance_of(a, flows) for a in active if a.type in LIABILITY_TYPES), Decimal(0))
    return have, owe


@router.get("")
def list_accounts(user: CurrentUser, db: DbSession, archived: bool = False) -> AccountList:
    from app.api.goals import load_goal_tags  # it imports this module

    accounts = db.scalars(select(Account).where(Account.user_id == user.id)).all()
    active = [a for a in accounts if a.archived_at is None]
    shown = [a for a in accounts if (a.archived_at is not None) == archived]
    shown.sort(key=list_sort_key)
    book = load_book(db, user.id, accounts)
    tags = load_goal_tags(db, user.id)
    have, owe = totals(active, book.flows)
    have += investments_totals(db, user.id).value
    return AccountList(
        accounts=[to_response(a, book, tags) for a in shown],
        total_have=fmt(have),
        total_owe=fmt(owe),
    )


def _check_links(
    db: DbSession, user: CurrentUser, values: dict[str, Any], moved_from_card: bool = False
) -> None:
    """A pay-from account must be the user's own and active: not a loan, or for a deposit a bank."""
    errors: list[dict[str, Any]] = []
    pay_from_id = values.get("pay_from_id")
    pay_from = None
    if pay_from_id is not None:
        if 1 <= pay_from_id <= MAX_ID:
            query = select(Account).where(Account.id == pay_from_id, Account.user_id == user.id)
            # A deposit's bank is locked, so it can't be archived while the link is being saved.
            pay_from = db.scalar(
                query.with_for_update() if values["type"] in DEPOSIT_TYPES else query
            )
        if values["type"] in DEPOSIT_TYPES:
            if pay_from is None or pay_from.type != "bank":
                errors.append(field_error("pay_from_id", "Choose a bank account."))
            elif pay_from.archived_at is not None:
                errors.append(
                    field_error(
                        "pay_from_id", f"{pay_from.name} is archived. Restore it to use it."
                    )
                )
        elif pay_from is None or pay_from.type == "loan" or pay_from.type in DEPOSIT_TYPES:
            errors.append(field_error("pay_from_id", "Choose the account EMIs are paid from."))
        elif pay_from.archived_at is not None:
            errors.append(
                field_error("pay_from_id", f"{pay_from.name} is archived. Restore it to use it.")
            )
    if moved_from_card and (pay_from_id is None or (pay_from and pay_from.type != "credit_card")):
        errors.append(
            field_error("moved_from_card", "Choose the card the loan is paid from to move it.")
        )
    if errors:
        raise RequestValidationError(errors)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_account(body: AccountCreate, user: CurrentUser, db: DbSession) -> AccountResponse:
    values = body.model_dump()
    moved = values.pop("moved_from_card")
    validate_rules(values)
    _check_links(db, user, values, moved)
    if moved:
        # Locked like any transaction save, so the card's balance can't move underneath us.
        db.scalar(select(Account).where(Account.id == values["pay_from_id"]).with_for_update())
    account = Account(
        user_id=user.id,
        type=values["type"],
        name=values["name"],
        # Moved from a card, the loan starts at 0 and the transfer below makes it owed.
        opening_balance=Decimal(0) if moved else values["balance"],
        emis_at_opening=values["emis_left"],
        deposits_at_opening=values["deposits_paid"],
        **{field: values[field] for field in STORED},
    )
    db.add(account)
    if moved and values["balance"] > 0:
        db.flush()
        db.add(
            Transaction(
                user_id=user.id,
                type="transfer",
                amount=values["balance"],
                date=today_india(),
                account_id=account.id,
                to_account_id=values["pay_from_id"],
                note=f"Moved to {account.name}",
            )
        )
    db.commit()
    return account_response(db, user.id, account)


def _get_owned(db: DbSession, user: CurrentUser, id: int, lock: bool = False) -> Account:
    # Ids outside the column's range can't exist; asking the database would be a 500.
    account = None
    if 1 <= id <= MAX_ID:
        query = select(Account).where(Account.id == id, Account.user_id == user.id)
        account = db.scalar(query.with_for_update() if lock else query)
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    return account


@router.patch("/{id}")
def update_account(
    id: int, body: AccountUpdate, user: CurrentUser, db: DbSession
) -> AccountResponse:
    changes = body.model_dump(exclude_unset=True)
    new_bank = changes.get("pay_from_id")
    if new_bank is not None and new_bank != db.scalar(
        select(Account.pay_from_id).where(Account.id == id, Account.user_id == user.id)
    ):
        from app.api.routes.transactions import lock_accounts  # it imports this module

        # A changed bank is locked together with this account, in id order, like any transaction
        # save, so two requests can't each hold one and wait for the other.
        lock_accounts(db, user.id, [id, new_bank])
    # Locked so that a transaction saved meanwhile can't throw off the opening balance below.
    account = _get_owned(db, user, id, lock=True)
    if account.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Restore this account before editing it.")
    book = load_book(db, user.id)
    values = {
        "type": account.type,
        "balance": balance_of(account, book.flows),
        **{field: getattr(account, field) for field in STORED},
        "emis_left": emis_left(account, book),
        "deposits_paid": rd_deposits_paid(account, book),
        "name": account.name,
    }
    values.update(changes)
    validate_rules(values, check_paid=bool({"deposits_paid", "tenure_months"} & changes.keys()))
    # Only a changed bank is locked (above) and checked: archiving a bank locks it and its PPFs in
    # id order, so locking an unchanged one after this account, out of order, could deadlock.
    if "pay_from_id" in changes and changes["pay_from_id"] != account.pay_from_id:
        _check_links(db, user, values)
    at_opening = None
    if values["deposits_paid"] is not None:
        at_opening = values["deposits_paid"] - rd_months_recorded(account, book)
        if at_opening < 0:
            raise RequestValidationError(
                [field_error("deposits_paid", "More instalments are already recorded than that.")]
            )
    # Correcting a balance moves the opening balance, so the transactions stay as they are.
    opening = opening_for(account, values["balance"], book.flows)
    if abs(opening) >= MAX_MONEY:
        raise RequestValidationError(
            [field_error("balance", "This balance is too large with this account's transactions.")]
        )
    account.name = values["name"]
    account.opening_balance = opening
    for field in STORED:
        setattr(account, field, values[field])
    account.emis_at_opening = emis_at_opening(values["emis_left"], account, book)
    if values["deposits_paid"] is not None:
        account.deposits_at_opening = at_opening
    db.commit()
    return account_response(db, user.id, account)


def _ppf_ids(db: Session, user_id: int, id: int) -> list[int]:
    """The active PPFs paid from this account, in id order."""
    if not 1 <= id <= MAX_ID:
        return []
    return list(
        db.scalars(
            select(Account.id)
            .where(
                Account.user_id == user_id,
                Account.type == "ppf",
                Account.pay_from_id == id,
                Account.archived_at.is_(None),
            )
            .order_by(Account.id)
        )
    )


ARCHIVE_TRIES = 3


@router.post("/{id}/archive")
def archive_account(id: int, user: CurrentUser, db: DbSession) -> AccountResponse:
    from app.api.goals import load_goal_tags  # it imports this module
    from app.api.routes.transactions import lock_accounts  # it imports this module

    # The bank's PPFs are cleared below, so they're locked with it, all in id order like a PPF
    # edit locks its PPF and new bank; locking the bank first could deadlock with that edit.
    # A PPF repointed here between the read and the lock would be missed, so the ids are read
    # again under the lock, and on a change everything is let go and tried again.
    for _ in range(ARCHIVE_TRIES):
        ppf_ids = _ppf_ids(db, user.id, id)
        # Locked so that a trade saved meanwhile can't put shares in a broker being archived,
        # and a goal can't set money aside here meanwhile (it locks the account first too).
        account = lock_accounts(db, user.id, [id, *ppf_ids]).get(id)
        if _ppf_ids(db, user.id, id) == ppf_ids:
            break
        db.rollback()
    else:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Something changed while archiving. Try again."
        )
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    if account.archived_at is None:
        if account.type == "broker" and holds_units(db, user.id, account.id, "stock"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Sell the shares held in {account.name} before archiving it.",
            )
        if account.type == "broker" and holds_units(db, user.id, account.id, "crypto"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Sell the coins held in {account.name} before archiving it.",
            )
        if account.type == "bank":
            if holds_units(db, user.id, account.id, "mutual_fund"):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"Redeem the fund units held in {account.name} before archiving it.",
                )
            if db.scalar(
                select(Sip.id)
                .where(Sip.user_id == user.id, Sip.account_id == account.id, Sip.active)
                .limit(1)
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"Stop the SIPs paid from {account.name} before archiving it.",
                )
        if account.type in DEPOSIT_TYPES:
            book = load_book(db, user.id)
            if balance_of(account, book.flows) > 0:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"Withdraw the balance from {account.name} before archiving it.",
                )
        if account.type == "bank":
            paid_by = db.scalar(
                select(Account).where(
                    Account.user_id == user.id,
                    Account.type == "rd",
                    Account.pay_from_id == account.id,
                    Account.archived_at.is_(None),
                )
            )
            if paid_by is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"Close or move the RD {paid_by.name} before archiving {account.name}.",
                )
        tags = load_goal_tags(db, user.id)
        set_aside = tags.set_aside_by_account.get(account.id)
        if set_aside:
            goals = ", ".join(tags.set_aside_for[account.id])
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"{rupees(set_aside)} of {account.name} is set aside for {goals}. "
                "Release it first.",
            )
        insurer = db.scalar(
            select(InsurancePolicy.insurer)
            .join(RecurringTemplate, RecurringTemplate.id == InsurancePolicy.template_id)
            .where(
                InsurancePolicy.user_id == user.id,
                InsurancePolicy.active.is_(True),
                RecurringTemplate.account_id == account.id,
            )
            .order_by(InsurancePolicy.id)
            .limit(1)
        )
        if insurer is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"This account pays the {insurer} premium. "
                "Change the policy's paying account or lapse the policy first.",
            )
        # Every check passed: the bank's PPFs (locked above) let go of it.
        if account.type == "bank":
            for ppf in db.scalars(select(Account).where(Account.id.in_(ppf_ids))):
                ppf.pay_from_id = None
        account.archived_at = datetime.now(UTC)
        db.commit()
    return account_response(db, user.id, account)


class Activity(BaseModel):
    trade_id: int
    kind: str
    instrument_id: int
    symbol: str
    name: str
    side: str
    date: str
    quantity: str
    amount: str
    signed_amount: str
    sip_id: int | None


class ActivityList(BaseModel):
    items: list[Activity]


def _quantity(kind: str, quantity: Decimal) -> str:
    if kind == "stock":
        return str(int(quantity))  # whole shares
    if kind == "crypto":
        return fmt_coin(quantity)
    return fmt_units(quantity)


@router.get("/{id}/investment-activity")
def investment_activity(
    id: int,
    user: CurrentUser,
    db: DbSession,
    month: Annotated[str, Query(pattern=r"^[1-9][0-9]{3}-(0[1-9]|1[0-2])$")],
) -> ActivityList:
    """The trades whose cash moved through this account in a month, newest first."""
    account = _get_owned(db, user, id)
    year, number = int(month[:4]), int(month[5:])
    rows = db.execute(
        select(InvestmentTrade, Instrument)
        .join(Instrument, Instrument.id == InvestmentTrade.instrument_id)
        .where(
            InvestmentTrade.user_id == user.id,
            InvestmentTrade.account_id == account.id,
            InvestmentTrade.opening.is_(False),
            InvestmentTrade.date >= date(year, number, 1),
            InvestmentTrade.date <= date(year, number, calendar.monthrange(year, number)[1]),
        )
        .order_by(InvestmentTrade.date.desc(), InvestmentTrade.id.desc())
    ).all()
    return ActivityList(
        items=[
            Activity(
                trade_id=trade.id,
                kind=instrument.kind,
                instrument_id=instrument.id,
                symbol=instrument.symbol,
                name=instrument.name,
                side=trade.side,
                date=trade.date.isoformat(),
                quantity=_quantity(instrument.kind, trade.quantity),
                amount=fmt(trade.amount),
                signed_amount=fmt(trade.amount if trade.side == "sell" else -trade.amount),
                sip_id=trade.sip_id,
            )
            for trade, instrument in rows
        ]
    )


@router.post("/{id}/restore")
def restore_account(id: int, user: CurrentUser, db: DbSession) -> AccountResponse:
    account = _get_owned(db, user, id)
    if account.archived_at is not None:
        if account.type in DEPOSIT_TYPES and account.pay_from_id is not None:
            bank = db.get(Account, account.pay_from_id)
            if bank is not None and bank.archived_at is not None:
                if account.type == "rd":
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        f"Restore or choose another bank for {account.name} first: "
                        f"{bank.name} is archived.",
                    )
                account.pay_from_id = None
        if account.type == "rd" and balance_of(account, load_book(db, user.id).flows) == 0:
            paid_out = db.scalar(
                select(Transaction.id)
                .join(Account, Account.id == Transaction.to_account_id)
                .where(
                    Transaction.user_id == user.id,
                    Transaction.type == "transfer",
                    Transaction.account_id == account.id,
                    Account.type == "bank",
                )
                .limit(1)
            )
            if paid_out is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT, "This RD was closed. Its record stays in the archive."
                )
        account.archived_at = None
        db.commit()
    return account_response(db, user.id, account)
