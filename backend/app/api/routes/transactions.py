import calendar
import re
from collections.abc import Iterable
from datetime import date, timedelta
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
    rupees,
)
from app.api.suggest import suggest_category
from app.db.session import DbSession
from app.models.account import Account
from app.models.corporate_action import delete_links_for_transactions
from app.models.insurance import InsurancePolicy
from app.models.recurring import RecurringTemplate
from app.models.sms import SmsEntry
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/transactions", tags=["transactions"], dependencies=[Depends(get_current_user)]
)

TransactionType = Literal["income", "expense", "transfer", "emi", "refund", "adjustment"]
ADJUST_REASON = "Say why the balance changed."
_CHOOSE_PURCHASE = "Choose the purchase refunded."
# How far back a purchase is suggested for a refund, and how many at most.
REFUNDABLE_DAYS = 180
REFUNDABLE_LIMIT = 20
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


def _purchase_id(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise PydanticCustomError("purchase", _CHOOSE_PURCHASE)
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
PurchaseRef = Annotated[int | None, BeforeValidator(_purchase_id)]


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
    refund_of_id: PurchaseRef = None


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
    refund_of_id: PurchaseRef = None


class SplitTag(BaseModel):
    """Where a transaction sits in a split bill: `id` is the original's, part 1 is the original."""

    id: int
    part: int
    parts: int


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
    refund_of_id: int | None  # a refund's purchase, when linked
    refunded: str | None  # an expense's linked refunds; None when there are none
    from_sms: bool
    # False once a linked account is archived; restore the account to change the transaction.
    editable: bool
    split: SplitTag | None  # None unless it's part of a split bill


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


class CategorySuggestion(BaseModel):
    category: str | None
    source: Literal["history", "keywords"] | None


def refunded_totals(db: Session, user_id: int, ids: Iterable[int]) -> dict[int, Decimal]:
    """What the refunds linked to each of these purchases add up to (a purchase with none
    is left out)."""
    wanted = list(ids)
    if not wanted:
        return {}
    rows = db.execute(
        select(Transaction.refund_of_id, Transaction.amount).where(
            Transaction.user_id == user_id,
            Transaction.type == "refund",
            Transaction.refund_of_id.in_(wanted),
        )
    )
    totals: dict[int, Decimal] = {}
    for purchase_id, amount in rows:
        totals[purchase_id] = totals.get(purchase_id, Decimal(0)) + amount
    return totals


def split_tags(db: Session, user_id: int, txs: Iterable[Transaction]) -> dict[int, SplitTag]:
    """Each split transaction's place in its bill, by transaction id."""
    roots = {tx.split_of_id or tx.id for tx in txs}
    if not roots:
        return {}
    members = db.execute(
        select(Transaction.id, Transaction.split_of_id)
        .where(
            Transaction.user_id == user_id,
            or_(Transaction.split_of_id.in_(roots), Transaction.id.in_(roots)),
        )
        .order_by(Transaction.id)
    ).all()
    bills: dict[int, list[int]] = {}
    for id_, root in members:
        bills.setdefault(root or id_, []).append(id_)
    tags: dict[int, SplitTag] = {}
    for root, ids in bills.items():
        if len(ids) < 2:
            continue
        ordered = [root, *[i for i in ids if i != root]]
        for n, id_ in enumerate(ordered, 1):
            tags[id_] = SplitTag(id=root, part=n, parts=len(ordered))
    return tags


def _to_response(
    tx: Transaction,
    accounts: dict[int, Account],
    refunded: Decimal | None = None,
    split: SplitTag | None = None,
) -> TransactionResponse:
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
        refund_of_id=tx.refund_of_id,
        refunded=None if not refunded else fmt(refunded),
        from_sms=tx.source == "sms",
        editable=account.archived_at is None and (target is None or target.archived_at is None),
        split=split,
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
    elif type_ == "adjustment":
        # Signed: what the correction moved into (or, below 0, out of) the account.
        if amount == 0:
            errors.append(field_error("amount", "An adjustment can't be ₹0."))
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
    elif type_ == "adjustment":
        if target is not None:
            errors.append(field_error("to_account_id", "Only a transfer has a second account."))
        if values["category"] is not None:
            message = "An adjustment doesn't have a category."
            errors.append(field_error("category", message))
        if values["note"] is None:
            errors.append(field_error("note", ADJUST_REASON))
    elif type_ is not None:
        if target is not None:
            errors.append(field_error("to_account_id", "Only a transfer has a second account."))
        # A linked refund takes its purchase's category (`_check_refund`).
        linked = type_ == "refund" and values.get("refund_of_id") is not None
        if values["category"] is None and not allow_uncategorised and not linked:
            errors.append(field_error("category", "Choose a category."))
    if type_ != "refund" and values.get("refund_of_id") is not None:
        errors.append(field_error("refund_of_id", "Only a refund links to a purchase."))

    if type_ != "emi" and values["interest"] is not None:
        errors.append(field_error("interest", "Only an EMI has an interest part."))

    _validate_deposits(values, accounts, errors)

    if errors:
        raise RequestValidationError(errors)


_DEPOSIT_NAMES = {"ppf": "PPF account", "rd": "RD", "fd": "FD"}


def _deposit_name(account: Account) -> str:
    return _DEPOSIT_NAMES[account.type]


def _article(account: Account) -> str:
    """The article before the name: an RD, an FD, a PPF account."""
    return "an" if account.type in ("rd", "fd") else "a"


def _validate_deposits(
    values: dict[str, Any], accounts: dict[int, Account], errors: list[dict[str, Any]]
) -> None:
    """A PPF, RD or FD takes deposits, interest and withdrawals to a bank, and nothing else."""
    type_ = values["type"]
    source = accounts.get(values["account_id"] or 0)
    target = accounts.get(values["to_account_id"] or 0)
    found: list[tuple[str, str]] = []  # (field, message)

    def deposit(account: Account | None) -> bool:
        return account is not None and account.type in DEPOSIT_TYPES

    def only(account: Account) -> str:
        what = f"{_article(account).capitalize()} {_deposit_name(account)}"
        return f"{what} only takes deposits, interest and withdrawals to a bank."

    if type_ in ("expense", "emi", "refund") and source is not None and deposit(source):
        found.append(("account_id", only(source)))
    if type_ == "emi" and target is not None and deposit(target):
        found.append(("to_account_id", only(target)))
    if type_ == "income" and source is not None and deposit(source):
        category = values["category"]
        if category is not None and category.casefold() != "interest":
            what = f"{_article(source)} {_deposit_name(source)}"
            found.append(("category", f"Interest is the only income {what} takes."))
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
    purchase = _check_refund(db, user_id, values, existing_id)
    if values["type"] == "expense" and existing_id is not None:
        _check_refunded(db, user_id, values, existing_id)
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
        # A linked refund keeps its purchase's category even once that is archived.
        keep = None if purchase is None else purchase.category
        values["category"] = resolve(
            db,
            user_id,
            kind_of(values["type"]) or "expense",
            values["category"],
            keep=keep if kept is None else kept.category,
        )


def _check_refund(
    db: Session, user_id: int, values: dict[str, Any], existing_id: int | None
) -> Transaction | None:
    """A linked refund's purchase: the owner's expense, dated no later than the refund, with
    enough left to refund. The refund takes its category. Returns the purchase, locked."""
    purchase_id = values.get("refund_of_id")
    if values["type"] != "refund" or purchase_id is None:
        return None
    purchase = None
    if 1 <= purchase_id <= MAX_ID and purchase_id != existing_id:
        # Locked, so two refunds saved at once can't together pass what is left.
        purchase = db.scalar(
            select(Transaction)
            .where(
                Transaction.id == purchase_id,
                Transaction.user_id == user_id,
                Transaction.type == "expense",
            )
            .with_for_update()
        )
    if purchase is None:
        raise RequestValidationError([field_error("refund_of_id", _CHOOSE_PURCHASE)])
    if values["date"] < purchase.date:
        message = "A refund can't be dated before its purchase."
        raise RequestValidationError([field_error("date", message)])
    others = refunded_totals(db, user_id, [purchase.id]).get(purchase.id, Decimal(0))
    if existing_id is not None:
        current = db.get(Transaction, existing_id)
        if current is not None and current.refund_of_id == purchase.id:
            others -= current.amount
    left = purchase.amount - others
    if values["amount"] > left:
        message = f"Only {rupees(left)} of this purchase is left to refund."
        raise RequestValidationError([field_error("amount", message)])
    given = values["category"]
    if given is not None and (purchase.category or "").casefold() != given.casefold():
        message = "A linked refund takes its purchase's category."
        raise RequestValidationError([field_error("category", message)])
    values["category"] = purchase.category
    return purchase


def _check_refunded(db: Session, user_id: int, values: dict[str, Any], existing_id: int) -> None:
    """A purchase can't be made smaller than what its linked refunds already gave back. Only a
    smaller amount is checked, so an edit that keeps it costs no query."""
    current = db.get(Transaction, existing_id)  # already loaded and locked by the caller
    if current is None or values["amount"] >= current.amount:
        return
    refunded = refunded_totals(db, user_id, [existing_id]).get(existing_id, Decimal(0))
    if values["amount"] < refunded:
        message = f"{rupees(refunded)} of this purchase is already refunded."
        raise RequestValidationError([field_error("amount", message)])


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
    """As the month report counts it (`cash_flow.spent`): a refund gives spending back."""
    if tx.type == "expense":
        return tx.amount
    if tx.type == "emi" and tx.interest is not None:
        return tx.interest
    if tx.type == "refund":
        return -tx.amount
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


@router.get("/suggest-category")
def suggest_category_route(
    user: CurrentUser,
    db: DbSession,
    type: Literal["expense", "income"],
    note: Annotated[str, Query(max_length=200)] = "",
) -> CategorySuggestion:
    """The category a note most likely belongs to: the owner's history, then everyday words."""
    category, source = suggest_category(db, user.id, type, note)
    db.commit()  # a first read seeds the defaults
    return CategorySuggestion(category=category, source=source)


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
                Transaction.category.is_(None),
                Transaction.type.in_(("income", "expense", "refund")),
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
    refunded = refunded_totals(db, user.id, [t.id for t in page if t.type == "expense"])
    tags = split_tags(db, user.id, page)
    return TransactionList(
        transactions=[_to_response(t, accounts, refunded.get(t.id), tags.get(t.id)) for t in page],
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


class RefundablePurchase(BaseModel):
    id: int
    date: str
    amount: str
    left: str  # what is still unrefunded
    category: str | None
    account_id: int
    account_name: str
    note: str | None


class RefundableList(BaseModel):
    purchases: list[RefundablePurchase]


@router.get("/refundable")
def list_refundable(
    user: CurrentUser,
    db: DbSession,
    day: Annotated[date | None, Query(alias="date")] = None,
    amount: Annotated[Decimal | None, Query(gt=0, lt=MAX_MONEY, decimal_places=2)] = None,
    exclude_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
) -> RefundableList:
    """Purchases a refund on `date` (default today) could be for: expenses from the
    `REFUNDABLE_DAYS` before it with at least `amount` still unrefunded, newest first.
    `exclude_id` is a refund being edited, so its own amount counts as still refundable."""
    on = day or today_india()
    rows = list(
        db.scalars(
            select(Transaction)
            .where(
                Transaction.user_id == user.id,
                Transaction.type == "expense",
                Transaction.date <= on,
                Transaction.date >= on - timedelta(days=REFUNDABLE_DAYS),
            )
            .order_by(Transaction.date.desc(), Transaction.id.desc())
        )
    )
    refunded = refunded_totals(db, user.id, [t.id for t in rows])
    if exclude_id is not None:
        editing = db.scalar(
            select(Transaction).where(Transaction.id == exclude_id, Transaction.user_id == user.id)
        )
        if editing is not None and editing.refund_of_id in refunded:
            refunded[editing.refund_of_id] -= editing.amount
    accounts = _all_accounts(db, user.id)
    found: list[RefundablePurchase] = []
    for t in rows:
        left = t.amount - refunded.get(t.id, Decimal(0))
        if left <= 0 or (amount is not None and left < amount):
            continue
        found.append(
            RefundablePurchase(
                id=t.id,
                date=t.date.isoformat(),
                amount=fmt(t.amount),
                left=fmt(left),
                category=t.category,
                account_id=t.account_id,
                account_name=accounts[t.account_id].name,
                note=t.note,
            )
        )
        if len(found) == REFUNDABLE_LIMIT:
            break
    return RefundableList(purchases=found)


class SplitPartIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Category = None
    amount: Money = None


class SplitIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parts: list[SplitPartIn]


class SplitPart(BaseModel):
    id: int
    category: str | None
    amount: str


class SplitOut(BaseModel):
    """A split bill: `id` is the original's, which is part 1."""

    id: int
    total: str
    parts: list[SplitPart]


MAX_SPLIT_PARTS = 20
CHANGE_THE_SPLIT = "Change the split instead."


def _split_root(db: Session, user_id: int, id: int) -> Transaction:
    tx = _get_owned(db, user_id, id)
    return tx if tx.split_of_id is None else _get_owned(db, user_id, tx.split_of_id)


def _split_rows(db: Session, user_id: int, root: Transaction) -> list[Transaction]:
    """The bill's original, then its other parts by id."""
    parts = db.scalars(
        select(Transaction)
        .where(Transaction.user_id == user_id, Transaction.split_of_id == root.id)
        .order_by(Transaction.id)
    )
    return [root, *parts]


def _split_out(rows: list[Transaction]) -> SplitOut:
    return SplitOut(
        id=rows[0].id,
        total=fmt(sum((r.amount for r in rows), Decimal(0))),
        parts=[SplitPart(id=r.id, category=r.category, amount=fmt(r.amount)) for r in rows],
    )


def _split_error(message: str) -> NoReturn:
    raise RequestValidationError([field_error("parts", message)])


def _refunds_follow(db: Session, user_id: int, purchase: Transaction) -> None:
    """A purchase's linked refunds give spending back in its category."""
    db.execute(
        update(Transaction)
        .where(
            Transaction.user_id == user_id,
            Transaction.type == "refund",
            Transaction.refund_of_id == purchase.id,
        )
        .values(category=purchase.category)
    )


@router.get("/{id}/split")
def get_split(id: int, user: CurrentUser, db: DbSession) -> SplitOut:
    """A bill's parts, asked for by the original or by any part."""
    return _split_out(_split_rows(db, user.id, _split_root(db, user.id, id)))


@router.put("/{id}/split")
def put_split(id: int, body: SplitIn, user: CurrentUser, db: DbSession) -> SplitOut:
    """Split an expense into parts, change its split, or undo it with one part (the whole bill).
    Part 1 is the original; the others share its date, account, note and source."""
    root, accounts = _lock_transaction(db, user.id, _split_root(db, user.id, id).id)
    _require_active(root, accounts)
    if root.type != "expense":
        _split_error("Only an expense can be split.")
    if not 1 <= len(body.parts) <= MAX_SPLIT_PARTS:
        _split_error(f"Split into 2 to {MAX_SPLIT_PARTS} parts.")
    if any(p.category is None for p in body.parts):
        _split_error("Each part needs a category.")
    amounts = [p.amount for p in body.parts]
    if any(a is None or a <= 0 for a in amounts):
        _split_error("Each part needs an amount above 0.")
    rows = _split_rows(db, user.id, root)
    total = sum((r.amount for r in rows), Decimal(0))
    given = sum((a for a in amounts if a is not None), Decimal(0))
    if given != total:
        _split_error(f"The parts add up to {rupees(given)}; the bill is {rupees(total)}.")
    names = [resolve(db, user.id, "expense", p.category or "") for p in body.parts]
    extra = rows[1:]
    kept: list[Transaction] = [root]
    for n, (amount, name) in enumerate(zip(amounts, names, strict=True)):
        if n == 0:
            row = root
        elif n - 1 < len(extra):
            row = extra[n - 1]
        else:
            row = Transaction(
                user_id=user.id,
                type=root.type,
                date=root.date,
                account_id=root.account_id,
                note=root.note,
                source=root.source,
                split_of_id=root.id,
            )
            db.add(row)
        row.amount, row.category = amount, name  # type: ignore[assignment]
        if row is not root:
            kept.append(row)
    db.flush()
    for gone in extra[len(body.parts) - 1 :]:
        # Refunds of a removed part now belong to the bill's original.
        db.execute(
            update(Transaction)
            .where(Transaction.user_id == user.id, Transaction.refund_of_id == gone.id)
            .values(refund_of_id=root.id)
        )
        db.delete(gone)
    for row in kept:
        _refunds_follow(db, user.id, row)
    db.commit()
    return _split_out(_split_rows(db, user.id, root))


@router.get("/{id}")
def get_transaction(id: int, user: CurrentUser, db: DbSession) -> TransactionResponse:
    tx = _get_owned(db, user.id, id)
    refunded = refunded_totals(db, user.id, [tx.id]).get(tx.id)
    split = split_tags(db, user.id, [tx]).get(tx.id)
    return _to_response(tx, _all_accounts(db, user.id), refunded, split)


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
        "refund_of_id": tx.refund_of_id,
        **changes,
    }
    _require_active(tx, accounts)
    link_changed = values["recurring_template_id"] != tx.recurring_template_id
    if link_changed and period_of(db, tx.id) is not None:
        raise RequestValidationError([field_error("recurring_template_id", PERIOD_LINKED)])
    # An SMS transaction waiting in review for its category can still be edited meanwhile.
    uncategorised_sms = tx.category is None and tx.source in ("sms", "statement")
    save_checks(
        db,
        user.id,
        accounts,
        values,
        existing_id=tx.id,
        link_changed=link_changed,
        allow_uncategorised=uncategorised_sms,
    )
    old_category = tx.category
    for field, value in values.items():
        setattr(tx, field, value)
    if tx.type == "expense" and tx.category != old_category:
        # Its linked refunds give spending back in the purchase's category, wherever it moves.
        db.execute(
            update(Transaction)
            .where(
                Transaction.user_id == user.id,
                Transaction.type == "refund",
                Transaction.refund_of_id == tx.id,
            )
            .values(category=tx.category)
        )
    try:
        db.commit()
    except IntegrityError:  # its reminder was deleted since it was checked
        if values["recurring_template_id"] is None:
            db.rollback()
            raise
        _template_gone(db)
    refunded = refunded_totals(db, user.id, [tx.id]).get(tx.id)
    return _to_response(tx, accounts, refunded, split_tags(db, user.id, [tx]).get(tx.id))


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
    # A dividend it was linked to just loses the link (links are notes, not money).
    delete_links_for_transactions(db, user.id, [tx.id])
    # Its refunds stay, unlinked, keeping the category they give spending back in.
    db.execute(
        update(Transaction)
        .where(Transaction.user_id == user.id, Transaction.refund_of_id == tx.id)
        .values(refund_of_id=None)
    )
    db.delete(tx)
    db.commit()
    return {"id": id}
