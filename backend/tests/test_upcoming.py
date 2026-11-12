"""The next 30 days and safe to spend, built straight in the database so each test shows only
what it needs. "Today" is frozen at 12 November 2026."""

import hashlib
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import budgets, cash_flow, upcoming
from app.main import app
from app.models.account import Account
from app.models.goal import Goal, GoalEarmark
from app.models.insurance import InsurancePolicy
from app.models.investment import Instrument, Sip
from app.models.recurring import RecurringTemplate
from app.models.sms import SmsEntry
from app.models.transaction import Transaction
from app.models.user import User
from tests.test_accounts import Headers, auth

client = TestClient(app)

TODAY = date(2026, 11, 12)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (budgets, cash_flow, upcoming):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


class World:
    """Rows for the signed-in user."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.user = db.scalars(select(User.id).where(User.email == "me@example.com")).one()

    def add(self, row: Any) -> Any:
        self.db.add(row)
        self.db.commit()
        return row

    def account(self, type_: str, name: str, opening: str, **extra: Any) -> Account:
        return self.add(
            Account(
                user_id=self.user, type=type_, name=name, opening_balance=Decimal(opening), **extra
            )
        )

    def template(self, name: str, type_: str, amount: str, account: Account, **extra: Any) -> Any:
        values: dict[str, Any] = {
            "frequency": "monthly",
            "day": 1,
            "start_date": date(2026, 11, 1),
            "remind_days": 3,
            **extra,
        }
        return self.add(
            RecurringTemplate(
                user_id=self.user,
                name=name,
                type=type_,
                amount=Decimal(amount),
                account_id=account.id,
                **values,
            )
        )

    def tx(self, type_: str, amount: str, day: date, account: Account, **extra: Any) -> None:
        self.add(
            Transaction(
                user_id=self.user,
                type=type_,
                amount=Decimal(amount),
                date=day,
                account_id=account.id,
                **extra,
            )
        )

    def budget(self, headers: Headers, category: str, amount: str) -> None:
        rows = client.get("/api/categories", headers=headers).json()["expense"]
        category_id = next(c["id"] for c in rows if c["name"] == category)
        response = client.put(
            f"/api/budgets/{category_id}", json={"amount": amount}, headers=headers
        )
        assert response.status_code == 200, response.json()


def next_30(headers: Headers) -> dict[str, Any]:
    response = client.get("/api/upcoming", headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def safe(headers: Headers) -> dict[str, Any]:
    response = client.get("/api/safe-to-spend", headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def rows(body: dict[str, Any]) -> list[tuple[Any, ...]]:
    return [
        (i["date"], i["kind"], i["name"], i["amount"], i["direction"], i["balance_after"])
        for i in body["items"]
    ]


def worked_example(w: World, headers: Headers) -> dict[str, Account]:
    """The example in financial-calculations.md, "Safe to spend"."""
    bank = w.account("bank", "HDFC", "60000.00", bank_kind="savings")
    cash = w.account("cash", "Wallet cash", "2000.00")
    card = w.account("credit_card", "Regalia", "8000.00", due_day=25)
    amex = w.account("credit_card", "Amex", "0.00")  # no due day: no bill to list
    w.account(
        "loan",
        "Car loan",
        "300000.00",
        due_day=20,
        emi_amount=Decimal("12000.00"),
        interest_rate=Decimal("12.00"),
        pay_from_id=bank.id,
    )
    w.template(
        "Salary", "income", "80000.00", bank, category="Salary", start_date=date(2026, 12, 1)
    )
    w.template("Rent", "expense", "20000.00", bank, category="Housing", day=15)
    w.tx("expense", "7200.00", date(2026, 11, 4), amex, category="Food and dining")
    w.tx("expense", "1500.00", date(2026, 11, 6), amex, category="Shopping")
    goal = w.add(Goal(user_id=w.user, name="Bike", kind="custom", target_amount=Decimal("90000")))
    w.add(
        GoalEarmark(
            user_id=w.user,
            goal_id=goal.id,
            account_id=bank.id,
            amount=Decimal("5000.00"),
            date=date(2026, 11, 2),
        )
    )
    w.budget(headers, "Food and dining", "8000")
    w.budget(headers, "Housing", "20000")
    w.budget(headers, "Shopping", "1000")
    return {"bank": bank, "cash": cash, "card": card}


def test_the_worked_example(headers: Headers, db_session: Session) -> None:
    worked_example(World(db_session), headers)
    body = safe(headers)
    assert (body["amount"], body["until"], body["reason"]) == ("16200.00", "2026-11-30", "salary")
    assert body["payday"] == {"name": "Salary", "date": "2026-12-01"}
    assert (body["money"], body["due"], body["goals"], body["budgets"]) == (
        "62000.00",
        "40000.00",
        "5000.00",
        "800.00",
    )
    assert body["money_items"] == [
        {"name": "HDFC", "amount": "60000.00"},
        {"name": "Wallet cash", "amount": "2000.00"},
    ]
    assert [(d["date"], d["name"], d["amount"], d["varies"]) for d in body["due_items"]] == [
        ("2026-11-15", "Rent", "20000.00", False),
        ("2026-11-20", "Car loan EMI", "12000.00", False),
        ("2026-11-25", "Regalia bill", "8000.00", True),
    ]
    assert body["goal_items"] == [{"name": "Bike", "amount": "5000.00"}]
    budgets_left = {
        b["name"]: (b["remaining"], b["due"], b["amount"]) for b in body["budget_items"]
    }
    assert budgets_left == {
        "Food and dining": ("800.00", "0.00", "800.00"),
        # The rent is already counted above, so the Housing budget isn't taken again.
        "Housing": ("20000.00", "20000.00", "0.00"),
        # Overspent: nothing left, and nothing given back.
        "Shopping": ("0.00", "0.00", "0.00"),
    }


def test_next_30_days_with_a_running_balance(headers: Headers, db_session: Session) -> None:
    worked_example(World(db_session), headers)
    body = next_30(headers)
    assert (body["start"], body["through"]) == ("2026-11-12", "2026-12-12")
    assert (body["starting_balance"], body["ending_balance"]) == ("62000.00", "102000.00")
    assert rows(body) == [
        ("2026-11-15", "recurring", "Rent", "20000.00", "out", "42000.00"),
        ("2026-11-20", "emi", "Car loan EMI", "12000.00", "out", "30000.00"),
        ("2026-11-25", "card_bill", "Regalia bill", "8000.00", "out", "22000.00"),
        ("2026-12-01", "recurring", "Salary", "80000.00", "in", "102000.00"),
    ]
    rent = body["items"][0]
    assert (rent["account_name"], rent["overdue"], rent["varies"]) == ("HDFC", False, False)
    assert body["items"][2]["varies"] is True


def test_without_a_salary_reminder_it_counts_to_the_end_of_the_month(
    headers: Headers, db_session: Session
) -> None:
    w = World(db_session)
    bank = w.account("bank", "HDFC", "10000.00", bank_kind="savings")
    w.template("Rent", "expense", "3000.00", bank, category="Housing", day=30)
    w.template(  # 2 December: after the month
        "Gym", "expense", "1000.00", bank, category="Health", day=2, start_date=date(2026, 12, 1)
    )
    body = safe(headers)
    assert (body["until"], body["reason"], body["payday"]) == ("2026-11-30", "month_end", None)
    assert [d["name"] for d in body["due_items"]] == ["Rent"]
    assert body["amount"] == "7000.00"


def test_income_other_than_salary_isnt_payday(headers: Headers, db_session: Session) -> None:
    w = World(db_session)
    bank = w.account("bank", "HDFC", "10000.00", bank_kind="savings")
    w.template("Tenant", "income", "15000.00", bank, category="Other", day=20)
    assert safe(headers)["reason"] == "month_end"


def test_a_salary_subcategory_counts_and_payday_bills_are_left_to_it(
    headers: Headers, db_session: Session
) -> None:
    w = World(db_session)
    bank = w.account("bank", "HDFC", "10000.00", bank_kind="savings")
    response = client.post(
        "/api/categories",
        json={"kind": "income", "name": "Bonus pay", "parent_id": salary_id(headers)},
        headers=headers,
    )
    assert response.status_code == 201, response.json()
    w.template("Pay", "income", "50000.00", bank, category="Bonus pay", day=20)
    w.template("Maid", "expense", "4000.00", bank, category="Housing", day=20)
    w.template("Milk", "expense", "900.00", bank, category="Groceries", day=19)
    body = safe(headers)
    assert body["payday"] == {"name": "Pay", "date": "2026-11-20"}
    assert body["until"] == "2026-11-19"
    assert [d["name"] for d in body["due_items"]] == ["Milk"]
    assert body["amount"] == "9100.00"


def salary_id(headers: Headers) -> int:
    rows = client.get("/api/categories", headers=headers).json()["income"]
    return next(c["id"] for c in rows if c["name"] == "Salary")


def test_overdue_items_come_first_and_count(headers: Headers, db_session: Session) -> None:
    w = World(db_session)
    bank = w.account("bank", "HDFC", "10000.00", bank_kind="savings")
    rent = w.template("Rent", "expense", "3000.00", bank, category="Housing", day=5)
    # October was paid, November's on the 5th wasn't.
    w.tx("expense", "3000.00", date(2026, 10, 5), bank, recurring_template_id=rent.id)
    rent.start_date = date(2026, 10, 1)
    db_session.commit()
    body = next_30(headers)
    assert rows(body) == [
        ("2026-11-05", "recurring", "Rent", "3000.00", "out", "4000.00"),
        ("2026-12-05", "recurring", "Rent", "3000.00", "out", "1000.00"),
    ]
    assert [i["overdue"] for i in body["items"]] == [True, False]
    assert safe(headers)["due"] == "3000.00"


def test_transfers_cards_and_goals_move_the_balance_only_when_money_leaves(
    headers: Headers, db_session: Session
) -> None:
    w = World(db_session)
    bank = w.account("bank", "HDFC", "50000.00", bank_kind="savings")
    cash = w.account("cash", "Cash", "0.00")
    card = w.account("credit_card", "Regalia", "0.00", due_day=8)
    w.template("ATM", "transfer", "2000.00", bank, to_account_id=cash.id, day=14)
    premium = w.template(
        "Star premium",
        "expense",
        "18000.00",
        card,
        category="Insurance",
        frequency="yearly",
        day=16,
        month=11,
        start_date=date(2026, 11, 16),
        remind_days=30,
    )
    w.add(
        InsurancePolicy(
            user_id=w.user,
            kind="health",
            insurer="Star",
            plan="Family",
            policy_number="P1",
            insured="Me",
            sum_insured=Decimal("500000"),
            period_start=date(2025, 11, 16),
            period_end=date(2026, 11, 15),
            premium=Decimal("18000"),
            template_id=premium.id,
        )
    )
    goal = w.add(
        Goal(
            user_id=w.user,
            name="Trip",
            kind="custom",
            target_amount=Decimal("50000"),
            monthly_amount=Decimal("2000.00"),
            reminder_day=5,
            reminder_start=date(2026, 11, 1),
        )
    )
    w.add(
        GoalEarmark(
            user_id=w.user,
            goal_id=goal.id,
            account_id=bank.id,
            amount=Decimal("500.00"),
            date=date(2026, 11, 6),
        )
    )
    body = next_30(headers)
    assert rows(body) == [
        ("2026-11-05", "goal", "Trip", "1500.00", "none", "50000.00"),
        ("2026-11-14", "recurring", "ATM", "2000.00", "none", "50000.00"),
        ("2026-11-16", "insurance", "Star premium", "18000.00", "none", "50000.00"),
        ("2026-12-05", "goal", "Trip", "2000.00", "none", "50000.00"),
    ]
    assert body["items"][2]["account_name"] == "Regalia"
    # The card has nothing owed yet, so no bill; the premium will reach it later.
    body = safe(headers)
    assert [(d["name"], d["amount"]) for d in body["due_items"]] == [("Trip", "1500.00")]
    assert (body["goals"], body["amount"]) == ("500.00", "48000.00")


def test_card_bills_from_statements_and_reminders(headers: Headers, db_session: Session) -> None:
    w = World(db_session)
    bank = w.account("bank", "HDFC", "50000.00", bank_kind="savings")
    regalia = w.account("credit_card", "Regalia", "15000.00", due_day=23)
    paid = w.account("credit_card", "Paid by reminder", "7000.00", due_day=10)
    settled = w.account("credit_card", "Settled", "0.00", due_day=3)
    w.add(
        SmsEntry(
            user_id=w.user,
            hash=hashlib.sha256(b"statement").hexdigest(),
            sender="HDFCBK",
            bank="hdfc",
            kind="card_statement",
            status="recorded",
            account_id=regalia.id,
            amount=Decimal("12000.00"),
            occurred_on=date(2026, 11, 3),
            due_date=date(2026, 11, 23),
        )
    )
    w.tx("transfer", "2000.00", date(2026, 11, 5), bank, to_account_id=regalia.id)
    w.template(
        "Card payment",
        "transfer",
        "7000.00",
        bank,
        to_account_id=paid.id,
        day=10,
        start_date=date(2026, 12, 1),
    )
    body = next_30(headers)
    assert rows(body) == [
        ("2026-11-23", "card_bill", "Regalia bill", "10000.00", "out", "38000.00"),
        ("2026-12-10", "recurring", "Card payment", "7000.00", "out", "31000.00"),
    ]
    assert body["items"][0]["varies"] is False
    assert settled.id not in [i["ref_id"] for i in body["items"] if i["kind"] == "card_bill"]


def test_emis_sips_and_rd_instalments(headers: Headers, db_session: Session) -> None:
    w = World(db_session)
    bank = w.account("bank", "HDFC", "100000.00", bank_kind="savings")
    card = w.account("credit_card", "Regalia", "0.00")
    loan = w.account(
        "loan",
        "Home loan",
        "100000.00",
        due_day=5,
        emi_amount=Decimal("10000.00"),
        interest_rate=Decimal("12.00"),
        pay_from_id=bank.id,
    )
    w.account(
        "loan",
        "Phone",
        "6000.00",
        due_day=28,
        emi_amount=Decimal("2000.00"),
        interest_rate=Decimal("12.00"),
        pay_from_id=card.id,
    )
    w.account("loan", "Paid off", "0.00", due_day=1, emi_amount=Decimal("500.00"))
    # November's EMI is paid; the phone's is charged to the card.
    w.tx(
        "emi",
        "10000.00",
        date(2026, 11, 4),
        bank,
        to_account_id=loan.id,
        interest=Decimal("1000.00"),
    )
    fund = w.add(Instrument(user_id=w.user, kind="mutual_fund", symbol="PPFAS", name="Flexi"))
    w.add(
        Sip(
            user_id=w.user,
            instrument_id=fund.id,
            account_id=bank.id,
            amount=Decimal("3000.00"),
            day=10,
            start_date=date(2026, 11, 10),
        )
    )
    w.account(
        "rd",
        "SBI RD",
        "5000.00",
        opened_on=date(2026, 10, 1),
        deposit_amount=Decimal("5000.00"),
        due_day=15,
        tenure_months=12,
        deposits_at_opening=1,
        interest_rate=Decimal("7.00"),
    )
    body = next_30(headers)
    assert rows(body) == [
        ("2026-11-10", "sip", "Flexi SIP", "3000.00", "out", "87000.00"),
        ("2026-11-15", "rd", "SBI RD instalment", "5000.00", "out", "82000.00"),
        ("2026-11-28", "emi", "Phone EMI", "2000.00", "none", "82000.00"),
        ("2026-12-05", "emi", "Home loan EMI", "10000.00", "out", "72000.00"),
        ("2026-12-10", "sip", "Flexi SIP", "3000.00", "out", "69000.00"),
    ]
    assert body["starting_balance"] == "90000.00"
    assert [i["overdue"] for i in body["items"]][:2] == [True, False]


def test_negative_money_gives_a_negative_figure(headers: Headers, db_session: Session) -> None:
    w = World(db_session)
    bank = w.account("bank", "HDFC", "-4000.00", bank_kind="current")
    w.account("wallet", "Paytm", "500.00")
    w.account("broker", "Zerodha", "90000.00")  # not spendable
    w.template("Rent", "expense", "3000.00", bank, category="Housing", day=20)
    body = safe(headers)
    assert (body["money"], body["due"], body["amount"]) == ("-3500.00", "3000.00", "-6500.00")


def test_an_empty_user(headers: Headers) -> None:
    assert next_30(headers)["items"] == []
    body = safe(headers)
    assert (body["amount"], body["due_items"], body["budget_items"]) == ("0.00", [], [])


def test_another_users_items_stay_out(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    worked_example(World(db_session), headers)
    other = auth(db_session, monkeypatch, email="other@example.com")
    assert next_30(other)["items"] == []
    assert safe(other)["amount"] == "0.00"
