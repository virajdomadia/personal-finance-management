from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.balances import load_flows
from app.api.goals import free_balance, load_goal_book
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


def test_emergency_fund_with_no_expenses_in_the_window_has_no_figure(
    headers: Headers, db_session: Session
) -> None:
    uid = me(db_session)
    bank = account(db_session, uid)
    db_session.add(
        Transaction(
            user_id=uid,
            type="income",
            amount=Decimal("500.00"),
            date=date(2026, 9, 1),
            account_id=bank.id,
        )
    )
    db_session.commit()
    body = emergency(headers).json()
    assert body["target"] is None
    assert body["ef"]["monthly"] is None
    assert body["ef"]["computed"] is None
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
    assert client.post(f"{URL}/{old}/archive", headers=headers).status_code == 200

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
    client.post(f"{URL}/{gone}/archive", headers=headers)
    names = [g["name"] for g in client.get(URL, headers=headers).json()["goals"]]
    assert names == ["Emergency fund", "Apple", "Zebra"]
    archived = client.get(f"{URL}?archived=true", headers=headers).json()["goals"]
    assert [g["name"] for g in archived] == ["Old"]


def test_restore_checks_for_a_second_emergency_fund(headers: Headers) -> None:
    first = emergency(headers).json()["id"]
    client.post(f"{URL}/{first}/archive", headers=headers)
    assert emergency(headers).status_code == 201
    restored = client.post(f"{URL}/{first}/restore", headers=headers)
    assert restored.status_code == 409
    assert restored.json()["detail"] == "You already have an emergency fund."
    assert client.get(f"{URL}/{first}", headers=headers).json()["archived"] is True


def test_patch_no_longer_archives(headers: Headers) -> None:
    goal_id = create(headers).json()["id"]
    response = client.patch(f"{URL}/{goal_id}", json={"archived": True}, headers=headers)
    assert response.status_code == 422


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


# Baskets: set aside, release, holdings, archive and restore.


def earmark(
    headers: Headers, goal_id: int, account_id: int | None, action: str, amount: str, **extra: Any
) -> Response:
    body = {"account_id": account_id, "action": action, "amount": amount, **extra}
    return client.post(f"{URL}/{goal_id}/earmarks", json=body, headers=headers)


def add_holding(headers: Headers, goal_id: int, **target: int) -> Response:
    return client.post(f"{URL}/{goal_id}/holdings", json=target, headers=headers)


def fund(db: Session, user_id: int, name: str = "Mutual fund X", held: bool = True) -> int:
    """A mutual fund bought from a broker account, and sold again unless `held`."""
    broker = account(db, user_id, f"Broker for {name}", "broker")
    row = Instrument(user_id=user_id, kind="mutual_fund", symbol=name.upper(), name=name)
    db.add(row)
    db.flush()
    sides = [("buy", "1000.00"), *([] if held else [("sell", "1000.00")])]
    for side, amount in sides:
        db.add(
            InvestmentTrade(
                user_id=user_id,
                instrument_id=row.id,
                account_id=broker.id,
                side=side,
                date=date(2026, 10, 1),
                quantity=Decimal("100"),
                price=Decimal("10"),
                charges=Decimal("0.00"),
                amount=Decimal(amount),
            )
        )
    db.commit()
    return row.id


def test_rupees_uses_indian_grouping() -> None:
    assert accounts.rupees(Decimal("40000.00")) == "₹40,000"
    assert accounts.rupees(Decimal("1234567.50")) == "₹12,34,567.50"
    assert accounts.rupees(Decimal("999")) == "₹999"
    assert accounts.rupees(Decimal("0.00")) == "₹0"
    assert accounts.rupees(Decimal("100000000.05")) == "₹10,00,00,000.05"


