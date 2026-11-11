from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes import dashboard
from app.api.routes.dashboard import next_due_date
from app.main import app
from tests.test_accounts import Headers, auth, make
from tests.test_recurring import made

client = TestClient(app)
URL = "/api/dashboard"
EMPTY = {
    "has_accounts": False,
    "net_worth": "0.00",
    "total_have": "0.00",
    "total_owe": "0.00",
    "next_card_due": None,
    "credit_used": None,
    "investments": None,
    "recurring": [],
    "goals_due": [],
    "goals": [],
}


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(dashboard, "today_india", lambda: date(2026, 11, 8))
    return auth(db_session, monkeypatch)


def get(headers: Headers) -> dict[str, Any]:
    response = client.get(URL, headers=headers)
    assert response.status_code == 200
    return response.json()


def card(headers: Headers, name: str = "Card", balance: str = "0.00", **fields: Any) -> int:
    return make(headers, type="credit_card", name=name, balance=balance, **fields).json()["id"]


@pytest.mark.parametrize(
    ("due_day", "today", "expected"),
    [
        (8, date(2026, 11, 8), date(2026, 11, 8)),
        (5, date(2026, 11, 8), date(2026, 12, 5)),
        (25, date(2026, 11, 8), date(2026, 11, 25)),
        (31, date(2026, 11, 8), date(2026, 11, 30)),
        (31, date(2027, 2, 1), date(2027, 2, 28)),
        (31, date(2028, 2, 1), date(2028, 2, 29)),
        (5, date(2026, 12, 20), date(2027, 1, 5)),
        (30, date(2026, 1, 31), date(2026, 2, 28)),
        (30, date(2026, 1, 20), date(2026, 1, 30)),
    ],
)
def test_next_due_date(due_day: int, today: date, expected: date) -> None:
    assert next_due_date(due_day, today) == expected


def test_empty_user(headers: Headers) -> None:
    assert get(headers) == EMPTY


def test_net_worth_exact_decimals(headers: Headers) -> None:
    make(headers, type="bank", bank_kind="savings", name="B", balance="0.10")
    make(headers, name="C", balance="0.20")
    card(headers, balance="0.05")

    body = get(headers)

    assert body["has_accounts"] is True
    assert (body["total_have"], body["total_owe"], body["net_worth"]) == ("0.30", "0.05", "0.25")


def test_negative_net_worth(headers: Headers) -> None:
    make(headers, balance="100.00")
    card(headers, balance="250.50")

    assert get(headers)["net_worth"] == "-150.50"


def test_overdraft_and_overpaid_card(headers: Headers) -> None:
    make(headers, type="bank", bank_kind="current", name="B", balance="-40.00")
    make(headers, name="C", balance="100.00")
    card(headers, balance="-10.00")

    body = get(headers)

    figures = (body["total_have"], body["total_owe"], body["net_worth"])
    assert figures == ("60.00", "-10.00", "70.00")


def test_archived_accounts_are_excluded(headers: Headers) -> None:
    gone_cash = make(headers, balance="999.00").json()["id"]
    gone_card = card(headers, name="Old", balance="500.00", credit_limit="1000.00", due_day=9)
    card(headers, name="New", balance="100.00", credit_limit="1000.00", due_day=20)
    for id_ in (gone_cash, gone_card):
        client.post(f"/api/accounts/{id_}/archive", headers=headers)

    body = get(headers)

    assert (body["total_have"], body["total_owe"]) == ("0.00", "100.00")
    assert body["next_card_due"]["name"] == "New"
    assert body["credit_used"] == {"percent": 10}


def test_only_archived_accounts_means_no_accounts(headers: Headers) -> None:
    id_ = make(headers, balance="5.00").json()["id"]
    client.post(f"/api/accounts/{id_}/archive", headers=headers)

    assert get(headers) == EMPTY


def test_credit_used_ignores_cards_without_a_limit(headers: Headers) -> None:
    card(headers, name="Limited", balance="250.00", credit_limit="1000.00")
    card(headers, name="Unlimited", balance="9000.00")

    assert get(headers)["credit_used"] == {"percent": 25}


def test_credit_used_null_without_limits(headers: Headers) -> None:
    card(headers, balance="100.00")

    assert get(headers)["credit_used"] is None


@pytest.mark.parametrize(
    ("balance", "percent"),
    [("185.00", 19), ("184.00", 18), ("-50.00", 0), ("2500.00", 250), ("0.00", 0)],
)
def test_credit_used_rounding_floor_and_cap(headers: Headers, balance: str, percent: int) -> None:
    card(headers, balance=balance, credit_limit="1000.00")

    assert get(headers)["credit_used"] == {"percent": percent}


def test_credit_used_half_rounds_up(headers: Headers) -> None:
    card(headers, balance="18.50", credit_limit="100.00")

    assert get(headers)["credit_used"] == {"percent": 19}


def test_credit_used_sums_across_cards_and_floors_the_sum(headers: Headers) -> None:
    card(headers, name="A", balance="300.00", credit_limit="1000.00")
    card(headers, name="B", balance="-400.00", credit_limit="1000.00")

    assert get(headers)["credit_used"] == {"percent": 0}


def test_nearest_card_due(headers: Headers) -> None:
    card(headers, name="Later", due_day=25)
    soon = card(headers, name="Soon", due_day=10)
    card(headers, name="Rolled", due_day=2)
    card(headers, name="No day")

    assert get(headers)["next_card_due"] == {
        "account_id": soon,
        "name": "Soon",
        "due_date": "2026-11-10",
    }


def test_due_tie_uses_name_then_id(headers: Headers) -> None:
    card(headers, name="zeta", due_day=10)
    first = card(headers, name="Alpha", due_day=10)
    card(headers, name="alpha2", due_day=10)

    assert get(headers)["next_card_due"]["account_id"] == first


def test_no_due_day_is_null(headers: Headers) -> None:
    card(headers)
    make(headers, balance="1.00")

    assert get(headers)["next_card_due"] is None


def test_other_users_accounts_never_counted(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers
) -> None:
    other = auth(db_session, monkeypatch, "other@example.com")
    make(other, balance="500.00")
    card(other, balance="70.00", credit_limit="100.00", due_day=9)

    assert get(headers) == EMPTY
    assert get(other)["total_have"] == "500.00"


def test_requires_a_session() -> None:
    assert client.get(URL).status_code == 401


def test_recurring_shows_due_and_coming_up_and_leaves_other_keys(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import recurring

    monkeypatch.setattr(recurring, "today_india", lambda: date(2026, 11, 8))
    account_id = make(headers, balance="50000.00").json()["id"]
    before = get(headers)
    assert before["recurring"] == []

    rent = made(headers, account_id, day=1, start_date="2026-11-01", remind_days=3)
    premium = made(
        headers, account_id, name="Premium", day=10, start_date="2026-11-10", remind_days=3
    )

    after = get(headers)
    assert {k: v for k, v in after.items() if k != "recurring"} == {
        k: v for k, v in before.items() if k != "recurring"
    }
    got = [(i["template"]["id"], i["occurrence"], i["state"]) for i in after["recurring"]]
    assert got == [
        (rent["id"], "2026-11-01", "due"),
        (premium["id"], "2026-11-10", "coming_up"),
    ]
