"""What each parsed bank SMS becomes.

`decide` stores the message, then runs the steps in `STEPS` in order. Each step either decides the
entry (returns it) or leaves it to the next (returns None). Money is recorded straight away
whenever the account and amount are known; whatever is still missing is left as a review reason.
"""

import re
from collections.abc import Callable
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any

from fastapi.exceptions import RequestValidationError
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.routes.accounts import rupees
from app.api.routes.transactions import lock_accounts, save_checks
from app.models.account import Account
from app.models.investment import Instrument, InvestmentTrade
from app.models.market import MarketCode
from app.models.sms import AccountIdentifier, PayeeRule, SmsEntry
from app.models.transaction import Transaction
from app.sms.expected import apply_expected, emis_paid, expected_candidates, rule_template
from app.sms.merchants import builtin_category
from app.sms.payees import display_name, payee_key
from app.sms.recording import link as _link
from app.sms.recording import record
from app.sms.recording import review as _review

if TYPE_CHECKING:
    from app.api.routes.sms import ParsedSms

MONEY_OUT = {"debit", "card_spend"}
MONEY_IN = {"credit"}
# The two sides a message can tell of one transaction. A transfer between the owner's accounts
# is told once from each side, so it can carry one message of each.
OUT_SIDE = MONEY_OUT
IN_SIDE = MONEY_IN | {"card_payment"}
CARD_KINDS = {"card_spend", "card_payment", "card_statement"}
# A debit card's spend lands on its bank through an identifier, so cards count for debits too.
BANK_SIDE_TYPES = ("bank", "wallet", "credit_card")
MANUAL_WINDOW = timedelta(days=1)
PAIR_WINDOW = timedelta(days=3)
PAYERS = ("bank", "wallet")
# A payee that is a masked account number, as a payee key: "xx650", "x8650", "a/c xx8650".
_MASKED = re.compile(r"^(?:a/?c\.?\s*)?x+(\d{3,4})$")
# Payees that pay card bills.
_BILL_WORDS = re.compile(r"\bcred|billdesk|\bcards?\b|\bcc\b")

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


_NAME_NOISE = {"ltd", "limited", "the"}
SHARE_WINDOW = timedelta(days=2)
MARKET_CHOICES = 5


def _name_words(text: str | None) -> str:
    """A security name for comparing: casefolded, no punctuation, without Ltd / Limited / The."""
    words = re.sub(r"[^0-9a-z]+", " ", (text or "").casefold()).split()
    return " ".join(w for w in words if w not in _NAME_NOISE)


def _same_security(sms_name: str, name: str, symbol: str | None = None) -> bool:
    """Whether a stock's name (or symbol) starts with the SMS name or the SMS name starts with it.
    The SMS name is cut short by CDSL, so either may be the longer one. A symbol is shorter than
    any name, so there the SMS name has to continue it at a word."""
    if not sms_name:
        return False
    full = _name_words(name)
    if full and (full.startswith(sms_name) or sms_name.startswith(full)):
        return True
    code = _name_words(symbol)
    return bool(code) and (code.startswith(sms_name) or sms_name.startswith(code + " "))


def _owned_stocks(db: Session, user_id: int, entry: SmsEntry) -> list[Instrument]:
    stocks = list(
        db.scalars(
            select(Instrument)
            .where(Instrument.user_id == user_id, Instrument.kind == "stock")
            .order_by(Instrument.id)
        )
    )
    if entry.isin is not None:
        codes = select(MarketCode.code).where(
            MarketCode.kind == "stock", MarketCode.isin == entry.isin
        )
        by_isin = [s for s in stocks if s.source_code in set(db.scalars(codes))]
        if by_isin:
            return by_isin
    name = _name_words(entry.payee)
    return [s for s in stocks if _same_security(name, s.name, s.symbol)]


def _market_stocks(db: Session, entry: SmsEntry) -> list[MarketCode]:
    """Public stock listings the SMS could be, to prefill "create this stock"."""
    if entry.isin is not None:
        found = list(
            db.scalars(
                select(MarketCode)
                .where(MarketCode.kind == "stock", MarketCode.isin == entry.isin)
                .order_by(MarketCode.id)
            )
        )
        if found:
            return found
    name = _name_words(entry.payee)
    if not name:
        return []
    first = name.split()[0]
    rows = db.scalars(
        select(MarketCode)
        .where(MarketCode.kind == "stock", MarketCode.name.ilike(f"{first}%"))
        .order_by(MarketCode.name, MarketCode.id)
    )
    return [m for m in rows if _same_security(name, m.name, m.code)][:MARKET_CHOICES]