def test_set_aside_then_release_no_more_than_is_set_aside(
    headers: Headers, db_session: Session
) -> None:
    goal_id = create(headers).json()["id"]
    hdfc = account(db_session, me(db_session), "HDFC").id
    db_session.commit()

    added = earmark(headers, goal_id, hdfc, "set_aside", "50000.00", date="2026-11-01")
    assert added.status_code == 201, added.json()
    assert added.json()["earmarked"] == "50000.00"
    released = earmark(headers, goal_id, hdfc, "release", "10000.00", note="Bills")
    assert released.status_code == 201, released.json()
    assert released.json()["earmarks"] == [
        {"account_id": hdfc, "account_name": "HDFC", "amount": "40000.00"}
    ]

    too_much = earmark(headers, goal_id, hdfc, "release", "50000.00")
    assert too_much.status_code == 422
    assert messages(too_much) == {"amount": "Only ₹40,000 of HDFC is set aside for this goal."}

    history = client.get(f"{URL}/{goal_id}", headers=headers).json()["history"]
    assert [(h["amount"], h["date"], h["note"]) for h in history] == [
        ("-10000.00", "2026-11-11", "Bills"),
        ("50000.00", "2026-11-01", None),
    ]


def test_deleting_an_entry_cannot_leave_the_earmark_below_zero(
    headers: Headers, db_session: Session
) -> None:
    goal_id = create(headers).json()["id"]
    hdfc = account(db_session, me(db_session), "HDFC").id
    db_session.commit()
    earmark(headers, goal_id, hdfc, "set_aside", "50000.00", date="2026-11-01")
    earmark(headers, goal_id, hdfc, "release", "10000.00")
    release_id, set_aside_id = [
        h["id"] for h in client.get(f"{URL}/{goal_id}", headers=headers).json()["history"]
    ]

    refused = client.delete(f"{URL}/{goal_id}/earmarks/{set_aside_id}", headers=headers)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Delete the later release first."

    url = f"{URL}/{goal_id}/earmarks"
    assert client.delete(f"{url}/{release_id}", headers=headers).json() == {"id": release_id}
    assert client.delete(f"{url}/{set_aside_id}", headers=headers).status_code == 200
    assert client.get(f"{URL}/{goal_id}", headers=headers).json()["history"] == []
    assert client.delete(f"{url}/{set_aside_id}", headers=headers).status_code == 404


def test_set_aside_only_from_active_bank_cash_or_wallet(
    headers: Headers, db_session: Session
) -> None:
    goal_id = create(headers).json()["id"]
    uid = me(db_session)
    rd = owners_rd(headers)
    old = account(db_session, uid, "Old bank")
    old.archived_at = datetime(2026, 11, 1, tzinfo=UTC)
    wallet = account(db_session, uid, "Paytm", "wallet").id
    old_id = old.id
    db_session.commit()

    message = {"account_id": "Set money aside from a bank, cash or wallet account."}
    for account_id in (rd, old_id, 999999):
        response = earmark(headers, goal_id, account_id, "set_aside", "100.00")
        assert response.status_code == 422
        assert messages(response) == message
    assert earmark(headers, goal_id, wallet, "set_aside", "100.00").status_code == 201


@pytest.mark.parametrize(
    ("fields", "field", "message"),
    [
        ({"amount": "0.00"}, "amount", "Enter an amount greater than 0."),
        ({"amount": "-5.00"}, "amount", "Enter an amount greater than 0."),
        ({"amount": None}, "amount", "Enter an amount greater than 0."),
        ({"action": "spend"}, "action", "Choose set aside or release."),
        ({"action": None}, "action", "Choose set aside or release."),
        ({"date": "2026-11-12"}, "date", "Choose today or an earlier date."),
        (
            {"account_id": None},
            "account_id",
            "Set money aside from a bank, cash or wallet account.",
        ),
    ],
)
def test_earmark_validation(
    headers: Headers, db_session: Session, fields: dict, field: str, message: str
) -> None:
    goal_id = create(headers).json()["id"]
    bank = account(db_session, me(db_session)).id
    db_session.commit()
    body = {"account_id": bank, "action": "set_aside", "amount": "100.00", **fields}
    response = client.post(f"{URL}/{goal_id}/earmarks", json=body, headers=headers)
    assert response.status_code == 422
    assert messages(response)[field] == message


