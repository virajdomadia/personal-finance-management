"""Debits that are a payment the owner already expects: an EMI, a SIP instalment or a recurring
reminder (rent, say). Such a debit ticks its plan off instead of being asked about as new spending.

`expected_candidates` finds the plans a debit could be; `apply_expected` records the debit as one.
"""

from collections import defaultdict
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal, TypedDict

from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.loans import load_book, next_emi
from app.api.recurring import TemplateRow, is_recorded, status
from app.api.routes.fund_trades import fund_columns, fund_save_checks, sync_trade_nav
from app.api.routes.transactions import lock_accounts
from app.api.sips import DEBIT_SLACK, load_due
from app.models.account import Account
from app.models.insurance import InsurancePolicy
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade, Sip
from app.models.market import MarketCode
from app.models.recurring import RecurringSkip, RecurringTemplate
from app.models.sms import PayeeRule, SmsEntry
from app.models.transaction import Transaction
from app.sms.recording import record, review

SIP_WINDOW = timedelta(days=DEBIT_SLACK)  # an instalment is debited within this of its day
TEMPLATE_SPREAD = Decimal("0.10")  # a reminder's payment may differ this much from its amount
UNITS = Decimal("0.001")
SIP_UNITS_MESSAGE = "Check the units against your fund statement"


class Candidate(TypedDict):
    kind: Literal["emi", "sip", "template"]
    id: int
    label: str


def rule_template(db: Session, user_id: int, payee_key: str | None) -> int | None:
    """The reminder the owner tied this payee to, if any."""
    if payee_key is None:
        return None
    return db.scalar(
        select(PayeeRule.template_id).where(
            PayeeRule.user_id == user_id, PayeeRule.payee_key == payee_key
        )
    )


# Finding


def _emis(db: Session, user_id: int, account: Account, amount: Decimal) -> list[Candidate]:
    """Active loans paid from this account whose EMI is exactly this amount.

    A loan whose next EMI can't be split into interest and principal isn't offered: its EMI
    would have to guess the split.
    """
    loans = list(
        db.scalars(
            select(Account)
            .where(
                Account.user_id == user_id,
                Account.type == "loan",
                Account.archived_at.is_(None),
                Account.pay_from_id == account.id,
                Account.emi_amount == amount,
            )
            .order_by(Account.id)
        )
    )
    if not loans:
        return []
    book = load_book(db, user_id)
    found: list[Candidate] = []
    for loan in loans:
        upcoming = next_emi(loan, book)
        if upcoming is not None and upcoming.interest is not None:
            found.append({"kind": "emi", "id": loan.id, "label": f"{loan.name} EMI"})
    return found


def _sips(
    db: Session, user_id: int, account: Account, amount: Decimal, day: date
) -> list[Candidate]:
    """Active SIPs on this account of exactly this amount with an unrecorded debit date within
    `SIP_WINDOW` of the day."""
    rows = db.execute(
        select(Sip.id, Instrument.name)
        .join(Instrument, Instrument.id == Sip.instrument_id)
        .where(
            Sip.user_id == user_id,
            Sip.account_id == account.id,
            Sip.active.is_(True),
            Sip.amount == amount,
        )
        .order_by(Sip.id)
    ).all()
    if not rows:
        return []
    due = load_due(db, user_id, day + SIP_WINDOW)
    return [
        {"kind": "sip", "id": sip_id, "label": f"{name} SIP"}
        for sip_id, name in rows
        if any(abs(d - day) <= SIP_WINDOW for d in due.get(sip_id, []))
    ]


def _row(t: RecurringTemplate) -> TemplateRow:
    return TemplateRow(
        t.id, t.frequency, t.day, t.month, t.start_date, t.end_date, t.remind_days, t.active
    )


