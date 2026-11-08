import calendar
import re
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal, get_args

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.balances import Movement, balance_of, load_movements, net_flows
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import (
    CAN_BE_NEGATIVE,
    MAX_ID,
    MAX_MONEY,
    Money,
    clean_text,
    field_error,
    fmt,
)
from app.api.routes.dashboard import today_india
from app.db.session import DbSession
from app.models.account import Account
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/transactions", tags=["transactions"], dependencies=[Depends(get_current_user)]
)

TransactionType = Literal["income", "expense", "transfer", "emi"]
EMI_CATEGORY = "Loan interest"

DEFAULT_CATEGORIES = {
    "income": ["Salary", "Business", "Interest", "Dividends", "Refund", "Gift", "Other"],
    "expense": [
        "Groceries",
        "Food and dining",
        "Transport",
        "Fuel",
        "Housing",
        "Utilities",
        "Shopping",
        "Health",
        "Entertainment",
        "Education",
        "Insurance",
        "Loan payments",
        "Travel",
        "Gifts and donations",
        "Fees and charges",
        "Other",
    ],
}

_ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_DATE_MESSAGE = "Enter a date, like 2026-01-15."


def _date(value: Any) -> date | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _ISO_DATE.fullmatch(value):
        raise PydanticCustomError("date", _DATE_MESSAGE)
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise PydanticCustomError("date", _DATE_MESSAGE) from None


def _account_id(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise PydanticCustomError("account", "Choose an account.")
    return value


def _type(value: Any) -> Any:
    if value is not None and value not in get_args(TransactionType):
        raise PydanticCustomError("type", "Choose a type.")
    return value


Kind = Annotated[TransactionType | None, BeforeValidator(_type)]
Day = Annotated[date | None, BeforeValidator(_date)]
AccountRef = Annotated[int | None, BeforeValidator(_account_id)]
Category = Annotated[
    str | None, BeforeValidator(lambda v: clean_text(v, "Enter a category.", limit=40))
]
Note = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, "Enter a note.", limit=200))]


class TransactionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that _validate reports them like any other rule.
    type: Kind = None
    account_id: AccountRef = None
    to_account_id: AccountRef = None
    amount: Money = None
    date: Day = None
    category: Category = None
    interest: Money = None
    note: Note = None


class TransactionUpdate(BaseModel):
    """Create's fields, all optional, minus `type`; extras are forbidden, so type can't change."""

    model_config = ConfigDict(extra="forbid")

    account_id: AccountRef = None
    to_account_id: AccountRef = None
    amount: Money = None
    date: Day = None
    category: Category = None
    interest: Money = None
    note: Note = None


class TransactionResponse(BaseModel):
    id: int
    type: str
    amount: str
    date: str
    account_id: int
    account_name: str
    to_account_id: int | None
    to_account_name: str | None
    category: str | None
    interest: str | None
    note: str | None
    # False once a linked account is archived; restore the account to change the transaction.
    editable: bool


class TransactionList(BaseModel):
    transactions: list[TransactionResponse]
    has_more: bool
    # Over every transaction matching the filters, not just this page. Transfers count in neither;
    # an EMI's interest counts as spending.
    total_income: str
    total_expense: str


class CategoryList(BaseModel):
    income: list[str]
    expense: list[str]


def _to_response(tx: Transaction, accounts: dict[int, Account]) -> TransactionResponse:
    account = accounts[tx.account_id]
    target = None if tx.to_account_id is None else accounts[tx.to_account_id]
    return TransactionResponse(
        id=tx.id,
        type=tx.type,
        amount=fmt(tx.amount),
        date=tx.date.isoformat(),
        account_id=tx.account_id,
        account_name=account.name,
        to_account_id=tx.to_account_id,
        to_account_name=None if target is None else target.name,
        category=tx.category,
        interest=None if tx.interest is None else fmt(tx.interest),
        note=tx.note,
        editable=account.archived_at is None and (target is None or target.archived_at is None),
    )


def _all_accounts(db: Session, user_id: int) -> dict[int, Account]:
    accounts = db.scalars(select(Account).where(Account.user_id == user_id))
    return {a.id: a for a in accounts}


def _lock_accounts(db: Session, user_id: int, ids: Iterable[int | None]) -> dict[int, Account]:
    """The user's accounts among `ids`, locked in id order so concurrent saves can't deadlock.

    The lock makes the below-zero check safe: nothing else can move these balances until commit.
    """
    wanted = {i for i in ids if i is not None and 1 <= i <= MAX_ID}
    query = (
        select(Account)
        .where(Account.id.in_(wanted), Account.user_id == user_id)
        .order_by(Account.id)
        .with_for_update()
    )
    return {a.id: a for a in db.scalars(query)}


def _account_problem(
    account_id: int | None, accounts: dict[int, Account], missing: str
) -> str | None:
    account = None if account_id is None else accounts.get(account_id)
    if account is None:  # someone else's account is reported the same as one that doesn't exist
        return missing
    if account.archived_at is not None:
        return f"{account.name} is archived. Restore it to use it."
    return None


