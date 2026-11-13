"""How sure Gullak is about an open To review item, and approving every item it is sure about.

Only a "category" item (money recorded with no category yet, from a payee without a rule when it
arrived) can be confident: every other reason is a question ingestion deliberately left to the
owner. A category item is confident when the payee now has a category rule, is a known merchant, or
its history is clear (`CONFIDENT_COUNT` and `CONFIDENT_SHARE`), and nothing else about it needs a
human. All of it is worked out on read, so nothing is stored and a stale answer is never trusted:
approving checks again.

Everything an assessment needs is read once per request into a `Context` (rules, the category
registry, history, accounts, typed-in payments), so a list of 200 items costs about the same
queries as a list of 2.
"""

from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from decimal import Decimal
from fractions import Fraction
from typing import Any

from fastapi import HTTPException, status
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.categories import UNCATEGORISED, ensure_seeded, name_key
from app.models.account import Account
from app.models.category import Category
from app.models.investment import Sip
from app.models.recurring import RecurringTemplate
from app.models.sms import PayeeRule, SmsEntry
from app.models.transaction import Transaction
from app.sms import ingest, review
from app.sms.expected import Candidate, expected_candidates
from app.sms.merchants import builtin_category

# My call: the latest 20 categorised payments of the payee are looked at, so a habit that changed
# wins over an old one; a category used 3+ times and in at least 80% of them is confident.
HISTORY_LIMIT = 20
CONFIDENT_COUNT = 3
CONFIDENT_SHARE = Fraction(4, 5)
# At most this many items are approved in one go, the oldest first; the rest come next time.
APPROVE_LIMIT = 200

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
AS_TRANSFER = "Payee is set as a transfer"
AS_REMINDER = "Payee is set as a regular payment"


@dataclass
class Assessment:
    suggested_category: str | None = None
    # "rule" (the payee's rule), "merchant" (the built-in list) or "history".
    source: str | None = None
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


def _moves_like(entry: SmsEntry, tx: Transaction) -> bool:
    """Whether a typed-in transaction moves money the way the message says (ingest's
    `_direction`, in memory)."""
    here = entry.account_id
    into = tx.type == "transfer" and tx.to_account_id == here
    if entry.kind in ingest.MONEY_OUT:
        return tx.type in ("expense", "emi", "transfer") and tx.account_id == here
    if entry.kind in ingest.MONEY_IN:
        return (tx.type == "income" and tx.account_id == here) or into
    return into