def test_archived_goal_takes_no_earmarks(headers: Headers, db_session: Session) -> None:
    goal_id = create(headers).json()["id"]
    bank = account(db_session, me(db_session)).id
    db_session.commit()
    entry = earmark(headers, goal_id, bank, "set_aside", "100.00")
    assert entry.status_code == 201
    entry_id = client.get(f"{URL}/{goal_id}", headers=headers).json()["history"][0]["id"]
    client.post(f"{URL}/{goal_id}/archive", headers=headers)
    for response in (
        earmark(headers, goal_id, bank, "release", "100.00"),
        client.delete(f"{URL}/{goal_id}/earmarks/{entry_id}", headers=headers),
    ):
        assert response.status_code == 409
        assert response.json()["detail"] == "Restore this goal first."


def test_set_aside_may_exceed_the_free_balance_and_warns(
    headers: Headers, db_session: Session
) -> None:
    hdfc = account(db_session, me(db_session), "HDFC").id  # holds 50,000
    db_session.commit()
    bike = create(headers).json()["id"]
    trip = create(headers, name="Trip").json()["id"]
    assert earmark(headers, bike, hdfc, "set_aside", "45000.00").json()["warnings"] == []
    over = earmark(headers, trip, hdfc, "set_aside", "15000.50")
    assert over.status_code == 201
    warning = "₹10,000.50 more is set aside than HDFC holds."
    assert over.json()["warnings"] == [warning]
    assert client.get(f"{URL}/{bike}", headers=headers).json()["warnings"] == [warning]

    # Archiving Trip stops its earmark counting, so the account is no longer over.
    client.post(f"{URL}/{trip}/archive", headers=headers)
    assert client.get(f"{URL}/{bike}", headers=headers).json()["warnings"] == []


def test_free_balance_helper(headers: Headers, db_session: Session) -> None:
    uid = me(db_session)
    hdfc = account(db_session, uid, "HDFC")
    db_session.commit()
    goal_id = create(headers).json()["id"]
    earmark(headers, goal_id, hdfc.id, "set_aside", "20000.00")
    book = load_goal_book(db_session, uid, TODAY)
    flows = load_flows(db_session, uid)
    assert free_balance(hdfc, flows, book.set_aside_by_account) == Decimal("30000.00")
    assert free_balance(hdfc, flows, {}) == Decimal("50000.00")


def test_a_holding_belongs_to_one_active_goal(headers: Headers, db_session: Session) -> None:
    fund_id = fund(db_session, me(db_session))
    ef = emergency(headers, name="EF").json()["id"]
    bike = create(headers).json()["id"]

    added = add_holding(headers, ef, instrument_id=fund_id)
    assert added.status_code == 201, added.json()
    assert [h["name"] for h in added.json()["holdings"]] == ["Mutual fund X"]
    for goal_id in (bike, ef):
        again = add_holding(headers, goal_id, instrument_id=fund_id)
        assert again.status_code == 409
        assert again.json()["detail"] == "Mutual fund X is already in EF."


def test_archive_frees_holdings_and_restore_is_refused_once_taken(
    headers: Headers, db_session: Session
) -> None:
    fund_id = fund(db_session, me(db_session))
    ef = emergency(headers, name="EF").json()["id"]
    bike = create(headers).json()["id"]
    add_holding(headers, ef, instrument_id=fund_id)

    archived = client.post(f"{URL}/{ef}/archive", headers=headers)
    assert archived.status_code == 200
    assert archived.json()["archived"] is True
    assert add_holding(headers, bike, instrument_id=fund_id).status_code == 201

    restored = client.post(f"{URL}/{ef}/restore", headers=headers)
    assert restored.status_code == 409
    assert restored.json()["detail"] == "Mutual fund X is in Bike now."
    assert client.get(f"{URL}/{ef}", headers=headers).json()["archived"] is True
    holding = db_session.scalars(select(GoalHolding).where(GoalHolding.goal_id == ef)).one()
    db_session.refresh(holding)
    assert holding.active is False

    # Taking it out of Bike lets EF come back with it.
    bike_holding = client.get(f"{URL}/{bike}", headers=headers).json()["holdings"][0]["id"]
    removed = client.delete(f"{URL}/{bike}/holdings/{bike_holding}", headers=headers)
    assert removed.json() == {"id": bike_holding}
    back = client.post(f"{URL}/{ef}/restore", headers=headers)
    assert back.status_code == 200
    assert back.json()["archived"] is False
    book = load_goal_book(db_session, me(db_session), TODAY)
    assert book.holding_goal == {("instrument", fund_id): (ef, "EF")}


