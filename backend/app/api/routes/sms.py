"""Bank SMS from the phone: parsed fields and a hash only, never the message text.

Also the To review list, which answers what ingestion couldn't decide, the payee rules and card
numbers those answers taught, and masked samples of messages no parser understood.
"""

import re
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.categories import resolve, rule_kind
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import MAX_ID, Flag, Money, field_error, fmt
from app.api.routes.funds import Nav, Units
from app.api.routes.stocks import StockName, Symbol
from app.api.routes.trades import Side
from app.api.routes.transactions import AccountRef, Category, Day, TemplateRef
from app.db.session import DbSession
from app.models.account import Account
from app.models.recurring import RecurringTemplate
from app.models.sms import AccountIdentifier, PayeeRule, SmsEntry, SmsSample
from app.sms import confidence, recording, review
from app.sms.ingest import decide

router = APIRouter(prefix="/sms", tags=["sms"], dependencies=[Depends(get_current_user)])
rules_router = APIRouter(
    prefix="/payee-rules", tags=["sms"], dependencies=[Depends(get_current_user)]
)

SmsKind = Literal["debit", "credit", "card_spend", "card_payment", "card_statement", "demat"]


class ParsedSms(BaseModel):
    """One message as the phone's parser read it."""

    model_config = ConfigDict(extra="forbid")

    # SHA-256 of the message, so the same SMS sent twice is recognised.
    hash: Annotated[str, Field(pattern=r"^[0-9a-fA-F]{64}$")]
    sender: Annotated[str, Field(min_length=1, max_length=20)]
    # The parser key, such as "hdfc".
    bank: Annotated[str, Field(min_length=1, max_length=30)]
    kind: SmsKind
    amount: Money = None
    date: Day
    last4: Annotated[str | None, Field(pattern=r"^[0-9]{4}$")] = None
    payee: Annotated[str | None, Field(max_length=120)] = None
    ref: Annotated[str | None, Field(max_length=40)] = None
    balance: Money = None
    isin: Annotated[str | None, Field(pattern=r"^[A-Za-z0-9]{12}$")] = None
    quantity: Annotated[Decimal | None, Field(gt=0, max_digits=24, decimal_places=8)] = None
    due_date: Day = None

    @model_validator(mode="after")
    def _rules(self) -> "ParsedSms":
        self.hash = self.hash.lower()
        if self.date is None:
            raise PydanticCustomError("date", "Choose a date.")
        if self.date > today_india():
            raise PydanticCustomError("date", "The date can't be in the future.")
        if self.amount is None and self.kind != "demat":
            raise PydanticCustomError("amount", "Enter an amount.")
        if self.amount is not None and self.amount <= 0:
            raise PydanticCustomError("amount", "Amount must be greater than 0.")
        if self.payee is not None:
            self.payee = " ".join(self.payee.split()) or None
        if self.ref is not None:
            self.ref = self.ref.strip() or None
        return self


class SmsBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: Annotated[list[ParsedSms], Field(min_length=1, max_length=100)]


class SmsResult(BaseModel):
    hash: str
    # What became of the message: "recorded", "review", "draft", "ignored" or "duplicate".
    status: str
    reason: str | None


class SmsResults(BaseModel):
    results: list[SmsResult]


@router.post("/entries")
def post_entries(body: SmsBatch, user: CurrentUser, db: DbSession) -> SmsResults:
    """Decides each message in order and commits it on its own, so one can't undo another."""
    results = []
    for sms in body.entries:
        recording.lock_user(db, user.id)
        entry, repeat = decide(db, user.id, sms)
        db.commit()
        if repeat:
            results.append(SmsResult(hash=sms.hash, status="duplicate", reason=None))
        else:
            results.append(SmsResult(hash=sms.hash, status=entry.status, reason=entry.reason))
    return SmsResults(results=results)


# To review


