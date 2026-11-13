# ruff: noqa: E501
"""A user with something in every table a backup holds, for the restore tests.

Categories and budgets go through the API (so seeding, nesting, renames and merges are real);
the rest is written directly, dated in the months before TODAY.
"""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import app
from app.models.account import Account
from app.models.budget import Budget
from app.models.goal import Goal, GoalEarmark, GoalHolding
from app.models.insurance import InsurancePolicy, PolicyPeriod
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade, Sip
from app.models.market import MarketCode
from app.models.recurring import RecurringSkip, RecurringTemplate
from app.models.sms import AccountIdentifier, PayeeRule, SmsEntry, SmsSample
from app.models.transaction import Transaction

client = TestClient(app)
Headers = dict[str, str]
D = Decimal


def _ok(response: Any, code: int = 200) -> dict[str, Any]:
    assert response.status_code == code, response.json()
    return response.json()


def _categories(headers: Headers) -> dict[tuple[str, str], int]:
    body = _ok(client.get("/api/categories", headers=headers))
    return {(kind, c["name"]): c["id"] for kind in ("income", "expense") for c in body[kind]}


def build_categories(headers: Headers) -> dict[tuple[str, str], int]:
    """Seeded defaults, a custom one, nesting, a rename (old name kept) and a merge."""
    ids = _categories(headers)
    _ok(client.post("/api/categories", json={"kind": "expense", "name": "Pets"}, headers=headers), 201)
    _ok(client.post("/api/categories", json={"kind": "expense", "name": "Snacks"}, headers=headers), 201)
    ids = _categories(headers)
    food = ids[("expense", "Food and dining")]
    for child in ("Groceries", "Pets"):
        _ok(client.patch(f"/api/categories/{ids[('expense', child)]}", json={"parent_id": food}, headers=headers))
    _ok(client.patch(f"/api/categories/{ids[('expense', 'Fuel')]}", json={"name": "Petrol"}, headers=headers))
    _ok(client.post(f"/api/categories/{ids[('expense', 'Snacks')]}/merge", json={"into_id": food}, headers=headers))
    _ok(client.patch(f"/api/categories/{ids[('expense', 'Education')]}", json={"archived": True}, headers=headers))
    return _categories(headers)  # fmt: skip


