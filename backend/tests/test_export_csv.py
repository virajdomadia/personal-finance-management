import csv
import io
import zipfile
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import app
from app.models.user import User
from tests import export_fixture
from tests.test_accounts import Headers, auth

client = TestClient(app)

FILES = {
    "accounts.csv",
    "transactions.csv",
    "stock_trades.csv",
    "fund_trades.csv",
    "crypto_trades.csv",
    "sips.csv",
    "loans.csv",
    "deposits.csv",
    "goals.csv",
    "insurance_policies.csv",
    "recurring_templates.csv",
    "budgets.csv",
    "categories.csv",
    "net_worth_history.csv",
}


@pytest.fixture
def me(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    headers = auth(db_session, monkeypatch, "me@example.com")
    user = db_session.scalars(select(User).where(User.email == "me@example.com")).one()
    export_fixture.build(db_session, headers, user.id, date.today())
    other = auth(db_session, monkeypatch, "other@example.com")
    client.post(
        "/api/accounts",
        json={"type": "bank", "name": "Other bank", "bank_kind": "savings", "balance": "1.00"},
        headers=other,
    )
    return headers


def _zip(headers: Headers) -> dict[str, bytes]:
    response = client.get("/api/export/csv", headers=headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert 'filename="pfm-export-' in response.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def _rows(data: bytes) -> list[dict[str, str]]:
    assert data.startswith(b"\xef\xbb\xbf")  # a BOM, so Excel reads UTF-8
    return list(csv.DictReader(io.StringIO(data.decode("utf-8-sig"))))


def test_one_csv_per_entity_with_readable_figures(me: Headers) -> None:
    files = _zip(me)
    assert set(files) == FILES
    accounts = {r["Name"]: r for r in _rows(files["accounts.csv"])}
    assert "Other bank" not in accounts
    assert accounts["HDFC"]["Type"] == "Bank"
    assert accounts["Regalia"]["Credit limit"] == "200000.00"
    balances = {
        a["name"]: a["balance"] for a in client.get("/api/accounts", headers=me).json()["accounts"]
    }
    assert all(accounts[name]["Balance"] == balance for name, balance in balances.items())

    tx = _rows(files["transactions.csv"])
    emi = next(r for r in tx if r["Type"] == "emi" and r["To account"] == "Car loan")
    assert (emi["Account"], emi["Amount"], emi["Interest"]) == ("HDFC", "12000.00", "3100.00")
    assert any(r["Amount"] == "6200.40" and r["Category"] == "Groceries" for r in tx)

    funds = _rows(files["fund_trades.csv"])
    assert funds[0]["Units"] == "60.123" and funds[0]["NAV"] == "83.16"
    assert _rows(files["crypto_trades.csv"])[0]["Quantity"] == "0.0005"
    assert {r["Symbol"] for r in _rows(files["stock_trades.csv"])} == {"INFY", "TCS"}
    loans = {r["Name"]: r for r in _rows(files["loans.csv"])}
    assert loans["Car loan"]["EMI paid from"] == "HDFC"
    assert {r["Type"] for r in _rows(files["deposits.csv"])} == {"PPF", "RD"}
    categories = {(r["Kind"], r["Name"]): r for r in _rows(files["categories.csv"])}
    assert categories[("expense", "Groceries")]["Parent"] == "Food and dining"
    assert categories[("expense", "Fuel")]["Merged into"] == "Petrol"
    budgets = _rows(files["budgets.csv"])
    assert {(b["Category"], b["Monthly budget"]) for b in budgets} >= {("Groceries", "6000.00")}
    assert _rows(files["insurance_policies.csv"])[0]["Premium paid from"] == "Regalia"
    goals = {g["Name"]: g for g in _rows(files["goals.csv"])}
    assert goals["Goa trip"]["Target"] == "60000.00"
    templates = {t["Name"]: t for t in _rows(files["recurring_templates.csv"])}
    assert templates["RD instalment"]["To account"] == "SBI RD"
    assert _rows(files["sips.csv"])[0]["Fund"] == "Parag Parikh Flexi Cap"
    history = _rows(files["net_worth_history.csv"])
    assert [(h["Net worth"], h["Estimated"]) for h in history] == [
        ("480000.00", "Yes"),
        ("612345.67", "No"),
    ]
    for data in files.values():
        assert "₹" not in data.decode("utf-8-sig")


def test_exports_need_a_signed_in_user(db_session: Session) -> None:
    for url in ("/api/export/csv", "/api/export/backup"):
        assert client.get(url).status_code == 401


def test_a_new_user_gets_headers_only(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    files = _zip(auth(db_session, monkeypatch))
    assert _rows(files["transactions.csv"]) == []
    assert files["transactions.csv"].decode("utf-8-sig").startswith("Date,Type,Amount,Account")