class Context:
    """What assessing `entries` needs, read once. Takes the category registry's shared lock once,
    as `resolve` would for each name."""

    def __init__(self, db: Session, user_id: int, entries: Iterable[SmsEntry]) -> None:
        self.db, self.user_id = db, user_id
        entries = list(entries)
        keys = {e.payee_key for e in entries if e.payee_key is not None}
        asking = [e for e in entries if e.reason == "category"]
        self.offered = offered_transactions(db, user_id)
        self.rules: dict[str, PayeeRule] = {}
        if keys:
            self.rules = {
                r.payee_key: r
                for r in db.scalars(
                    select(PayeeRule).where(
                        PayeeRule.user_id == user_id, PayeeRule.payee_key.in_(keys)
                    )
                )
            }
        self.accounts = {
            a.id: a for a in db.scalars(select(Account).where(Account.user_id == user_id))
        }
        self._registry(db, user_id)
        tx_ids = [e.transaction_id for e in asking if e.transaction_id is not None]
        self.txs: dict[int, Transaction] = {}
        if tx_ids:
            self.txs = {
                t.id: t
                for t in db.scalars(
                    select(Transaction).where(
                        Transaction.user_id == user_id, Transaction.id.in_(tx_ids)
                    )
                )
            }
        self._history(db, user_id, {e.payee_key for e in asking if e.payee_key is not None})
        self._typed_in(db, user_id, asking)
        self._plans(db, user_id)
        self._expected: dict[tuple[Any, ...], list[Candidate]] = {}
        self._masked: dict[tuple[str, int | None], bool] = {}

    # Categories

    def _registry(self, db: Session, user_id: int) -> None:
        ensure_seeded(db, user_id)
        rows = list(
            db.scalars(
                select(Category)
                .where(Category.user_id == user_id)
                .order_by(Category.id)
                .with_for_update(read=True)
            )
        )
        by_id = {c.id: c for c in rows}
        # As `categories._find`: the live category of a name, else the newest one merged or
        # renamed away under it, followed to where it went.
        ranked = sorted(rows, key=lambda c: (c.merged_into_id is not None, -c.id))
        self._names: dict[tuple[str, str], Category] = {}
        for c in ranked:
            target = by_id.get(c.merged_into_id, c) if c.merged_into_id is not None else c
            self._names.setdefault((c.kind, c.name_key), target)

    def _current(self, kind: str, name: str) -> Category | None:
        return self._names.get((kind, name_key(name)))

    def canonical(self, kind: str, name: str) -> str:
        """The name a category goes by now (an old name gives the one it became)."""
        found = self._current(kind, name)
        return name if found is None else found.name

    def usable(self, kind: str, name: str) -> str | None:
        """`categories.usable` in memory: None for an archived category. A name the registry
        doesn't have yet is kept as it is; saving it creates it, as ingestion would."""
        if name_key(name) == name_key(UNCATEGORISED):
            return None
        found = self._current(kind, name)
        if found is None:
            return name
        return None if found.archived_at is not None else found.name

    # History

    def _history(self, db: Session, user_id: int, keys: set[str]) -> None:
        """The categories of each payee's latest settled payments, per type, newest first, each
        under the name it goes by now."""
        self.history: dict[tuple[str, str], list[str]] = defaultdict(list)
        if not keys:
            return
        seen: set[tuple[str, int]] = set()
        rows = db.execute(
            select(SmsEntry.payee_key, Transaction.id, Transaction.type, Transaction.category)
            .join(Transaction, Transaction.id == SmsEntry.transaction_id)
            .where(
                SmsEntry.user_id == user_id,
                Transaction.user_id == user_id,
                SmsEntry.payee_key.in_(keys),
                SmsEntry.status.not_in(review.OPEN),  # settled: not still being asked about
                Transaction.type.in_(("income", "expense")),
                Transaction.category.is_not(None),
            )
            .order_by(Transaction.date.desc(), Transaction.id.desc())
        )
        for key, tx_id, type_, category in rows:
            group = self.history[(key, type_)]
            if (key, tx_id) in seen or len(group) >= HISTORY_LIMIT:
                continue
            seen.add((key, tx_id))
            group.append(self.canonical(type_, category))

    # Typed-in payments

    def _typed_in(self, db: Session, user_id: int, asking: list[SmsEntry]) -> None:
        self.manual: list[Transaction] = []
        self.linked_kinds: dict[int, set[str]] = defaultdict(set)
        amounts = {e.amount for e in asking if e.amount is not None}
        if not amounts:
            return
        days = [e.occurred_on for e in asking]
        self.manual = list(
            db.scalars(
                select(Transaction).where(
                    Transaction.user_id == user_id,
                    Transaction.source == "manual",
                    Transaction.amount.in_(amounts),
                    Transaction.date >= min(days) - ingest.MANUAL_WINDOW,
                    Transaction.date <= max(days) + ingest.MANUAL_WINDOW,
                )
            )
        )
        if self.manual:
            for tx_id, kind in db.execute(
                select(SmsEntry.transaction_id, SmsEntry.kind).where(
                    SmsEntry.user_id == user_id,
                    SmsEntry.transaction_id.in_([t.id for t in self.manual]),
                )
            ):
                self.linked_kinds[tx_id].add(kind)

    def typed_in_since(self, entry: SmsEntry) -> bool:
        """A payment typed in by hand that could be this one, as ingestion's own check."""
        side = ingest.side_of(entry.kind)
        return any(
            t.amount == entry.amount
            and abs(t.date - entry.occurred_on) <= ingest.MANUAL_WINDOW
            and not (self.linked_kinds.get(t.id, set()) & side)
            and _moves_like(entry, t)
            for t in self.manual
        )

    # Expected payments and the owner's own accounts

    def _plans(self, db: Session, user_id: int) -> None:
        """Accounts anything regular is paid from: only their debits can be an EMI, SIP or
        reminder, so only those are looked up."""
        self.plan_accounts: set[int] = set()
        for query in (
            select(Account.pay_from_id).where(
                Account.user_id == user_id,
                Account.type == "loan",
                Account.archived_at.is_(None),
                Account.pay_from_id.is_not(None),
            ),
            select(Sip.account_id).where(Sip.user_id == user_id, Sip.active.is_(True)),
            select(RecurringTemplate.account_id).where(
                RecurringTemplate.user_id == user_id, RecurringTemplate.active.is_(True)
            ),
        ):
            self.plan_accounts.update(i for i in db.scalars(query) if i is not None)

    def expected(self, entry: SmsEntry, account: Account) -> list[Candidate]:
        if account.id not in self.plan_accounts or entry.amount is None:
            return []
        key = (account.id, entry.amount, entry.occurred_on, entry.payee_key)
        if key not in self._expected:
            self._expected[key] = expected_candidates(
                self.db, self.user_id, account, entry.amount, entry.occurred_on, entry.payee_key
            )
        return self._expected[key]

    def own_account(self, entry: SmsEntry) -> bool:
        """Whether the payee is a masked number of another of the owner's accounts."""
        key = entry.payee_key or ""
        if ingest._MASKED.match(key) is None:
            return False
        memo = (key, entry.account_id)
        if memo not in self._masked:
            self._masked[memo] = ingest._masked_target(self.db, self.user_id, entry) is not None
        return self._masked[memo]


