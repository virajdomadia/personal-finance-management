from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deposits import rd_maturity_value
from app.api.routes import accounts, dashboard, policies, recurring, transactions
from app.main import app
from app.models.insurance import PolicyPeriod
from app.models.transaction import Transaction
from tests.test_accounts import Headers, archive, auth, locs, make
from tests.test_fund_trades import bank

client = TestClient(app)

URL = "/api/insurance"
TX = "/api/transactions"


class Clock:
    today = date(2026, 11, 10)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> type[Clock]:
    Clock.today = date(2026, 11, 10)
    for module in (accounts, dashboard, policies, recurring, transactions):
        monkeypatch.setattr(module, "today_india", lambda: Clock.today)
    return Clock


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch, clock: type[Clock]) -> Headers:
    return auth(db_session, monkeypatch)


@pytest.fixture
def other(db_session: Session, monkeypatch: pytest.MonkeyPatch, clock: type[Clock]) -> Headers:
    return auth(db_session, monkeypatch, email="other@example.com")


def card(headers: Headers, statement_day: int = 15, due_day: int = 5, name: str = "Signet") -> int:
    response = make(
        headers,
        type="credit_card",
        name=name,
        balance="0.00",
        credit_limit="200000.00",
        statement_day=statement_day,
        due_day=due_day,
    )
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def owners_rd(headers: Headers) -> int:
    pay_from = bank(headers, name="Bank of India")
    response = client.post(
        "/api/accounts",
        json={
            "type": "rd",
            "name": "Bank of India RD",
            "balance": "9000.00",
            "interest_rate": "6.50",
            "opened_on": "2026-05-19",
            "deposit_amount": "1500.00",
            "due_day": 19,
            "tenure_months": 12,
            "deposits_paid": 6,
            "pay_from_id": pay_from,
        },
        headers=headers,
    )
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def new(headers: Headers, account_id: int, **fields: Any) -> Response:
    body = {
        "kind": "health",
        "insurer": "Care Health Insurance",
        "plan": "Care Supreme + Care Advanced",
        "policy_number": "A3859370",
        "insured": "Self",
        "sum_insured": "1000000.00",
        "period_start": "2026-04-07",
        "period_end": "2027-04-06",
        "premium": "11936.00",
        "account_id": account_id,
        "paid_on": "2026-04-06",
        **fields,
    }
    return client.post(URL, json=body, headers=headers)


def made(headers: Headers, account_id: int, **fields: Any) -> dict[str, Any]:
    response = new(headers, account_id, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def listed(headers: Headers) -> list[dict[str, Any]]:
    response = client.get(URL, headers=headers)
    assert response.status_code == 200
    return response.json()["policies"]


def renew(headers: Headers, id_: int, account_id: int, **fields: Any) -> Response:
    body = {
        "date": "2027-04-05",
        "amount": "12500.00",
        "account_id": account_id,
        "period_start": "2027-04-07",
        "period_end": "2028-04-06",
        "sum_insured": "1000000.00",
        **fields,
    }
    return client.post(f"{URL}/{id_}/renew", json=body, headers=headers)


def balance(headers: Headers, account_id: int) -> str:
    rows = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a for a in rows if a["id"] == account_id)["balance"]


def messages(response: Response) -> dict[str, str]:
    return {e["loc"][-1]: e["msg"] for e in response.json()["detail"]}


def counts(db: Session) -> tuple[int, int]:
    return (
        db.scalar(select(func.count()).select_from(Transaction)) or 0,
        db.scalar(select(func.count()).select_from(PolicyPeriod)) or 0,
    )


