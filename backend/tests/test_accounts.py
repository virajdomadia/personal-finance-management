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


def patch(headers: Headers, id_: int, **body: Any) -> Response:
    return client.patch(f"{URL}/{id_}", json=body, headers=headers)


def archive(headers: Headers, id_: int) -> Response:
    return client.post(f"{URL}/{id_}/archive", headers=headers)


def restore(headers: Headers, id_: int) -> Response:
    return client.post(f"{URL}/{id_}/restore", headers=headers)


def get_one(headers: Headers, id_: int) -> dict:
    accounts = client.get(URL, headers=headers).json()["accounts"]
    return next(a for a in accounts if a["id"] == id_)


def test_patch_updates_only_sent_fields(headers: Headers) -> None:
    created = make(
        headers, type="bank", bank_kind="savings", institution="HDFC", last4="1234"
    ).json()

    response = patch(headers, created["id"], name="Renamed", balance="10.50")

    assert response.status_code == 200
    assert response.json() == {**created, "name": "Renamed", "balance": "10.50"}


def test_patch_null_clears_optional_field(headers: Headers) -> None:
    created = make(headers, type="bank", bank_kind="savings", last4="1234").json()

    response = patch(headers, created["id"], last4=None)

    assert response.status_code == 200
    assert response.json()["last4"] is None
    assert get_one(headers, created["id"])["last4"] is None


def test_patch_empty_body_is_a_no_op(headers: Headers) -> None:
    created = make(headers, balance="5.00").json()

    response = patch(headers, created["id"])

    assert response.status_code == 200
    assert response.json() == created


def test_patch_cannot_change_type(headers: Headers) -> None:
    created = make(headers).json()

    response = patch(headers, created["id"], type="cash")

    assert response.status_code == 422
    assert ["body", "type"] in locs(response)


@pytest.mark.parametrize("body", [{"name": None}, {"balance": None}, {"bank_kind": None}])
def test_patch_cannot_clear_required_field(headers: Headers, body: dict) -> None:
    created = make(headers, type="bank", bank_kind="savings").json()

    response = patch(headers, created["id"], **body)

    assert response.status_code == 422
    assert ["body", next(iter(body))] in locs(response)


def test_patch_validates_merged_result(headers: Headers) -> None:
    cash = make(headers).json()
    bank = make(headers, type="bank", bank_kind="savings").json()

    negative = patch(headers, cash["id"], balance="-1.00")
    wrong_field = patch(headers, bank["id"], due_day=5)

    assert negative.status_code == 422
    assert ["body", "balance"] in locs(negative)
    assert wrong_field.status_code == 422
    assert ["body", "due_day"] in locs(wrong_field)


def test_failed_patch_changes_nothing(headers: Headers) -> None:
    created = make(headers, balance="7.00").json()

    assert patch(headers, created["id"], name="New", balance="-1.00").status_code == 422

    assert get_one(headers, created["id"]) == created


def test_patch_archived_is_409(headers: Headers) -> None:
    created = make(headers).json()
    archive(headers, created["id"])

    response = patch(headers, created["id"], name="New")

    assert response.status_code == 409
    assert response.json() == {"detail": "Restore this account before editing it."}


def test_archive_leaves_list_and_totals(headers: Headers) -> None:
    kept = make(headers, name="Kept", balance="10.00").json()
    gone = make(headers, name="Gone", balance="5.00").json()

    response = archive(headers, gone["id"])

    assert response.status_code == 200
    assert response.json()["archived"] is True
    body = client.get(URL, headers=headers).json()
    assert [a["id"] for a in body["accounts"]] == [kept["id"]]
    assert body["total_have"] == "10.00"


def test_archived_list_shows_only_archived_with_active_totals(headers: Headers) -> None:
    make(headers, name="Kept", balance="10.00")
    gone = make(headers, name="Gone", balance="5.00").json()
    archive(headers, gone["id"])

    body = client.get(URL, params={"archived": "true"}, headers=headers).json()

    assert [a["id"] for a in body["accounts"]] == [gone["id"]]
    assert body["accounts"][0]["archived"] is True
    assert body["total_have"] == "10.00"
    assert body["total_owe"] == "0.00"


