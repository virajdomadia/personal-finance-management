"""Excel: the workbook export, the import template, and importing transactions."""

import io
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from openpyxl import Workbook, load_workbook
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.export.importing import COLUMNS
from app.main import app
from tests.test_accounts import Headers, auth

client = TestClient(app)
TODAY = today_india()
YESTERDAY = TODAY - timedelta(days=1)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def account(headers: Headers, name: str, type_: str = "bank", balance: str = "1000.00") -> int:
    body: dict[str, Any] = {"type": type_, "name": name, "balance": balance}
    if type_ == "bank":
        body["bank_kind"] = "savings"
    response = client.post("/api/accounts", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def workbook(*rows: list[Any], header: list[str] = COLUMNS, title: str = "Sheet") -> bytes:
    book = Workbook()
    ws = book.active
    assert ws is not None
    ws.title = title
    ws.append(header)
    for row in rows:
        ws.append(row)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def send(headers: Headers, data: bytes, preview: bool = False) -> Response:
    path = "/api/import/transactions" + ("/preview" if preview else "")
    return client.post(path, content=data, headers=headers)


def transactions(headers: Headers) -> list[dict]:
    return client.get("/api/transactions", headers=headers).json()["transactions"]


def balance(headers: Headers, id_: int) -> str:
    found = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a["balance"] for a in found if a["id"] == id_)


# Export


def test_export_is_a_workbook_with_one_sheet_per_table(headers: Headers) -> None:
    response = client.get("/api/export/xlsx", headers=headers)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert f"pfm-export-{TODAY.isoformat()}.xlsx" in response.headers["content-disposition"]
    book = load_workbook(io.BytesIO(response.content))
    assert book.sheetnames[:3] == ["Accounts", "Transactions", "Stock trades"]
    assert "Net worth history" in book.sheetnames


def test_export_cells_are_typed_and_text_is_never_a_formula(headers: Headers) -> None:
    bank = account(headers, "=HYPERLINK(1)")
    client.post(
        "/api/accounts",
        json={"type": "bank", "bank_kind": "savings", "name": "HDFC", "balance": "0.00",
              "last4": "0123"},
        headers=headers,
    )  # fmt: skip
    client.post(
        "/api/transactions",
        json={"type": "expense", "account_id": bank, "amount": "250.50",
              "date": YESTERDAY.isoformat(), "category": "Groceries"},
        headers=headers,
    )  # fmt: skip

    book = load_workbook(io.BytesIO(client.get("/api/export/xlsx", headers=headers).content))

    accounts = list(book["Accounts"].iter_rows(values_only=True))
    names = [r[0] for r in accounts[1:]]
    assert "=HYPERLINK(1)" in names
    last4 = next(r[4] for r in accounts[1:] if r[0] == "HDFC")
    assert last4 == "0123"
    for cell in book["Accounts"]["A"]:
        assert cell.data_type == "s"
    rows = list(book["Transactions"].iter_rows(values_only=True))
    assert rows[0][:3] == ("Date", "Type", "Amount")
    when, kind, amount = rows[1][:3]
    assert isinstance(when, datetime) and when.date() == YESTERDAY
    assert (kind, amount) == ("expense", 250.5)


# Template


def test_template_has_columns_dropdowns_and_help(headers: Headers) -> None:
    account(headers, "SBI")

    response = client.get("/api/import/transactions/template", headers=headers)

    assert response.status_code == 200
    book = load_workbook(io.BytesIO(response.content))
    assert book.sheetnames == ["Transactions", "Lists", "How to fill"]
    ws = book["Transactions"]
    assert [c.value for c in ws[1]] == COLUMNS
    assert ws["D2"].value == "SBI"
    assert book["Lists"].sheet_state == "hidden"
    covered = " ".join(str(v.sqref) for v in ws.data_validations.dataValidation)
    for column in "BDEF":
        assert f"{column}2:{column}2001" in covered


# Import


def test_preview_checks_every_row_and_saves_nothing(headers: Headers) -> None:
    account(headers, "SBI")
    data = workbook(
        [YESTERDAY, "expense", 250, "SBI", None, "Groceries", None, "Milk"],
        [YESTERDAY, "income", "1,500.00", "sbi", None, "A brand new category", None, None],
        [YESTERDAY, "spend", 10, "SBI", None, None, None, None],
        [YESTERDAY, "expense", 10, "Nowhere", None, "Groceries", None, None],
    )

    response = send(headers, data, preview=True)

    assert response.status_code == 200
    body = response.json()
    assert (body["ok"], body["duplicates"], body["problems"], body["imported"]) == (2, 0, 2, 0)
    rows = body["rows"]
    assert [r["row"] for r in rows] == [2, 3, 4, 5]
    assert [r["status"] for r in rows] == ["ok", "ok", "error", "error"]
    assert rows[0]["date"] == YESTERDAY.isoformat()
    assert rows[2]["errors"] == ["Type: use expense, income, transfer or EMI."]
    assert rows[3]["errors"] == ["Account: no account called Nowhere."]
    assert transactions(headers) == []
    names = [c["name"] for c in client.get("/api/categories", headers=headers).json()["income"]]
    assert "A brand new category" not in names


