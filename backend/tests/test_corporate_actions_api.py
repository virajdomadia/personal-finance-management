"""The corporate actions API: the review inbox, a stock's history, confirming and undoing, and
linking dividends to the payments that brought them."""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.api.routes import corporate_actions, portfolio
from app.main import app
from app.models.corporate_action import CorporateAction, DividendLink, StockAction
from app.models.investment import Instrument
from app.models.user import User
from tests.conftest import ON_POSTGRES
from tests.test_accounts import Headers, auth
from tests.test_trades import bank, broker, made, stock

client = TestClient(app)
EX = date(2026, 3, 1)
ACTIONS = "/api/investments/actions"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def me(db: Session, email: str = "me@example.com") -> int:
    return db.scalars(select(User).where(User.email == email)).one().id


def holding(headers: Headers, qty: int = 40, price: str = "1500.00") -> tuple[int, int]:
    account, infy = broker(headers, balance="1000000.00"), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=qty, price=price)
    return account, infy


def create(headers: Headers, stock_id: int, **fields: Any) -> Response:
    """A split 5:1 on EX unless `fields` say otherwise. A merger or demerger gets no default
    ratio: its ratio must be given, as the exchange's feed never gives one."""
    body: dict[str, Any] = {"kind": "split", "ex_date": EX.isoformat()}
    if fields.get("kind") not in ("merger", "demerger"):
        body |= {"ratio_new": "5", "ratio_old": "1"}
    return client.post(
        f"/api/investments/stocks/{stock_id}/actions", json={**body, **fields}, headers=headers
    )