def _typed_trade(
    db: Session, user_id: int, entry: SmsEntry, stocks: list[Instrument]
) -> InvestmentTrade | None:
    """The one trade of these stocks the owner already typed in for this share movement."""
    if not stocks or entry.quantity is None:
        return None
    linked = select(SmsEntry.trade_id).where(
        SmsEntry.user_id == user_id, SmsEntry.trade_id.is_not(None)
    )
    found = list(
        db.scalars(
            select(InvestmentTrade).where(
                InvestmentTrade.user_id == user_id,
                InvestmentTrade.instrument_id.in_([s.id for s in stocks]),
                InvestmentTrade.opening.is_(False),
                InvestmentTrade.side == ("sell" if entry.ref == "debit" else "buy"),
                InvestmentTrade.quantity == entry.quantity,
                InvestmentTrade.date >= entry.occurred_on - SHARE_WINDOW,
                InvestmentTrade.date <= entry.occurred_on + SHARE_WINDOW,
                InvestmentTrade.id.not_in(linked),
            )
        )
    )
    return found[0] if len(found) == 1 else None


def _demat(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """A CDSL share movement: a trade the owner typed in already, else a draft for them to
    confirm. The demat account number isn't a bank account, so no account is looked up. Nothing
    is recorded."""
    if entry.kind != "demat":
        return None
    stocks = _owned_stocks(db, user_id, entry)
    trade = _typed_trade(db, user_id, entry, stocks)
    if trade is not None:
        entry.trade_id = trade.id
        entry.status = "duplicate"
        return entry
    entry.status = "draft"
    entry.reason = "demat"
    verb = "Sold" if entry.ref == "debit" else "Bought"
    quantity = "" if entry.quantity is None else f"{entry.quantity.normalize():f} "
    entry.message = f"{verb} {quantity}{entry.payee or 'shares'}"[:200]
    if stocks:
        entry.candidates = [{"kind": "stock", "id": s.id, "label": s.symbol} for s in stocks]
    else:
        entry.candidates = [
            {"kind": "market", "id": m.id, "label": f"{m.code} · {m.name}"}
            for m in _market_stocks(db, entry)
        ]
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


def side_of(kind: str) -> set[str]:
    """The message kinds on the same side as `kind`: money out, or money in."""
    return OUT_SIDE if kind in OUT_SIDE else IN_SIDE


def linked_on_side(user_id: int, kind: str) -> Any:
    """Transactions a message on the same side as `kind` already belongs to. One from the other
    side may still join them: the two halves of a transfer."""
    return select(SmsEntry.transaction_id).where(
        SmsEntry.user_id == user_id,
        SmsEntry.transaction_id.is_not(None),
        SmsEntry.kind.in_(side_of(kind)),
    )


def _claimed(db: Session, user_id: int, entry: SmsEntry, tx_id: int) -> bool:
    """Whether a message on this entry's side already belongs to the transaction."""
    return (
        db.scalar(
            select(SmsEntry.id)
            .where(
                SmsEntry.user_id == user_id,
                SmsEntry.transaction_id == tx_id,
                SmsEntry.kind.in_(side_of(entry.kind)),
            )
            .limit(1)
        )
        is not None
    )


def _typed_by_hand(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """The owner already typed this in: link to it instead of recording it again."""
    if entry.kind not in OUT_SIDE | IN_SIDE or entry.amount is None:
        return None
    linked = linked_on_side(user_id, entry.kind)
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


# Transfers


def _near(column: Any, day: date) -> Any:
    return and_(column >= day - PAIR_WINDOW, column <= day + PAIR_WINDOW)


def _closest(
    rows: list[Any], day: date, day_of: Callable[[Any], date], id_of: Callable[[Any], int]
) -> list[Any]:
    return sorted(rows, key=lambda r: (abs((day_of(r) - day).days), id_of(r)))


def _active_account(db: Session, user_id: int, id_: int | None) -> int | None:
    if id_ is None:
        return None
    return db.scalar(
        select(Account.id).where(
            Account.id == id_, Account.user_id == user_id, Account.archived_at.is_(None)
        )
    )


def _sms_sides(
    db: Session, user_id: int, entry: SmsEntry, kind: str, tx_type: str, *where: Any
) -> list[tuple[SmsEntry, Transaction]]:
    """Other SMS entries of `kind` whose money was recorded as `tx_type` (so not yet paired), of
    the same amount and within the pair window, closest first."""
    query = (
        select(SmsEntry, Transaction)
        .join(Transaction, Transaction.id == SmsEntry.transaction_id)
        .where(
            SmsEntry.user_id == user_id,
            Transaction.user_id == user_id,
            SmsEntry.id != entry.id,
            SmsEntry.kind == kind,
            SmsEntry.status.not_in(("ignored", "duplicate")),
            Transaction.type == tx_type,
            Transaction.account_id == SmsEntry.account_id,
            Transaction.amount == entry.amount,
            Transaction.recurring_template_id.is_(None),
            _near(Transaction.date, entry.occurred_on),
            *where,
        )
    )
    rows = [(e, tx) for e, tx in db.execute(query)]
    return _closest(rows, entry.occurred_on, lambda r: r[1].date, lambda r: r[1].id)


def _convert(db: Session, user_id: int, tx: Transaction, from_id: int, to_id: int) -> bool:
    """Turns a recorded expense or income into a transfer, under the usual save checks."""
    values = {
        "type": "transfer",
        "account_id": from_id,
        "to_account_id": to_id,
        "amount": tx.amount,
        "date": tx.date,
        "category": None,
        "interest": None,
        "note": tx.note,
        "recurring_template_id": None,
    }
    # The old accounts are locked too: their balances change as well.
    accounts = lock_accounts(db, user_id, [tx.account_id, tx.to_account_id, from_id, to_id])
    try:
        save_checks(
            db,
            user_id,
            accounts,
            values,
            existing_id=tx.id,
            link_changed=False,
            allow_uncategorised=True,
        )
    except RequestValidationError:
        return False
    for field, value in values.items():
        setattr(tx, field, value)
    db.flush()
    return True


def _join(
    db: Session,
    user_id: int,
    entry: SmsEntry,
    sides: list[tuple[SmsEntry, Transaction]],
    from_id: int | None,
    to_id: int | None,
) -> SmsEntry | None:
    """Makes the first side that passes the checks one transfer with this entry. A `None` end
    is the other side's account."""
    for other, tx in sides:
        source = other.account_id if from_id is None else from_id
        target = other.account_id if to_id is None else to_id
        if source is None or target is None:
            continue
        if _convert(db, user_id, tx, source, target):
            _link(entry, tx.id)
            _link(other, tx.id)
            return entry
    return None


def _waiting_card_payments(
    db: Session, user_id: int, entry: SmsEntry, card_id: int | None = None
) -> list[SmsEntry]:
    """Card "payment received" messages still asking which account paid, closest first."""
    active_cards = select(Account.id).where(
        Account.user_id == user_id,
        Account.type == "credit_card",
        Account.archived_at.is_(None),
    )
    query = select(SmsEntry).where(
        SmsEntry.user_id == user_id,
        SmsEntry.kind == "card_payment",
        SmsEntry.status == "review",
        SmsEntry.reason == "card_payment",
        SmsEntry.transaction_id.is_(None),
        SmsEntry.amount == entry.amount,
        _near(SmsEntry.occurred_on, entry.occurred_on),
        SmsEntry.account_id.in_(active_cards),
    )
    if card_id is not None:
        query = query.where(SmsEntry.account_id == card_id)
    rows = list(db.scalars(query))
    return _closest(rows, entry.occurred_on, lambda e: e.occurred_on, lambda e: e.id)


def _record_transfer(
    db: Session, user_id: int, entry: SmsEntry, to_id: int, waiting: SmsEntry | None = None
) -> SmsEntry:
    """Records this debit as a transfer to `to_id`; a card payment waiting for it links too."""
    values = {
        "type": "transfer",
        "account_id": entry.account_id,
        "to_account_id": to_id,
        "amount": entry.amount,
        "date": entry.occurred_on,
        "category": None,
        "note": entry.payee,
    }
    if not record(db, user_id, entry, values):
        return entry
    tx_id = entry.transaction_id
    assert tx_id is not None
    _link(entry, tx_id)
    if waiting is None:
        found = _waiting_card_payments(db, user_id, entry, to_id)
        waiting = found[0] if found else None
    if waiting is not None:
        _link(waiting, tx_id)
    return entry


def _rule_target(db: Session, user_id: int, entry: SmsEntry) -> int | None:
    if entry.payee_key is None:
        return None
    target = db.scalar(
        select(PayeeRule.to_account_id).where(
            PayeeRule.user_id == user_id, PayeeRule.payee_key == entry.payee_key
        )
    )
    if target == entry.account_id:
        return None
    return _active_account(db, user_id, target)


def _masked_target(db: Session, user_id: int, entry: SmsEntry) -> int | None:
    """The one other account a masked payee such as "XX650" or "A/c XX8650" ends like."""
    match = _MASKED.match(entry.payee_key or "")
    if match is None:
        return None
    ending = f"%{match.group(1)}"
    identified = select(AccountIdentifier.account_id).where(
        AccountIdentifier.user_id == user_id, AccountIdentifier.last4.like(ending)
    )
    found = db.scalars(
        select(Account.id).where(
            Account.user_id == user_id,
            Account.archived_at.is_(None),
            Account.id != entry.account_id,
            or_(Account.last4.like(ending), Account.id.in_(identified)),
        )
    ).all()
    return found[0] if len(found) == 1 else None


def _bill_like(key: str | None, card: Account) -> bool:
    """Whether a payee reads like paying this card's bill: CRED, BillDesk, "credit card", the
    card's bank, or the card's masked number."""
    if not key:
        return False
    if _BILL_WORDS.search(key):
        return True
    bank = (card.institution or "").casefold().strip()
    if bank and re.search(rf"\b{re.escape(bank)}\b", key):
        return True
    masked = re.search(r"x+(\d{3,4})\b", key)
    return masked is not None and card.last4 is not None and card.last4.endswith(masked.group(1))


def _offer(card_entry: SmsEntry, tx: Transaction) -> None:
    """Adds a debit to a waiting card payment's choices, ahead of the accounts."""
    choices = list(card_entry.candidates or [])
    if any(c["kind"] == "transaction" and c["id"] == tx.id for c in choices):
        return
    found = [c for c in choices if c["kind"] == "transaction"]
    rest = [c for c in choices if c["kind"] != "transaction"]
    card_entry.candidates = [
        *found,
        {"kind": "transaction", "id": tx.id, "label": _label(tx)},
        *rest,
    ]


def _maybe_transfer(
    db: Session, user_id: int, entry: SmsEntry, sides: list[tuple[SmsEntry, Transaction]]
) -> SmsEntry:
    """Recorded as usual, but asked about: equal amounts alone aren't evidence of a transfer."""
    _category(db, user_id, entry)
    if entry.transaction_id is None:
        return entry
    _review(entry, "maybe_transfer", "Is this a transfer between your accounts?")
    entry.candidates = [
        {"kind": "transaction", "id": tx.id, "label": _label(tx)} for _, tx in sides
    ]
    return entry


def _pending_transfer_into(db: Session, user_id: int, entry: SmsEntry) -> Transaction | None:
    """A transfer into this account, typed in or recorded from the paying side's SMS, whose
    receiving side hasn't come yet."""
    received = linked_on_side(user_id, "credit")
    query = select(Transaction).where(
        Transaction.user_id == user_id,
        Transaction.type == "transfer",
        Transaction.to_account_id == entry.account_id,
        Transaction.amount == entry.amount,
        _near(Transaction.date, entry.occurred_on),
        Transaction.id.not_in(received),
    )
    rows = _closest(list(db.scalars(query)), entry.occurred_on, lambda t: t.date, lambda t: t.id)
    return rows[0] if rows else None


def _pending_transfer_out_of(db: Session, user_id: int, entry: SmsEntry) -> Transaction | None:
    """A transfer out of this account, typed in or recorded from the receiving side (a card
    payment answered with this account), whose paying debit hasn't come yet."""
    paid = linked_on_side(user_id, "debit")
    query = select(Transaction).where(
        Transaction.user_id == user_id,
        Transaction.type == "transfer",
        Transaction.account_id == entry.account_id,
        Transaction.amount == entry.amount,
        _near(Transaction.date, entry.occurred_on),
        Transaction.id.not_in(paid),
    )
    rows = _closest(list(db.scalars(query)), entry.occurred_on, lambda t: t.date, lambda t: t.id)
    return rows[0] if rows else None


def _debit_side(db: Session, user_id: int, entry: SmsEntry, account: Account) -> SmsEntry | None:
    here = account.id
    pending = _pending_transfer_out_of(db, user_id, entry)
    if pending is not None:
        _link(entry, pending.id)
        return entry
    if entry.ref is not None:
        same_ref = _sms_sides(
            db,
            user_id,
            entry,
            "credit",
            "income",
            SmsEntry.ref == entry.ref,
            SmsEntry.account_id != here,
        )
        if _join(db, user_id, entry, same_ref, here, None) is not None:
            return entry
    target = _rule_target(db, user_id, entry) or _masked_target(db, user_id, entry)
    if target is not None:
        arrived = _sms_sides(db, user_id, entry, "credit", "income", SmsEntry.account_id == target)
        if _join(db, user_id, entry, arrived, here, target) is not None:
            return entry
        return _record_transfer(db, user_id, entry, target)
    waiting = _waiting_card_payments(db, user_id, entry) if account.type in PAYERS else []
    if len(waiting) == 1 and waiting[0].account_id is not None:
        card = db.get(Account, waiting[0].account_id)
        # The card SMS proves a payment reached the card, not that this debit paid it: a debit
        # with its own category (a Swiggy order) stays an expense unless it reads like a bill.
        if card is not None and (
            _category_for(db, user_id, entry) is None or _bill_like(entry.payee_key, card)
        ):
            return _record_transfer(db, user_id, entry, card.id, waiting[0])
    # Not a transfer the evidence proves: an EMI, a SIP or a reminder before a guess.
    if expected_payment(db, user_id, entry, account) is None:
        other_side = _sms_sides(db, user_id, entry, "credit", "income", SmsEntry.account_id != here)
        if other_side:
            _maybe_transfer(db, user_id, entry, other_side)
        else:
            _category(db, user_id, entry)
    tx = None if entry.transaction_id is None else db.get(Transaction, entry.transaction_id)
    # A plain expense may have paid the card; an EMI or a reminder's payment didn't.
    if tx is not None and tx.type == "expense" and tx.recurring_template_id is None:
        for card_entry in waiting:
            _offer(card_entry, tx)
    return entry


def _credit_side(db: Session, user_id: int, entry: SmsEntry, account: Account) -> SmsEntry | None:
    here = account.id
    pending = _pending_transfer_into(db, user_id, entry)
    if pending is not None:
        _link(entry, pending.id)
        return entry
    if entry.ref is not None:
        same_ref = _sms_sides(
            db,
            user_id,
            entry,
            "debit",
            "expense",
            SmsEntry.ref == entry.ref,
            SmsEntry.account_id != here,
        )
        if _join(db, user_id, entry, same_ref, None, here) is not None:
            return entry
    other_side = _sms_sides(db, user_id, entry, "debit", "expense", SmsEntry.account_id != here)
    if other_side:
        return _maybe_transfer(db, user_id, entry, other_side)
    return None


def _card_paid(db: Session, user_id: int, entry: SmsEntry, card: Account) -> SmsEntry:
    """A card "payment received": the bank debit that paid it, else ask which account paid."""
    pending = _pending_transfer_into(db, user_id, entry)
    if pending is not None:
        _link(entry, pending.id)
        return entry
    payers = select(Account.id).where(
        Account.user_id == user_id,
        Account.archived_at.is_(None),
        Account.type.in_(PAYERS),
    )
    debits = _sms_sides(db, user_id, entry, "debit", "expense", SmsEntry.account_id.in_(payers))
    # Only one debit, and nothing says it was anything else: it paid the card. Otherwise ask.
    if len(debits) == 1:
        other, tx = debits[0]
        if tx.category is None or _bill_like(other.payee_key, card):
            if _join(db, user_id, entry, debits, None, card.id) is not None:
                return entry
    amount = "" if entry.amount is None else f"{rupees(entry.amount)} "
    _review(entry, "card_payment", f"Which account paid {amount}to {card.name}?")
    accounts = db.scalars(
        select(Account)
        .where(
            Account.user_id == user_id,
            Account.archived_at.is_(None),
            Account.type.in_(PAYERS),
        )
        .order_by(Account.id)
    )
    entry.candidates = [
        *({"kind": "transaction", "id": tx.id, "label": _label(tx)} for _, tx in debits),
        *({"kind": "account", "id": a.id, "label": a.name} for a in accounts),
    ]
    return entry


def pair_transfer(db: Session, user_id: int, entry: SmsEntry, account: Account) -> SmsEntry | None:
    """One transfer from the two sides of a move between the owner's own accounts.

    Sides merge only with evidence: the same reference on both, a payee that is one of the
    owner's own account numbers, a payee rule pointing at an account, or a card "payment
    received". Equal amounts alone are recorded as they are and asked about ("maybe_transfer").
    `account` is the entry's resolved account.
    """
    if entry.kind == "card_payment":
        return _card_paid(db, user_id, entry, account)
    if entry.amount is None:
        return None
    if entry.kind == "debit":
        return _debit_side(db, user_id, entry, account)
    if entry.kind in MONEY_IN:
        return _credit_side(db, user_id, entry, account)
    return None


def _transfer(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    account = None if entry.account_id is None else db.get(Account, entry.account_id)
    if account is None or account.user_id != user_id:
        return None
    return pair_transfer(db, user_id, entry, account)


# Expected payments


def _same_emi(db: Session, user_id: int, entry: SmsEntry, tx: Transaction) -> bool:
    """Whether a recorded EMI is surely this debit: no debit message has it yet, and it is in the
    debit's calendar month or within the manual window. One further off, across a month end
    (last month's, typed in late in the month), may be a different instalment: that is asked."""
    close = (tx.date.year, tx.date.month) == (entry.occurred_on.year, entry.occurred_on.month) or (
        abs(tx.date - entry.occurred_on) <= MANUAL_WINDOW
    )
    return close and not _claimed(db, user_id, entry, tx.id)


def expected_payment(
    db: Session, user_id: int, entry: SmsEntry, account: Account
) -> SmsEntry | None:
    """A debit that is an EMI, a SIP instalment or a recurring reminder ticks it off.

    One candidate is applied when the evidence is enough: an EMI or SIP (the account and exact
    amount), or a reminder the payee is tied to by a rule. Otherwise the money is recorded as an
    uncategorised expense and the owner is asked, with every candidate. Nothing is guessed.

    An EMI whose period is already paid isn't applied again: the one EMI recorded for it that no
    debit message has claimed yet, in the debit's month or a day from it, is this debit;
    otherwise the owner is asked, with those EMIs.
    A SIP whose fund has no NAV for the day is asked about too, for the NAV.
    """
    if entry.kind != "debit" or entry.amount is None:
        return None
    found = expected_candidates(
        db, user_id, account, entry.amount, entry.occurred_on, entry.payee_key
    )
    if not found:
        return None
    paid: list[Transaction] = []
    if len(found) == 1:
        only = found[0]
        tied = rule_template(db, user_id, entry.payee_key) == only["id"]
        if only["kind"] == "emi":
            paid = emis_paid(db, user_id, only["id"], entry.occurred_on)
            if len(paid) == 1 and _same_emi(db, user_id, entry, paid[0]):
                _link(entry, paid[0].id)
                return entry
        if (only["kind"] == "template" and tied) or (
            only["kind"] in ("emi", "sip") and not paid and not only.get("needs_nav")
        ):
            apply_expected(db, user_id, entry, only)
            return entry
        message = f"Is this your {only['label']}?"
        if paid:
            message = f"Is this another {only['label']}? One is already recorded for it."
    else:
        message = "Which of your expected payments is this?"
    values = {
        "type": "expense",
        "account_id": entry.account_id,
        "amount": entry.amount,
        "date": entry.occurred_on,
        "category": None,
        "note": entry.payee,
    }
    if record(db, user_id, entry, values):
        _review(entry, "expected", message)
        entry.candidates = [
            *(dict(c) for c in found),
            *({"kind": "transaction", "id": tx.id, "label": _label(tx)} for tx in paid),
        ]
    return entry


def _category_for(db: Session, user_id: int, entry: SmsEntry) -> str | None:
    """The owner's rule for this payee, else (for money out) the built-in merchant list."""
    if entry.payee_key is None:
        return None
    rule = db.scalar(
        select(PayeeRule).where(
            PayeeRule.user_id == user_id, PayeeRule.payee_key == entry.payee_key
        )
    )
    if rule is not None and rule.category is not None:
        return rule.category
    if entry.kind in MONEY_OUT:
        return builtin_category(entry.payee_key)
    return None


def _category(db: Session, user_id: int, entry: SmsEntry) -> SmsEntry | None:
    """Records the money as income or an expense, categorised when the payee is known."""
    spending = entry.kind in MONEY_OUT
    category = _category_for(db, user_id, entry)
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


# The order matters. Expected payments (`expected_payment`) are decided inside `_transfer`, for
# debits no transfer evidence claimed, before they fall back to `_category`.
STEPS: list[Step] = [
    _demat,
    _account,
    _card_statement,
    _same_ref,
    _typed_by_hand,
    _transfer,
    _category,
]
