import calendar
import re
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal, NoReturn, get_args

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.balances import Movement, balance_of, load_movements, net_flows
from app.api.categories import (
    DEFAULTS,
    UNCATEGORISED,
    category_family,
    kind_of,
    name_key,
    picker_names,
    resolve,
)
from app.api.dates import iso_date, today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.policy_periods import LINKED as PERIOD_LINKED
from app.api.policy_periods import period_of, undo_renewal
from app.api.routes.accounts import (
    CAN_BE_NEGATIVE,
    DEPOSIT_TYPES,
    MAX_ID,
    MAX_MONEY,
    Money,
    clean_text,
    field_error,
    fmt,
)
from app.db.session import DbSession
from app.models.account import Account
from app.models.insurance import InsurancePolicy
from app.models.recurring import RecurringTemplate
from app.models.sms import SmsEntry
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/transactions", tags=["transactions"], dependencies=[Depends(get_current_user)]
)

TransactionType = Literal["income", "expense", "transfer", "emi"]
EMI_CATEGORY = "Loan interest"
_CHOOSE_TEMPLATE = "Choose a reminder of this type."

# The names every user starts with (the registry adds what they create).
DEFAULT_CATEGORIES = {kind: [name for name, _, _ in rows] for kind, rows in DEFAULTS.items()}


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


def _template_id(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise PydanticCustomError("template", _CHOOSE_TEMPLATE)
    return value


Kind = Annotated[TransactionType | None, BeforeValidator(_type)]
Day = Annotated[date | None, BeforeValidator(iso_date)]
AccountRef = Annotated[int | None, BeforeValidator(_account_id)]
Category = Annotated[
    str | None, BeforeValidator(lambda v: clean_text(v, "Enter a category.", limit=40))
]
Note = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, "Enter a note.", limit=200))]
TemplateRef = Annotated[int | None, BeforeValidator(_template_id)]


class TransactionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that they are reported like any other rule.
    type: Kind = None
    account_id: AccountRef = None
    to_account_id: AccountRef = None
    amount: Money = None
    date: Day = None
    category: Category = None
    interest: Money = None
    note: Note = None
    recurring_template_id: TemplateRef = None


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
    recurring_template_id: TemplateRef = None


class TransactionResponse(BaseModel):
    id: int
    type: str
    amount: str
    date: str
    account_id: int
    account_name: str
    to_account_id: int | None
    to_account_name: str | None
    # None only on income or an expense recorded from an SMS that isn't categorised yet.
    category: str | None
    interest: str | None
    note: str | None
    recurring_template_id: int | None
    from_sms: bool
    # False once a linked account is archived; restore the account to change the transaction.
    editable: bool


class CategorySpend(BaseModel):
    category: str
    amount: str


class TransactionList(BaseModel):
    transactions: list[TransactionResponse]
    has_more: bool
    # Over every transaction matching the filters, not just this page. Transfers count in neither;
    # an EMI's interest counts as spending.
    total_income: str
    total_expense: str
    # The same spending as total_expense, split by category: at most 5 entries, biggest first.
    expense_by_category: list["CategorySpend"]


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
        recurring_template_id=tx.recurring_template_id,
        from_sms=tx.source == "sms",
        editable=account.archived_at is None and (target is None or target.archived_at is None),
    )


def _all_accounts(db: Session, user_id: int) -> dict[int, Account]:
    accounts = db.scalars(select(Account).where(Account.user_id == user_id))
    return {a.id: a for a in accounts}


def lock_accounts(db: Session, user_id: int, ids: Iterable[int | None]) -> dict[int, Account]:
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


def validate_transaction_values(
    values: dict[str, Any], accounts: dict[int, Account], allow_uncategorised: bool = False
) -> None:
    """`allow_uncategorised` lets income or an expense have no category: only SMS recording
    (and editing what it recorded, while still uncategorised) passes it."""
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
        if values["category"] is None and not allow_uncategorised:
            errors.append(field_error("category", "Choose a category."))

    if type_ != "emi" and values["interest"] is not None:
        errors.append(field_error("interest", "Only an EMI has an interest part."))

    _validate_deposits(values, accounts, errors)

    if errors:
        raise RequestValidationError(errors)