def _templates(
    db: Session, user_id: int, account: Account, amount: Decimal, day: date, only: int | None
) -> list[Candidate]:
    """Active expense or transfer reminders on this account within ±10% of the amount, with an
    open occurrence (due, or coming up) whose window holds the day. A policy's reminder is
    renewed on the policy, so it isn't offered."""
    policies = select(InsurancePolicy.template_id).where(
        InsurancePolicy.user_id == user_id, InsurancePolicy.template_id.is_not(None)
    )
    query = select(RecurringTemplate).where(
        RecurringTemplate.user_id == user_id,
        RecurringTemplate.account_id == account.id,
        RecurringTemplate.active.is_(True),
        RecurringTemplate.type.in_(("expense", "transfer")),
        RecurringTemplate.id.not_in(policies),
    )
    if only is not None:
        query = query.where(RecurringTemplate.id == only)
    near = [
        t
        for t in db.scalars(query.order_by(RecurringTemplate.id))
        if abs(amount - t.amount) <= t.amount * TEMPLATE_SPREAD
    ]
    if not near:
        return []
    ids = [t.id for t in near]
    paid: dict[int, list[date]] = defaultdict(list)
    for template_id, paid_on in db.execute(
        select(Transaction.recurring_template_id, Transaction.date).where(
            Transaction.user_id == user_id, Transaction.recurring_template_id.in_(ids)
        )
    ):
        paid[template_id].append(paid_on)
    skips: dict[int, set[date]] = defaultdict(set)
    for template_id, occurrence in db.execute(
        select(RecurringSkip.template_id, RecurringSkip.occurrence).where(
            RecurringSkip.user_id == user_id, RecurringSkip.template_id.in_(ids)
        )
    ):
        skips[template_id].add(occurrence)
    found: list[Candidate] = []
    for t in near:
        if t.to_account_id is not None and _active(db, user_id, t.to_account_id) is None:
            continue
        row = _row(t)
        state = status(row, paid[t.id], skips[t.id], day)
        open_ = [*state.due, *([state.coming_up] if state.coming_up else [])]
        if any(is_recorded(row, o, [day]) for o in open_):
            found.append({"kind": "template", "id": t.id, "label": t.name})
    return found


def expected_candidates(
    db: Session,
    user_id: int,
    account: Account,
    amount: Decimal,
    day: date,
    payee_key: str | None,
) -> list[Candidate]:
    """Every plan a debit of `amount` from `account` on `day` could be paying.

    A payee rule tied to a reminder narrows the reminders to that one.
    """
    only = rule_template(db, user_id, payee_key)
    return [
        *_emis(db, user_id, account, amount),
        *_sips(db, user_id, account, amount, day),
        *_templates(db, user_id, account, amount, day, only),
    ]


# Recording


def _active(db: Session, user_id: int, id_: int) -> Account | None:
    return db.scalar(
        select(Account).where(
            Account.id == id_, Account.user_id == user_id, Account.archived_at.is_(None)
        )
    )


def _wait(entry: SmsEntry, candidate: Candidate) -> bool:
    """Nothing recorded: the entry asks the owner about this plan."""
    review(entry, "expected", f"Is this your {candidate['label']}?")
    entry.candidates = [dict(candidate)]
    return False


def _recorded(entry: SmsEntry) -> bool:
    entry.status, entry.reason, entry.message, entry.candidates = "recorded", None, None, None
    return True


def _apply_emi(db: Session, user_id: int, entry: SmsEntry, candidate: Candidate) -> bool:
    loan = _active(db, user_id, candidate["id"])
    upcoming = None if loan is None else next_emi(loan, load_book(db, user_id))
    if loan is None or upcoming is None or upcoming.interest is None:
        return _wait(entry, candidate)
    values = {
        "type": "emi",
        "account_id": entry.account_id,
        "to_account_id": loan.id,
        "amount": entry.amount,
        "date": entry.occurred_on,
        "category": None,
        "interest": Decimal(upcoming.interest),
        "note": entry.payee,
    }
    return record(db, user_id, entry, values) and _recorded(entry)