def test_restore_returns_account_to_list_and_totals(headers: Headers) -> None:
    created = make(headers, balance="5.00").json()
    archive(headers, created["id"])

    response = restore(headers, created["id"])

    assert response.status_code == 200
    assert response.json()["archived"] is False
    body = client.get(URL, headers=headers).json()
    assert [a["id"] for a in body["accounts"]] == [created["id"]]
    assert body["total_have"] == "5.00"
    assert patch(headers, created["id"], name="Edited").status_code == 200


def test_archive_and_restore_can_repeat(headers: Headers) -> None:
    created = make(headers).json()

    assert [archive(headers, created["id"]).status_code for _ in range(2)] == [200, 200]
    assert [restore(headers, created["id"]).status_code for _ in range(2)] == [200, 200]


@pytest.mark.parametrize(
    "request_",
    [
        lambda h, i: patch(h, i, name="Hacked"),
        archive,
        restore,
    ],
    ids=["patch", "archive", "restore"],
)
def test_other_users_account_is_404_and_unchanged(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers, request_: Any
) -> None:
    other = auth(db_session, monkeypatch, "other@example.com")
    theirs = make(other, name="Theirs").json()

    assert request_(headers, theirs["id"]).status_code == 404

    assert get_one(other, theirs["id"]) == theirs


@pytest.mark.parametrize(
    "request_",
    [
        lambda h, i: patch(h, i, name="X"),
        archive,
        restore,
    ],
    ids=["patch", "archive", "restore"],
)
def test_missing_account_is_404(headers: Headers, request_: Any) -> None:
    assert request_(headers, 99999).status_code == 404