def _deposit_name(account: Account) -> str:
    return "PPF account" if account.type == "ppf" else "RD"


def _validate_deposits(
    values: dict[str, Any], accounts: dict[int, Account], errors: list[dict[str, Any]]
) -> None:
    """A PPF or RD takes deposits, interest and withdrawals to a bank, and nothing else."""
    type_ = values["type"]
    source = accounts.get(values["account_id"] or 0)
    target = accounts.get(values["to_account_id"] or 0)
    found: list[tuple[str, str]] = []  # (field, message)

    def deposit(account: Account | None) -> bool:
        return account is not None and account.type in DEPOSIT_TYPES

    def only(account: Account) -> str:
        article = "An" if account.type == "rd" else "A"
        what = f"{article} {_deposit_name(account)}"
        return f"{what} only takes deposits, interest and withdrawals to a bank."

    if type_ in ("expense", "emi") and source is not None and deposit(source):
        found.append(("account_id", only(source)))
    if type_ == "emi" and target is not None and deposit(target):
        found.append(("to_account_id", only(target)))
    if type_ == "income" and source is not None and deposit(source):
        category = values["category"]
        if category is not None and category.casefold() != "interest":
            article = "an" if source.type == "rd" else "a"
            found.append(
                (
                    "category",
                    f"Interest is the only income {article} {_deposit_name(source)} takes.",
                )
            )
    if type_ == "transfer" and source is not None and target is not None:
        if deposit(target) and source.type != "bank":
            found.append(("account_id", only(target)))
        if deposit(source) and target.type != "bank":
            found.append(("to_account_id", only(source)))

    for field, message in found:
        errors[:] = [e for e in errors if e["loc"][1] != field]
        errors.append(field_error(field, message))


