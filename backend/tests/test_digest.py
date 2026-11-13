"""The weekly digest, built straight in the database. Rules: financial-calculations.md, "Weekly
digest". "Now" is frozen per test; November 2026 starts on a Sunday, so its weeks run Monday 2 –
Sunday 8, 9–15, 16–22, 23–29, and Monday 30 November – Sunday 6 December."""

from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import digest as dg
from app.api.dates import INDIA
from app.api.routes import budgets, cash_flow, upcoming
from app.api.routes import digest as digest_route
from app.main import app
from app.models.account import Account
from tests.test_accounts import Headers, auth
from tests.test_upcoming import World

client = TestClient(app)

URL = "/api/digest"


class Clock:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.monkeypatch = monkeypatch
        self.set(datetime(2026, 11, 9, 8, 0))

    def set(self, moment: datetime) -> None:
        now = moment.replace(tzinfo=INDIA)
        self.monkeypatch.setattr(digest_route, "now_india", lambda: now)
        for module in (budgets, cash_flow, upcoming):
            self.monkeypatch.setattr(module, "today_india", lambda: now.date())


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    return Clock(monkeypatch)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch, clock: Clock) -> Headers:
    return auth(db_session, monkeypatch)


@pytest.fixture
def w(db_session: Session, headers: Headers) -> World:
    return World(db_session)


def digest(headers: Headers, **params: str) -> dict[str, Any]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def bank(w: World) -> Account:
    return w.account("bank", "HDFC", "500000.00", bank_kind="savings")


def spend(w: World, account: Account, day: str, amount: str, category: str = "Groceries") -> None:
    w.tx("expense", amount, date.fromisoformat(day), account, category=category)


def four_weeks(w: World, account: Account) -> None:
    """₹3,000, ₹4,000, ₹3,800 and ₹3,800 in the four weeks before 2–8 November: usual ₹3,650."""
    spend(w, account, "2026-10-06", "3000.00")
    spend(w, account, "2026-10-14", "4000.00")
    spend(w, account, "2026-10-20", "3800.00")
    spend(w, account, "2026-10-31", "3800.00")


# The week


def test_monday_morning_shows_the_week_just_ended(w: World, headers: Headers) -> None:
    body = digest(headers)
    assert (body["week_start"], body["week_end"], body["through"]) == (
        "2026-11-02",
        "2026-11-08",
        "2026-11-08",
    )
    assert (body["is_current"], body["is_complete"], body["label"]) == (False, True, "last week")


def test_sunday_afternoon_still_shows_last_week(w: World, headers: Headers, clock: Clock) -> None:
    clock.set(datetime(2026, 11, 8, 17, 59))
    body = digest(headers)
    assert (body["week_start"], body["week_end"], body["label"]) == (
        "2026-10-26",
        "2026-11-01",
        "last week",
    )


def test_sunday_night_shows_the_week_ending_today(w: World, headers: Headers, clock: Clock) -> None:
    clock.set(datetime(2026, 11, 8, 21, 30))
    body = digest(headers)
    assert (body["week_start"], body["week_end"], body["through"]) == (
        "2026-11-02",
        "2026-11-08",
        "2026-11-08",
    )
    assert (body["is_current"], body["is_complete"], body["label"]) == (True, True, "this week")


def test_a_chosen_week_and_this_week_so_far(w: World, headers: Headers, clock: Clock) -> None:
    clock.set(datetime(2026, 11, 12, 10, 0))  # a Thursday
    older = digest(headers, week="2026-10-21")
    assert (older["week_start"], older["week_end"], older["label"]) == (
        "2026-10-19",
        "2026-10-25",
        "the week of 19 October",
    )
    now = digest(headers, week="current")
    assert (now["week_start"], now["through"], now["is_current"], now["is_complete"]) == (
        "2026-11-09",
        "2026-11-12",
        True,
        False,
    )
    assert digest(headers, week="2026-11-14")["through"] == "2026-11-12"  # same week


@pytest.mark.parametrize("week", ["2026-11-16", "2027-01-01"])
def test_a_week_that_has_not_started_is_refused(headers: Headers, week: str) -> None:
    response = client.get(URL, params={"week": week}, headers=headers)
    assert response.status_code == 422
    assert "hasn't started" in str(response.json())


@pytest.mark.parametrize("week", ["2026-13-01", "last", "2026-11-31"])
def test_a_bad_week_is_refused(headers: Headers, week: str) -> None:
    assert client.get(URL, params={"week": week}, headers=headers).status_code == 422


