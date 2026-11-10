from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.goals import load_goal_book
from app.api.routes import accounts, dashboard, goals, policies, recurring, transactions
from app.main import app
from app.models.account import Account
from app.models.goal import Goal, GoalEarmark, GoalHolding
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade
from app.models.transaction import Transaction
from app.models.user import User
from tests.test_accounts import Headers, auth
from tests.test_policies import new as new_policy
from tests.test_policies import owners_rd

client = TestClient(app)

URL = "/api/goals"
TODAY = date(2026, 11, 11)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (accounts, dashboard, goals, policies, recurring, transactions):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


@pytest.fixture
def other(db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers) -> Headers:
    return auth(db_session, monkeypatch, email="other@example.com")


def me(db: Session) -> int:
    return db.scalars(select(User).where(User.email == "me@example.com")).one().id


def create(headers: Headers, **fields: Any) -> Response:
    body = {"name": "Bike", "kind": "custom", "target_amount": "120000.00", **fields}
    return client.post(URL, json=body, headers=headers)


def emergency(headers: Headers, **fields: Any) -> Response:
    return client.post(
        URL, json={"name": "Emergency fund", "kind": "emergency", **fields}, headers=headers
    )


def messages(response: Response) -> dict[str, str]:
    return {e["loc"][-1]: e["msg"] for e in response.json()["detail"]}


def account(db: Session, user_id: int, name: str = "SBI", type_: str = "bank") -> Account:
    row = Account(user_id=user_id, type=type_, name=name, opening_balance=Decimal("50000.00"))
    db.add(row)
    db.flush()
    return row


def spend(db: Session, user_id: int) -> None:
    """The Task 2 expenses, as transactions. The first is on 2026-05-20."""
    bank = account(db, user_id)
    loan = account(db, user_id, "Loan", "loan")

    def tx(kind: str, amount: str, day: date, **extra: Any) -> None:
        db.add(
            Transaction(
                user_id=user_id,
                type=kind,
                amount=Decimal(amount),
                date=day,
                account_id=bank.id,
                **extra,
            )
        )

    tx("expense", "700.00", date(2026, 5, 20))
    tx("expense", "30000.00", date(2026, 6, 10))
    tx("expense", "32000.00", date(2026, 7, 10))
    tx("expense", "28000.00", date(2026, 8, 10))
    tx("emi", "5000.00", date(2026, 8, 12), to_account_id=loan.id, interest=Decimal("800.00"))
    tx("expense", "31000.00", date(2026, 9, 10))
    tx("transfer", "10000.00", date(2026, 9, 11), to_account_id=loan.id)
    tx("income", "50000.00", date(2026, 9, 12))
    tx("expense", "36000.00", date(2026, 10, 10))
    tx("expense", "99999.00", date(2026, 11, 3))
    db.commit()


def test_emergency_fund_worked_out_from_expenses(headers: Headers, db_session: Session) -> None:
    spend(db_session, me(db_session))
    response = emergency(headers)
    assert response.status_code == 201, response.json()
    body = response.json()
    assert body["kind"] == "emergency"
    assert body["ef"] == {
        "months": 6,
        "monthly": "32400.00",
        "computed": "32400.00",
        "override": None,
        "window": ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
    }
    assert body["target"] == "194400.00"
    assert body["warnings"] == []


def test_override_replaces_the_figure_but_not_the_computed_one(
    headers: Headers, db_session: Session
) -> None:
    spend(db_session, me(db_session))
    body = emergency(headers, ef_monthly_override="40000.00").json()
    assert body["target"] == "240000.00"
    assert body["ef"]["computed"] == "32400.00"
    assert body["ef"]["monthly"] == "40000.00"
    assert body["ef"]["override"] == "40000.00"


def test_emergency_fund_without_a_full_month_has_no_target(
    headers: Headers, db_session: Session
) -> None:
    uid = me(db_session)
    bank = account(db_session, uid)
    db_session.add(
        Transaction(
            user_id=uid,
            type="expense",
            amount=Decimal("500.00"),
            date=date(2026, 11, 2),
            account_id=bank.id,
        )
    )
    db_session.commit()
    body = emergency(headers).json()
    assert body["target"] is None
    assert body["ef"]["monthly"] is None
    assert body["ef"]["computed"] is None
    assert body["ef"]["window"] == []
    assert body["percent"] is None