def test_edit_routes_require_session(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    auth(db_session, monkeypatch)

    assert client.patch(f"{URL}/1", json={}).status_code == 401
    assert client.post(f"{URL}/1/archive").status_code == 401
    assert client.post(f"{URL}/1/restore").status_code == 401


def message(response: Response, field: str) -> str:
    return next(e["msg"] for e in response.json()["detail"] if e["loc"] == ["body", field])


def test_422_shape_is_unchanged(headers: Headers) -> None:
    error = make(headers, last4="12").json()["detail"][0]

    assert set(error) >= {"loc", "msg", "type"}
    assert error["loc"] == ["body", "last4"]


@pytest.mark.parametrize("value", ["123", "12345", "12a4", "١٢٣٤", 1234])
def test_last4_message(headers: Headers, value: Any) -> None:
    response = make(headers, type="bank", bank_kind="savings", last4=value)

    assert response.status_code == 422
    assert message(response, "last4") == "Enter exactly 4 digits."


@pytest.mark.parametrize("value", ["abc", "", "NaN", "Infinity", 12.5, True])
def test_invalid_amount_message(headers: Headers, value: Any) -> None:
    response = make(headers, balance=value)

    assert response.status_code == 422
    assert message(response, "balance") == "Enter an amount, like 1234.50."


@pytest.mark.parametrize("value", ["1e5", "1_000", "١٢٣", "1,000", "1.", ".5", "1 2", "0x10"])
def test_loose_money_text_is_rejected(headers: Headers, value: str) -> None:
    response = make(headers, balance=value)

    assert response.status_code == 422
    assert message(response, "balance") == "Enter an amount, like 1234.50."


@pytest.mark.parametrize("value", ["+5", "-5", "5", "5.5", " 5.00 ", "007.10"])
def test_plain_ascii_money_is_accepted(headers: Headers, value: str) -> None:
    status = 422 if value == "-5" else 201  # cash can't be negative
    assert make(headers, balance=value).status_code == status


def test_too_many_decimals_message(headers: Headers) -> None:
    response = make(headers, balance="1.234")

    assert message(response, "balance") == "Use at most 2 decimal places."


def test_trailing_zero_decimals_are_fine(headers: Headers) -> None:
    assert make(headers, balance="1.500").json()["balance"] == "1.50"


@pytest.mark.parametrize("value", ["1000000000000.00", "-1000000000000", "99999999999999999"])
def test_too_large_message(headers: Headers, value: str) -> None:
    response = make(headers, type="broker", balance=value)

    assert message(response, "balance") == "Amount must be under ₹1,00,00,00,00,00,000."


def test_credit_limit_uses_same_messages(headers: Headers) -> None:
    response = make(headers, type="credit_card", credit_limit="1.234")

    assert message(response, "credit_limit") == "Use at most 2 decimal places."


@pytest.mark.parametrize("name", ["x" * 61])
def test_name_too_long_message(headers: Headers, name: str) -> None:
    assert message(make(headers, name=name), "name") == "Use 60 characters or fewer."


def test_institution_too_long_message(headers: Headers) -> None:
    response = make(headers, type="broker", institution="x" * 61)

    assert message(response, "institution") == "Use 60 characters or fewer."


@pytest.mark.parametrize("day", [0, 32, "5", 5.5, True])
def test_day_message(headers: Headers, day: Any) -> None:
    response = make(headers, type="credit_card", statement_day=day)

    assert response.status_code == 422
    assert message(response, "statement_day") == "Enter a day from 1 to 31."


def test_blank_name_is_422_with_plain_message(headers: Headers) -> None:
    for name in ("", "   ", None):
        response = make(headers, name=name)
        assert response.status_code == 422
        assert message(response, "name") == "Enter a name."


def test_missing_fields_are_all_reported_together(headers: Headers) -> None:
    response = client.post(URL, json={"type": "bank", "name": "  "}, headers=headers)

    assert response.status_code == 422
    assert message(response, "name") == "Enter a name."
    assert message(response, "balance") == "Enter a balance."
    assert message(response, "bank_kind") == "Choose a kind of account."


def test_missing_or_bad_type_message(headers: Headers) -> None:
    missing = client.post(URL, json={"name": "A", "balance": "1"}, headers=headers)
    bad = make(headers, type="loan")

    assert message(missing, "type") == "Choose a kind of account."
    assert message(bad, "type") == "Choose a kind of account."


def test_bad_bank_kind_message(headers: Headers) -> None:
    response = make(headers, type="bank", bank_kind="gold")

    assert message(response, "bank_kind") == "Choose a kind of account."


def test_patch_clearing_required_fields_uses_plain_messages(headers: Headers) -> None:
    created = make(headers, type="bank", bank_kind="savings").json()

    response = patch(headers, created["id"], name="  ", balance=None)

    assert message(response, "name") == "Enter a name."
    assert message(response, "balance") == "Enter a balance."


def test_no_422_message_is_technical(headers: Headers) -> None:
    bodies = [
        {"type": "credit_card", "name": "x" * 61, "balance": "1e5", "last4": "x", "due_day": 99},
        {"type": "cash", "name": None, "balance": None, "institution": "a"},
        {"type": "bank", "name": "n", "balance": "-1", "bank_kind": "q", "credit_limit": "0"},
    ]
    for body in bodies:
        response = client.post(URL, json=body, headers=headers)
        assert response.status_code == 422
        for error in response.json()["detail"]:
            msg = error["msg"]
            assert not msg.startswith(("Value error", "String should", "Input should"))
            assert "Field required" not in msg


@pytest.mark.parametrize("field", ["name", "institution"])
def test_nul_byte_is_422(headers: Headers, field: str) -> None:
    response = make(headers, type="broker", **{field: "a\x00b"})

    assert response.status_code == 422
    assert ["body", field] in locs(response)


def test_nul_byte_in_patch_is_422(headers: Headers) -> None:
    created = make(headers, type="broker").json()

    assert patch(headers, created["id"], name="a\x00b").status_code == 422
    assert patch(headers, created["id"], institution="a\x00b").status_code == 422


@pytest.mark.parametrize("id_", [0, -1, 2147483648, 99999999999999999999])
@pytest.mark.parametrize(
    "request_",
    [lambda h, i: patch(h, i, name="X"), archive, restore],
    ids=["patch", "archive", "restore"],
)
def test_out_of_range_id_is_404(headers: Headers, request_: Any, id_: int) -> None:
    assert request_(headers, id_).status_code == 404
