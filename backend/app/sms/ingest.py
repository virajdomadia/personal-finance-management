"""What each parsed bank SMS becomes.

`decide` stores the message, then runs the steps in `STEPS` in order. Each step either decides the
entry (returns it) or leaves it to the next (returns None). Money is recorded straight away
whenever the account and amount are known; whatever is still missing is left as a review reason.
"""

from collections.abc import Callable
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from fastapi.exceptions import RequestValidationError
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.routes.accounts import rupees
from app.api.routes.transactions import lock_accounts, save_checks
from app.models.account import Account
from app.models.sms import AccountIdentifier, PayeeRule, SmsEntry
from app.models.transaction import Transaction
from app.sms.merchants import builtin_category
from app.sms.payees import display_name, payee_key

if TYPE_CHECKING:
    from app.api.routes.sms import ParsedSms

MONEY_OUT = {"debit", "card_spend"}
MONEY_IN = {"credit"}
CARD_KINDS = {"card_spend", "card_payment", "card_statement"}
# A debit card's spend lands on its bank through an identifier, so cards count for debits too.
BANK_SIDE_TYPES = ("bank", "wallet", "credit_card")
MANUAL_WINDOW = timedelta(days=1)

Step = Callable[[Session, int, SmsEntry], SmsEntry | None]


def _find_by_hash(db: Session, user_id: int, hash_: str) -> SmsEntry | None:
    return db.scalar(select(SmsEntry).where(SmsEntry.user_id == user_id, SmsEntry.hash == hash_))


def _new_entry(user_id: int, sms: "ParsedSms") -> SmsEntry:
    key = payee_key(sms.payee) if sms.payee else ""
    shown = display_name(sms.payee) if sms.payee else ""
    return SmsEntry(
        user_id=user_id,
        hash=sms.hash,
        sender=sms.sender,
        bank=sms.bank,
        kind=sms.kind,
        amount=sms.amount,
        occurred_on=sms.date,
        last4=sms.last4,
        payee=shown or None,
        payee_key=key[:120] or None,
        ref=sms.ref,
        balance=sms.balance,
        isin=None if sms.isin is None else sms.isin.upper(),
        quantity=sms.quantity,
        due_date=sms.due_date,
        status="review",
    )


def decide(db: Session, user_id: int, sms: "ParsedSms") -> tuple[SmsEntry, bool]:
    """The entry for this message, and whether it was already stored (a duplicate upload).

    The new entry is inserted first, so its hash is claimed before anything is recorded: a second
    upload of the same message, even a concurrent one, hits the unique constraint and becomes a
    duplicate. The caller commits.
    """
    existing = _find_by_hash(db, user_id, sms.hash)
    if existing is not None:
        return existing, True
    entry = _new_entry(user_id, sms)
    db.add(entry)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = _find_by_hash(db, user_id, sms.hash)
        if existing is None:
            raise
        return existing, True
    for step in STEPS:
        if step(db, user_id, entry) is not None:
            break
    return entry, False


def ingest(db: Session, user_id: int, sms: "ParsedSms") -> SmsEntry:
    return decide(db, user_id, sms)[0]


def _review(entry: SmsEntry, reason: str, message: str | None = None) -> SmsEntry:
    entry.status = "review"
    entry.reason = reason
    entry.message = None if message is None else message[:200]
    return entry


# Accounts


def resolve_account(db: Session, user_id: int, kind: str, last4: str | None) -> list[Account]:
    """The user's active accounts that answer to `last4`, on their own number or an identifier."""
    if last4 is None:
        return []
    types = ("credit_card",) if kind in CARD_KINDS else BANK_SIDE_TYPES
    identified = select(AccountIdentifier.account_id).where(
        AccountIdentifier.user_id == user_id, AccountIdentifier.last4 == last4
    )
    query = (
        select(Account)
        .where(
            Account.user_id == user_id,
            Account.archived_at.is_(None),
            Account.type.in_(types),
            or_(Account.last4 == last4, Account.id.in_(identified)),
        )
        .order_by(Account.id)
    )
    return list(db.scalars(query))


