from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import create_token
from app.main import app
from app.models.user import User

client = TestClient(app)

URL = "/api/accounts"
SECRET = "test-secret"
Headers = dict[str, str]


def auth(db: Session, monkeypatch: pytest.MonkeyPatch, email: str = "me@example.com") -> Headers:
    monkeypatch.setattr(get_settings(), "token_secret", SECRET)
    monkeypatch.setattr(get_settings(), "environment", "production")
    user = User(email=email)
    db.add(user)
    db.commit()
    return {"Authorization": f"Bearer {create_token(user.id, 1, SECRET)}"}


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def make(headers: Headers, **fields: Any) -> Response:
    body = {"type": "cash", "name": "Cash", "balance": "0.00", **fields}
    return client.post(URL, json=body, headers=headers)


def locs(response: Response) -> list[list[str]]:
    return [error["loc"] for error in response.json()["detail"]]


@pytest.mark.parametrize(
    "extra",
    [
        {"type": "bank", "bank_kind": "savings", "institution": "HDFC", "last4": "1234"},
        {
            "type": "credit_card",
            "institution": "HDFC",
            "last4": "1234",
            "credit_limit": "100000.00",
            "statement_day": 5,
            "due_day": 25,
        },
        {"type": "cash"},
        {"type": "broker", "institution": "Zerodha"},
        {"type": "wallet", "institution": "Paytm"},
    ],
)
def test_create_each_type_returns_201_with_string_money(headers: Headers, extra: dict) -> None:
    response = make(headers, balance="1234.50", **extra)

    assert response.status_code == 201
    body = response.json()
    assert body["balance"] == "1234.50"
    assert body["type"] == extra["type"]
    assert body["archived"] is False
    assert isinstance(body["id"], int)


def test_response_shape(headers: Headers) -> None:
    response = make(
        headers,
        type="credit_card",
        name="HDFC Regalia",
        balance="2500.00",
        institution="HDFC",
        last4="1234",
        credit_limit="100000.00",
        statement_day=5,
        due_day=25,
    )

    assert response.json() == {
        "id": response.json()["id"],
        "type": "credit_card",
        "name": "HDFC Regalia",
        "balance": "2500.00",
        "institution": "HDFC",
        "bank_kind": None,
        "last4": "1234",
        "credit_limit": "100000.00",
        "available_credit": "97500.00",
        "statement_day": 5,
        "due_day": 25,
        "archived": False,
    }


def test_blank_institution_becomes_null(headers: Headers) -> None:
    assert make(headers, type="broker", institution="   ").json()["institution"] is None


def test_bank_requires_kind(headers: Headers) -> None:
    response = make(headers, type="bank")

    assert response.status_code == 422
    assert ["body", "bank_kind"] in locs(response)


@pytest.mark.parametrize(
    ("type_", "field", "value"),
    [
        ("cash", "institution", "HDFC"),
        ("broker", "last4", "1234"),
        ("wallet", "credit_limit", "10.00"),
        ("bank", "due_day", 5),
    ],
)
def test_field_for_wrong_type_is_rejected(
    headers: Headers, type_: str, field: str, value: Any
) -> None:
    extra = {"bank_kind": "savings"} if type_ == "bank" else {}
    response = make(headers, type=type_, **{field: value}, **extra)

    assert response.status_code == 422
    assert ["body", field] in locs(response)


def test_null_for_wrong_type_is_accepted(headers: Headers) -> None:
    assert make(headers, last4=None).status_code == 201


def test_unknown_field_is_rejected(headers: Headers) -> None:
    response = make(headers, card_number="4111111111111111")

    assert response.status_code == 422
    assert ["body", "card_number"] in locs(response)


@pytest.mark.parametrize(
    ("type_", "value", "status"),
    [
        ("bank", "-1.00", 201),
        ("broker", "-1.00", 201),
        ("credit_card", "-1.00", 201),
        ("cash", "-1.00", 422),
        ("wallet", "-1.00", 422),
    ],
)
def test_balance_sign_rules(headers: Headers, type_: str, value: str, status: int) -> None:
    extra = {"bank_kind": "current"} if type_ == "bank" else {}
    response = make(headers, type=type_, balance=value, **extra)

    assert response.status_code == status
    if status == 422:
        assert ["body", "balance"] in locs(response)