def test_archive_and_restore_switch_earmarks_in_and_out(
    headers: Headers, db_session: Session
) -> None:
    uid = me(db_session)
    goal_id = create(headers).json()["id"]
    bank = account(db_session, uid).id
    db_session.commit()
    earmark(headers, goal_id, bank, "set_aside", "700.00")
    client.post(f"{URL}/{goal_id}/archive", headers=headers)
    assert load_goal_book(db_session, uid, TODAY).set_aside_by_account == {}
    client.post(f"{URL}/{goal_id}/restore", headers=headers)
    assert load_goal_book(db_session, uid, TODAY).set_aside_by_account == {bank: Decimal("700.00")}


def test_holding_must_be_held_units_or_a_ppf_or_rd(headers: Headers, db_session: Session) -> None:
    uid = me(db_session)
    goal_id = create(headers).json()["id"]
    gone = fund(db_session, uid, "Gone Fund", held=False)
    bank = account(db_session, uid).id
    db_session.commit()
    rd = owners_rd(headers)

    not_held = add_holding(headers, goal_id, instrument_id=gone)
    assert not_held.status_code == 422
    assert messages(not_held) == {"instrument_id": "You don't hold any Gone Fund."}
    for account_id in (bank, 999999):
        wrong = add_holding(headers, goal_id, account_id=account_id)
        assert wrong.status_code == 422
        assert messages(wrong) == {"account_id": "Choose a PPF or RD account."}
    missing = add_holding(headers, goal_id, instrument_id=999999)
    assert messages(missing) == {"instrument_id": "Choose a fund, stock, coin, PPF or RD."}
    for body in ({}, {"instrument_id": gone, "account_id": rd}):
        neither = client.post(f"{URL}/{goal_id}/holdings", json=body, headers=headers)
        assert neither.status_code == 422
        assert messages(neither) == {"instrument_id": "Choose a fund, stock, coin, PPF or RD."}

    added = add_holding(headers, goal_id, account_id=rd)
    assert added.status_code == 201, added.json()
    assert added.json()["holdings"][0]["account_id"] == rd


def test_archived_goal_takes_no_holdings(headers: Headers, db_session: Session) -> None:
    fund_id = fund(db_session, me(db_session))
    goal_id = create(headers).json()["id"]
    client.post(f"{URL}/{goal_id}/archive", headers=headers)
    response = add_holding(headers, goal_id, instrument_id=fund_id)
    assert response.status_code == 409
    assert response.json()["detail"] == "Restore this goal first."


def test_other_users_basket_routes_are_404(
    headers: Headers, other: Headers, db_session: Session
) -> None:
    theirs = create(other).json()["id"]
    bank = account(db_session, me(db_session)).id
    db_session.commit()
    for call in (
        lambda: earmark(headers, theirs, bank, "set_aside", "1.00"),
        lambda: client.delete(f"{URL}/{theirs}/earmarks/1", headers=headers),
        lambda: client.post(f"{URL}/{theirs}/holdings", json={}, headers=headers),
        lambda: client.delete(f"{URL}/{theirs}/holdings/1", headers=headers),
        lambda: client.post(f"{URL}/{theirs}/archive", headers=headers),
        lambda: client.post(f"{URL}/{theirs}/restore", headers=headers),
    ):
        assert call().status_code == 404