class ReviewItem(BaseModel):
    id: int
    status: str  # "review", or "draft" for a share movement to confirm as a trade
    kind: str
    reason: str | None
    message: str | None
    amount: str | None
    date: str
    payee: str | None
    last4: str | None
    account_id: int | None
    account_name: str | None
    transaction_id: int | None
    trade_id: int | None
    isin: str | None
    quantity: str | None
    # Each {"kind": str, "id": int, "label": str}; a SIP may add "needs_nav": true.
    candidates: list[dict[str, Any]] | None
    suggested_price: str | None  # a draft trade's stock price on the day, or the latest before
    # The category the payee's rule or history suggests, and where it came from: "rule" (a payee
    # rule or the built-in list) or "history" (`history_count` of the latest `history_total`).
    suggested_category: str | None
    suggestion_source: str | None
    history_count: int
    history_total: int
    # For a message whose account is unknown: the one account the payee's earlier messages used.
    suggested_account_id: int | None
    # Approvable with "Approve all confident"; `why` says why it is or what needs a look.
    confident: bool
    why: str


class CategoryTotal(BaseModel):
    category: str
    type: str  # "income" or "expense"
    count: int
    amount: str


class ConfidentSummary(BaseModel):
    count: int
    spent: str
    received: str
    categories: list[CategoryTotal]


class ReviewList(BaseModel):
    items: list[ReviewItem]
    confident: ConfidentSummary


def _item(
    db: Session,
    user_id: int,
    entry: SmsEntry,
    names: dict[int, str],
    found: confidence.Assessment | None = None,
) -> ReviewItem:
    price = review.suggested_price(db, user_id, entry)
    if found is None:
        found = confidence.assess(db, user_id, entry, confidence.offered_transactions(db, user_id))
    return ReviewItem(
        id=entry.id,
        status=entry.status,
        kind=entry.kind,
        reason=entry.reason,
        message=entry.message,
        amount=None if entry.amount is None else fmt(entry.amount),
        date=entry.occurred_on.isoformat(),
        payee=entry.payee,
        last4=entry.last4,
        account_id=entry.account_id,
        account_name=None if entry.account_id is None else names.get(entry.account_id),
        transaction_id=entry.transaction_id,
        trade_id=entry.trade_id,
        isin=entry.isin,
        quantity=None if entry.quantity is None else f"{entry.quantity.normalize():f}",
        candidates=entry.candidates,
        suggested_price=None if price is None else fmt(price),
        suggested_category=found.suggested_category,
        suggestion_source=found.source,
        history_count=found.count,
        history_total=found.total,
        suggested_account_id=found.suggested_account_id,
        confident=found.confident,
        why=found.why,
    )


def _account_names(db: Session, user_id: int) -> dict[int, str]:
    rows = db.execute(select(Account.id, Account.name).where(Account.user_id == user_id))
    return {id_: name for id_, name in rows}


@router.get("/review")
def list_review(user: CurrentUser, db: DbSession) -> ReviewList:
    entries = db.scalars(
        select(SmsEntry)
        .where(SmsEntry.user_id == user.id, SmsEntry.status.in_(review.OPEN))
        .order_by(SmsEntry.occurred_on.desc(), SmsEntry.id.desc())
    ).all()
    names = _account_names(db, user.id)
    offered = confidence.offered_transactions(db, user.id)
    found = [confidence.assess(db, user.id, e, offered) for e in entries]
    summary = confidence.summarise(found)
    return ReviewList(
        items=[_item(db, user.id, e, names, a) for e, a in zip(entries, found, strict=True)],
        confident=ConfidentSummary(
            count=summary.count,
            spent=fmt(summary.spent),
            received=fmt(summary.received),
            categories=[
                CategoryTotal(category=g.category, type=g.type, count=g.count, amount=fmt(g.amount))
                for g in summary.categories
            ],
        ),
    )


class ApproveItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Annotated[int, Field(strict=True, ge=1)]
    # The category the owner saw suggested: the item is skipped if the suggestion changed.
    category: Annotated[str, Field(min_length=1, max_length=40)]


class ApproveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: Annotated[list[ApproveItem], Field(min_length=1, max_length=200)]


class Skipped(BaseModel):
    id: int
    reason: str


class Learnable(BaseModel):
    entry_id: int
    payee: str
    category: str


class ApproveResult(BaseModel):
    approved: int
    skipped: list[Skipped]
    # Payees approved from their history, to offer "Always use <category> for <payee>".
    learn: list[Learnable]


