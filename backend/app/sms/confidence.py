"""How sure Gullak is about an open To review item, and approving every item it is sure about.

Only a "category" item (money recorded with no category yet, from a payee without a rule when it
arrived) can be confident: every other reason is a question ingestion deliberately left to the
owner. A category item is confident when the payee now has a rule, or the payee's history is clear
(`CONFIDENT_COUNT` and `CONFIDENT_SHARE`), and nothing else about it needs a human. All of it is
worked out on read, so nothing is stored and a stale answer is never trusted: approving checks
again.
"""

from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal
from fractions import Fraction

from fastapi import HTTPException, status
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.categories import name_key, usable
from app.models.account import Account
from app.models.sms import SmsEntry
from app.models.transaction import Transaction
from app.sms import ingest, review
from app.sms.expected import expected_candidates

# My call: the latest 20 categorised payments of the payee are looked at, so a habit that changed
# wins over an old one; a category used 3+ times and in at least 80% of them is confident.
HISTORY_LIMIT = 20
CONFIDENT_COUNT = 3
CONFIDENT_SHARE = Fraction(4, 5)

WHY: dict[str, str] = {
    "account": "Account unknown",
    "maybe_duplicate": "Possible duplicate",
    "maybe_transfer": "Possible transfer",
    "expected": "Possible regular payment",
    "card_payment": "Card bill payer unknown",
    "sip_units": "Units are estimated",
    "demat": "Check the price",
    "balance": "Couldn't record",
}
# Another open item offering this item's transaction as one of its answers.
OFFERED_WHY: dict[str, str] = {
    "card_payment": "May have paid a card bill",
    "maybe_transfer": "May be a transfer",
}


@dataclass
class Assessment:
    suggested_category: str | None = None
    source: str | None = None  # "rule" (a payee rule or the built-in list) or "history"
    count: int = 0  # times the suggested category was used before
    total: int = 0  # categorised payments of the payee looked at
    suggested_account_id: int | None = None
    confident: bool = False
    why: str = ""
    type: str | None = None  # "income" or "expense": the recorded money's type
    amount: Decimal | None = None


def offered_transactions(db: Session, user_id: int) -> dict[int, str]:
    """Transactions some open item offers as an answer, with that item's reason."""
    found: dict[int, str] = {}
    for reason, choices in db.execute(
        select(SmsEntry.reason, SmsEntry.candidates).where(
            SmsEntry.user_id == user_id,
            SmsEntry.status.in_(review.OPEN),
            SmsEntry.candidates.is_not(None),
        )
    ):
        for choice in choices or []:
            if choice.get("kind") == "transaction" and isinstance(choice.get("id"), int):
                found.setdefault(choice["id"], reason or "")
    return found


def _history(db: Session, user_id: int, entry: SmsEntry, tx: Transaction) -> list[str]:
    """Categories of the payee's latest categorised payments of the same type, newest first."""
    linked = select(SmsEntry.transaction_id).where(
        SmsEntry.user_id == user_id,
        SmsEntry.payee_key == entry.payee_key,
        SmsEntry.transaction_id.is_not(None),
    )
    return list(
        db.scalars(
            select(Transaction.category)
            .where(
                Transaction.user_id == user_id,
                Transaction.id != tx.id,
                Transaction.id.in_(linked),
                Transaction.type == tx.type,
                Transaction.category.is_not(None),
            )
            .order_by(Transaction.date.desc(), Transaction.id.desc())
            .limit(HISTORY_LIMIT)
        )
    )


def _most_common(names: list[str]) -> tuple[str, int]:
    """The most used name (by its key) and how often; a tie goes to the one used latest."""
    keys = [name_key(n) for n in names]
    counts = Counter(keys)
    best = max(counts, key=lambda k: (counts[k], -keys.index(k)))
    return names[keys.index(best)], counts[best]


def _history_account(db: Session, user_id: int, entry: SmsEntry) -> int | None:
    """The one account every earlier recorded message from this payee was in, if still usable."""
    if entry.payee_key is None:
        return None
    ids = db.scalars(
        select(SmsEntry.account_id)
        .where(
            SmsEntry.user_id == user_id,
            SmsEntry.payee_key == entry.payee_key,
            SmsEntry.status == "recorded",
            SmsEntry.account_id.is_not(None),
            SmsEntry.id != entry.id,
        )
        .distinct()
    ).all()
    if len(ids) != 1 or ids[0] is None:
        return None
    types = ("credit_card",) if entry.kind in ingest.CARD_KINDS else ingest.BANK_SIDE_TYPES
    db_account = db.scalar(
        select(Account.id).where(
            Account.id == ids[0],
            Account.user_id == user_id,
            Account.archived_at.is_(None),
            Account.type.in_(types),
        )
    )
    return db_account


def _typed_in_since(db: Session, user_id: int, entry: SmsEntry) -> bool:
    """A payment typed in by hand that could be this one, as ingestion's own duplicate check."""
    found = db.scalar(
        select(Transaction.id)
        .where(
            Transaction.user_id == user_id,
            Transaction.source == "manual",
            Transaction.amount == entry.amount,
            Transaction.date >= entry.occurred_on - ingest.MANUAL_WINDOW,
            Transaction.date <= entry.occurred_on + ingest.MANUAL_WINDOW,
            Transaction.id.not_in(ingest.linked_on_side(user_id, entry.kind)),
            ingest._direction(entry),
        )
        .limit(1)
    )
    return found is not None