def _validate_emi(
    values: dict[str, Any], accounts: dict[int, Account], errors: list[dict[str, Any]]
) -> None:
    payer = accounts.get(values["account_id"] or 0)
    if (
        payer is not None
        and payer.type == "loan"
        and not any(e["loc"][1] == "account_id" for e in errors)
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


def balance_problem(
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


def _check_template(db: Session, user_id: int, values: dict[str, Any]) -> None:
    """A linked reminder must be the owner's, of the transaction's type, and not a policy's."""
    template_id = values["recurring_template_id"]
    if template_id is None:
        return
    template = None
    if 1 <= template_id <= MAX_ID:
        # Locked, so deleting the reminder waits for this save.
        template = db.scalar(
            select(RecurringTemplate)
            .where(RecurringTemplate.id == template_id, RecurringTemplate.user_id == user_id)
            .with_for_update()
        )
    if template is None or template.type != values["type"]:
        raise RequestValidationError([field_error("recurring_template_id", _CHOOSE_TEMPLATE)])
    if db.scalar(select(InsurancePolicy.id).where(InsurancePolicy.template_id == template_id)):
        raise RequestValidationError(
            [field_error("recurring_template_id", "Renew the policy instead.")]
        )


def _template_gone(db: Session) -> NoReturn:
    db.rollback()
    raise RequestValidationError([field_error("recurring_template_id", _CHOOSE_TEMPLATE)]) from None


def save_checks(
    db: Session,
    user_id: int,
    accounts: dict[int, Account],
    values: dict[str, Any],
    existing_id: int | None,
    link_changed: bool = True,
    allow_uncategorised: bool = False,
) -> None:
    """Every rule a transaction is saved under, the balance check included.

    `link_changed=False` skips the reminder-link check: an unchanged link is left alone, so a
    policy's payment stays editable, and a policy's renewal checks its own template.
    """
    validate_transaction_values(values, accounts, allow_uncategorised)
    if link_changed:
        _check_template(db, user_id, values)
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
    problem = balance_problem(accounts, before, after)
    if problem:
        raise RequestValidationError([field_error("amount", problem)])
    if values["type"] == "emi":
        values["category"] = EMI_CATEGORY
    elif values["category"] is not None:
        # The registry's spelling; an edit may keep the archived category it already had.
        kept = None if existing_id is None else db.get(Transaction, existing_id)
        values["category"] = resolve(
            db,
            user_id,
            kind_of(values["type"]) or "expense",
            values["category"],
            keep=None if kept is None else kept.category,
        )


def _query_error(field: str, message: str) -> NoReturn:
    raise RequestValidationError([{"loc": ("query", field), "msg": message, "type": "value_error"}])


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


def _lock_transaction(
    db: Session, user_id: int, id: int, also: Iterable[int | None] = ()
) -> tuple[Transaction, dict[int, Account]]:
    """The transaction and its accounts, locked, then the transaction re-read under its own lock.

    The first read only says which accounts to lock. By the time they are locked, another request
    may have deleted the transaction (404) or moved it to other accounts, which would leave the
    wrong ones locked (409, so the client retries).
    """
    first = _get_owned(db, user_id, id)
    seen = (first.account_id, first.to_account_id)
    accounts = lock_accounts(db, user_id, [*seen, *also])
    tx = db.scalar(
        select(Transaction)
        .where(Transaction.id == id, Transaction.user_id == user_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if tx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    if (tx.account_id, tx.to_account_id) != seen:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This transaction changed while saving. Try again."
        )
    return tx, accounts


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


TOP_CATEGORIES = 4


def expense_breakdown(matches: list[Transaction]) -> list[CategorySpend]:
    """Spending (see `_spent`) by category: the top four named, then the rest as "Other".

    No category (an SMS expense not yet categorised) shows as "Uncategorised"."""
    totals: dict[str, Decimal] = {}
    for tx in matches:
        spent = _spent(tx)
        if spent == 0:
            continue
        name = "EMI interest" if tx.type == "emi" else tx.category or "Uncategorised"
        totals[name] = totals.get(name, Decimal(0)) + spent
    ranked = sorted(totals.items(), key=lambda item: (-item[1], item[0]))
    if len(ranked) > TOP_CATEGORIES + 1:
        # Four named categories, then everything else (any existing "Other" too) as one.
        head = [(name, v) for name, v in ranked if name != "Other"][:TOP_CATEGORIES]
        kept = {name for name, _ in head}
        merged = sum((v for name, v in ranked if name not in kept), Decimal(0))
        ranked = [*head, ("Other", merged)]
    return [CategorySpend(category=name, amount=fmt(value)) for name, value in ranked]


@router.get("/categories")
def list_categories(user: CurrentUser, db: DbSession) -> CategoryList:
    """The names the pickers offer: live, unarchived categories. `/categories` has the detail."""
    result = CategoryList(
        income=picker_names(db, user.id, "income"), expense=picker_names(db, user.id, "expense")
    )
    db.commit()  # a first read seeds the defaults
    return result


@router.get("")
def list_transactions(
    user: CurrentUser,
    db: DbSession,
    account_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
    type: TransactionType | None = None,
    month: Annotated[str | None, Query(pattern=r"^[1-9][0-9]{3}-(0[1-9]|1[0-2])$")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=MAX_ID)] = 0,
    q: Annotated[str | None, Query(max_length=100)] = None,
    date_from: date | None = None,
    date_to: date | None = None,
    category: Annotated[str | None, Query(max_length=40)] = None,
    amount_min: Annotated[Decimal | None, Query(ge=0, lt=MAX_MONEY, decimal_places=2)] = None,
    amount_max: Annotated[Decimal | None, Query(ge=0, lt=MAX_MONEY, decimal_places=2)] = None,
) -> TransactionList:
    """Newest first. `q` finds text in the note, the SMS payee or the category; `category`
    includes a parent's subcategories, and "Uncategorised" finds income and expenses without one."""
    if date_from is not None and date_to is not None and date_from > date_to:
        _query_error("date_to", "The end date can't be before the start.")
    if amount_min is not None and amount_max is not None and amount_min > amount_max:
        _query_error("amount_max", "The highest amount can't be below the lowest.")
    query = select(Transaction).where(Transaction.user_id == user.id)
    if date_from is not None:
        query = query.where(Transaction.date >= date_from)
    if date_to is not None:
        query = query.where(Transaction.date <= date_to)
    if amount_min is not None:
        query = query.where(Transaction.amount >= amount_min)
    if amount_max is not None:
        query = query.where(Transaction.amount <= amount_max)
    text = None if q is None else q.strip()
    if text:
        # LIKE's own characters are matched literally.
        pattern = "%" + re.sub(r"([\\%_])", r"\\\1", text.lower()) + "%"
        payee = (
            select(SmsEntry.id)
            .where(
                SmsEntry.user_id == user.id,
                SmsEntry.transaction_id == Transaction.id,
                func.lower(SmsEntry.payee).like(pattern, escape="\\"),
            )
            .exists()
        )
        query = query.where(
            or_(
                func.lower(Transaction.note).like(pattern, escape="\\"),
                func.lower(Transaction.category).like(pattern, escape="\\"),
                payee,
            )
        )
    wanted = None if category is None else category.strip()
    if wanted:
        if name_key(wanted) == name_key(UNCATEGORISED):
            query = query.where(
                Transaction.category.is_(None), Transaction.type.in_(("income", "expense"))
            )
        else:
            names = category_family(db, user.id, wanted)
            query = query.where(func.lower(Transaction.category).in_([n.lower() for n in names]))
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
        expense_by_category=expense_breakdown(matches),
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_transaction(
    body: TransactionCreate, user: CurrentUser, db: DbSession
) -> TransactionResponse:
    values = body.model_dump()
    accounts = lock_accounts(db, user.id, [values["account_id"], values["to_account_id"]])
    save_checks(db, user.id, accounts, values, existing_id=None)
    tx = Transaction(user_id=user.id, **values)
    db.add(tx)
    try:
        db.commit()
    except IntegrityError:  # its reminder was deleted since it was checked
        if values["recurring_template_id"] is None:
            db.rollback()
            raise
        _template_gone(db)
    return _to_response(tx, accounts)


@router.get("/{id}")
def get_transaction(id: int, user: CurrentUser, db: DbSession) -> TransactionResponse:
    return _to_response(_get_owned(db, user.id, id), _all_accounts(db, user.id))


@router.patch("/{id}")
def update_transaction(
    id: int, body: TransactionUpdate, user: CurrentUser, db: DbSession
) -> TransactionResponse:
    changes = body.model_dump(exclude_unset=True)
    # The old accounts are locked too, because moving a transaction changes their balances as well.
    tx, accounts = _lock_transaction(
        db, user.id, id, [changes.get("account_id"), changes.get("to_account_id")]
    )
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
        "recurring_template_id": tx.recurring_template_id,
        **changes,
    }
    _require_active(tx, accounts)
    link_changed = values["recurring_template_id"] != tx.recurring_template_id
    if link_changed and period_of(db, tx.id) is not None:
        raise RequestValidationError([field_error("recurring_template_id", PERIOD_LINKED)])
    # An SMS transaction waiting in review for its category can still be edited meanwhile.
    uncategorised_sms = tx.category is None and tx.source == "sms"
    save_checks(
        db,
        user.id,
        accounts,
        values,
        existing_id=tx.id,
        link_changed=link_changed,
        allow_uncategorised=uncategorised_sms,
    )
    for field, value in values.items():
        setattr(tx, field, value)
    try:
        db.commit()
    except IntegrityError:  # its reminder was deleted since it was checked
        if values["recurring_template_id"] is None:
            db.rollback()
            raise
        _template_gone(db)
    return _to_response(tx, accounts)


@router.delete("/{id}")
def delete_transaction(id: int, user: CurrentUser, db: DbSession) -> dict[str, int]:
    tx, accounts = _lock_transaction(db, user.id, id)
    _require_active(tx, accounts)
    before = load_movements(db, user.id)
    problem = balance_problem(accounts, before, [m for m in before if m.id != tx.id])
    if problem:
        raise HTTPException(status.HTTP_409_CONFLICT, problem)
    # A policy's latest renewal goes with its payment; an earlier one's payment stays.
    undo_renewal(db, user.id, tx)
    # The SMS it came from stays known, so sending that message again doesn't bring it back.
    db.execute(
        update(SmsEntry)
        .where(SmsEntry.user_id == user.id, SmsEntry.transaction_id == tx.id)
        .values(status="ignored", transaction_id=None)
    )
    db.delete(tx)
    db.commit()
    return {"id": id}