def created(headers: Headers, stock_id: int, **fields: Any) -> dict[str, Any]:
    response = create(headers, stock_id, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def patch(headers: Headers, id_: int, **fields: Any) -> Response:
    return client.patch(f"{ACTIONS}/{id_}", json=fields, headers=headers)


def patched(headers: Headers, id_: int, **fields: Any) -> dict[str, Any]:
    response = patch(headers, id_, **fields)
    assert response.status_code == 200, response.json()
    return response.json()


def messages(response: Response) -> list[str]:
    return [e["msg"] for e in response.json()["detail"]]


def portfolio_body(headers: Headers) -> dict[str, Any]:
    response = client.get("/api/investments/portfolio", headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def dividend(db: Session, stock_id: int, amount: str = "25", ex: date = EX, **fields) -> int:
    row = StockAction(
        user_id=fields.pop("user_id", None) or me(db),
        instrument_id=stock_id,
        kind="dividend",
        ex_date=ex,
        amount_per_share=Decimal(amount),
        status=fields.pop("status", "applied"),
        **fields,
    )
    db.add(row)
    db.commit()
    return row.id


def income(headers: Headers, account: int, amount: str, day: date, category="Dividends") -> int:
    body = {"type": "income", "account_id": account, "amount": amount,
            "date": day.isoformat(), "category": category}  # fmt: skip
    response = client.post("/api/transactions", json=body, headers=headers)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


# Creating and previewing


def test_manual_split_is_pending_with_a_preview(headers: Headers, db_session: Session) -> None:
    _, infy = holding(headers)
    body = created(headers, infy)
    assert body == {
        "id": body["id"],
        "stock_id": infy,
        "symbol": "INFY",
        "kind": "split",
        "ex_date": "2026-03-01",
        "ratio_new": "5",
        "ratio_old": "1",
        "amount_per_share": None,
        "status": "pending",
        "purpose": None,
        "target_stock_id": None,
        "cost_share_pct": None,
        "preview": {
            "shares_before": 40,
            "shares_after": 200,
            "average_before": "1500.00",
            "average_after": "300.00",
        },
        "dividend": None,
    }
    row = db_session.get(StockAction, body["id"])
    assert row is not None and row.corporate_action_id is None
    # Pending changes nothing yet.
    assert portfolio_body(headers)["holdings"][0]["shares"] == 40


def test_create_checks_fields(headers: Headers) -> None:
    _, infy = holding(headers)
    response = create(headers, infy, kind=None, ex_date=None)
    assert response.status_code == 422
    assert {tuple(e["loc"]) for e in response.json()["detail"]} >= {
        ("body", "kind"),
        ("body", "ex_date"),
    }
    response = create(headers, infy, ratio_new="0")
    assert response.status_code == 422
    response = create(headers, infy, kind="dividend", ratio_new=None, ratio_old=None)
    assert response.status_code == 422
    assert [e["loc"] for e in response.json()["detail"]] == [["body", "amount_per_share"]]
    response = create(headers, infy, kind="demerger", cost_share_pct="100")
    assert response.status_code == 422
    response = create(headers, infy, kind="merger", target_stock_id=infy)
    assert response.status_code == 422
    assert create(headers, infy, surprise=1).status_code == 422


def test_merger_without_target_has_no_preview(headers: Headers) -> None:
    _, infy = holding(headers)
    assert created(headers, infy, kind="merger", ratio_new="1", ratio_old="1")["preview"] is None


def test_merger_or_demerger_entered_by_hand_needs_a_ratio(headers: Headers) -> None:
    _, infy = holding(headers)
    target = stock(headers, "TARGET")
    for kind in ("merger", "demerger"):
        response = create(headers, infy, kind=kind, target_stock_id=target)
        assert response.status_code == 422
        assert [e["loc"] for e in response.json()["detail"]] == [
            ["body", "ratio_new"],
            ["body", "ratio_old"],
        ]


def fetched_merger(db: Session, stock_id: int) -> int:
    """A merger as the nightly feed stores it: no ratio and no target."""
    feed = CorporateAction(
        symbol="INFY", kind="merger", ex_date=EX, purpose="Scheme Of Merger",
        purpose_key="scheme of merger", source="nse",
    )  # fmt: skip
    db.add(feed)
    db.flush()
    row = StockAction(
        user_id=me(db), instrument_id=stock_id, corporate_action_id=feed.id, kind="merger",
        ex_date=EX, status="pending",
    )  # fmt: skip
    db.add(row)
    db.commit()
    return row.id


def test_fetched_merger_is_applied_with_its_ratio_and_target(
    headers: Headers, db_session: Session
) -> None:
    _, infy = holding(headers)
    target = stock(headers, "TARGET")
    id_ = fetched_merger(db_session, infy)
    response = patch(headers, id_, status="applied", target_stock_id=target)
    assert response.status_code == 422
    assert [e["loc"] for e in response.json()["detail"]] == [
        ["body", "ratio_new"],
        ["body", "ratio_old"],
    ]
    body = patched(
        headers, id_, status="applied", target_stock_id=target, ratio_new="1", ratio_old="2"
    )
    assert (body["status"], body["ratio_new"], body["ratio_old"]) == ("applied", "1", "2")
    by_stock = {s["symbol"]: s["shares"] for s in portfolio_body(headers)["by_stock"]}
    assert by_stock == {"TARGET": 20}


def test_demerger_preview_moves_cost(headers: Headers) -> None:
    _, infy = holding(headers)
    child = stock(headers, "CHILD")
    body = created(
        headers, infy, kind="demerger", ratio_new="1", ratio_old="2",
        target_stock_id=child, cost_share_pct="25",
    )  # fmt: skip
    assert body["preview"] == {
        "shares_before": 40,
        "shares_after": 40,
        "average_before": "1500.00",
        "average_after": "1125.00",
    }


# Listing


def test_inbox_lists_pending_with_count(headers: Headers, db_session: Session) -> None:
    _, infy = holding(headers)
    first = created(headers, infy)
    second = created(headers, infy, kind="bonus", ratio_new="1", ratio_old="1")
    patched(headers, second["id"], status="dismissed")
    body = client.get(ACTIONS, params={"status": "pending"}, headers=headers).json()
    assert [a["id"] for a in body["actions"]] == [first["id"]]
    assert body["pending_count"] == 1
    dismissed = client.get(ACTIONS, params={"status": "dismissed"}, headers=headers).json()
    assert [a["id"] for a in dismissed["actions"]] == [second["id"]]
    assert dismissed["pending_count"] == 1
    assert client.get(ACTIONS, params={"status": "nope"}, headers=headers).status_code == 422


def test_fetched_action_shows_its_purpose(headers: Headers, db_session: Session) -> None:
    _, infy = holding(headers)
    feed = CorporateAction(
        symbol="INFY", kind="bonus", ex_date=EX, ratio_new=Decimal(1), ratio_old=Decimal(1),
        purpose="Bonus 1:1", purpose_key="bonus 1 1", source="nse",
    )  # fmt: skip
    db_session.add(feed)
    db_session.flush()
    db_session.add(
        StockAction(
            user_id=me(db_session), instrument_id=infy, corporate_action_id=feed.id,
            kind="bonus", ex_date=EX, ratio_new=Decimal(1), ratio_old=Decimal(1),
            status="pending",
        )
    )  # fmt: skip
    db_session.commit()
    (row,) = client.get(ACTIONS, headers=headers).json()["actions"]
    assert row["purpose"] == "Bonus 1:1"
    assert row["preview"]["shares_after"] == 80


def test_stock_history_upcoming_first(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(corporate_actions, "today_india", lambda: date(2026, 6, 1))
    _, infy = holding(headers)
    old = created(headers, infy, ex_date="2026-02-01")
    older = created(headers, infy, ex_date="2026-01-20")
    soon = created(headers, infy, ex_date="2026-06-10")
    later = created(headers, infy, ex_date="2026-07-10")
    url = f"/api/investments/stocks/{infy}/actions"
    body = client.get(url, headers=headers).json()
    assert [a["id"] for a in body["actions"]] == [
        soon["id"], later["id"], old["id"], older["id"]
    ]  # fmt: skip
    assert body["suspect_drop_on"] is None
    assert body["backfilled"] is True  # not linked to the exchange: nothing to check

    stock_row = db_session.get(Instrument, infy)
    assert stock_row is not None
    stock_row.source_code = "INFY"
    stock_row.suspect_drop_on = date(2026, 5, 20)
    db_session.commit()
    body = client.get(url, headers=headers).json()
    assert body["suspect_drop_on"] == "2026-05-20"
    assert body["backfilled"] is False
    stock_row.actions_backfilled_at = datetime.now(UTC)
    db_session.commit()
    assert client.get(url, headers=headers).json()["backfilled"] is True

    cleared = client.delete(f"/api/investments/stocks/{infy}/suspect-drop", headers=headers)
    assert cleared.status_code == 200
    assert cleared.json()["suspect_drop_on"] is None
    db_session.refresh(stock_row)
    assert stock_row.suspect_drop_on is None


# Confirming, dismissing, undoing


def test_apply_split_changes_holdings_and_undo_restores(headers: Headers) -> None:
    _, infy = holding(headers)
    action = created(headers, infy)
    body = patched(headers, action["id"], status="applied")
    assert body["status"] == "applied"
    assert body["preview"]["shares_before"] == 40
    assert body["preview"]["shares_after"] == 200
    row = portfolio_body(headers)["holdings"][0]
    assert (row["shares"], row["average_cost"]) == (200, "300.00")
    assert patched(headers, action["id"], status="pending")["status"] == "pending"
    assert portfolio_body(headers)["holdings"][0]["shares"] == 40


def test_undo_refused_when_a_later_sell_would_be_short(headers: Headers) -> None:
    account, infy = holding(headers)
    action = created(headers, infy)
    patched(headers, action["id"], status="applied")
    made(headers, stock_id=infy, account_id=account, side="sell", date="2026-04-01",
         quantity=100, price="320.00")  # fmt: skip
    response = patch(headers, action["id"], status="pending")
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "This would leave the sale of INFY on 1 Apr 2026 selling more than was held."
    )
    assert portfolio_body(headers)["holdings"][0]["shares"] == 100


def test_apply_consolidation_refused_when_a_later_sell_would_be_short(headers: Headers) -> None:
    account, infy = holding(headers)
    made(headers, stock_id=infy, account_id=account, side="sell", date="2026-04-01",
         quantity=30, price="1500.00")  # fmt: skip
    action = created(headers, infy, kind="consolidation", ratio_new="1", ratio_old="2")
    response = patch(headers, action["id"], status="applied")
    assert response.status_code == 409
    assert "INFY on 1 Apr 2026" in response.json()["detail"]


def test_status_transitions(headers: Headers) -> None:
    _, infy = holding(headers)
    action = created(headers, infy)
    patched(headers, action["id"], status="dismissed")
    assert patch(headers, action["id"], status="applied").status_code == 409
    patched(headers, action["id"], status="pending")
    patched(headers, action["id"], status="applied")
    assert patch(headers, action["id"], status="dismissed").status_code == 409
    assert patch(headers, action["id"], status="maybe").status_code == 422


def test_owner_dismiss_and_restore_clear_auto_dismissed(
    headers: Headers, db_session: Session
) -> None:
    _, infy = holding(headers)
    action = created(headers, infy)
    row = db_session.get(StockAction, action["id"])
    assert row is not None and row.auto_dismissed is False
    row.status, row.auto_dismissed = "dismissed", True  # as the nightly matcher leaves it
    db_session.commit()
    patched(headers, action["id"], status="pending")
    db_session.refresh(row)
    assert (row.status, row.auto_dismissed) == ("pending", False)
    patched(headers, action["id"], status="dismissed")
    db_session.refresh(row)
    assert (row.status, row.auto_dismissed) == ("dismissed", False)


def test_fields_edit_only_while_pending(headers: Headers) -> None:
    _, infy = holding(headers)
    action = created(headers, infy)
    body = patched(headers, action["id"], ratio_new="2")
    assert body["ratio_new"] == "2"
    assert body["preview"]["shares_after"] == 80
    # Edit and confirm together.
    body = patched(headers, action["id"], ratio_new="10", status="applied")
    assert (body["ratio_new"], body["status"]) == ("10", "applied")
    assert portfolio_body(headers)["holdings"][0]["shares"] == 400
    response = patch(headers, action["id"], ratio_new="5")
    assert response.status_code == 409


def test_applying_merger_needs_a_target(headers: Headers) -> None:
    _, infy = holding(headers)
    target = stock(headers, "TARGET")
    action = created(headers, infy, kind="merger", ratio_new="1", ratio_old="2")
    response = patch(headers, action["id"], status="applied")
    assert response.status_code == 422
    assert [e["loc"] for e in response.json()["detail"]] == [["body", "target_stock_id"]]
    response = patch(headers, action["id"], status="applied", target_stock_id=infy)
    assert response.status_code == 422
    body = patched(headers, action["id"], status="applied", target_stock_id=target)
    assert body["preview"] == {
        "shares_before": 40, "shares_after": 0,
        "average_before": "1500.00", "average_after": "0.00",
    }  # fmt: skip
    by_stock = {s["symbol"]: s["shares"] for s in portfolio_body(headers)["by_stock"]}
    assert by_stock == {"TARGET": 20}


def test_applying_demerger_needs_a_cost_share(headers: Headers) -> None:
    _, infy = holding(headers)
    child = stock(headers, "CHILD")
    action = created(headers, infy, kind="demerger", ratio_new="1", ratio_old="1",
                     target_stock_id=child)  # fmt: skip
    response = patch(headers, action["id"], status="applied")
    assert response.status_code == 422
    assert [e["loc"] for e in response.json()["detail"]] == [["body", "cost_share_pct"]]
    assert patch(headers, action["id"], status="applied", cost_share_pct="0").status_code == 422
    patched(headers, action["id"], status="applied", cost_share_pct="40")


def test_target_must_be_your_own_stock(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, infy = holding(headers)
    stranger = auth(db_session, monkeypatch, "them@example.com")
    theirs = stock(stranger, "THEIRS")
    response = create(headers, infy, kind="merger", target_stock_id=theirs)
    assert response.status_code == 422


def test_other_users_actions_are_not_found(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, infy = holding(headers)
    action = created(headers, infy)
    stranger = auth(db_session, monkeypatch, "them@example.com")
    assert patch(stranger, action["id"], status="applied").status_code == 404
    assert client.get(f"{ACTIONS}/{action['id']}/link-suggestions",
                      headers=stranger).status_code == 404  # fmt: skip
    assert client.post(f"{ACTIONS}/{action['id']}/links/1", headers=stranger).status_code == 404
    assert client.get(f"/api/investments/stocks/{infy}/actions",
                      headers=stranger).status_code == 404  # fmt: skip
    assert create(stranger, infy).status_code == 404
    assert client.delete(f"/api/investments/stocks/{infy}/suspect-drop",
                         headers=stranger).status_code == 404  # fmt: skip
    assert client.get(ACTIONS, headers=stranger).json() == {"actions": [], "pending_count": 0}
    assert patch(headers, 2**40, status="applied").status_code == 404


# Dividends


def test_applied_dividend_shows_gross_per_account(headers: Headers, db_session: Session) -> None:
    account, infy = holding(headers)
    id_ = dividend(db_session, infy)
    (row,) = client.get(f"/api/investments/stocks/{infy}/actions", headers=headers).json()[
        "actions"
    ]
    assert row["id"] == id_
    assert row["amount_per_share"] == "25"
    assert row["preview"] is None
    assert row["dividend"] == {
        "gross": "1000.00",
        "by_account": [
            {"account_id": account, "account_name": "Zerodha", "gross": "1000.00", "links": []}
        ],
    }


def test_dividend_not_held_on_record_date_is_zero(headers: Headers, db_session: Session) -> None:
    account, infy = holding(headers)
    made(headers, stock_id=infy, account_id=account, side="sell", date="2026-02-01",
         quantity=40, price="1500.00")  # fmt: skip
    dividend(db_session, infy)
    (row,) = client.get(ACTIONS, params={"status": "applied"}, headers=headers).json()["actions"]
    assert row["dividend"] == {"gross": "0.00", "by_account": []}
    assert portfolio_body(headers)["totals"]["dividends"] == "0.00"
    paid = income(headers, bank(headers), "900.00", EX + timedelta(days=3))
    linked = client.post(f"{ACTIONS}/{row['id']}/links/{paid}", headers=headers)
    assert linked.status_code == 409


def test_link_suggestions_and_links(headers: Headers, db_session: Session) -> None:
    _, infy = holding(headers)
    id_ = dividend(db_session, infy)
    sbi = bank(headers)
    good = income(headers, sbi, "900.00", EX + timedelta(days=10))
    income(headers, sbi, "800.00", EX + timedelta(days=10))
    income(headers, sbi, "900.00", EX + timedelta(days=50))
    income(headers, sbi, "950.00", EX + timedelta(days=5), category="Salary")
    url = f"{ACTIONS}/{id_}/link-suggestions"
    body = client.get(url, headers=headers).json()
    (acct,) = body["accounts"]
    assert acct["gross"] == "1000.00"
    assert [s["id"] for s in acct["suggestions"]] == [good]
    assert acct["suggestions"][0] == {
        "id": good,
        "date": (EX + timedelta(days=10)).isoformat(),
        "amount": "900.00",
        "account_id": sbi,
        "account_name": "SBI",
        "note": None,
    }

    before = client.get("/api/dashboard", headers=headers).json()["net_worth"]
    linked = client.post(f"{ACTIONS}/{id_}/links/{good}", headers=headers)
    assert linked.status_code == 200, linked.json()
    assert linked.json()["dividend"]["by_account"][0]["links"] == [good]
    # Linking twice is harmless.
    again = client.post(f"{ACTIONS}/{id_}/links/{good}", headers=headers)
    assert again.json()["dividend"]["by_account"][0]["links"] == [good]
    # Informational only: no money moves.
    assert client.get("/api/dashboard", headers=headers).json()["net_worth"] == before
    # A linked payment isn't suggested again.
    assert client.get(url, headers=headers).json()["accounts"][0]["suggestions"] == []

    unlinked = client.delete(f"{ACTIONS}/{id_}/links/{good}", headers=headers)
    assert unlinked.status_code == 200
    assert unlinked.json()["dividend"]["by_account"][0]["links"] == []
    assert client.delete(f"{ACTIONS}/{id_}/links/{good}", headers=headers).status_code == 404


def test_a_dividend_leaving_applied_loses_its_links(headers: Headers, db_session: Session) -> None:
    _, infy = holding(headers)
    id_ = dividend(db_session, infy)
    paid = income(headers, bank(headers), "900.00", EX + timedelta(days=3))
    url = f"{ACTIONS}/{id_}/link-suggestions"
    for leave in ("pending", "dismissed"):
        assert client.post(f"{ACTIONS}/{id_}/links/{paid}", headers=headers).status_code == 200
        assert client.get(url, headers=headers).json()["accounts"][0]["suggestions"] == []
        body = patched(headers, id_, status=leave)
        assert body["dividend"]["by_account"][0]["links"] == []
        assert db_session.scalars(select(DividendLink)).all() == []
        # The credit is free again, for this dividend or another.
        suggested = client.get(url, headers=headers).json()["accounts"][0]["suggestions"]
        assert [c["id"] for c in suggested] == [paid]
        if leave == "dismissed":
            patched(headers, id_, status="pending")
        patched(headers, id_, status="applied")


def test_only_a_dividend_can_be_dismissed_once_applied(
    headers: Headers, db_session: Session
) -> None:
    _, infy = holding(headers)
    id_ = dividend(db_session, infy)
    assert patched(headers, id_, status="dismissed")["status"] == "dismissed"
    split = created(headers, infy)
    patched(headers, split["id"], status="applied")
    assert patch(headers, split["id"], status="dismissed").status_code == 409


def test_link_needs_your_own_credit_and_a_confirmed_dividend(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, infy = holding(headers)
    id_ = dividend(db_session, infy)
    sbi = bank(headers)
    body = {"type": "expense", "account_id": sbi, "amount": "10.00", "date": "2026-03-05",
            "category": "Groceries"}  # fmt: skip
    spent = client.post("/api/transactions", json=body, headers=headers).json()["id"]
    assert client.post(f"{ACTIONS}/{id_}/links/{spent}", headers=headers).status_code == 409
    stranger = auth(db_session, monkeypatch, "them@example.com")
    theirs = income(stranger, bank(stranger), "900.00", EX + timedelta(days=3))
    assert client.post(f"{ACTIONS}/{id_}/links/{theirs}", headers=headers).status_code == 404
    split = created(headers, infy)
    mine = income(headers, sbi, "900.00", EX + timedelta(days=3))
    assert client.post(f"{ACTIONS}/{split['id']}/links/{mine}", headers=headers).status_code == 409
    pending = dividend(db_session, infy, status="pending", ex=date(2026, 3, 2))
    assert client.post(f"{ACTIONS}/{pending}/links/{mine}", headers=headers).status_code == 409


def test_deleting_a_linked_payment_drops_the_link(headers: Headers, db_session: Session) -> None:
    _, infy = holding(headers)
    id_ = dividend(db_session, infy)
    paid = income(headers, bank(headers), "900.00", EX + timedelta(days=3))
    client.post(f"{ACTIONS}/{id_}/links/{paid}", headers=headers)
    assert client.delete(f"/api/transactions/{paid}", headers=headers).status_code == 200
    row = client.get(ACTIONS, params={"status": "applied"}, headers=headers).json()["actions"][0]
    assert row["dividend"]["by_account"][0]["links"] == []


# Portfolio totals


def test_portfolio_dividends_and_total_return(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(portfolio, "today_india", lambda: date(2026, 5, 1))
    account, infy = holding(headers, price="100.00")  # 40 shares
    before = client.get("/api/dashboard", headers=headers).json()["net_worth"]
    dividend(db_session, infy, amount="2.5", ex=date(2026, 3, 1))  # last FY: 100.00
    dividend(db_session, infy, amount="1", ex=date(2026, 4, 1))  # this FY: 40.00
    dividend(db_session, infy, amount="9", ex=date(2026, 4, 2), status="pending")
    made(headers, stock_id=infy, account_id=account, side="sell", date="2026-04-10",
         quantity=10, price="110.00")  # fmt: skip
    body = portfolio_body(headers)
    assert body["holdings"][0]["dividends"] == "140.00"
    assert body["by_stock"][0]["dividends"] == "140.00"
    totals = body["totals"]
    assert totals["dividends"] == "140.00"
    assert totals["dividends_fy"] == "40.00"
    assert totals["realised"] == "100.00"
    assert totals["total_return"] == "240.00"  # unrealised 0 (at cost)
    assert body["overall"]["dividends"] == "140.00"
    assert body["overall"]["total_return"] == "240.00"
    assert body["funds"]["totals"]["dividends"] == "0.00"
    # No money was recorded for the dividends.
    after = client.get("/api/dashboard", headers=headers).json()["net_worth"]
    assert Decimal(after) == Decimal(before) + 100  # just the sale's profit


def test_upcoming_dividend_counts_once_its_ex_date_comes(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, infy = holding(headers, price="100.00")  # 40 shares
    dividend(db_session, infy, amount="5", ex=date(2026, 6, 10))  # 200.00
    monkeypatch.setattr(portfolio, "today_india", lambda: date(2026, 6, 9))
    body = portfolio_body(headers)
    assert body["holdings"][0]["dividends"] == "0.00"
    assert body["by_stock"][0]["dividends"] == "0.00"
    totals = body["totals"]
    assert (totals["dividends"], totals["dividends_fy"], totals["total_return"]) == (
        "0.00", "0.00", "0.00",
    )  # fmt: skip
    assert body["overall"]["dividends"] == "0.00"
    # The action itself still shows what it will pay.
    (row,) = client.get(ACTIONS, params={"status": "applied"}, headers=headers).json()["actions"]
    assert row["dividend"]["gross"] == "200.00"

    monkeypatch.setattr(portfolio, "today_india", lambda: date(2026, 6, 10))
    totals = portfolio_body(headers)["totals"]
    assert (totals["dividends"], totals["dividends_fy"], totals["total_return"]) == (
        "200.00", "200.00", "200.00",
    )  # fmt: skip


# Deleting a stock


@pytest.fixture
def foreign_keys(db_session: Session) -> None:
    """SQLite checks foreign keys only when asked, so an orphan left behind fails the test."""
    if ON_POSTGRES:
        return
    db_session.commit()
    db_session.execute(text("PRAGMA foreign_keys=ON"))
    db_session.commit()
    assert db_session.execute(text("PRAGMA foreign_keys")).scalar() == 1


def delete_stock(headers: Headers, stock_id: int) -> Response:
    return client.delete(f"/api/investments/stocks/{stock_id}", headers=headers)


def test_deleting_a_stock_removes_its_actions_and_links(
    headers: Headers, db_session: Session, foreign_keys: None
) -> None:
    infy = stock(headers)
    split = created(headers, infy)
    paid = dividend(db_session, infy)
    tx = income(headers, bank(headers), "900.00", EX + timedelta(days=3))
    db_session.add(DividendLink(user_id=me(db_session), stock_action_id=paid, transaction_id=tx))
    db_session.commit()
    response = delete_stock(headers, infy)
    assert response.status_code == 200, response.json()
    assert db_session.get(StockAction, split["id"]) is None
    assert db_session.get(StockAction, paid) is None
    assert db_session.scalars(select(DividendLink)).all() == []


def test_target_of_an_applied_merger_cant_be_deleted(
    headers: Headers, db_session: Session, foreign_keys: None
) -> None:
    _, infy = holding(headers)
    target = stock(headers, "TARGET")
    action = created(headers, infy, kind="merger", ratio_new="1", ratio_old="1",
                     target_stock_id=target)  # fmt: skip
    patched(headers, action["id"], status="applied")
    response = delete_stock(headers, target)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "TARGET is the target of an applied merger of INFY. Undo it first."
    )
    assert db_session.get(Instrument, target) is not None


def test_target_of_a_pending_merger_is_let_go(
    headers: Headers, db_session: Session, foreign_keys: None
) -> None:
    _, infy = holding(headers)
    target = stock(headers, "TARGET")
    action = created(headers, infy, kind="demerger", ratio_new="1", ratio_old="1",
                     target_stock_id=target, cost_share_pct="30")  # fmt: skip
    assert delete_stock(headers, target).status_code == 200
    row = db_session.get(StockAction, action["id"])
    assert row is not None
    db_session.refresh(row)
    assert (row.target_instrument_id, row.cost_share_pct) == (None, Decimal("30"))