def test_custom_goal_progress(headers: Headers, db_session: Session) -> None:
    goal_id = create(headers, target_date="2027-06-30").json()["id"]
    bank = account(db_session, me(db_session))
    db_session.add(
        GoalEarmark(
            user_id=me(db_session),
            goal_id=goal_id,
            account_id=bank.id,
            amount=Decimal("45500.00"),
            date=date(2026, 11, 1),
        )
    )
    db_session.commit()
    body = client.get(f"{URL}/{goal_id}", headers=headers).json()
    assert body["target"] == "120000.00"
    assert body["saved"] == "45500.00"
    assert body["earmarked"] == "45500.00"
    assert body["holdings_value"] == "0.00"
    assert body["percent"] == 38
    assert body["per_month"] == "9313.00"
    assert body["months_left"] == 8
    assert body["earmarks"] == [
        {"account_id": bank.id, "account_name": "SBI", "amount": "45500.00"}
    ]
    assert body["history"][0]["amount"] == "45500.00"
    assert body["history"][0]["account_name"] == "SBI"


def test_holdings_values_status_and_note(headers: Headers, db_session: Session) -> None:
    uid = me(db_session)
    goal_id = create(headers).json()["id"]
    bank = account(db_session, uid)
    live = Instrument(user_id=uid, kind="mutual_fund", symbol="LIVE", name="Live Fund")
    gone = Instrument(user_id=uid, kind="mutual_fund", symbol="GONE", name="Gone Fund")
    db_session.add_all([live, gone])
    db_session.flush()

    def trade(i: Instrument, side: str, units: str, nav: str, amount: str) -> None:
        db_session.add(
            InvestmentTrade(
                user_id=uid,
                instrument_id=i.id,
                account_id=bank.id,
                side=side,
                date=date(2026, 10, 1),
                quantity=Decimal(units),
                price=Decimal(nav),
                charges=Decimal("0.00"),
                amount=Decimal(amount),
            )
        )

    trade(live, "buy", "100", "10", "1000.00")
    trade(gone, "buy", "10", "10", "100.00")
    trade(gone, "sell", "10", "11", "110.00")
    db_session.add(
        InstrumentPrice(
            user_id=uid, instrument_id=live.id, date=date(2026, 11, 1), price=Decimal("12.5")
        )
    )
    db_session.commit()

    rd = owners_rd(headers)
    pay = db_session.scalars(select(Account).where(Account.name == "Bank of India")).one()
    policy = new_policy(headers, pay.id, funded_by_id=rd)
    assert policy.status_code == 201, policy.json()

    for inst_id, acc_id in ((live.id, None), (gone.id, None), (None, rd)):
        db_session.add(
            GoalHolding(user_id=uid, goal_id=goal_id, instrument_id=inst_id, account_id=acc_id)
        )
    db_session.commit()

    body = client.get(f"{URL}/{goal_id}", headers=headers).json()
    by_name = {h["name"]: h for h in body["holdings"]}
    assert by_name["Live Fund"]["value"] == "1250.00"
    assert by_name["Live Fund"]["status"] == "held"
    assert by_name["Live Fund"]["kind"] == "mutual_fund"
    assert by_name["Live Fund"]["note"] is None
    assert by_name["Gone Fund"]["value"] == "0.00"
    assert by_name["Gone Fund"]["status"] == "sold"
    assert by_name["Bank of India RD"]["kind"] == "rd"
    assert by_name["Bank of India RD"]["value"] == "9000.00"
    assert by_name["Bank of India RD"]["account_id"] == rd
    assert by_name["Bank of India RD"]["note"] == "Also funds the Care Health Insurance premium."
    assert body["holdings_value"] == "10250.00"
    assert body["saved"] == "10250.00"