@router.post("/review/approve")
def approve_confident(body: ApproveBody, user: CurrentUser, db: DbSession) -> ApproveResult:
    """Approves the confident items the owner confirmed, each completely or not at all."""
    try:
        recording.lock_user(db, user.id)
        done = confidence.approve(db, user.id, [(i.id, i.category) for i in body.items])
        db.commit()
    except Exception:
        db.rollback()
        raise
    return ApproveResult(
        approved=done.approved,
        skipped=[Skipped(id=i, reason=r) for i, r in done.skipped],
        learn=[
            Learnable(entry_id=x.entry_id, payee=x.payee, category=x.category) for x in done.learn
        ],
    )


class _Answer(BaseModel):
    model_config = ConfigDict(extra="forbid")


StrictId = Annotated[int, Field(strict=True, ge=1)]


class CategoryAnswer(_Answer):
    action: Literal["category"]
    # Required, except for "not a transfer" when the money already has a category.
    category: Category = None
    remember: Flag = True


class AccountAnswer(_Answer):
    action: Literal["account"]
    account_id: StrictId
    remember: Flag = True


class SameAnswer(_Answer):
    action: Literal["same"]
    transaction_id: StrictId


class NewAnswer(_Answer):
    action: Literal["new"]


class TransferAnswer(_Answer):
    action: Literal["transfer"]
    transaction_id: StrictId


class ExpectedAnswer(_Answer):
    action: Literal["expected"]
    kind: Literal["emi", "sip", "template"]
    id: StrictId
    remember: Flag = True
    # Only for a SIP whose fund has no NAV for the day (its candidate says "needs_nav").
    nav: Nav = None


class UnitsAnswer(_Answer):
    action: Literal["units"]
    units: Units = None
    nav: Nav = None


class UnitsOkAnswer(_Answer):
    action: Literal["units_ok"]


class TradeAnswer(_Answer):
    action: Literal["trade"]
    stock_id: Annotated[int | None, Field(strict=True, ge=1)] = None
    account_id: StrictId
    price: Money = None
    charges: Money = None
    # For a new stock (no `stock_id`).
    symbol: Symbol = None
    name: StockName = None
    # Only when the message doesn't say whether the shares came in or went out.
    side: Side = None


class RetryAnswer(_Answer):
    action: Literal["retry"]


class DismissAnswer(_Answer):
    action: Literal["dismiss"]


Answer = Annotated[
    CategoryAnswer
    | AccountAnswer
    | SameAnswer
    | NewAnswer
    | TransferAnswer
    | ExpectedAnswer
    | UnitsAnswer
    | UnitsOkAnswer
    | TradeAnswer
    | RetryAnswer
    | DismissAnswer,
    Field(discriminator="action"),
]


def _apply(db: Session, user_id: int, entry: SmsEntry, body: Any) -> None:
    review.check_answer(entry, body.action)
    match body:
        case CategoryAnswer():
            review.categorise(db, user_id, entry, body.category, body.remember)
        case AccountAnswer():
            review.choose_account(db, user_id, entry, body.account_id, body.remember)
        case SameAnswer():
            review.same(db, user_id, entry, body.transaction_id)
        case NewAnswer():
            review.new(db, user_id, entry)
        case TransferAnswer():
            review.merge_transfer(db, user_id, entry, body.transaction_id)
        case ExpectedAnswer():
            review.expected(db, user_id, entry, body.kind, body.id, body.remember, body.nav)
        case UnitsAnswer():
            review.units(db, user_id, entry, body.units, body.nav)
        case UnitsOkAnswer():
            review.units_ok(db, user_id, entry)
        case TradeAnswer():
            review.trade(
                db,
                user_id,
                entry,
                stock_id=body.stock_id,
                account_id=body.account_id,
                price=body.price,
                charges=body.charges,
                symbol=body.symbol,
                name=body.name,
                side=body.side,
            )
        case RetryAnswer():
            review.retry(db, user_id, entry)
        case _:
            review.dismiss(db, user_id, entry)