def build(db: Session, headers: Headers, user_id: int, today: date) -> None:
    ids = build_categories(headers)
    u = user_id
    first = today.replace(day=1)
    last_month = date(first.year - (first.month == 1), (first.month - 2) % 12 + 1, 1)

    def day(n: int, month: date = first) -> date:
        return month.replace(day=min(n, 28))

    def add(row: Any) -> Any:
        db.add(row)
        db.flush()
        return row

    hdfc = add(Account(user_id=u, type="bank", name="HDFC", opening_balance=D("250000.00"), institution="HDFC Bank", bank_kind="salary", last4="1234"))
    sbi = add(Account(user_id=u, type="bank", name="SBI", opening_balance=D("80000.00"), bank_kind="savings"))
    card = add(Account(user_id=u, type="credit_card", name="Regalia", opening_balance=D("4500.00"), credit_limit=D("200000.00"), statement_day=15, due_day=5, last4="9876"))
    cash = add(Account(user_id=u, type="cash", name="Wallet cash", opening_balance=D("3000.00")))
    add(Account(user_id=u, type="wallet", name="Paytm", opening_balance=D("650.50")))
    zerodha = add(Account(user_id=u, type="broker", name="Zerodha", opening_balance=D("20000.00")))
    coindcx = add(Account(user_id=u, type="broker", name="CoinDCX", opening_balance=D("5000.00")))
    ppf = add(Account(user_id=u, type="ppf", name="PPF", opening_balance=D("300000.00"), interest_rate=D("7.10"), opened_on=date(2020, 6, 10)))
    rd = add(Account(user_id=u, type="rd", name="SBI RD", opening_balance=D("10000.00"), interest_rate=D("7.00"), opened_on=date(2026, 7, 1), deposit_amount=D("5000.00"), tenure_months=24, deposits_at_opening=2, due_day=1, pay_from_id=sbi.id))
    car = add(Account(user_id=u, type="loan", name="Car loan", opening_balance=D("400000.00"), interest_rate=D("9.50"), emi_amount=D("12000.00"), emis_at_opening=40, due_day=5, pay_from_id=hdfc.id))
    phone = add(Account(user_id=u, type="loan", name="Phone EMI", opening_balance=D("30000.00"), emi_amount=D("2500.00"), emis_at_opening=12, pay_from_id=card.id))
    add(Account(user_id=u, type="cash", name="Old cash", opening_balance=D("0.00"), archived_at=datetime(2026, 5, 1, tzinfo=UTC)))

    rent = add(RecurringTemplate(user_id=u, name="Rent", type="expense", amount=D("20000.00"), account_id=hdfc.id, category="Housing", frequency="monthly", day=3, start_date=date(2026, 1, 3), remind_days=5))
    to_rd = add(RecurringTemplate(user_id=u, name="RD instalment", type="transfer", amount=D("5000.00"), account_id=sbi.id, to_account_id=rd.id, frequency="monthly", day=1, start_date=date(2026, 7, 1), remind_days=3))
    premium = add(RecurringTemplate(user_id=u, name="Health premium", type="expense", amount=D("18000.00"), account_id=card.id, category="Insurance", frequency="yearly", day=10, month=last_month.month, start_date=day(10, last_month), remind_days=30))
    add(RecurringTemplate(user_id=u, name="Old gym", type="expense", amount=D("1500.00"), account_id=cash.id, category="Health", frequency="monthly", day=1, start_date=date(2026, 1, 1), end_date=date(2026, 6, 1), remind_days=3, active=False))
    add(RecurringSkip(user_id=u, template_id=rent.id, occurrence=day(3, last_month)))

    def tx(when: date, type_: str, account: Account, amount: str, **kw: Any) -> Transaction:
        return add(Transaction(user_id=u, type=type_, date=when, account_id=account.id, amount=D(amount), **kw))

    for month in (last_month, first):
        tx(day(1, month), "income", hdfc, "150000.00", category="Salary")
        tx(day(2, month), "expense", hdfc, "6200.40", category="Groceries", note="Big basket")
        tx(day(3, month), "expense", card, "1850.00", category="Food and dining", note="Swiggy")
        tx(day(4, month), "expense", card, "900.00", category="Pets")
        tx(day(5, month), "emi", hdfc, "12000.00", to_account_id=car.id, interest="3100.00", category="Loan interest")
        tx(day(5, month), "emi", card, "2500.00", to_account_id=phone.id, interest="0.00", category="Loan interest")
        tx(day(1, month), "transfer", sbi, "5000.00", to_account_id=rd.id, recurring_template_id=to_rd.id)
    tx(day(3, last_month), "expense", cash, "1200.00", category="Petrol")
    tx(day(6), "transfer", hdfc, "8000.00", to_account_id=card.id, note="Card bill")
    tx(day(7), "transfer", hdfc, "12500.00", to_account_id=ppf.id)
    tx(date(2026, 3, 31), "income", ppf, "21300.00", category="Interest")
    tx(day(8), "income", sbi, "450.00", category="Refund", source="sms")
    paid = tx(day(10, last_month), "expense", card, "18000.00", category="Insurance", recurring_template_id=premium.id)
    tx(day(3), "expense", hdfc, "20000.00", category="Housing", recurring_template_id=rent.id)

    infy = add(Instrument(user_id=u, kind="stock", symbol="INFY", name="Infosys", source_code="INFY"))
    tcs = add(Instrument(user_id=u, kind="stock", symbol="TCS", name="Tata Consultancy"))
    fund = add(Instrument(user_id=u, kind="mutual_fund", symbol="PPFCF", name="Parag Parikh Flexi Cap", source_code="122639"))
    btc = add(Instrument(user_id=u, kind="crypto", symbol="BTC", name="Bitcoin", source_code="bitcoin"))
    sip = add(Sip(user_id=u, instrument_id=fund.id, account_id=hdfc.id, amount=D("5000.00"), day=5, start_date=date(2026, 1, 5)))

    def trade(inst: Instrument, account: Account, side: str, when: date, qty: str, price: str, charges: str, amount: str, **kw: Any) -> InvestmentTrade:
        return add(InvestmentTrade(user_id=u, instrument_id=inst.id, account_id=account.id, side=side, date=when, quantity=D(qty), price=D(price), charges=D(charges), amount=D(amount), **kw))

    trade(infy, zerodha, "buy", date(2025, 1, 10), "10", "1500.0000", "0.00", "15000.00", opening=True)
    trade(infy, zerodha, "buy", day(12, last_month), "5", "1600.0000", "15.20", "8015.20")
    trade(infy, zerodha, "sell", day(9), "3", "1700.0000", "12.10", "5087.90")
    trade(tcs, zerodha, "buy", day(13, last_month), "2", "4000.0000", "8.00", "8008.00")
    f1 = trade(fund, hdfc, "buy", day(5, last_month), "60.123", "83.1600", "0.25", "5000.00", sip_id=sip.id)
    f2 = trade(fund, hdfc, "buy", day(5), "58.900", "84.8800", "0.25", "5000.00", sip_id=sip.id, estimated=True)
    trade(fund, hdfc, "sell", day(9), "10.000", "85.0000", "0.00", "850.00", note="Partial")
    crypto = trade(btc, coindcx, "buy", day(14, last_month), "0.00050000", "7500000.0000", "4.43", "3754.43")
    add(InstrumentPrice(user_id=u, instrument_id=infy.id, date=day(10), price=D("1725.5500")))
    add(InstrumentPrice(user_id=u, instrument_id=tcs.id, date=day(10), price=D("4100.0000"), source="auto"))
    add(InstrumentPrice(user_id=u, instrument_id=fund.id, date=f1.date, price=f1.price, trade_id=f1.id))
    add(InstrumentPrice(user_id=u, instrument_id=fund.id, date=f2.date, price=f2.price, trade_id=f2.id))
    add(InstrumentPrice(user_id=u, instrument_id=btc.id, date=day(11), price=D("7812345.1200"), source="auto"))

    policy = add(InsurancePolicy(user_id=u, kind="health", insurer="Niva Bupa", plan="ReAssure 2.0", policy_number="NB-123", insured="Self, spouse", sum_insured=D("1000000.00"), period_start=day(10, last_month), period_end=date(last_month.year + 1, last_month.month, 9), premium=D("18000.00"), template_id=premium.id, funded_by_id=rd.id, details="Room rent: no cap"))
    add(PolicyPeriod(user_id=u, policy_id=policy.id, period_start=policy.period_start, period_end=policy.period_end, premium=D("18000.00"), sum_insured=D("1000000.00"), paid_on=paid.date, transaction_id=paid.id))

    trip = add(Goal(user_id=u, name="Goa trip", kind="custom", target_amount=D("60000.00"), target_date=date(2027, 3, 1), monthly_amount=D("5000.00"), reminder_day=7, reminder_start=last_month, note="December"))
    ef = add(Goal(user_id=u, name="Emergency fund", kind="emergency", ef_months=6))
    add(Goal(user_id=u, name="Old bike", kind="custom", target_amount=D("90000.00"), archived_at=datetime(2026, 8, 1, tzinfo=UTC)))
    add(GoalEarmark(user_id=u, goal_id=trip.id, account_id=hdfc.id, amount=D("15000.00"), date=day(7, last_month)))
    add(GoalEarmark(user_id=u, goal_id=trip.id, account_id=hdfc.id, amount=D("-2000.00"), date=day(7)))
    add(GoalEarmark(user_id=u, goal_id=ef.id, account_id=sbi.id, amount=D("40000.00"), date=day(2, last_month)))
    add(GoalHolding(user_id=u, goal_id=ef.id, account_id=ppf.id))
    add(GoalHolding(user_id=u, goal_id=trip.id, instrument_id=fund.id))
    add(GoalHolding(user_id=u, goal_id=trip.id, instrument_id=tcs.id, active=False))

    market = db.query(MarketCode).filter_by(kind="stock", code="INFY").one_or_none() or add(MarketCode(kind="stock", code="INFY", name="Infosys Ltd", price=D("1720.0000")))
    add(AccountIdentifier(user_id=u, account_id=card.id, last4="4321"))
    add(PayeeRule(user_id=u, payee_key="swiggy", display="Swiggy", category="Food and dining"))
    add(PayeeRule(user_id=u, payee_key="sbi rd", display="SBI RD", to_account_id=rd.id))
    add(PayeeRule(user_id=u, payee_key="landlord", display="Landlord", template_id=rent.id))
    sms_tx = db.query(Transaction).filter_by(user_id=u, source="sms").one()
    candidates = [
        {"kind": "transaction", "id": sms_tx.id, "label": "Refund"},
        {"kind": "transaction", "id": 999999, "label": "Deleted since"},
        {"kind": "account", "id": sbi.id, "label": "SBI"},
        {"kind": "emi", "id": car.id, "label": "Car loan EMI"},
        {"kind": "sip", "id": sip.id, "label": "PPFCF SIP", "needs_nav": True},
        {"kind": "template", "id": rent.id, "label": "Rent"},
        {"kind": "stock", "id": infy.id, "label": "INFY"},
        {"kind": "market", "id": market.id, "label": "INFY · Infosys Ltd"},
    ]
    add(SmsEntry(user_id=u, hash="a" * 64, sender="VM-SBIINB", bank="sbi", kind="credit", amount=D("450.00"), occurred_on=sms_tx.date, last4="5678", payee="Amazon refund", payee_key="amazon refund", ref="R123", balance=D("80450.00"), account_id=sbi.id, status="review", reason="maybe_transfer", message="Is this a transfer?", candidates=candidates, transaction_id=sms_tx.id))
    add(SmsEntry(user_id=u, hash="b" * 64, sender="VM-CDSL", bank="cdsl", kind="demat", occurred_on=day(9), isin="INE009A01021", quantity=D("3"), status="recorded", trade_id=crypto.id))
    add(SmsEntry(user_id=u, hash="c" * 64, sender="VM-HDFCBK", bank="hdfc", kind="card_statement", amount=D("8000.00"), occurred_on=day(1), due_date=day(20), account_id=card.id, status="ignored"))
    add(SmsSample(user_id=u, sender="VM-ICICIB", text="Your a/c XX12 is debited for Rs 99 — unknown format"))
    db.commit()

    food, groceries = ids[("expense", "Food and dining")], ids[("expense", "Groceries")]
    db.add(Budget(user_id=u, category_id=food, effective_from=last_month, amount=D("7000.00")))
    db.commit()
    _ok(client.put(f"/api/budgets/{food}", json={"amount": "8000.00"}, headers=headers))
    _ok(client.put(f"/api/budgets/{groceries}", json={"amount": "6000.00"}, headers=headers))