def fund_nav(db: Session, user_id: int, fund: Instrument, day: date) -> Decimal | None:
    """The fund's NAV on `day`, else the latest before it: its own prices first, then the shared
    market price of the scheme it is linked to."""
    own = db.scalar(
        select(InstrumentPrice.price)
        .where(
            InstrumentPrice.user_id == user_id,
            InstrumentPrice.instrument_id == fund.id,
            InstrumentPrice.date <= day,
        )
        .order_by(InstrumentPrice.date.desc(), InstrumentPrice.id.desc())
        .limit(1)
    )
    if own is not None or fund.source_code is None:
        return own
    return db.scalar(
        select(MarketCode.price).where(
            MarketCode.kind == fund.kind,
            MarketCode.code == fund.source_code,
            MarketCode.price.is_not(None),
            MarketCode.price_date <= day,
        )
    )


def _apply_sip(db: Session, user_id: int, entry: SmsEntry, candidate: Candidate) -> bool:
    """A fund purchase at the day's NAV, its units worked out and marked estimated."""
    sip = db.scalar(select(Sip).where(Sip.id == candidate["id"], Sip.user_id == user_id))
    fund = None if sip is None else db.get(Instrument, sip.instrument_id)
    if sip is None or fund is None or entry.amount is None:
        return _wait(entry, candidate)
    nav = fund_nav(db, user_id, fund, entry.occurred_on)
    if nav is None or nav <= 0:
        return _wait(entry, candidate)
    values = {
        "fund_id": fund.id,
        "account_id": entry.account_id,
        "side": "buy",
        "date": entry.occurred_on,
        "units": (entry.amount / nav).quantize(UNITS, rounding=ROUND_HALF_UP),
        "nav": nav,
        "charges": Decimal(0),
        "amount": entry.amount,
        "opening": False,
        "sip_id": sip.id,
        "note": entry.payee,
    }
    accounts = lock_accounts(db, user_id, [entry.account_id])
    try:
        _, price = fund_save_checks(db, user_id, accounts, values, existing_id=None)
    except RequestValidationError as error:
        problem = error.errors()[0]
        if problem["loc"][-1] in ("units", "nav"):  # the worked-out units don't fit: ask
            return _wait(entry, candidate)
        review(entry, "balance", problem["msg"])
        entry.candidates = [dict(candidate)]
        return False
    trade = InvestmentTrade(user_id=user_id, estimated=True, **fund_columns(values, price))
    db.add(trade)
    db.flush()
    sync_trade_nav(db, trade)
    entry.trade_id = trade.id
    entry.transaction_id = None
    review(entry, "sip_units", SIP_UNITS_MESSAGE)
    entry.candidates = None
    return True


def _apply_template(db: Session, user_id: int, entry: SmsEntry, candidate: Candidate) -> bool:
    template = db.scalar(
        select(RecurringTemplate).where(
            RecurringTemplate.id == candidate["id"], RecurringTemplate.user_id == user_id
        )
    )
    if template is None:
        return _wait(entry, candidate)
    values = {
        "type": template.type,
        "account_id": entry.account_id,
        "to_account_id": template.to_account_id,
        "amount": entry.amount,
        "date": entry.occurred_on,
        "category": template.category,
        "note": entry.payee,
        "recurring_template_id": template.id,
    }
    return record(db, user_id, entry, values) and _recorded(entry)


def apply_expected(db: Session, user_id: int, entry: SmsEntry, candidate: Candidate) -> bool:
    """Records the entry's debit as `candidate`. False when nothing was recorded; the entry then
    says why in its review reason."""
    if candidate["kind"] == "emi":
        return _apply_emi(db, user_id, entry, candidate)
    if candidate["kind"] == "sip":
        return _apply_sip(db, user_id, entry, candidate)
    return _apply_template(db, user_id, entry, candidate)