def test_create_the_owners_policy(headers: Headers) -> None:
    paying = card(headers)
    fund = owners_rd(headers)
    body = made(headers, paying, funded_by_id=fund, details="Cumulative bonus 50% a year.")

    assert body["kind"] == "health"
    assert body["insurer"] == "Care Health Insurance"
    assert body["plan"] == "Care Supreme + Care Advanced"
    assert body["policy_number"] == "A3859370"
    assert body["insured"] == "Self"
    assert body["sum_insured"] == "1000000.00"
    assert body["period_start"] == "2026-04-07"
    assert body["period_end"] == "2027-04-06"
    assert body["premium"] == "11936.00"
    assert body["details"] == "Cumulative bonus 50% a year."
    assert body["active"] is True
    assert body["paying_account_id"] == paying
    assert body["paying_account_name"] == "Signet"
    assert body["days_to_renewal"] == (date(2027, 4, 6) - date(2026, 11, 10)).days

    template = body["template"]
    assert template["name"] == "Care Health Insurance premium"
    assert template["type"] == "expense"
    assert template["amount"] == "11936.00"
    assert template["account_id"] == paying
    assert template["category"] == "Insurance"
    assert template["frequency"] == "yearly"
    assert (template["day"], template["month"]) == (6, 4)
    assert template["start_date"] == "2027-04-06"
    assert template["remind_days"] == 30
    assert template["policy_id"] == body["id"]
    assert template["due"] == []
    assert template["coming_up"] is None

    assert body["periods"] == [
        {
            "period_start": "2026-04-07",
            "period_end": "2027-04-06",
            "premium": "11936.00",
            "sum_insured": "1000000.00",
            "paid_on": "2026-04-06",
            "transaction_id": None,
        }
    ]
    assert body["premium_by_fy"] == [{"fy": "2026-27", "amount": "11936.00"}]

    estimate = rd_maturity_value(Decimal("1500"), Decimal("6.5"), 12)
    assert body["funded_by"] == {
        "account_id": fund,
        "name": "Bank of India RD",
        "maturity_date": "2027-05-19",
        "maturity_estimate": f"{estimate:.2f}",
        "covers": True,
        "shortfall": None,
    }
    assert body["card_bill"] == {"due": "2027-05-05", "before_funding": True}
    assert listed(headers) == [body]


def test_card_bill_due_after_the_rd_matures(headers: Headers) -> None:
    body = made(
        headers, card(headers, statement_day=1, due_day=25), funded_by_id=owners_rd(headers)
    )
    assert body["card_bill"] == {"due": "2027-05-25", "before_funding": False}


def test_card_bill_without_funding(headers: Headers) -> None:
    body = made(headers, card(headers))
    assert body["funded_by"] is None
    assert body["card_bill"] == {"due": "2027-05-05", "before_funding": False}


def test_bank_payer_has_no_card_bill(headers: Headers) -> None:
    assert made(headers, bank(headers))["card_bill"] is None


def test_short_rd_reports_the_shortfall(headers: Headers) -> None:
    fund = owners_rd(headers)
    body = made(headers, card(headers), funded_by_id=fund, premium="20000.00")
    estimate = rd_maturity_value(Decimal("1500"), Decimal("6.5"), 12)
    assert body["funded_by"]["covers"] is False
    assert body["funded_by"]["shortfall"] == f"{Decimal('20000.00') - estimate:.2f}"


def test_funded_by_a_bank_has_no_maturity(headers: Headers) -> None:
    savings = bank(headers, name="Savings")
    body = made(headers, card(headers), funded_by_id=savings)
    assert body["funded_by"] == {
        "account_id": savings,
        "name": "Savings",
        "maturity_date": None,
        "maturity_estimate": None,
        "covers": None,
        "shortfall": None,
    }
    assert body["card_bill"]["before_funding"] is False


def test_premium_shows_as_coming_up_a_month_before(headers: Headers, clock: type[Clock]) -> None:
    body = made(headers, card(headers))
    clock.today = date(2027, 3, 7)
    items = client.get("/api/recurring/due", headers=headers).json()["items"]
    assert [(i["template"]["id"], i["occurrence"], i["state"]) for i in items] == [
        (body["template"]["id"], "2027-04-06", "coming_up")
    ]
    clock.today = date(2027, 3, 6)
    assert client.get("/api/recurring/due", headers=headers).json()["items"] == []