@router.post("/review/{id}")
def answer_review(id: int, body: Answer, user: CurrentUser, db: DbSession) -> ReviewItem | None:
    """Applies the answer completely or not at all. The item comes back while it still waits
    (a fund purchase whose units to check, say), else null."""
    try:
        recording.lock_user(db, user.id)
        entry = review.lock_entry(db, user.id, id)
        _apply(db, user.id, entry, body)
        db.commit()
    except Exception:
        db.rollback()
        raise
    if entry.status not in review.OPEN:
        return None
    return _item(db, user.id, entry, _account_names(db, user.id))


# Payee rules


class PayeeRuleResponse(BaseModel):
    id: int
    payee_key: str
    display: str
    category: str | None
    to_account_id: int | None
    to_account_name: str | None
    template_id: int | None
    template_name: str | None


class PayeeRuleList(BaseModel):
    rules: list[PayeeRuleResponse]


class PayeeRuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The message whose payee the rule is for.
    entry_id: StrictId
    category: Category = None


class PayeeRuleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: Category = None
    to_account_id: AccountRef = None
    template_id: TemplateRef = None  # can only be cleared here


class Deleted(BaseModel):
    id: int


def _rule_response(db: Session, rule: PayeeRule) -> PayeeRuleResponse:
    account = None if rule.to_account_id is None else db.get(Account, rule.to_account_id)
    template = None if rule.template_id is None else db.get(RecurringTemplate, rule.template_id)
    return PayeeRuleResponse(
        id=rule.id,
        payee_key=rule.payee_key,
        display=rule.display,
        category=rule.category,
        to_account_id=rule.to_account_id,
        to_account_name=None if account is None else account.name,
        template_id=rule.template_id,
        template_name=None if template is None else template.name,
    )


def _owned_rule(db: Session, user_id: int, id: int) -> PayeeRule:
    rule = None
    if 1 <= id <= MAX_ID:
        rule = db.scalar(select(PayeeRule).where(PayeeRule.id == id, PayeeRule.user_id == user_id))
    if rule is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Rule not found.")
    return rule


@rules_router.get("")
def list_rules(user: CurrentUser, db: DbSession) -> PayeeRuleList:
    rules = db.scalars(
        select(PayeeRule)
        .where(PayeeRule.user_id == user.id)
        .order_by(PayeeRule.display, PayeeRule.id)
    ).all()
    return PayeeRuleList(rules=[_rule_response(db, r) for r in rules])


def _rule_target_problem(db: Session, user_id: int, target: int) -> bool:
    found = None
    if 1 <= target <= MAX_ID:
        found = db.scalar(
            select(Account.id).where(
                Account.id == target, Account.user_id == user_id, Account.archived_at.is_(None)
            )
        )
    return found is None