def test_restore_refused_while_an_account_it_has_money_in_is_archived(
    headers: Headers, db_session: Session
) -> None:
    goal_id = create(headers).json()["id"]
    bank = account(db_session, me(db_session)).id
    db_session.commit()
    assert earmark(headers, goal_id, bank, "set_aside", "100.00").status_code == 201
    client.post(f"{URL}/{goal_id}/archive", headers=headers)
    assert client.post(f"/api/accounts/{bank}/archive", headers=headers).status_code == 200

    response = client.post(f"{URL}/{goal_id}/restore", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "SBI is archived. Restore it first."
    assert client.get(f"{URL}/{goal_id}", headers=headers).json()["archived"] is True

    assert client.post(f"/api/accounts/{bank}/restore", headers=headers).status_code == 200
    assert client.post(f"{URL}/{goal_id}/restore", headers=headers).status_code == 200


def test_deleting_a_release_is_refused_while_its_account_is_archived(
    headers: Headers, db_session: Session
) -> None:
    goal_id = create(headers).json()["id"]
    bank = account(db_session, me(db_session)).id
    db_session.commit()
    earmark(headers, goal_id, bank, "set_aside", "100.00")
    earmark(headers, goal_id, bank, "release", "40.00")
    before = client.get(f"{URL}/{goal_id}", headers=headers).json()
    release_id = before["history"][0]["id"]
    row = db_session.get(Account, bank)
    assert row is not None
    row.archived_at = datetime(2026, 11, 1, tzinfo=UTC)
    db_session.commit()

    response = client.delete(f"{URL}/{goal_id}/earmarks/{release_id}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "SBI is archived. Restore it first."
    assert client.get(f"{URL}/{goal_id}", headers=headers).json() == before


def test_restore_ignores_an_archived_account_the_goal_released(
    headers: Headers, db_session: Session
) -> None:
    goal_id = create(headers).json()["id"]
    bank = account(db_session, me(db_session)).id
    db_session.commit()
    earmark(headers, goal_id, bank, "set_aside", "100.00")
    earmark(headers, goal_id, bank, "release", "100.00")
    client.post(f"{URL}/{goal_id}/archive", headers=headers)
    assert client.post(f"/api/accounts/{bank}/archive", headers=headers).status_code == 200
    assert client.post(f"{URL}/{goal_id}/restore", headers=headers).status_code == 200


# Reminders and the dashboard.


def due_goals(headers: Headers) -> list[dict[str, Any]]:
    response = client.get("/api/recurring/due", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []  # goals never appear among the recurring items
    return body["goals_due"]


def test_monthly_set_aside_is_due_until_it_is_made(headers: Headers, db_session: Session) -> None:
    goal_id = create(headers, monthly_amount="5000.00", reminder_day=5).json()["id"]
    bank = account(db_session, me(db_session)).id
    db_session.commit()
    assert due_goals(headers) == [
        {"goal_id": goal_id, "name": "Bike", "amount": "5000.00", "due_since": "2026-11-05"}
    ]
    earmark(headers, goal_id, bank, "set_aside", "2000.00")
    assert due_goals(headers)[0]["amount"] == "3000.00"
    earmark(headers, goal_id, bank, "set_aside", "3000.00")
    assert due_goals(headers) == []
    # A release does not make it due again.
    earmark(headers, goal_id, bank, "release", "4000.00")
    assert due_goals(headers) == []


def test_no_reminder_before_its_day_or_for_archived_goals(headers: Headers) -> None:
    create(headers, name="Later", monthly_amount="5000.00", reminder_day=20)
    gone = create(headers, name="Gone", monthly_amount="5000.00", reminder_day=1).json()["id"]
    assert due_goals(headers) == [
        {"goal_id": gone, "name": "Gone", "amount": "5000.00", "due_since": "2026-11-01"}
    ]
    client.post(f"{URL}/{gone}/archive", headers=headers)
    assert due_goals(headers) == []


def test_dashboard_lists_active_goals_and_what_is_due(
    headers: Headers, db_session: Session
) -> None:
    emergency_id = emergency(headers, ef_monthly_override="10000.00").json()["id"]
    bike = create(headers, monthly_amount="5000.00", reminder_day=5).json()["id"]
    gone = create(headers, name="Gone").json()["id"]
    client.post(f"{URL}/{gone}/archive", headers=headers)
    bank = account(db_session, me(db_session)).id
    db_session.commit()
    earmark(headers, bike, bank, "set_aside", "12000.00")
    trip = create(headers, name="Trip", monthly_amount="1500.00", reminder_day=2).json()["id"]
    body = client.get("/api/dashboard", headers=headers).json()
    assert body["goals_due"] == [
        {"goal_id": trip, "name": "Trip", "amount": "1500.00", "due_since": "2026-11-02"}
    ]
    assert [g["id"] for g in body["goals"]] == [emergency_id, bike, trip]
    assert body["goals"][1] == {
        "id": bike,
        "name": "Bike",
        "kind": "custom",
        "saved": "12000.00",
        "target": "120000.00",
        "percent": 10,
        "reached": False,
    }
    assert body["goals"][0]["target"] == "60000.00"