def test_renewal(headers: Headers, clock: type[Clock]) -> None:
    paying = card(headers)
    body = made(headers, paying, funded_by_id=owners_rd(headers))
    clock.today = date(2027, 4, 5)
    assert balance(headers, paying) == "0.00"

    response = renew(headers, body["id"], paying)
    assert response.status_code == 200, response.json()
    renewed = response.json()

    assert balance(headers, paying) == "12500.00"
    assert renewed["period_start"] == "2027-04-07"
    assert renewed["period_end"] == "2028-04-06"
    assert renewed["premium"] == "12500.00"
    assert renewed["template"]["amount"] == "12500.00"
    assert renewed["template"]["start_date"] == "2028-04-06"
    assert renewed["template"]["due"] == []
    assert renewed["template"]["coming_up"] is None
    assert renewed["template"]["recorded"] == 1
    assert len(renewed["periods"]) == 2
    latest = renewed["periods"][-1]
    assert latest["period_start"] == "2027-04-07"
    assert latest["paid_on"] == "2027-04-05"
    assert latest["premium"] == "12500.00"
    assert renewed["premium_by_fy"] == [
        {"fy": "2026-27", "amount": "11936.00"},
        {"fy": "2027-28", "amount": "12500.00"},
    ]
    tx = client.get(f"{TX}/{latest['transaction_id']}", headers=headers).json()
    assert tx["type"] == "expense"
    assert tx["category"] == "Insurance"
    assert tx["recurring_template_id"] == body["template"]["id"]
    assert client.get("/api/recurring/due", headers=headers).json()["items"] == []


@pytest.mark.parametrize(
    ("fields", "field", "message"),
    [
        ({"amount": "0.00"}, "amount", "Amount must be greater than 0."),
        (
            {"period_start": "2027-04-06"},
            "period_start",
            "The new period must start after the current one ends.",
        ),
        (
            {"period_end": "2028-04-08"},
            "period_end",
            "The period must end after it starts, within a year.",
        ),
        ({"sum_insured": "0.00"}, "sum_insured", "Sum insured must be greater than 0."),
        ({"date": "2027-04-06"}, "date", "The date can't be in the future."),
    ],
)
def test_renewal_problems_write_nothing(
    headers: Headers,
    clock: type[Clock],
    db_session: Session,
    fields: dict[str, Any],
    field: str,
    message: str,
) -> None:
    paying = card(headers)
    body = made(headers, paying)
    clock.today = date(2027, 4, 5)
    before = counts(db_session)
    response = renew(headers, body["id"], paying, **fields)
    assert response.status_code == 422
    assert messages(response)[field] == message
    assert counts(db_session) == before
    after = listed(headers)[0]
    assert (after["period_end"], after["premium"]) == ("2027-04-06", "11936.00")
    assert after["periods"] == body["periods"]
    assert after["template"]["amount"] == "11936.00"


def test_renewal_from_an_archived_card_writes_nothing(
    headers: Headers, clock: type[Clock], db_session: Session
) -> None:
    paying = card(headers)
    body = made(headers, paying)
    assert archive(headers, paying).status_code == 200
    clock.today = date(2027, 4, 5)
    before = counts(db_session)
    response = renew(headers, body["id"], paying)
    assert response.status_code == 422
    assert messages(response) == {"account_id": "Signet is archived. Restore it to use it."}
    assert counts(db_session) == before
    assert listed(headers)[0]["period_end"] == "2027-04-06"


def test_renewal_below_zero_writes_nothing(
    headers: Headers, clock: type[Clock], db_session: Session
) -> None:
    paying = make(headers, type="cash", name="Wallet", balance="100.00").json()["id"]
    body = made(headers, paying)
    clock.today = date(2027, 4, 5)
    before = counts(db_session)
    response = renew(headers, body["id"], paying)
    assert response.status_code == 422
    assert messages(response) == {"amount": "This would take Wallet below ₹0."}
    assert counts(db_session) == before


def test_renewal_from_another_account_moves_the_template(
    headers: Headers, clock: type[Clock]
) -> None:
    body = made(headers, card(headers))
    other_card = card(headers, name="Regalia")
    clock.today = date(2027, 4, 5)
    renewed = renew(headers, body["id"], other_card).json()
    assert renewed["paying_account_id"] == other_card
    assert renewed["template"]["account_id"] == other_card