def _blocker(
    db: Session, user_id: int, entry: SmsEntry, tx: Transaction, offered: dict[int, str]
) -> str | None:
    """What about this item still needs a human, if anything."""
    if tx.id in offered:
        return OFFERED_WHY.get(offered[tx.id], "Another item asks about this")
    account = db.get(Account, tx.account_id)
    if entry.account_id is None or account is None or entry.amount is None:
        return "Check this one"
    if account.archived_at is not None:
        return "Its account is archived"
    if _typed_in_since(db, user_id, entry):
        return "You may have typed this in"
    if entry.kind == "debit":
        plans = expected_candidates(
            db, user_id, account, entry.amount, entry.occurred_on, entry.payee_key
        )
        if len(plans) == 1:
            return f"Might be your {plans[0]['label']}"
        if plans:
            return "Might be a regular payment"
    return None


def _times(n: int) -> str:
    return "once" if n == 1 else f"{n} times"


def assess(db: Session, user_id: int, entry: SmsEntry, offered: dict[int, str]) -> Assessment:
    found = Assessment()
    if entry.reason == "account":
        found.suggested_account_id = _history_account(db, user_id, entry)
    if entry.reason != "category":
        found.why = WHY.get(entry.reason or "", "Needs a look")
        return found
    if entry.payee_key is None:
        found.why = "No payee in the SMS"
        return found
    tx = None if entry.transaction_id is None else db.get(Transaction, entry.transaction_id)
    if (
        tx is None
        or tx.user_id != user_id
        or tx.type not in ("income", "expense")
        or tx.category is not None
        or tx.recurring_template_id is not None
    ):
        found.why = "Check this one"
        return found
    found.type, found.amount = tx.type, tx.amount

    sure = False
    rule_category = ingest._category_for(db, user_id, entry)
    if rule_category is not None:
        found.suggested_category, found.source = rule_category, "rule"
        found.why = f"Payee rule: {rule_category}"
        sure = True
    else:
        past = _history(db, user_id, entry, tx)
        if not past:
            found.why = "First time for this payee"
            return found
        name, count = _most_common(past)
        found.count, found.total = count, len(past)
        found.suggested_category = usable(db, user_id, tx.type, name)
        if found.suggested_category is None:
            found.why = f"{name} is archived"
            return found
        found.source = "history"
        sure = count >= CONFIDENT_COUNT and Fraction(count, len(past)) >= CONFIDENT_SHARE
        if sure:
            found.why = f"{found.suggested_category} {count} of {len(past)} times before"
        elif count == len(past):
            found.why = f"Seen {_times(count)} before"
        else:
            found.why = f"{found.suggested_category} only {count} of {len(past)} times"
    if sure:
        blocker = _blocker(db, user_id, entry, tx, offered)
        if blocker is not None:
            found.why = blocker
        else:
            found.confident = True
    return found


# The confident items together


@dataclass
class CategoryTotal:
    category: str
    type: str
    count: int = 0
    amount: Decimal = Decimal(0)


@dataclass
class Summary:
    count: int = 0
    spent: Decimal = Decimal(0)
    received: Decimal = Decimal(0)
    categories: list[CategoryTotal] = field(default_factory=list)


def summarise(found: list[Assessment]) -> Summary:
    summary = Summary()
    groups: dict[tuple[str, str], CategoryTotal] = {}
    for a in found:
        if not a.confident or a.amount is None or a.type is None:
            continue
        assert a.suggested_category is not None
        summary.count += 1
        if a.type == "income":
            summary.received += a.amount
        else:
            summary.spent += a.amount
        key = (a.type, a.suggested_category)
        group = groups.setdefault(key, CategoryTotal(category=a.suggested_category, type=a.type))
        group.count += 1
        group.amount += a.amount
    summary.categories = sorted(groups.values(), key=lambda g: (-g.amount, g.category))
    return summary


# Approving


@dataclass
class Learnable:
    entry_id: int
    payee: str
    category: str


@dataclass
class Approval:
    approved: int = 0
    skipped: list[tuple[int, str]] = field(default_factory=list)
    learn: list[Learnable] = field(default_factory=list)


class _Skip(Exception):
    pass


def approve(db: Session, user_id: int, wanted: list[tuple[int, str]]) -> Approval:
    """Categorises each listed item, in order, if it is still open and confident and still
    suggests the category the owner saw. Each item applies completely or not at all (a
    savepoint), and one that can't is reported with why. No payee rules are made: payees approved
    from history come back in `learn`, to offer one. The caller holds the user lock and commits."""
    result = Approval()
    offered = offered_transactions(db, user_id)
    learn: dict[str, Learnable] = {}
    for id_, category in wanted:
        try:
            with db.begin_nested():
                entry = review.lock_entry(db, user_id, id_)
                found = assess(db, user_id, entry, offered)
                if not found.confident or found.suggested_category is None:
                    raise _Skip("Not confident any more")
                if name_key(found.suggested_category) != name_key(category):
                    raise _Skip("Its suggestion changed")
                review.categorise(db, user_id, entry, found.suggested_category, remember=False)
        except _Skip as skip:
            result.skipped.append((id_, str(skip)))
            continue
        except HTTPException as error:
            if error.status_code == status.HTTP_404_NOT_FOUND:
                reason = "Not found"
            elif error.detail == "This was already answered.":
                reason = "Already answered"
            else:
                reason = str(error.detail)
            result.skipped.append((id_, reason))
            continue
        except RequestValidationError as error:
            result.skipped.append((id_, str(error.errors()[0]["msg"])))
            continue
        result.approved += 1
        if found.source == "history" and entry.payee_key is not None:
            learn[entry.payee_key] = Learnable(
                entry_id=entry.id,
                payee=entry.payee or entry.payee_key,
                category=found.suggested_category,
            )
    result.learn = list(learn.values())
    return result
