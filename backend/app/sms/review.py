"""Answering the To review list: what the owner says an SMS entry is.

Each answer is checked against the entry's reason (`ANSWERS`), then applied under the same save
checks a typed-in change goes through. The caller commits, or rolls back when an answer raises:
an answer either applies completely or not at all.
"""

from collections.abc import Iterable
from decimal import Decimal
from typing import Any, NoReturn

from fastapi import HTTPException, status
from fastapi.exceptions import RequestValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.routes.accounts import MAX_ID, field_error
from app.api.routes.fund_trades import fund_columns, fund_save_checks, sync_trade_nav
from app.api.routes.funds import MUTUAL_FUND
from app.api.routes.market import apply_link
from app.api.routes.stocks import STOCK
from app.api.routes.trades import MAX_QUANTITY, stock_columns, stock_save_checks
from app.api.routes.transactions import lock_accounts, save_checks
from app.api.trade_checks import lock_trade, require_active
from app.models.account import Account
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade, Sip
from app.models.market import MarketCode
from app.models.recurring import RecurringTemplate
from app.models.sms import AccountIdentifier, PayeeRule, SmsEntry
from app.models.transaction import Transaction
from app.sms import ingest
from app.sms.expected import Candidate, apply_expected, fund_nav, usable_nav
from app.sms.recording import link, record

OPEN = ("review", "draft")
# The answers each reason takes, besides "dismiss", which every reason takes.
ANSWERS: dict[str, set[str]] = {
    "category": {"category"},
    "account": {"account"},
    "maybe_duplicate": {"same", "new"},
    "maybe_transfer": {"transfer", "category"},
    "card_payment": {"account", "transfer"},
    # "same": an EMI already recorded for the period, suggested as a transaction.
    "expected": {"expected", "same", "category"},
    "sip_units": {"units", "units_ok"},
    "demat": {"trade"},
    "balance": {"retry"},
}
_GONE = "That transaction no longer exists."
CHANGED = "This payment changed since. Check it again."
_OWN_GONE = "This message's transaction no longer exists."


def _invalid(field: str, message: str) -> NoReturn:
    raise RequestValidationError([field_error(field, message)])


def _conflict(message: str) -> NoReturn:
    raise HTTPException(status.HTTP_409_CONFLICT, message)


def _done(entry: SmsEntry) -> None:
    entry.status, entry.reason, entry.message, entry.candidates = "recorded", None, None, None


# The entry


def lock_entry(db: Session, user_id: int, id_: int) -> SmsEntry:
    """The user's open entry, locked so two answers to it can't both apply."""
    entry = None
    if 1 <= id_ <= MAX_ID:  # a larger id can't exist; asking the database would be a 500
        entry = db.scalar(
            select(SmsEntry)
            .where(SmsEntry.id == id_, SmsEntry.user_id == user_id)
            .with_for_update()
        )
    if entry is None:  # someone else's entry is reported the same as one that doesn't exist
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Review item not found.")
    if entry.status not in OPEN:
        _conflict("This was already answered.")
    return entry


def check_answer(entry: SmsEntry, action: str) -> None:
    if action != "dismiss" and action not in ANSWERS.get(entry.reason or "", set()):
        _invalid("action", "That answer doesn't fit this item.")


def suggested_price(db: Session, user_id: int, entry: SmsEntry) -> Decimal | None:
    """For a share movement matched to exactly one of the owner's stocks: its price on the day,
    else the latest before it."""
    if entry.kind != "demat":
        return None
    stocks = [c["id"] for c in entry.candidates or [] if c.get("kind") == "stock"]
    if len(stocks) != 1:
        return None
    return db.scalar(
        select(InstrumentPrice.price)
        .where(
            InstrumentPrice.user_id == user_id,
            InstrumentPrice.instrument_id == stocks[0],
            InstrumentPrice.date <= entry.occurred_on,
        )
        .order_by(InstrumentPrice.date.desc(), InstrumentPrice.id.desc())
        .limit(1)
    )