def _validate(values: dict[str, Any], accounts: dict[int, Account]) -> None:
    errors: list[dict[str, Any]] = []
    type_ = values["type"]
    if type_ is None:
        errors.append(field_error("type", "Choose a type."))

    amount = values["amount"]
    if amount is None:
        errors.append(field_error("amount", "Enter an amount."))
    elif amount <= 0:
        errors.append(field_error("amount", "Amount must be greater than 0."))

    day = values["date"]
    if day is None:
        errors.append(field_error("date", "Choose a date."))
    elif day > today_india():
        errors.append(field_error("date", "The date can't be in the future."))

    problem = _account_problem(values["account_id"], accounts, "Choose an account.")
    if problem:
        errors.append(field_error("account_id", problem))

    target = values["to_account_id"]
    if type_ == "transfer":
        problem = _account_problem(target, accounts, "Choose the account the money goes to.")
        if not problem and target == values["account_id"]:
            problem = "Choose a different account to transfer to."
        if problem:
            errors.append(field_error("to_account_id", problem))
        if values["category"] is not None:
            errors.append(field_error("category", "A transfer doesn't have a category."))
    elif type_ == "emi":
        _validate_emi(values, accounts, errors)
    elif type_ is not None:
        if target is not None:
            errors.append(field_error("to_account_id", "Only a transfer has a second account."))
        if values["category"] is None:
            errors.append(field_error("category", "Choose a category."))

    if type_ != "emi" and values["interest"] is not None:
        errors.append(field_error("interest", "Only an EMI has an interest part."))

    if errors:
        raise RequestValidationError(errors)


def _validate_emi(
    values: dict[str, Any], accounts: dict[int, Account], errors: list[dict[str, Any]]
) -> None:
    payer = accounts.get(values["account_id"] or 0)
    if payer is not None and payer.type == "loan" and not any(
        e["loc"][1] == "account_id" for e in errors
    ):
        errors.append(field_error("account_id", "Choose the account the EMI is paid from."))

    loan = accounts.get(values["to_account_id"] or 0)
    problem = _account_problem(values["to_account_id"], accounts, "Choose a loan.")
    if not problem and loan is not None and loan.type != "loan":
        problem = "Choose a loan."
    if problem:
        errors.append(field_error("to_account_id", problem))

    if values["category"] is not None:
        errors.append(field_error("category", f"An EMI's category is always {EMI_CATEGORY}."))

    interest, amount = values["interest"], values["amount"]
    if interest is None:
        errors.append(field_error("interest", "Enter the interest part, or 0."))
    elif interest < 0:
        errors.append(field_error("interest", "Interest can't be negative."))
    elif amount is not None and interest > amount:
        errors.append(field_error("interest", "Interest can't be more than the EMI."))


def _balance_problem(
    accounts: dict[int, Account], before: list[Movement], after: list[Movement]
) -> str | None:
    """Why this change can't be saved, judged on what it does to each account's current balance."""
    flows_before = net_flows(before)
    flows_after = net_flows(after)
    for account in accounts.values():
        old = balance_of(account, flows_before)
        new = balance_of(account, flows_after)
        if account.type not in CAN_BE_NEGATIVE and new < 0 and new < old:
            return f"This would take {account.name} below ₹0."
        if abs(new) >= MAX_MONEY and abs(new) > abs(old):
            return f"This would take {account.name} past the largest balance allowed."
    return None


def _used_categories(db: Session, user_id: int, type_: str) -> list[str]:
    query = (
        select(Transaction.category)
        .where(
            Transaction.user_id == user_id,
            Transaction.type == type_,
            Transaction.category.is_not(None),
        )
        .distinct()
    )
    return [c for c in db.scalars(query) if c is not None]


def _known_spelling(db: Session, user_id: int, type_: str, category: str) -> str:
    """So that "groceries" and "Groceries" don't become two categories."""
    for known in [*DEFAULT_CATEGORIES[type_], *_used_categories(db, user_id, type_)]:
        if known.casefold() == category.casefold():
            return known
    return category


def _save_checks(
    db: Session,
    user_id: int,
    accounts: dict[int, Account],
    values: dict[str, Any],
    existing_id: int | None,
) -> None:
    _validate(values, accounts)
    before = load_movements(db, user_id)
    after = [m for m in before if m.id != existing_id]
    after.append(
        Movement(
            existing_id or 0,
            values["type"],
            values["amount"],
            values["account_id"],
            values["to_account_id"],
            values["interest"],
        )
    )
    problem = _balance_problem(accounts, before, after)
    if problem:
        raise RequestValidationError([field_error("amount", problem)])
    if values["type"] == "emi":
        values["category"] = EMI_CATEGORY
    elif values["category"] is not None:
        values["category"] = _known_spelling(db, user_id, values["type"], values["category"])