@rules_router.post("", status_code=status.HTTP_201_CREATED)
def create_rule(body: PayeeRuleCreate, user: CurrentUser, db: DbSession) -> PayeeRuleResponse:
    """Offered after an approval as "Always use <category> for <payee>": the payee's rule gets
    the category, made when it has none yet."""
    try:
        recording.lock_user(db, user.id)
        entry = None
        if body.entry_id <= MAX_ID:
            entry = db.scalar(
                select(SmsEntry).where(SmsEntry.id == body.entry_id, SmsEntry.user_id == user.id)
            )
        if entry is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found.")
        if entry.payee_key is None:
            raise RequestValidationError([field_error("entry_id", "This message names no payee.")])
        if body.category is None:
            raise RequestValidationError([field_error("category", "Choose a category.")])
        kind = "income" if entry.kind == "credit" else "expense"
        rule = review.remember_category(
            db, user.id, entry, resolve(db, user.id, kind, body.category)
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return _rule_response(db, rule)


@rules_router.patch("/{id}")
def update_rule(
    id: int, body: PayeeRuleUpdate, user: CurrentUser, db: DbSession
) -> PayeeRuleResponse:
    """A rule is a category or a transfer to an account (not both), and may also tie the payee
    to a reminder. The reminder is tied from To review, so here it can only be cleared."""
    rule = _owned_rule(db, user.id, id)
    changes = body.model_dump(exclude_unset=True)
    if changes.get("template_id") is not None:
        raise RequestValidationError(
            [field_error("template_id", "Tie a payee to a reminder from To review.")]
        )
    values = {
        "category": rule.category,
        "to_account_id": rule.to_account_id,
        "template_id": rule.template_id,
        **changes,
    }
    if values["category"] is not None and values["to_account_id"] is not None:
        raise RequestValidationError(
            [field_error("to_account_id", "Choose a category or an account, not both.")]
        )
    target = values["to_account_id"]
    if target is not None and _rule_target_problem(db, user.id, target):
        raise RequestValidationError([field_error("to_account_id", "Choose an account.")])
    if all(v is None for v in values.values()):
        raise RequestValidationError(
            [field_error("category", "Choose a category or an account, or delete the rule.")]
        )
    if values["category"] is not None:
        values["category"] = resolve(
            db,
            user.id,
            rule_kind(db, user.id, values["category"]),
            values["category"],
            keep=rule.category,
        )
    for field, value in values.items():
        setattr(rule, field, value)
    db.commit()
    return _rule_response(db, rule)


@rules_router.delete("/{id}")
def delete_rule(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    db.delete(_owned_rule(db, user.id, id))
    db.commit()
    return Deleted(id=id)


# Card and account numbers learned from answers


class IdentifierResponse(BaseModel):
    id: int
    account_id: int
    account_name: str
    last4: str


class IdentifierList(BaseModel):
    identifiers: list[IdentifierResponse]


@router.get("/identifiers")
def list_identifiers(user: CurrentUser, db: DbSession) -> IdentifierList:
    rows = db.execute(
        select(AccountIdentifier, Account.name)
        .join(Account, Account.id == AccountIdentifier.account_id)
        .where(AccountIdentifier.user_id == user.id, Account.user_id == user.id)
        .order_by(Account.name, AccountIdentifier.last4, AccountIdentifier.id)
    ).all()
    return IdentifierList(
        identifiers=[
            IdentifierResponse(id=i.id, account_id=i.account_id, account_name=name, last4=i.last4)
            for i, name in rows
        ]
    )


@router.delete("/identifiers/{id}")
def delete_identifier(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    found = None
    if 1 <= id <= MAX_ID:
        found = db.scalar(
            select(AccountIdentifier).where(
                AccountIdentifier.id == id, AccountIdentifier.user_id == user.id
            )
        )
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Number not found.")
    db.delete(found)
    db.commit()
    return Deleted(id=id)


# Samples of messages no parser understood

SAMPLES_SHOWN = 50
_DIGITS = re.compile(r"[0-9]{3,}")


def mask(text: str) -> str:
    """Every run of 3 or more digits becomes as many X: account numbers, amounts, references."""
    return _DIGITS.sub(lambda m: "X" * len(m.group()), text)


class SampleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sender: Annotated[str, Field(min_length=1, max_length=20)]
    text: Annotated[str, Field(min_length=1, max_length=500)]


class SampleResponse(BaseModel):
    id: int
    sender: str
    text: str
    created_at: str


class SampleList(BaseModel):
    samples: list[SampleResponse]


def _sample(s: SmsSample) -> SampleResponse:
    return SampleResponse(
        id=s.id, sender=s.sender, text=s.text, created_at=s.created_at.isoformat()
    )


@router.post("/samples", status_code=status.HTTP_201_CREATED)
def add_sample(body: SampleCreate, user: CurrentUser, db: DbSession) -> SampleResponse:
    # Masked here as well as on the phone: nothing unmasked is ever stored.
    sample = SmsSample(user_id=user.id, sender=mask(body.sender), text=mask(body.text))
    db.add(sample)
    db.commit()
    db.refresh(sample)
    return _sample(sample)


@router.get("/samples")
def list_samples(user: CurrentUser, db: DbSession) -> SampleList:
    found = db.scalars(
        select(SmsSample)
        .where(SmsSample.user_id == user.id)
        .order_by(SmsSample.id.desc())
        .limit(SAMPLES_SHOWN)
    ).all()
    return SampleList(samples=[_sample(s) for s in found])