def test_import_saves_every_row_and_a_second_import_adds_nothing(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    card = account(headers, "Regalia", "credit_card", "0.00")
    data = workbook(
        [YESTERDAY, "Expense", 250.5, "SBI", None, "Groceries", None, "Milk"],
        [YESTERDAY.strftime("%d/%m/%Y"), "income", "₹1,000", "SBI", None, "Salary", None, None],
        [YESTERDAY.isoformat(), "transfer", 100, "SBI", "Regalia", None, None, None],
    )

    first = send(headers, data)
    second = send(headers, data)

    assert first.status_code == 200
    assert (first.json()["imported"], first.json()["problems"]) == (3, 0)
    assert (second.json()["imported"], second.json()["duplicates"]) == (0, 3)
    saved = transactions(headers)
    assert len(saved) == 3
    assert {t["amount"] for t in saved} == {"250.50", "1000.00", "100.00"}
    assert balance(headers, sbi) == "1649.50"
    assert balance(headers, card) == "-100.00"


def test_nothing_is_saved_while_any_row_has_a_problem(headers: Headers) -> None:
    account(headers, "SBI")
    data = workbook(
        [YESTERDAY, "expense", 10, "SBI", None, "Groceries", None, None],
        [TODAY + timedelta(days=3), "expense", 10, "SBI", None, "Groceries", None, None],
    )

    body = send(headers, data).json()

    assert (body["imported"], body["problems"]) == (0, 1)
    assert body["rows"][1]["errors"] == ["Date: The date can't be in the future."]
    assert transactions(headers) == []


def test_the_balance_check_runs_row_after_row(headers: Headers) -> None:
    account(headers, "Cash", "cash", "100.00")
    data = workbook(
        [YESTERDAY, "expense", 60, "Cash", None, "Groceries", None, None],
        [YESTERDAY, "expense", 50, "Cash", None, "Groceries", None, None],
    )

    rows = send(headers, data, preview=True).json()["rows"]

    assert rows[0]["status"] == "ok"
    assert rows[1]["errors"] == ["Amount: This would take Cash below ₹0 (-₹10)."]


def test_the_same_rules_as_typing_one_in(headers: Headers) -> None:
    account(headers, "SBI")
    data = workbook(
        [YESTERDAY, "transfer", 10, "SBI", "SBI", None, None, None],
        [YESTERDAY, "expense", 10, "SBI", None, None, None, None],
        [YESTERDAY, "expense", "10.123", "SBI", None, "Groceries", None, None],
    )

    rows = send(headers, data, preview=True).json()["rows"]

    assert rows[0]["errors"] == ["To account: Choose a different account to transfer to."]
    assert rows[1]["errors"] == ["Category: Choose a category."]
    assert rows[2]["errors"] == ["Amount: Use at most 2 decimal places in the amount."]


def test_our_own_export_loads_back_in_as_duplicates(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    client.post(
        "/api/transactions",
        json={"type": "expense", "account_id": sbi, "amount": "99.00",
              "date": YESTERDAY.isoformat(), "category": "Groceries"},
        headers=headers,
    )  # fmt: skip
    exported = client.get("/api/export/xlsx", headers=headers).content

    body = send(headers, exported, preview=True).json()

    assert (body["ok"], body["duplicates"], body["problems"]) == (0, 1, 0)


def test_imported_rows_are_marked_as_imported(headers: Headers, db_session: Session) -> None:
    from app.models.transaction import Transaction

    account(headers, "SBI")
    send(headers, workbook([YESTERDAY, "expense", 10, "SBI", None, "Groceries", None, None]))

    (tx,) = db_session.query(Transaction).all()
    assert tx.source == "import"
    assert tx.amount == Decimal("10.00")
    assert tx.date == YESTERDAY


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"not a spreadsheet", "This isn't an Excel file (.xlsx). Save it as .xlsx and try again."),
        (
            workbook(["x"], header=["Something", "Else"]),
            "Couldn't find the columns Date, Type, Amount and Account. "
            "Start from the template, or keep its header row.",
        ),
        (workbook(), "The sheet has headers but no rows to import."),
    ],
)
def test_a_file_that_cant_be_read_says_why(headers: Headers, data: bytes, message: str) -> None:
    response = send(headers, data, preview=True)

    assert response.status_code == 422
    assert response.json()["detail"] == message


def test_an_empty_body_is_refused(headers: Headers) -> None:
    response = send(headers, b"")

    assert response.status_code == 400


def test_import_needs_sign_in() -> None:
    assert client.post("/api/import/transactions", content=b"x").status_code == 401


def test_dates_must_be_real(headers: Headers) -> None:
    account(headers, "SBI")
    data = workbook(["31/02/2026", "expense", 10, "SBI", None, "Groceries", None, None])

    rows = send(headers, data, preview=True).json()["rows"]

    assert rows[0]["errors"] == ["Date: Enter the date as a date, like 16-11-2026."]


def test_a_sheet_called_transactions_is_read_first(headers: Headers) -> None:
    account(headers, "SBI")
    book = Workbook()
    other = book.active
    assert other is not None
    other.append(COLUMNS)
    other.append([date(2020, 1, 1), "nonsense", 1, "SBI"])
    ws = book.create_sheet("Transactions")
    ws.append(COLUMNS)
    ws.append([YESTERDAY, "expense", 5, "SBI", None, "Groceries"])
    out = io.BytesIO()
    book.save(out)

    body = send(headers, out.getvalue(), preview=True).json()

    assert (body["ok"], body["problems"]) == (1, 0)