def _most_common(names: list[str]) -> tuple[str, int]:
    """The most used name (by its key) and how often; a tie goes to the one used latest."""
    keys = [name_key(n) for n in names]
    counts = Counter(keys)
    best = max(counts, key=lambda k: (counts[k], -keys.index(k)))
    return names[keys.index(best)], counts[best]


def _history_account(ctx: Context, entry: SmsEntry) -> int | None:
    """The one account every earlier recorded message from this payee was in, if still usable.
    Only a hint: the payee says nothing about an unknown card number."""
    if entry.payee_key is None:
        return None
    ids = ctx.db.scalars(
        select(SmsEntry.account_id)
        .where(
            SmsEntry.user_id == ctx.user_id,
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
    account = ctx.accounts.get(ids[0])
    if account is None or account.archived_at is not None or account.type not in types:
        return None
    return account.id


def _blocker(ctx: Context, entry: SmsEntry, tx: Transaction) -> str | None:
    """What about this item still needs a human, if anything."""
    if tx.id in ctx.offered:
        return OFFERED_WHY.get(ctx.offered[tx.id], "Another item asks about this")
    account = ctx.accounts.get(tx.account_id)
    if entry.account_id is None or account is None or entry.amount is None:
        return "Check this one"
    if account.archived_at is not None:
        return "Its account is archived"
    if ctx.typed_in_since(entry):
        return "You may have typed this in"
    if entry.kind == "debit":
        plans = ctx.expected(entry, account)
        if len(plans) == 1:
            return f"Might be your {plans[0]['label']}"
        if plans:
            return "Might be a regular payment"
    return None


def _times(n: int) -> str:
    return "once" if n == 1 else f"{n} times"


def assess(ctx: Context, entry: SmsEntry) -> Assessment:
    found = Assessment()
    if entry.reason == "account":
        found.suggested_account_id = _history_account(ctx, entry)
    if entry.reason != "category":
        found.why = WHY.get(entry.reason or "", "Needs a look")
        return found
    key = entry.payee_key
    if key is None:
        found.why = "No payee in the SMS"
        return found
    tx = None if entry.transaction_id is None else ctx.txs.get(entry.transaction_id)
    if (
        tx is None
        or tx.type not in ("income", "expense")
        or tx.category is not None
        or tx.recurring_template_id is not None
    ):
        found.why = "Check this one"
        return found
    found.type, found.amount = tx.type, tx.amount

    # A payee the owner set up as something other than a category is never categorised here.
    rule = ctx.rules.get(key)
    if rule is not None and rule.to_account_id is not None:
        found.why = AS_TRANSFER
        return found
    if rule is not None and rule.template_id is not None:
        found.why = AS_REMINDER
        return found
    if ctx.own_account(entry):
        found.why = AS_TRANSFER
        return found

    sure = False
    builtin = builtin_category(key) if entry.kind in ingest.MONEY_OUT else None
    if rule is not None and rule.category is not None:
        found.suggested_category = ctx.usable(tx.type, rule.category)
        if found.suggested_category is None:
            found.why = f"{rule.category} is archived"
            return found
        found.source, found.why, sure = "rule", f"Payee rule: {found.suggested_category}", True
    elif builtin is not None and (named := ctx.usable(tx.type, builtin)) is not None:
        found.suggested_category, found.source = named, "merchant"
        found.why, sure = f"Known merchant: {entry.payee or key}", True
    else:
        past = ctx.history.get((key, tx.type), [])
        if not past:
            found.why = "First time for this payee"
            return found
        name, count = _most_common(past)
        found.count, found.total = count, len(past)
        found.suggested_category = ctx.usable(tx.type, name)
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
        blocker = _blocker(ctx, entry, tx)
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
    count: int = 0  # in this batch
    total: int = 0  # confident items in all
    ids: list[int] = field(default_factory=list)  # this batch: the oldest `APPROVE_LIMIT`
    spent: Decimal = Decimal(0)
    received: Decimal = Decimal(0)
    categories: list[CategoryTotal] = field(default_factory=list)


def summarise(pairs: Iterable[tuple[SmsEntry, Assessment]]) -> Summary:
    summary = Summary()
    sure = [(e, a) for e, a in pairs if a.confident and a.amount is not None and a.type]
    sure.sort(key=lambda p: (p[0].occurred_on, p[0].id))
    summary.total = len(sure)
    groups: dict[tuple[str, str], CategoryTotal] = {}
    for entry, a in sure[:APPROVE_LIMIT]:
        assert a.suggested_category is not None and a.amount is not None and a.type is not None
        summary.count += 1
        summary.ids.append(entry.id)
        if a.type == "income":
            summary.received += a.amount
        else:
            summary.spent += a.amount
        group = groups.setdefault(
            (a.type, a.suggested_category),
            CategoryTotal(category=a.suggested_category, type=a.type),
        )
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
    savepoint), and one that can't is reported with why. The money must still be what was
    assessed once locked. No payee rules are made: payees approved from history come back in
    `learn`, to offer one. The caller holds the user lock and commits."""
    result = Approval()
    ids = [i for i, _ in wanted if 1 <= i <= review.MAX_ID]
    entries = list(
        db.scalars(select(SmsEntry).where(SmsEntry.user_id == user_id, SmsEntry.id.in_(ids)))
    )
    ctx = Context(db, user_id, entries)
    learn: dict[str, Learnable] = {}
    for id_, category in wanted:
        try:
            with db.begin_nested():
                entry = review.lock_entry(db, user_id, id_)
                found = assess(ctx, entry)
                if not found.confident or found.suggested_category is None:
                    raise _Skip("Not confident any more")
                if name_key(found.suggested_category) != name_key(category):
                    raise _Skip("Its suggestion changed")
                review.categorise(
                    db,
                    user_id,
                    entry,
                    found.suggested_category,
                    remember=False,
                    expected_amount=found.amount,
                )
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


def assess_one(db: Session, user_id: int, entry: SmsEntry) -> Assessment:
    return assess(Context(db, user_id, [entry]), entry)