# Spent and usual


def test_spending_follows_the_cash_flow_rules(w: World, headers: Headers) -> None:
    b = bank(w)
    card = w.account("credit_card", "Card", "0.00")
    loan = w.account("loan", "Car loan", "300000.00")
    spend(w, b, "2026-11-02", "3000.00")
    spend(w, card, "2026-11-04", "1200.00", "Dining")
    w.tx(
        "emi",
        "12000.00",
        date(2026, 11, 5),
        b,
        to_account_id=loan.id,
        interest=Decimal("1250"),
        category="Loan interest",
    )
    w.tx("transfer", "20000.00", date(2026, 11, 6), b, to_account_id=card.id)
    w.tx("income", "80000.00", date(2026, 11, 7), b, category="Salary")
    spend(w, b, "2026-11-09", "999.00")  # the next week
    body = digest(headers)
    assert body["spending"] == "5450.00"
    assert [(c["name"], c["amount"], c["percent"]) for c in body["top_spending"]] == [
        ("Groceries", "3000.00", 55),
        ("Loan interest", "1250.00", 23),
        ("Dining", "1200.00", 22),
    ]
    assert all(c["children"] == [] for c in body["top_spending"])


def test_usual_is_the_average_of_four_weeks(w: World, headers: Headers) -> None:
    b = bank(w)
    four_weeks(w, b)
    spend(w, b, "2026-09-30", "50000.00")  # five weeks back: not counted
    spend(w, b, "2026-11-03", "4250.00")
    body = digest(headers)
    assert (body["spending"], body["usual"], body["usual_weeks"]) == ("4250.00", "3650.00", 4)
    assert body["change"] == {"amount": "600.00", "percent": 16}
    assert body["headline"] == "You spent ₹4,250 last week, ₹600 more than usual."


def test_less_than_usual_and_about_the_same(w: World, headers: Headers) -> None:
    b = bank(w)
    four_weeks(w, b)
    spend(w, b, "2026-11-03", "3000.00")
    body = digest(headers)
    assert body["change"] == {"amount": "-650.00", "percent": -18}
    assert body["headline"] == "You spent ₹3,000 last week, ₹650 less than usual."
    spend(w, b, "2026-11-04", "700.00")
    assert digest(headers)["headline"] == "You spent ₹3,700 last week, about the same as usual."


def test_fewer_than_four_weeks_of_history(w: World, headers: Headers) -> None:
    b = bank(w)
    spend(w, b, "2026-10-25", "1000.00")  # a Sunday: its week (19–25 October) counts
    spend(w, b, "2026-10-28", "2001.00")
    spend(w, b, "2026-11-05", "2000.00")
    body = digest(headers)
    assert (body["usual"], body["usual_weeks"]) == ("1500.50", 2)
    assert body["change"] == {"amount": "499.50", "percent": 33}


def test_no_history_means_no_comparison(w: World, headers: Headers) -> None:
    b = bank(w)
    spend(w, b, "2026-11-05", "2000.00")
    body = digest(headers)
    assert (body["usual"], body["usual_weeks"], body["change"]) == (None, 0, None)
    assert body["headline"] == "You spent ₹2,000 last week."


def test_a_week_with_no_spending(w: World, headers: Headers) -> None:
    b = bank(w)
    four_weeks(w, b)
    w.tx("income", "80000.00", date(2026, 11, 3), b, category="Salary")
    body = digest(headers)
    assert (body["spending"], body["top_spending"]) == ("0.00", [])
    assert body["change"] == {"amount": "-3650.00", "percent": -100}
    assert body["headline"] == "You didn't spend anything last week."


def test_a_new_user_with_nothing_at_all(headers: Headers) -> None:
    body = digest(headers)
    assert (body["spending"], body["usual"], body["change"]) == ("0.00", None, None)
    assert body["budgets"]["at_risk"] == []
    assert body["due"] == {
        "start": "2026-11-09",
        "through": "2026-11-16",
        "total": "0.00",
        "items": [],
    }
    assert body["headline"] == "You didn't spend anything last week."


def test_this_week_so_far_compares_the_same_days(w: World, headers: Headers, clock: Clock) -> None:
    clock.set(datetime(2026, 11, 11, 9, 0))  # Wednesday
    b = bank(w)
    spend(w, b, "2026-11-03", "1000.00")  # a Tuesday: counted
    spend(w, b, "2026-11-05", "9000.00")  # a Thursday: after the same day
    spend(w, b, "2026-11-10", "1500.00")
    body = digest(headers, week="current")
    assert (body["spending"], body["usual"], body["usual_weeks"]) == ("1500.00", "1000.00", 1)
    assert body["headline"] == "So far this week you've spent ₹1,500, ₹500 more than usual by now."