def test_closed_account_holding_counts_zero(headers: Headers, db_session: Session) -> None:
    uid = me(db_session)
    goal_id = create(headers).json()["id"]
    rd = owners_rd(headers)
    db_session.add(GoalHolding(user_id=uid, goal_id=goal_id, account_id=rd))
    db_session.commit()
    row = db_session.get(Account, rd)
    assert row is not None
    row.archived_at = datetime(2026, 11, 1, tzinfo=UTC)
    db_session.commit()
    holding = client.get(f"{URL}/{goal_id}", headers=headers).json()["holdings"][0]
    assert (holding["status"], holding["value"]) == ("closed", "0.00")


def test_goal_book_sums_active_goals_and_holdings_only(
    headers: Headers, db_session: Session
) -> None:
    uid = me(db_session)
    live = create(headers, name="Live").json()["id"]
    old = create(headers, name="Old").json()["id"]
    bank = account(db_session, uid)
    for goal_id, amount in ((live, "100.00"), (live, "-30.00"), (old, "500.00")):
        db_session.add(
            GoalEarmark(
                user_id=uid,
                goal_id=goal_id,
                account_id=bank.id,
                amount=Decimal(amount),
                date=date(2026, 11, 1),
            )
        )
    db_session.add(GoalHolding(user_id=uid, goal_id=live, account_id=bank.id, active=False))
    db_session.commit()
    assert client.patch(f"{URL}/{old}", json={"archived": True}, headers=headers).status_code == 200

    book = load_goal_book(db_session, uid, TODAY)
    assert book.set_aside_by_account == {bank.id: Decimal("70.00")}
    assert book.holding_goal == {}
    assert book.responses[old].archived is True
    assert book.responses[old].saved == "500.00"  # still shown for display


def test_list_order_and_archived_filter(headers: Headers) -> None:
    create(headers, name="Zebra")
    create(headers, name="Apple")
    emergency(headers)
    gone = create(headers, name="Old").json()["id"]
    client.patch(f"{URL}/{gone}", json={"archived": True}, headers=headers)
    names = [g["name"] for g in client.get(URL, headers=headers).json()["goals"]]
    assert names == ["Emergency fund", "Apple", "Zebra"]
    archived = client.get(f"{URL}?archived=true", headers=headers).json()["goals"]
    assert [g["name"] for g in archived] == ["Old"]


def test_restore_checks_for_a_second_emergency_fund(headers: Headers) -> None:
    first = emergency(headers).json()["id"]
    client.patch(f"{URL}/{first}", json={"archived": True}, headers=headers)
    assert emergency(headers).status_code == 201
    restored = client.patch(f"{URL}/{first}", json={"archived": False}, headers=headers)
    assert restored.status_code == 409


@pytest.mark.parametrize(
    ("fields", "field", "message"),
    [
        ({"name": ""}, "name", "Enter a name."),
        ({"name": "x" * 61}, "name", "Enter a name."),
        ({"kind": "bogus"}, "kind", "Choose custom or emergency."),
        ({"target_amount": None}, "target_amount", "Enter a target amount."),
        ({"target_amount": "0.00"}, "target_amount", "Enter a target amount."),
        ({"monthly_amount": "500.00"}, "reminder_day", "Choose a day from 1 to 31."),
        (
            {"monthly_amount": "500.00", "reminder_day": 32},
            "reminder_day",
            "Choose a day from 1 to 31.",
        ),
    ],
)
def test_custom_validation(headers: Headers, fields: dict, field: str, message: str) -> None:
    response = create(headers, **fields)
    assert response.status_code == 422
    assert messages(response)[field] == message


@pytest.mark.parametrize(
    ("fields", "field", "message"),
    [
        (
            {"target_amount": "1000.00"},
            "target_amount",
            "The emergency fund's target is worked out for you.",
        ),
        ({"ef_months": 0}, "ef_months", "Choose 1 to 24 months."),
        ({"ef_months": 25}, "ef_months", "Choose 1 to 24 months."),
        (
            {"ef_monthly_override": "0.00"},
            "ef_monthly_override",
            "Enter a monthly figure greater than 0.",
        ),
    ],
)
def test_emergency_validation(headers: Headers, fields: dict, field: str, message: str) -> None:
    response = emergency(headers, **fields)
    assert response.status_code == 422
    assert messages(response)[field] == message