def _demat(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """CDSL share movements become drafts; Task 6 fills in the stock."""
    if entry.kind != "demat":
        return None
    entry.status = "draft"
    entry.reason = "demat"
    return entry


def _account(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    found = resolve_account(db, user_id, entry.kind, entry.last4)
    if len(found) == 1:
        entry.account_id = found[0].id
        return None
    which = "this" if entry.last4 is None else f"XX{entry.last4}"
    return _review(entry, "account", f"Which account is {which}?")


def _card_statement(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """A statement is kept for the card bill reminder; it doesn't move money."""
    if entry.kind != "card_statement":
        return None
    entry.status = "recorded"
    return entry


# Duplicates


def _same_ref(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """The same transaction told twice (two messages, or the same one worded differently)."""
    if entry.ref is None:
        return None
    seen = db.scalar(
        select(SmsEntry.id).where(
            SmsEntry.user_id == user_id,
            SmsEntry.ref == entry.ref,
            SmsEntry.account_id == entry.account_id,
            SmsEntry.status != "ignored",
            SmsEntry.id != entry.id,
        )
    )
    if seen is None:
        return None
    entry.status = "duplicate"
    return entry


def _direction(entry: SmsEntry) -> Any:
    """Manual transactions that move money the way this message says."""
    account = entry.account_id
    into = and_(Transaction.type == "transfer", Transaction.to_account_id == account)
    if entry.kind in MONEY_OUT:
        return and_(
            Transaction.type.in_(("expense", "emi", "transfer")), Transaction.account_id == account
        )
    if entry.kind in MONEY_IN:
        return or_(and_(Transaction.type == "income", Transaction.account_id == account), into)
    return into  # a card payment received: a transfer into the card


def _label(tx: Transaction) -> str:
    return f"{tx.date.isoformat()} · {tx.category or tx.type} · {rupees(tx.amount)}"


def _typed_by_hand(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """The owner already typed this in: link to it instead of recording it again."""
    if entry.kind not in MONEY_OUT | MONEY_IN | {"card_payment"} or entry.amount is None:
        return None
    linked = select(SmsEntry.transaction_id).where(
        SmsEntry.user_id == user_id, SmsEntry.transaction_id.is_not(None)
    )
    query = (
        select(Transaction)
        .where(
            Transaction.user_id == user_id,
            Transaction.source == "manual",
            Transaction.amount == entry.amount,
            Transaction.date >= entry.occurred_on - MANUAL_WINDOW,
            Transaction.date <= entry.occurred_on + MANUAL_WINDOW,
            Transaction.id.not_in(linked),
            _direction(entry),
        )
        .order_by(Transaction.date, Transaction.id)
    )
    found = list(db.scalars(query))
    if not found:
        return None
    if len(found) == 1:
        entry.transaction_id = found[0].id
        entry.status = "recorded"
        return entry
    _review(entry, "maybe_duplicate", "You may have typed this in already.")
    entry.candidates = [{"kind": "transaction", "id": tx.id, "label": _label(tx)} for tx in found]
    return entry


# Recording


def record(db: Session, user_id: int, entry: SmsEntry, values: dict[str, Any]) -> bool:
    """Saves the transaction under the usual checks and links it to the entry.

    When a check fails (below ₹0, say) nothing is recorded: the entry waits in review with the
    checker's message.
    """
    values = {
        "to_account_id": None,
        "interest": None,
        "note": None,
        "recurring_template_id": None,
        **values,
    }
    accounts = lock_accounts(db, user_id, [values["account_id"], values["to_account_id"]])
    try:
        save_checks(db, user_id, accounts, values, existing_id=None, allow_uncategorised=True)
    except RequestValidationError as error:
        _review(entry, "balance", error.errors()[0]["msg"])
        entry.transaction_id = None
        return False
    tx = Transaction(user_id=user_id, source="sms", **values)
    db.add(tx)
    db.flush()
    entry.transaction_id = tx.id
    return True


def _card_payment(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """Which bank paid the card bill is unknown until Task 4 pairs it; ask meanwhile."""
    if entry.kind != "card_payment":
        return None
    card = db.get(Account, entry.account_id)
    name = "your card" if card is None else card.name
    amount = "" if entry.amount is None else f"{rupees(entry.amount)} "
    _review(entry, "card_payment", f"Which account paid {amount}to {name}?")
    payers = db.scalars(
        select(Account)
        .where(
            Account.user_id == user_id,
            Account.archived_at.is_(None),
            Account.type.in_(("bank", "wallet")),
        )
        .order_by(Account.id)
    )
    entry.candidates = [{"kind": "account", "id": a.id, "label": a.name} for a in payers]
    return entry


def _category(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """Records the money as income or an expense, categorised when the payee is known."""
    spending = entry.kind in MONEY_OUT
    category = None
    if entry.payee_key is not None:
        rule = db.scalar(
            select(PayeeRule).where(
                PayeeRule.user_id == user_id, PayeeRule.payee_key == entry.payee_key
            )
        )
        if rule is not None and rule.category is not None:
            category = rule.category
        elif spending:
            category = builtin_category(entry.payee_key)
    values = {
        "type": "expense" if spending else "income",
        "account_id": entry.account_id,
        "amount": entry.amount,
        "date": entry.occurred_on,
        "category": category,
        "note": entry.payee,
    }
    if not record(db, user_id, entry, values):
        return entry
    if category is not None:
        entry.status, entry.reason, entry.message = "recorded", None, None
    elif entry.payee is not None:
        _review(entry, "category", f"New payee: {entry.payee}")
    else:
        what = "payment" if spending else "credit"
        _review(entry, "category", f"New {what}: the SMS names no payee")
    return entry


# The order matters: later tasks insert transfers and expected payments before `_category`.
STEPS: list[Step] = [
    _demat,
    _account,
    _card_statement,
    _same_ref,
    _typed_by_hand,
    _card_payment,
    _category,
]