def test_a_policys_template_cannot_be_recorded_as_a_plain_transaction(
    headers: Headers, clock: type[Clock]
) -> None:
    paying = card(headers)
    body = made(headers, paying)
    clock.today = date(2027, 4, 5)
    response = client.post(
        TX,
        json={
            "type": "expense",
            "account_id": paying,
            "amount": "12500.00",
            "date": "2027-04-05",
            "category": "Insurance",
            "recurring_template_id": body["template"]["id"],
        },
        headers=headers,
    )
    assert response.status_code == 422
    assert messages(response) == {"recurring_template_id": "Renew the policy instead."}


def test_a_renewal_payment_cannot_be_deleted_alone(headers: Headers, clock: type[Clock]) -> None:
    paying = card(headers)
    body = made(headers, paying)
    clock.today = date(2027, 4, 5)
    tx_id = renew(headers, body["id"], paying).json()["periods"][-1]["transaction_id"]
    response = client.delete(f"{TX}/{tx_id}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "This payment renewed an insurance policy, so it stays."


def test_create_links_an_existing_payment(headers: Headers) -> None:
    paying = card(headers)
    tx = client.post(
        TX,
        json={
            "type": "expense",
            "account_id": paying,
            "amount": "11936.00",
            "date": "2026-04-06",
            "category": "Insurance",
        },
        headers=headers,
    ).json()
    body = made(headers, paying, transaction_id=tx["id"])
    assert body["periods"][0]["transaction_id"] == tx["id"]
    again = new(headers, paying, transaction_id=tx["id"])
    assert again.status_code == 422
    assert messages(again) == {"transaction_id": "That payment already belongs to a policy."}


@pytest.mark.parametrize(
    ("fields", "field", "message"),
    [
        ({"kind": "life"}, "kind", "Choose health."),
        ({"insurer": None}, "insurer", "Enter the insurer."),
        ({"plan": None}, "plan", "Enter the plan."),
        ({"policy_number": None}, "policy_number", "Enter the policy number."),
        ({"insured": None}, "insured", "Enter who is insured."),
        ({"sum_insured": None}, "sum_insured", "Enter the sum insured."),
        ({"sum_insured": "0.00"}, "sum_insured", "Sum insured must be greater than 0."),
        ({"premium": None}, "premium", "Enter the premium."),
        ({"premium": "-1.00"}, "premium", "Premium must be greater than 0."),
        ({"period_start": None}, "period_start", "Choose the date the period starts."),
        ({"period_end": None}, "period_end", "Choose the date the period ends."),
        (
            {"period_end": "2026-04-07"},
            "period_end",
            "The period must end after it starts, within a year.",
        ),
        (
            {"period_end": "2027-04-08"},
            "period_end",
            "The period must end after it starts, within a year.",
        ),
        ({"paid_on": None}, "paid_on", "Choose the date it was paid."),
        ({"paid_on": "2026-11-11"}, "paid_on", "The date can't be in the future."),
        ({"account_id": None}, "account_id", "Choose an account."),
        ({"funded_by_id": 999999}, "funded_by_id", "Choose an account."),
        ({"transaction_id": 999999}, "transaction_id", "Choose a payment."),
    ],
)
def test_create_validation(
    headers: Headers, db_session: Session, fields: dict[str, Any], field: str, message: str
) -> None:
    response = new(headers, **{"account_id": card(headers), **fields})
    assert response.status_code == 422
    assert messages(response)[field] == message
    assert listed(headers) == []
    assert client.get("/api/recurring", headers=headers).json()["templates"] == []


def test_paying_account_obeys_the_transaction_rules(headers: Headers) -> None:
    response = new(headers, owners_rd(headers))
    assert response.status_code == 422
    assert messages(response) == {
        "account_id": "An RD only takes deposits, interest and withdrawals to a bank."
    }


def test_another_users_accounts_are_refused(headers: Headers, other: Headers) -> None:
    theirs = card(other)
    response = new(headers, card(headers), funded_by_id=theirs)
    assert messages(response) == {"funded_by_id": "Choose an account."}
    response = new(headers, theirs)
    assert messages(response) == {"account_id": "Choose an account."}


def test_edit_keeps_the_template_in_step(headers: Headers) -> None:
    body = made(headers, card(headers))
    other_card = card(headers, name="Regalia")
    reminder = client.patch(
        f"/api/recurring/{body['template']['id']}", json={"remind_days": 45}, headers=headers
    )
    assert reminder.status_code == 200, reminder.json()
    response = client.patch(
        f"{URL}/{body['id']}",
        json={
            "premium": "12000.00",
            "account_id": other_card,
            "period_start": "2026-05-01",
            "period_end": "2027-04-30",
            "details": "Nominee: mother.",
        },
        headers=headers,
    )
    assert response.status_code == 200, response.json()
    edited = response.json()
    assert edited["premium"] == "12000.00"
    assert edited["details"] == "Nominee: mother."
    assert edited["paying_account_id"] == other_card
    template = edited["template"]
    assert template["amount"] == "12000.00"
    assert template["account_id"] == other_card
    assert (template["day"], template["month"]) == (30, 4)
    assert template["start_date"] == "2027-04-30"
    assert template["remind_days"] == 45  # the reminder's own setting stays


def test_edit_validation(headers: Headers) -> None:
    body = made(headers, card(headers))
    response = client.patch(
        f"{URL}/{body['id']}", json={"period_end": "2028-01-01"}, headers=headers
    )
    assert messages(response) == {
        "period_end": "The period must end after it starts, within a year."
    }
    response = client.patch(f"{URL}/{body['id']}", json={"premium": "0.00"}, headers=headers)
    assert messages(response) == {"premium": "Premium must be greater than 0."}
    cleared = client.patch(f"{URL}/{body['id']}", json={"funded_by_id": None}, headers=headers)
    assert cleared.status_code == 200
    assert listed(headers)[0]["template"]["amount"] == "11936.00"


def test_lapse_stops_the_reminder(headers: Headers, clock: type[Clock]) -> None:
    body = made(headers, card(headers))
    response = client.post(f"{URL}/{body['id']}/lapse", headers=headers)
    assert response.status_code == 200
    assert response.json()["active"] is False
    assert response.json()["template"]["active"] is False
    clock.today = date(2027, 4, 1)
    assert client.get("/api/recurring/due", headers=headers).json()["items"] == []
    refused = renew(headers, body["id"], body["paying_account_id"], date="2027-04-01")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "This policy has lapsed."


def test_active_policies_come_first_then_by_renewal(headers: Headers) -> None:
    paying = card(headers)
    late = made(headers, paying, period_start="2026-06-01", period_end="2027-05-31")["id"]
    early = made(headers, paying)["id"]
    lapsed = made(headers, paying, period_start="2026-01-01", period_end="2026-12-31")["id"]
    client.post(f"{URL}/{lapsed}/lapse", headers=headers)
    assert [p["id"] for p in listed(headers)] == [early, late, lapsed]


def test_delete_without_recorded_premiums(headers: Headers) -> None:
    body = made(headers, card(headers))
    response = client.delete(f"{URL}/{body['id']}", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"id": body["id"]}
    assert listed(headers) == []
    assert client.get("/api/recurring", headers=headers).json()["templates"] == []


def test_delete_with_recorded_premiums_is_refused(headers: Headers, clock: type[Clock]) -> None:
    paying = card(headers)
    body = made(headers, paying)
    clock.today = date(2027, 4, 5)
    renew(headers, body["id"], paying)
    response = client.delete(f"{URL}/{body['id']}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "This policy has recorded premiums. Lapse it instead."


def test_another_users_policy_is_not_found(headers: Headers, other: Headers) -> None:
    body = made(headers, card(headers))
    theirs = card(other)
    for response in (
        client.patch(f"{URL}/{body['id']}", json={"details": "x"}, headers=other),
        renew(other, body["id"], theirs),
        client.post(f"{URL}/{body['id']}/lapse", headers=other),
        client.delete(f"{URL}/{body['id']}", headers=other),
        client.delete(f"{URL}/99999999999", headers=headers),
    ):
        assert response.status_code == 404
        assert response.json()["detail"] == "Policy not found."
    assert listed(other) == []
    assert listed(headers)[0]["details"] is None


def test_needs_login(headers: Headers) -> None:
    assert client.get(URL).status_code == 401


def test_locs_helper_is_shared(headers: Headers) -> None:
    assert locs(new(headers, card(headers), kind=None)) == [["body", "kind"]]