def _get_owned(db: Session, user_id: int, id: int) -> Transaction:
    # Ids outside the column's range can't exist; asking the database would be a 500.
    tx = None
    if 1 <= id <= MAX_ID:
        tx = db.scalar(
            select(Transaction).where(Transaction.id == id, Transaction.user_id == user_id)
        )
    if tx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    return tx


def _require_active(tx: Transaction, accounts: dict[int, Account]) -> None:
    for account_id in (tx.account_id, tx.to_account_id):
        account = None if account_id is None else accounts[account_id]
        if account is not None and account.archived_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Restore {account.name} before changing this transaction.",
            )


def _spent(tx: Transaction) -> Decimal:
    if tx.type == "expense":
        return tx.amount
    if tx.type == "emi" and tx.interest is not None:
        return tx.interest
    return Decimal(0)


@router.get("/categories")
def list_categories(user: CurrentUser, db: DbSession) -> CategoryList:
    def merged(type_: str) -> list[str]:
        defaults = DEFAULT_CATEGORIES[type_]
        extras = set(_used_categories(db, user.id, type_)) - set(defaults)
        return [*defaults, *sorted(extras, key=str.casefold)]

    return CategoryList(income=merged("income"), expense=merged("expense"))


@router.get("")
def list_transactions(
    user: CurrentUser,
    db: DbSession,
    account_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
    type: TransactionType | None = None,
    month: Annotated[str | None, Query(pattern=r"^[1-9][0-9]{3}-(0[1-9]|1[0-2])$")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=MAX_ID)] = 0,
) -> TransactionList:
    query = select(Transaction).where(Transaction.user_id == user.id)
    if account_id is not None:
        query = query.where(
            or_(Transaction.account_id == account_id, Transaction.to_account_id == account_id)
        )
    if type is not None:
        query = query.where(Transaction.type == type)
    if month is not None:
        year, number = int(month[:4]), int(month[5:])
        last = calendar.monthrange(year, number)[1]
        query = query.where(
            Transaction.date >= date(year, number, 1), Transaction.date <= date(year, number, last)
        )
    # Every match is loaded because the totals span them all, in Python for exact Decimal sums.
    matches = list(db.scalars(query.order_by(Transaction.date.desc(), Transaction.id.desc())))

    accounts = _all_accounts(db, user.id)
    page = matches[offset : offset + limit]
    return TransactionList(
        transactions=[_to_response(t, accounts) for t in page],
        has_more=offset + limit < len(matches),
        total_income=fmt(sum((t.amount for t in matches if t.type == "income"), Decimal(0))),
        total_expense=fmt(sum((_spent(t) for t in matches), Decimal(0))),
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_transaction(
    body: TransactionCreate, user: CurrentUser, db: DbSession
) -> TransactionResponse:
    values = body.model_dump()
    accounts = _lock_accounts(db, user.id, [values["account_id"], values["to_account_id"]])
    _save_checks(db, user.id, accounts, values, existing_id=None)
    tx = Transaction(user_id=user.id, **values)
    db.add(tx)
    db.commit()
    return _to_response(tx, accounts)


@router.get("/{id}")
def get_transaction(id: int, user: CurrentUser, db: DbSession) -> TransactionResponse:
    return _to_response(_get_owned(db, user.id, id), _all_accounts(db, user.id))


@router.patch("/{id}")
def update_transaction(
    id: int, body: TransactionUpdate, user: CurrentUser, db: DbSession
) -> TransactionResponse:
    tx = _get_owned(db, user.id, id)
    changes = body.model_dump(exclude_unset=True)
    values = {
        "type": tx.type,
        "account_id": tx.account_id,
        "to_account_id": tx.to_account_id,
        "amount": tx.amount,
        "date": tx.date,
        # An EMI's category is fixed, so it's only checked when the request sends one.
        "category": None if tx.type == "emi" else tx.category,
        "interest": tx.interest,
        "note": tx.note,
        **changes,
    }
    # The old accounts are locked too, because moving a transaction changes their balances as well.
    accounts = _lock_accounts(
        db,
        user.id,
        [tx.account_id, tx.to_account_id, values["account_id"], values["to_account_id"]],
    )
    _require_active(tx, accounts)
    _save_checks(db, user.id, accounts, values, existing_id=tx.id)
    for field, value in values.items():
        setattr(tx, field, value)
    db.commit()
    return _to_response(tx, accounts)


@router.delete("/{id}")
def delete_transaction(id: int, user: CurrentUser, db: DbSession) -> dict[str, int]:
    tx = _get_owned(db, user.id, id)
    accounts = _lock_accounts(db, user.id, [tx.account_id, tx.to_account_id])
    _require_active(tx, accounts)
    before = load_movements(db, user.id)
    problem = _balance_problem(accounts, before, [m for m in before if m.id != tx.id])
    if problem:
        raise HTTPException(status.HTTP_409_CONFLICT, problem)
    db.delete(tx)
    db.commit()
    return {"id": id}