def _candidate(entry: SmsEntry, kind: str, id_: int, field: str, message: str) -> dict[str, Any]:
    for choice in entry.candidates or []:
        if choice.get("kind") == kind and choice.get("id") == id_:
            return choice
    _invalid(field, message)


def redecide(db: Session, user_id: int, entry: SmsEntry, start: ingest.Step) -> None:
    """Runs ingestion's steps again on the entry, from `start` on."""
    entry.status, entry.reason, entry.message, entry.candidates = "review", None, None, None
    steps = ingest.STEPS[ingest.STEPS.index(start) :]
    for step in steps:
        if step(db, user_id, entry) is not None:
            break


# Transactions


def _values(tx: Transaction) -> dict[str, Any]:
    return {
        "type": tx.type,
        "account_id": tx.account_id,
        "to_account_id": tx.to_account_id,
        "amount": tx.amount,
        "date": tx.date,
        "category": tx.category,
        "interest": tx.interest,
        "note": tx.note,
        "recurring_template_id": tx.recurring_template_id,
    }


def _lock_transactions(
    db: Session, user_id: int, ids: Iterable[int], also: Iterable[int | None] = ()
) -> tuple[dict[int, Transaction], dict[int, Account]]:
    """The user's transactions among `ids` (missing ones left out) and their accounts plus
    `also`, all locked: the accounts first, in id order, then the transactions re-read."""
    wanted = [i for i in ids if 1 <= i <= MAX_ID]
    first = list(
        db.scalars(
            select(Transaction).where(Transaction.id.in_(wanted), Transaction.user_id == user_id)
        )
    )
    seen = {t.id: (t.account_id, t.to_account_id) for t in first}
    ends = [i for pair in seen.values() for i in pair]
    accounts = lock_accounts(db, user_id, [*ends, *also])
    found = {
        t.id: t
        for t in db.scalars(
            select(Transaction)
            .where(Transaction.id.in_(list(seen)), Transaction.user_id == user_id)
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    }
    if any((t.account_id, t.to_account_id) != seen[i] for i, t in found.items()):
        _conflict("This transaction changed while saving. Try again.")
    return found, accounts


def _link_waiting(db: Session, user_id: int, tx_id: int) -> None:
    """Entries of this transaction still asking about it are answered by it."""
    for other in db.scalars(
        select(SmsEntry).where(
            SmsEntry.user_id == user_id,
            SmsEntry.transaction_id == tx_id,
            SmsEntry.status.in_(OPEN),
        )
    ):
        _done(other)


def _rule(db: Session, user_id: int, entry: SmsEntry) -> PayeeRule:
    """The payee's rule, created when it has none yet."""
    assert entry.payee_key is not None
    query = select(PayeeRule).where(
        PayeeRule.user_id == user_id, PayeeRule.payee_key == entry.payee_key
    )
    rule = db.scalar(query)
    if rule is not None:
        return rule
    rule = PayeeRule(
        user_id=user_id, payee_key=entry.payee_key, display=entry.payee or entry.payee_key
    )
    try:
        with db.begin_nested():  # another request may create it first
            db.add(rule)
            db.flush()
    except IntegrityError:
        rule = db.scalar(query)
        assert rule is not None
    return rule


def remember_category(db: Session, user_id: int, entry: SmsEntry, category: str) -> PayeeRule:
    """The entry's payee is always this category from now on."""
    rule = _rule(db, user_id, entry)
    rule.category, rule.to_account_id = category, None
    db.flush()
    return rule


# Answers


def dismiss(db: Session, user_id: int, entry: SmsEntry) -> None:
    """Recorded money stays as it is; a message that recorded nothing is ignored. Dismissing a
    fund purchase's units means they are fine, so they stop being an estimate."""
    if entry.reason == "sip_units" and entry.trade_id is not None:
        trade = db.scalar(
            select(InvestmentTrade).where(
                InvestmentTrade.id == entry.trade_id, InvestmentTrade.user_id == user_id
            )
        )
        if trade is not None:
            trade.estimated = False
    if entry.transaction_id is not None or entry.trade_id is not None:
        _done(entry)
        return
    entry.status, entry.reason, entry.message, entry.candidates = "ignored", None, None, None


def _same_payee_waiting(
    db: Session, user_id: int, entry: SmsEntry, type_: str
) -> list[tuple[SmsEntry, Transaction]]:
    if entry.payee_key is None:
        return []
    rows = db.execute(
        select(SmsEntry, Transaction)
        .join(Transaction, Transaction.id == SmsEntry.transaction_id)
        .where(
            SmsEntry.user_id == user_id,
            SmsEntry.id != entry.id,
            SmsEntry.status == "review",
            SmsEntry.reason == "category",
            SmsEntry.payee_key == entry.payee_key,
            Transaction.user_id == user_id,
            Transaction.type == type_,
            Transaction.category.is_(None),
        )
        .order_by(SmsEntry.id)
    )
    return [(e, t) for e, t in rows]


def categorise(
    db: Session,
    user_id: int,
    entry: SmsEntry,
    category: str | None,
    remember: bool,
    expected_amount: Decimal | None = None,
) -> None:
    """Gives the entry's income or expense its category. `remember` keeps it as the payee's
    rule and answers the payee's other uncategorised items of the same type too.

    `expected_amount` is for an approval made from an earlier look: once locked, the money must
    still be uncategorised, not a reminder's, and of that amount, or nothing is changed."""
    if entry.transaction_id is None:
        _record_categorised(db, user_id, entry, category)
        return
    peek = db.get(Transaction, entry.transaction_id)
    others = (
        [] if peek is None or not remember else _same_payee_waiting(db, user_id, entry, peek.type)
    )
    txs, accounts = _lock_transactions(
        db, user_id, [entry.transaction_id, *(t.id for _, t in others)]
    )
    tx = txs.get(entry.transaction_id)
    if tx is None:
        _conflict(_OWN_GONE)
    if tx.type not in ("income", "expense"):
        _conflict(f"This is a {tx.type} now, which has no category.")
    if expected_amount is not None and (
        tx.category is not None
        or tx.recurring_template_id is not None
        or tx.amount != expected_amount
    ):
        _conflict(CHANGED)
    if category is None:
        # "Not a transfer" for money that already has its category.
        if entry.reason == "maybe_transfer" and tx.category is not None:
            _done(entry)
            return
        _invalid("category", "Choose a category.")
    values = {**_values(tx), "category": category}
    save_checks(db, user_id, accounts, values, existing_id=tx.id, link_changed=False)
    tx.category = values["category"]
    _done(entry)
    if not remember or entry.payee_key is None:
        return
    rule = _rule(db, user_id, entry)
    rule.category, rule.to_account_id = values["category"], None
    for other, other_tx in others:
        same = txs.get(other_tx.id)
        if same is None or same.type != tx.type or same.category is not None:
            continue
        changed = {**_values(same), "category": values["category"]}
        try:
            save_checks(db, user_id, accounts, changed, existing_id=same.id, link_changed=False)
        except RequestValidationError:  # an archived account, say: that one stays asked
            continue
        same.category = changed["category"]
        _done(other)


def _record_categorised(db: Session, user_id: int, entry: SmsEntry, category: str | None) -> None:
    """An expected payment that recorded nothing, answered "none of these": recorded now."""
    if entry.reason != "expected" or entry.account_id is None or entry.amount is None:
        _conflict(_OWN_GONE)
    if category is None:
        _invalid("category", "Choose a category.")
    values = {
        "type": "expense",
        "account_id": entry.account_id,
        "amount": entry.amount,
        "date": entry.occurred_on,
        "category": category,
        "note": entry.payee,
    }
    if not record(db, user_id, entry, values):
        _invalid("category", entry.message or "This can't be recorded.")
    _done(entry)


def _fits(db: Session, user_id: int, account_id: int, types: Iterable[str]) -> Account | None:
    if not 1 <= account_id <= MAX_ID:
        return None
    return db.scalar(
        select(Account).where(
            Account.id == account_id,
            Account.user_id == user_id,
            Account.archived_at.is_(None),
            Account.type.in_(list(types)),
        )
    )


def choose_account(
    db: Session, user_id: int, entry: SmsEntry, account_id: int, remember: bool
) -> None:
    if entry.reason == "card_payment":
        _card_paid_from(db, user_id, entry, account_id)
        return
    card = entry.kind in ingest.CARD_KINDS
    types = ("credit_card",) if card else ingest.BANK_SIDE_TYPES
    account = _fits(db, user_id, account_id, types)
    if account is None:
        _invalid("account_id", "Choose a card." if card else "Choose an account.")
    last4 = entry.last4
    if remember and last4 is not None and account.last4 != last4:
        known = db.scalar(
            select(AccountIdentifier.id).where(
                AccountIdentifier.account_id == account.id, AccountIdentifier.last4 == last4
            )
        )
        if known is None:
            db.add(AccountIdentifier(user_id=user_id, account_id=account.id, last4=last4))
            db.flush()
    entry.account_id = account.id
    after_account = ingest.STEPS[ingest.STEPS.index(ingest._account) + 1]
    redecide(db, user_id, entry, after_account)
    if not remember or last4 is None:
        return
    # Other messages with this number waiting for the same answer get decided again.
    for other in db.scalars(
        select(SmsEntry)
        .where(
            SmsEntry.user_id == user_id,
            SmsEntry.id != entry.id,
            SmsEntry.status == "review",
            SmsEntry.reason == "account",
            SmsEntry.last4 == last4,
        )
        .order_by(SmsEntry.occurred_on, SmsEntry.id)
    ).all():
        redecide(db, user_id, other, ingest._account)


def _card_paid_from(db: Session, user_id: int, entry: SmsEntry, account_id: int) -> None:
    """A card payment paid from this bank or wallet: a transfer to the card. The card's number
    isn't the payer's, so nothing is remembered."""
    payer = _fits(db, user_id, account_id, ingest.PAYERS)
    if payer is None or entry.account_id is None:
        _invalid("account_id", "Choose the bank or wallet that paid.")
    # A suggested debit from that account is the payment: it becomes the transfer, rather than
    # a second one being recorded next to it.
    offered = [c["id"] for c in entry.candidates or [] if c.get("kind") == "transaction"]
    debits = list(
        db.scalars(
            select(Transaction.id).where(
                Transaction.id.in_(offered),
                Transaction.user_id == user_id,
                Transaction.account_id == payer.id,
                Transaction.type == "expense",
            )
        )
    )
    if len(debits) > 1:
        _invalid("account_id", "Several debits from this account match. Choose the one that paid.")
    if debits:
        _card_paid_by(db, user_id, entry, debits[0])
        return
    values = {
        "type": "transfer",
        "account_id": payer.id,
        "to_account_id": entry.account_id,
        "amount": entry.amount,
        "date": entry.occurred_on,
        "category": None,
        "note": entry.payee,
    }
    if not record(db, user_id, entry, values):
        _invalid("account_id", entry.message or "This can't be recorded.")
    _done(entry)


def same(db: Session, user_id: int, entry: SmsEntry, transaction_id: int) -> None:
    """The message is a transaction already recorded: one the owner typed in, or (for an
    expected payment) an EMI already recorded for the period. Spending recorded from this
    message meanwhile goes. A transaction a message on the same side already tells of makes
    this one a second telling of it, so it is kept as a duplicate."""
    _candidate(
        entry, "transaction", transaction_id, "transaction_id", "Choose one of the suggestions."
    )
    if entry.transaction_id is not None:
        _drop_own_expense(db, user_id, entry, [entry.account_id])
    tx = db.scalar(
        select(Transaction).where(Transaction.id == transaction_id, Transaction.user_id == user_id)
    )
    if tx is None:
        _conflict(_GONE)
    taken = db.scalar(
        select(SmsEntry.id).where(
            SmsEntry.user_id == user_id,
            SmsEntry.transaction_id == tx.id,
            SmsEntry.id != entry.id,
            SmsEntry.kind.in_(ingest.side_of(entry.kind)),
        )
    )
    if taken is None:
        link(entry, tx.id)
    elif entry.reason == "expected":
        entry.status, entry.reason, entry.message, entry.candidates = "duplicate", None, None, None
    else:
        _conflict("That transaction already belongs to another message.")


def new(db: Session, user_id: int, entry: SmsEntry) -> None:
    """Not typed in after all: decided as a new message from the transfer step on."""
    redecide(db, user_id, entry, ingest._transfer)


def merge_transfer(db: Session, user_id: int, entry: SmsEntry, transaction_id: int) -> None:
    if entry.reason == "card_payment":
        _card_paid_by(db, user_id, entry, transaction_id)
        return
    _candidate(
        entry, "transaction", transaction_id, "transaction_id", "Choose one of the suggestions."
    )
    own_id = entry.transaction_id
    if own_id is None:
        _conflict(_OWN_GONE)
    txs, accounts = _lock_transactions(db, user_id, [own_id, transaction_id])
    own, other = txs.get(own_id), txs.get(transaction_id)
    if own is None:
        _conflict(_OWN_GONE)
    if other is None:
        _conflict(_GONE)
    if other.type == "transfer":
        _conflict("That transaction is already a transfer.")
    if {own.type, other.type} != {"income", "expense"} or own.account_id == other.account_id:
        _conflict("These two can't be one transfer between your accounts.")
    if own.recurring_template_id is not None or other.recurring_template_id is not None:
        _conflict("A reminder's payment can't become a transfer.")
    spend, received = (own, other) if own.type == "expense" else (other, own)
    values = {
        **_values(other),
        "type": "transfer",
        "account_id": spend.account_id,
        "to_account_id": received.account_id,
        "category": None,
        "interest": None,
    }
    # This message's own transaction goes; the other becomes the transfer for both.
    for linked in db.scalars(
        select(SmsEntry).where(SmsEntry.user_id == user_id, SmsEntry.transaction_id == own.id)
    ):
        linked.transaction_id = other.id
    db.flush()
    db.delete(own)
    db.flush()
    try:
        save_checks(
            db,
            user_id,
            accounts,
            values,
            existing_id=other.id,
            link_changed=False,
            allow_uncategorised=True,
        )
    except RequestValidationError as error:
        _invalid("transaction_id", error.errors()[0]["msg"])
    for field, value in values.items():
        setattr(other, field, value)
    db.flush()
    link(entry, other.id)
    _link_waiting(db, user_id, other.id)


def _card_paid_by(db: Session, user_id: int, entry: SmsEntry, transaction_id: int) -> None:
    """The card was paid by this bank or wallet debit: it becomes a transfer to the card."""
    _candidate(
        entry, "transaction", transaction_id, "transaction_id", "Choose one of the suggestions."
    )
    card_id = entry.account_id
    if card_id is None:
        _conflict("This card payment has no card.")
    txs, accounts = _lock_transactions(db, user_id, [transaction_id], also=[card_id])
    tx = txs.get(transaction_id)
    if tx is None:
        _conflict(_GONE)
    if tx.type == "transfer":
        _conflict("That transaction is already a transfer.")
    if tx.type != "expense":
        _conflict("Only a payment can have paid the card.")
    if tx.recurring_template_id is not None:
        _conflict("That payment belongs to a reminder.")
    values = {
        **_values(tx),
        "type": "transfer",
        "to_account_id": card_id,
        "category": None,
        "interest": None,
    }
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
    except RequestValidationError as error:
        _invalid("transaction_id", error.errors()[0]["msg"])
    for field, value in values.items():
        setattr(tx, field, value)
    db.flush()
    link(entry, tx.id)
    _link_waiting(db, user_id, tx.id)


def _drop_own_expense(db: Session, user_id: int, entry: SmsEntry, also: list[int | None]) -> None:
    """Deletes the uncategorised expense this message recorded while it waited, so something
    else can take its place. Its accounts and `also` are locked first."""
    own_id = entry.transaction_id
    assert own_id is not None
    txs, _ = _lock_transactions(db, user_id, [own_id], also)
    tx = txs.get(own_id)
    if tx is None:
        _conflict(_OWN_GONE)
    if tx.type != "expense" or tx.recurring_template_id is not None:
        _conflict("This payment was changed since. Edit it in Transactions instead.")
    shared = db.scalar(
        select(SmsEntry.id).where(
            SmsEntry.user_id == user_id,
            SmsEntry.transaction_id == tx.id,
            SmsEntry.id != entry.id,
        )
    )
    if shared is not None:  # replacing it would leave that message pointing at nothing
        _conflict("Another message is linked to this payment. Edit it in Transactions.")
    entry.transaction_id = None
    db.flush()
    db.delete(tx)
    db.flush()


def _sip_nav_known(db: Session, user_id: int, sip_id: int, entry: SmsEntry) -> bool:
    fund = db.scalar(
        select(Instrument)
        .join(Sip, Sip.instrument_id == Instrument.id)
        .where(Sip.id == sip_id, Sip.user_id == user_id)
    )
    if fund is None:  # the SIP is gone: applying it says so
        return True
    return usable_nav(fund_nav(db, user_id, fund, entry.occurred_on)) is not None


def expected(
    db: Session,
    user_id: int,
    entry: SmsEntry,
    kind: str,
    id_: int,
    remember: bool,
    nav: Decimal | None = None,
) -> None:
    """The debit was this EMI, SIP or reminder. The uncategorised expense recorded meanwhile
    is replaced by it. A SIP whose fund has no NAV for the day takes the NAV from the answer."""
    candidate = _candidate(entry, kind, id_, "id", "Choose one of the suggested payments.")
    if nav is not None and kind != "sip":
        _invalid("nav", "Only a SIP takes a NAV.")
    if kind == "sip" and nav is None and not _sip_nav_known(db, user_id, id_, entry):
        _invalid("nav", "There's no NAV for this fund on that day. Enter it from your statement.")
    also: list[int | None] = [entry.account_id]
    if kind == "emi":
        also.append(id_)
    elif kind == "template":
        also.append(
            db.scalar(
                select(RecurringTemplate.to_account_id).where(
                    RecurringTemplate.id == id_, RecurringTemplate.user_id == user_id
                )
            )
        )
    if entry.transaction_id is None:
        lock_accounts(db, user_id, also)
    else:
        _drop_own_expense(db, user_id, entry, also)
    choice: Candidate = {
        "kind": candidate["kind"],
        "id": candidate["id"],
        "label": candidate["label"],
    }
    if not apply_expected(db, user_id, entry, choice, nav):
        if entry.reason == "balance" and entry.message:
            _invalid("id", entry.message)
        _invalid(
            "nav" if nav is not None else "id",
            f"{choice['label']} can't be recorded from this message. Choose another answer.",
        )
    if remember and kind == "template" and entry.payee_key is not None:
        _rule(db, user_id, entry).template_id = id_


def _fund_trade(db: Session, user_id: int, entry: SmsEntry) -> InvestmentTrade:
    trade = None
    if entry.trade_id is not None:
        trade = db.scalar(
            select(InvestmentTrade).where(
                InvestmentTrade.id == entry.trade_id, InvestmentTrade.user_id == user_id
            )
        )
    if trade is None:
        _conflict("That fund purchase no longer exists.")
    return trade


def units(
    db: Session, user_id: int, entry: SmsEntry, units_: Decimal | None, nav: Decimal | None
) -> None:
    """The units and NAV from the fund statement replace the estimate."""
    trade, accounts = lock_trade(db, user_id, _fund_trade(db, user_id, entry).id, MUTUAL_FUND)
    require_active(accounts, [trade.account_id])
    values: dict[str, Any] = {
        "fund_id": trade.instrument_id,
        "account_id": trade.account_id,
        "side": trade.side,
        "date": trade.date,
        "units": units_,
        "nav": nav,
        "charges": trade.charges,
        "amount": trade.amount,
        "opening": trade.opening,
        "sip_id": trade.sip_id,
        "note": trade.note,
    }
    _, price = fund_save_checks(db, user_id, accounts, values, existing_id=trade.id)
    for field, value in fund_columns(values, price).items():
        setattr(trade, field, value)
    trade.estimated = False
    db.flush()
    sync_trade_nav(db, trade)
    _done(entry)


def units_ok(db: Session, user_id: int, entry: SmsEntry) -> None:
    _fund_trade(db, user_id, entry).estimated = False
    _done(entry)


_SIDES = {"debit": "sell", "credit": "buy"}


def _stock_code(db: Session, entry: SmsEntry, symbol: str) -> str | None:
    """The market listing a new stock is linked to: the ISIN's, else a suggested listing whose
    code is the symbol chosen."""
    if entry.isin is not None:
        code = db.scalar(
            select(MarketCode.code)
            .where(MarketCode.kind == STOCK, MarketCode.isin == entry.isin)
            .order_by(MarketCode.id)
            .limit(1)
        )
        if code is not None:
            return code
    ids = [c["id"] for c in entry.candidates or [] if c.get("kind") == "market"]
    if not ids:
        return None
    return db.scalar(
        select(MarketCode.code).where(
            MarketCode.id.in_(ids), MarketCode.kind == STOCK, MarketCode.code == symbol
        )
    )


def trade(
    db: Session,
    user_id: int,
    entry: SmsEntry,
    *,
    stock_id: int | None,
    account_id: int | None,
    price: Decimal | None,
    charges: Decimal | None,
    symbol: str | None,
    name: str | None,
    side: str | None,
) -> None:
    """The share movement recorded as a stock trade, the stock created first if need be."""
    known = _SIDES.get(entry.ref or "")
    if known is None and side is None:
        _invalid("side", "Choose buy or sell.")
    if known is not None and side is not None and side != known:
        _invalid("side", f"The message says this was a {known}.")
    quantity = entry.quantity
    if (
        quantity is None
        or quantity != quantity.to_integral_value()
        or not 1 <= quantity <= MAX_QUANTITY
    ):
        _invalid("quantity", "The message's quantity isn't whole shares. Add this trade by hand.")
    accounts = lock_accounts(db, user_id, [account_id])
    code = None
    if stock_id is None:
        errors = []
        if symbol is None:
            errors.append(field_error("symbol", "Enter the stock's symbol."))
        if name is None:
            errors.append(field_error("name", "Enter a name."))
        if errors:
            raise RequestValidationError(errors)
        assert symbol is not None and name is not None
        taken = db.scalar(
            select(Instrument.id).where(
                Instrument.user_id == user_id,
                Instrument.kind == STOCK,
                func.upper(Instrument.symbol) == symbol,
            )
        )
        if taken is not None:
            _invalid("symbol", f"You already have {symbol}.")
        code = _stock_code(db, entry, symbol)
        stock = Instrument(user_id=user_id, kind=STOCK, symbol=symbol, name=name, source_code=code)
        db.add(stock)
        db.flush()
        stock_id = stock.id
    values: dict[str, Any] = {
        "stock_id": stock_id,
        "account_id": account_id,
        "side": known or side,
        "date": entry.occurred_on,
        "quantity": int(quantity),
        "price": price,
        "charges": Decimal(0) if charges is None else charges,
        "opening": False,
        "note": None,
    }
    stock_save_checks(db, user_id, accounts, values, existing_id=None)
    row = InvestmentTrade(user_id=user_id, **stock_columns(values))
    db.add(row)
    db.flush()
    if code is not None:
        apply_link(db, STOCK, user_id)
    entry.trade_id = row.id
    _done(entry)


def retry(db: Session, user_id: int, entry: SmsEntry) -> None:
    """Decided again from the account on, after the owner fixed what stopped it."""
    redecide(db, user_id, entry, ingest._account)