def test_a_week_across_a_month_boundary(w: World, headers: Headers, clock: Clock) -> None:
    clock.set(datetime(2026, 12, 7, 7, 0))
    b = bank(w)
    spend(w, b, "2026-11-30", "1000.00")
    spend(w, b, "2026-12-06", "500.00")
    body = digest(headers)
    assert (body["week_start"], body["week_end"], body["spending"]) == (
        "2026-11-30",
        "2026-12-06",
        "1500.00",
    )
    assert (body["budgets"]["month"], body["budgets"]["through"]) == ("2026-12", "2026-12-06")


def test_other_users_spending_is_not_counted(
    w: World, headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    spend(w, bank(w), "2026-11-03", "4250.00")
    other = auth(db_session, monkeypatch, email="other@example.com")
    assert digest(other)["spending"] == "0.00"


# Budgets at risk


def test_budgets_over_and_on_pace(w: World, headers: Headers, clock: Clock) -> None:
    b = bank(w)
    w.budget(headers, "Food and dining", "8000.00")
    w.budget(headers, "Shopping", "1000.00")
    w.budget(headers, "Transport", "10000.00")
    w.budget(headers, "Housing", "20000.00")
    spend(w, b, "2026-11-02", "4400.00", "Food and dining")  # 55% by the 8th
    spend(w, b, "2026-11-03", "1200.00", "Shopping")  # over by 200
    spend(w, b, "2026-11-04", "3000.00", "Transport")  # 30%: fine
    spend(w, b, "2026-11-01", "20000.00", "Housing")  # rent, used up but not over: fine
    body = digest(headers)["budgets"]
    assert (body["month"], body["through"], body["days"], body["days_in_month"]) == (
        "2026-11",
        "2026-11-08",
        8,
        30,
    )
    assert body["elapsed_percent"] == 27
    assert [
        (r["name"], r["status"], r["spent"], r["percent"], r["over_by"], r["projected"])
        for r in body["at_risk"]
    ] == [
        ("Shopping", "over", "1200.00", 120, "200.00", "4500.00"),
        ("Food and dining", "on_pace", "4400.00", 55, "0.00", "16500.00"),
    ]


def test_an_early_bill_under_half_is_not_on_pace(w: World, headers: Headers, clock: Clock) -> None:
    clock.set(datetime(2026, 12, 7, 7, 0))  # the week 30 Nov – 6 Dec: December's 1st to 6th
    b = bank(w)
    w.budget(headers, "Food and dining", "8000.00")
    # 49%, well ahead of 20% elapsed, but under half
    spend(w, b, "2026-12-01", "3900.00", "Food and dining")
    assert digest(headers)["budgets"]["at_risk"] == []
    spend(w, b, "2026-12-02", "100.00", "Food and dining")
    assert [r["status"] for r in digest(headers)["budgets"]["at_risk"]] == ["on_pace"]


def test_a_whole_month_only_shows_over(w: World, headers: Headers, clock: Clock) -> None:
    clock.set(datetime(2027, 1, 5, 7, 0))
    b = bank(w)
    w.budget(headers, "Food and dining", "8000.00")
    w.budget(headers, "Shopping", "1000.00")
    clock.set(datetime(2027, 2, 1, 7, 0))  # Monday: the week ended on Sunday 31 January
    spend(w, b, "2027-01-10", "7900.00", "Food and dining")
    spend(w, b, "2027-01-30", "1001.00", "Shopping")
    body = digest(headers)["budgets"]
    assert (body["month"], body["days"], body["elapsed_percent"]) == ("2027-01", 31, 100)
    assert [(r["name"], r["status"]) for r in body["at_risk"]] == [("Shopping", "over")]


def test_budgets_agree_with_the_budgets_page(w: World, headers: Headers, clock: Clock) -> None:
    clock.set(datetime(2026, 11, 29, 20, 0))  # Sunday night: the week ending today
    b = bank(w)
    w.budget(headers, "Food and dining", "1000.00")
    spend(w, b, "2026-11-03", "700.00", "Food and dining")
    spend(w, b, "2026-11-25", "400.00", "Food and dining")
    risk = digest(headers)["budgets"]["at_risk"]
    page = client.get("/api/budgets", headers=headers).json()["budgets"]
    assert [(r["category_id"], r["spent"], r["percent"]) for r in risk] == [
        (p["category_id"], p["spent"], p["percent"]) for p in page
    ]


# Due next


def test_due_in_the_next_seven_days(w: World, headers: Headers) -> None:
    b = bank(w)
    w.template("Rent", "expense", "20000.00", b, category="Housing", day=15)
    w.template("Gym", "expense", "1500.00", b, category="Health", day=17)
    w.template("Netflix", "expense", "649.00", b, category="Entertainment", day=12)
    body = digest(headers)["due"]
    assert (body["start"], body["through"], body["total"]) == (
        "2026-11-09",
        "2026-11-16",
        "20649.00",
    )
    assert [(i["date"], i["name"], i["amount"], i["direction"]) for i in body["items"]] == [
        ("2026-11-12", "Netflix", "649.00", "out"),
        ("2026-11-15", "Rent", "20000.00", "out"),
    ]
    upcoming = client.get("/api/upcoming", headers=headers).json()["items"]
    assert body["items"] == [i for i in upcoming if i["date"] <= "2026-11-16"]


# Pure rules


def test_default_week_switches_at_six_on_sunday() -> None:
    def at(day: int, hour: int) -> date:
        return dg.default_week(datetime.combine(date(2026, 11, day), time(hour), INDIA))

    assert at(8, 17) == date(2026, 10, 26)
    assert at(8, 18) == date(2026, 11, 2)
    assert at(9, 0) == date(2026, 11, 2)
    assert at(14, 23) == date(2026, 11, 2)


def test_on_pace_rule() -> None:
    # 50% ≤ used < 100% and used > elapsed + 10 points; never when the month is whole.
    assert dg.on_pace(Decimal("4400"), Decimal("8000"), 8, 30)
    assert not dg.on_pace(Decimal("3000"), Decimal("8000"), 8, 30)
    assert not dg.on_pace(Decimal("3200"), Decimal("4000"), 21, 30)  # 80% vs 70% + 10: not above
    assert dg.on_pace(Decimal("3201"), Decimal("4000"), 21, 30)
    assert not dg.on_pace(Decimal("7900"), Decimal("8000"), 31, 31)
    assert not dg.on_pace(Decimal("9000"), Decimal("8000"), 8, 30)  # over, not on pace
    assert not dg.on_pace(Decimal("8000"), Decimal("8000"), 8, 30)  # used up, not over
    assert dg.projected(Decimal("4400"), 8, 30) == Decimal("16500.00")


# Review fixes


def test_so_far_ignores_earlier_weeks_before_the_first_transaction(
    w: World, headers: Headers, clock: Clock
) -> None:
    clock.set(datetime(2026, 11, 10, 9, 0))  # Tuesday
    b = bank(w)
    spend(w, b, "2026-11-06", "500.00")  # the first transaction: a Friday
    spend(w, b, "2026-11-10", "800.00")
    body = digest(headers, week="current")
    # 2–3 November, the same days last week, ended before the first transaction.
    assert (body["usual"], body["usual_weeks"], body["change"], body["tone"]) == (
        None,
        0,
        None,
        None,
    )
    assert body["headline"] == "So far this week you've spent ₹800."


@pytest.mark.parametrize("week", ["0001-01-03", "0999-12-31", "2026-11-2", "current "])
def test_out_of_range_weeks_are_refused(headers: Headers, week: str) -> None:
    assert client.get(URL, params={"week": week}, headers=headers).status_code == 422


def test_about_the_same_is_decided_exactly(w: World, headers: Headers) -> None:
    b = bank(w)
    spend(w, b, "2026-10-28", "1000.00")  # one earlier week: usual ₹1,000
    spend(w, b, "2026-11-03", "1054.00")  # +5.4%: rounds to 5%, but is more than 5%
    body = digest(headers)
    assert body["change"] == {"amount": "54.00", "percent": 5}
    assert body["tone"] == "more"
    assert body["headline"] == "You spent ₹1,054 last week, ₹54 more than usual."


def test_tones(w: World, headers: Headers) -> None:
    b = bank(w)
    spend(w, b, "2026-10-28", "1000.00")
    spend(w, b, "2026-11-03", "950.00")  # exactly 5% less
    body = digest(headers)
    assert (body["tone"], body["headline"]) == (
        "same",
        "You spent ₹950 last week, about the same as usual.",
    )