def test_second_active_emergency_fund_is_409(headers: Headers) -> None:
    assert emergency(headers).status_code == 201
    response = emergency(headers, name="Another")
    assert response.status_code == 409
    assert response.json()["detail"] == "You already have an emergency fund."


def test_emergency_months_default_and_edit(headers: Headers) -> None:
    body = emergency(headers).json()
    assert body["ef"]["months"] == 6
    patched = client.patch(f"{URL}/{body['id']}", json={"ef_months": 9}, headers=headers)
    assert patched.json()["ef"]["months"] == 9


def test_reminder_starts_this_month_when_turned_on(headers: Headers, db_session: Session) -> None:
    body = create(headers, monthly_amount="2000.00", reminder_day=5).json()
    assert (body["monthly_amount"], body["reminder_day"]) == ("2000.00", 5)
    goal = db_session.get(Goal, body["id"])
    assert goal is not None
    assert goal.reminder_start == date(2026, 11, 1)

    off = client.patch(f"{URL}/{body['id']}", json={"monthly_amount": None}, headers=headers).json()
    assert (off["monthly_amount"], off["reminder_day"]) == (None, None)
    db_session.refresh(goal)
    assert goal.reminder_start is None


def test_reminder_start_is_kept_while_on(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = create(headers, monthly_amount="2000.00", reminder_day=5).json()
    monkeypatch.setattr(goals, "today_india", lambda: date(2026, 12, 20))
    client.patch(f"{URL}/{body['id']}", json={"monthly_amount": "3000.00"}, headers=headers)
    goal = db_session.get(Goal, body["id"])
    assert goal is not None
    db_session.refresh(goal)
    assert goal.reminder_start == date(2026, 11, 1)


def test_patch_updates_and_validates_merged_values(headers: Headers) -> None:
    body = create(headers).json()
    patched = client.patch(
        f"{URL}/{body['id']}",
        json={"name": "Scooter", "target_amount": "90000.00", "note": "soon"},
        headers=headers,
    )
    assert patched.status_code == 200
    assert (patched.json()["name"], patched.json()["target"]) == ("Scooter", "90000.00")
    assert patched.json()["note"] == "soon"
    bad = client.patch(f"{URL}/{body['id']}", json={"target_amount": None}, headers=headers)
    assert bad.status_code == 422


def test_delete_without_history_then_with(headers: Headers, db_session: Session) -> None:
    uid = me(db_session)
    plain = create(headers, name="Plain").json()["id"]
    assert client.delete(f"{URL}/{plain}", headers=headers).json() == {"id": plain}
    assert client.get(f"{URL}/{plain}", headers=headers).status_code == 404

    kept = create(headers, name="Kept").json()["id"]
    bank = account(db_session, uid)
    db_session.add(
        GoalEarmark(
            user_id=uid,
            goal_id=kept,
            account_id=bank.id,
            amount=Decimal("10.00"),
            date=date(2026, 11, 1),
        )
    )
    db_session.commit()
    response = client.delete(f"{URL}/{kept}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "This goal has set-aside history. Archive it instead."


def test_other_users_goal_is_404(headers: Headers, other: Headers) -> None:
    # `other` signs in after `headers`, so the goal is made with its own headers first.
    mine = create(other).json()["id"]
    for call in (
        lambda: client.get(f"{URL}/{mine}", headers=headers),
        lambda: client.patch(f"{URL}/{mine}", json={"name": "X"}, headers=headers),
        lambda: client.delete(f"{URL}/{mine}", headers=headers),
        lambda: client.get(f"{URL}/999999999999", headers=headers),
    ):
        assert call().status_code == 404
    assert client.get(URL, headers=headers).json() == {"goals": []}


def test_requires_session(headers: Headers) -> None:
    assert client.get(URL).status_code == 401
    assert client.post(URL, json={}).status_code == 401