@pytest.mark.parametrize(
    "value", ["NaN", "Infinity", "1.234", "1000000000000.00", "", "abc", 12.5, None]
)
def test_bad_balance_is_422(headers: Headers, value: Any) -> None:
    response = make(headers, balance=value)

    assert response.status_code == 422
    assert ["body", "balance"] in locs(response)


def test_max_balance_round_trips(headers: Headers) -> None:
    assert make(headers, balance="999999999999.99").json()["balance"] == "999999999999.99"
    assert client.get(URL, headers=headers).json()["accounts"][0]["balance"] == "999999999999.99"


def test_negative_zero_is_zero(headers: Headers) -> None:
    assert make(headers, balance="-0.00").json()["balance"] == "0.00"


@pytest.mark.parametrize("name", ["", "   ", "x" * 61])
def test_bad_name_is_422(headers: Headers, name: str) -> None:
    response = make(headers, name=name)

    assert response.status_code == 422
    assert ["body", "name"] in locs(response)


def test_name_is_trimmed(headers: Headers) -> None:
    assert make(headers, name="  Cash  ").json()["name"] == "Cash"


@pytest.mark.parametrize("value", ["123", "12345", "12a4", "١٢٣٤"])
def test_bad_last4_is_422(headers: Headers, value: str) -> None:
    response = make(headers, type="bank", bank_kind="savings", last4=value)

    assert response.status_code == 422
    assert ["body", "last4"] in locs(response)


def test_credit_limit_must_be_positive(headers: Headers) -> None:
    response = make(headers, type="credit_card", credit_limit="0.00")

    assert response.status_code == 422
    assert ["body", "credit_limit"] in locs(response)


@pytest.mark.parametrize("day", [0, 32])
def test_bad_days_are_422(headers: Headers, day: int) -> None:
    for field in ("statement_day", "due_day"):
        response = make(headers, type="credit_card", **{field: day})
        assert response.status_code == 422
        assert ["body", field] in locs(response)


def test_available_credit_can_go_negative(headers: Headers) -> None:
    response = make(headers, type="credit_card", balance="1500.50", credit_limit="1000.00")

    assert response.json()["available_credit"] == "-500.50"


def test_available_credit_is_null_without_limit(headers: Headers) -> None:
    assert make(headers, type="credit_card").json()["available_credit"] is None


def test_totals_are_exact(headers: Headers) -> None:
    make(headers, type="bank", bank_kind="savings", balance="0.10")
    make(headers, balance="0.20")
    make(headers, type="bank", bank_kind="current", balance="-0.05")
    make(headers, type="credit_card", balance="100.10")
    make(headers, type="credit_card", balance="-0.05")

    body = client.get(URL, headers=headers).json()

    assert body["total_have"] == "0.25"
    assert body["total_owe"] == "100.05"


def test_empty_list(headers: Headers) -> None:
    assert client.get(URL, headers=headers).json() == {
        "accounts": [],
        "total_have": "0.00",
        "total_owe": "0.00",
    }


def test_list_order(headers: Headers) -> None:
    make(headers, type="wallet", name="W")
    make(headers, type="cash", name="Cash")
    make(headers, type="bank", bank_kind="savings", name="Banana")
    make(headers, type="broker", name="B")
    make(headers, type="credit_card", name="Card")
    make(headers, type="bank", bank_kind="savings", name="apple")

    accounts = client.get(URL, headers=headers).json()["accounts"]

    assert [(a["type"], a["name"]) for a in accounts] == [
        ("bank", "apple"),
        ("bank", "Banana"),
        ("credit_card", "Card"),
        ("cash", "Cash"),
        ("broker", "B"),
        ("wallet", "W"),
    ]


def test_list_only_shows_own_accounts(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers
) -> None:
    other = auth(db_session, monkeypatch, "other@example.com")
    make(other, name="Theirs", balance="500.00")
    make(headers, name="Mine", balance="1.00")

    body = client.get(URL, headers=headers).json()

    assert [a["name"] for a in body["accounts"]] == ["Mine"]
    assert body["total_have"] == "1.00"


def test_requires_session(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    auth(db_session, monkeypatch)

    assert client.get(URL).status_code == 401
    assert client.post(URL, json={}).status_code == 401
