"""Importing holdings you already have (stocks, mutual funds, crypto) from Excel."""

import io
from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from openpyxl import Workbook, load_workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.export.holdings_import import COLUMNS
from app.main import app
from app.models.investment import Instrument, InvestmentTrade
from app.models.market import MarketCode
from tests.test_accounts import Headers, auth, make

client = TestClient(app)
TODAY = today_india()
YESTERDAY = TODAY - timedelta(days=1)
DAY = TODAY - timedelta(days=30)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def account(headers: Headers, name: str, type_: str = "broker", balance: str = "1000.00") -> int:
    extra = {"bank_kind": "savings"} if type_ == "bank" else {}
    response = make(headers, type=type_, name=name, balance=balance, **extra)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def balance(headers: Headers, id_: int) -> str:
    found = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a["balance"] for a in found if a["id"] == id_)


def workbook(*rows: list[Any], header: list[str] = COLUMNS, title: str = "Holdings") -> bytes:
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
    path = "/api/import/holdings" + ("/preview" if preview else "")
    return client.post(path, content=data, headers=headers)


def counts(db: Session) -> tuple[int, int]:
    instruments = db.scalar(select(func.count()).select_from(Instrument)) or 0
    trades = db.scalar(select(func.count()).select_from(InvestmentTrade)) or 0
    return instruments, trades


def row(
    type_: str = "stock",
    name: str | None = "Infosys",
    symbol: str | None = "INFY",
    account_: str | None = "Zerodha",
    quantity: Any = 10,
    average: Any = "1500.00",
    invested: Any = None,
    day: Any = DAY,
    code: str | None = None,
) -> list[Any]:
    return [type_, name, symbol, account_, quantity, average, invested, day, code]


# Template


def test_template_has_columns_dropdowns_and_help(headers: Headers) -> None:
    account(headers, "Zerodha")
    account(headers, "SBI", "bank")
    account(headers, "Wallet", "cash")

    response = client.get("/api/import/holdings/template", headers=headers)

    assert response.status_code == 200
    assert "pfm-holdings-template.xlsx" in response.headers["content-disposition"]
    book = load_workbook(io.BytesIO(response.content))
    assert book.sheetnames == ["Holdings", "Lists", "How to fill"]
    ws = book["Holdings"]
    assert [c.value for c in ws[1]] == COLUMNS
    assert [ws["A2"].value, ws["C2"].value, ws["D2"].value] == ["stock", "INFY", "Zerodha"]
    lists = book["Lists"]
    assert lists.sheet_state == "hidden"
    assert [r[1] for r in lists.iter_rows(min_row=2, values_only=True) if r[1]] == [
        "SBI",
        "Zerodha",
    ]
    covered = " ".join(str(v.sqref) for v in ws.data_validations.dataValidation)
    for column in "AD":
        assert f"{column}2:{column}2001" in covered


# Importing each kind


def test_each_kind_becomes_a_holding_with_an_opening_buy_and_no_cash_moves(
    headers: Headers, db_session: Session
) -> None:
    zerodha = account(headers, "Zerodha")
    sbi = account(headers, "SBI", "bank")
    data = workbook(
        row(),
        row("Mutual Fund", "Parag Parikh Flexi Cap", None, "sbi", 35.552, None, "3000.00"),
        row("coin", "Bitcoin", "btc", "Zerodha", "0.00014067", 7504827.5, None, None),
    )

    response = send(headers, data)

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["ok"], body["duplicates"], body["problems"], body["imported"]) == (3, 0, 0, 3)
    rows = body["rows"]
    assert [r["invested"] for r in rows] == ["15000.00", "3000.00", "1055.70"]
    assert rows[2]["date"] == TODAY.isoformat()
    assert balance(headers, zerodha) == "1000.00"
    assert balance(headers, sbi) == "1000.00"

    stocks = client.get("/api/investments/trades", headers=headers).json()["trades"]
    assert [(t["symbol"], t["quantity"], t["price"], t["opening"]) for t in stocks] == [
        ("INFY", 10, "1500.00", True)
    ]
    funds = client.get("/api/investments/fund-trades", headers=headers).json()["trades"]
    assert [(f["units"], f["amount"], f["nav"], f["opening"]) for f in funds] == [
        ("35.552", "3000.00", "84.3834", True)
    ]
    fund = client.get("/api/investments/funds", headers=headers).json()["funds"][0]
    assert (fund["name"], fund["symbol"]) == ("Parag Parikh Flexi Cap", "PPFC")
    coins = client.get("/api/investments/crypto-trades", headers=headers).json()["trades"]
    assert [(c["symbol"], c["amount"], c["opening"]) for c in coins] == [("BTC", "1055.70", True)]
    assert coins[0]["date"] == TODAY.isoformat()


def test_existing_holdings_are_matched_and_a_new_one_is_made_once(
    headers: Headers, db_session: Session
) -> None:
    account(headers, "Zerodha")
    account(headers, "Groww")
    account(headers, "SBI", "bank")
    client.post("/api/investments/stocks", json={"symbol": "TCS", "name": "TCS"}, headers=headers)
    client.post(
        "/api/investments/funds",
        json={"name": "Axis Bluechip", "symbol": "AXBC"},
        headers=headers,
    )
    data = workbook(
        row(name="Tata Consultancy", symbol="tcs"),
        row(),
        row(account_="Groww", quantity=5),
        row("fund", "AXIS BLUECHIP", None, "SBI", 10, None, 500),
        row("mf", "Anything", "axbc", "SBI", 20, None, 1000),
    )

    body = send(headers, data).json()

    assert (body["imported"], body["problems"]) == (5, 0), body
    stocks = client.get("/api/investments/stocks", headers=headers).json()["stocks"]
    assert sorted((s["symbol"], s["name"]) for s in stocks) == [
        ("INFY", "Infosys"),
        ("TCS", "TCS"),
    ]
    funds = client.get("/api/investments/funds", headers=headers).json()["funds"]
    assert [f["symbol"] for f in funds] == ["AXBC"]
    assert counts(db_session) == (3, 5)


def test_average_price_or_invested(headers: Headers) -> None:
    account(headers, "Zerodha")
    account(headers, "SBI", "bank")
    data = workbook(
        row(quantity=3, average=None, invested="1000.00"),
        row(symbol="TCS", quantity=3, average="333.335", invested=None),
        row(symbol="HDFC", quantity=3, average="100", invested="300.90"),
        row(symbol="WIPRO", quantity=3, average="100", invested="310"),
        row(symbol="ITC", average=None, invested=None),
        row("fund", "Some Fund", None, "SBI", "10.5", "100.123", None),
    )

    rows = send(headers, data, preview=True).json()["rows"]

    assert [r["status"] for r in rows] == ["ok", "ok", "ok", "error", "error", "ok"]
    assert rows[0]["invested"] == "999.99"  # 3 × 333.33
    assert rows[1]["invested"] == "1000.02"  # 3 × 333.34
    assert rows[2]["invested"] == "300.00"
    assert rows[3]["errors"] == [
        "Invested: ₹310 doesn't match quantity × average price (₹300). "
        "Give one of them, or check both."
    ]
    assert rows[4]["errors"] == ["Average price: give the average price or the amount invested."]
    assert rows[5]["invested"] == "1051.29"


def test_the_account_must_be_the_right_kind(headers: Headers) -> None:
    account(headers, "Zerodha")
    account(headers, "SBI", "bank")
    data = workbook(
        row(account_="SBI"),
        row("fund", "Some Fund", None, "Zerodha", 10, None, 100),
        row("crypto", "Bitcoin", "BTC", "SBI", "0.1", None, 100),
        row(account_="Nowhere"),
        row(account_=None),
    )

    rows = send(headers, data, preview=True).json()["rows"]

    assert rows[0]["errors"] == [
        "Account: SBI isn't a broker account. Stocks are held in a broker account."
    ]
    assert rows[1]["errors"] == [
        "Account: Zerodha isn't a bank account. Mutual funds are held in a bank account."
    ]
    assert rows[2]["errors"] == [
        "Account: SBI isn't a broker or exchange account. "
        "Coins are held in a broker or exchange account."
    ]
    assert rows[3]["errors"] == ["Account: no account called Nowhere."]
    assert rows[4]["errors"] == ["Account: Choose a broker account."]


def test_archived_accounts_are_refused(headers: Headers) -> None:
    old = account(headers, "Old broker", balance="0.00")
    assert client.post(f"/api/accounts/{old}/archive", headers=headers).status_code == 200

    rows = send(headers, workbook(row(account_="Old broker")), preview=True).json()["rows"]

    assert rows[0]["errors"] == ["Account: Old broker is archived. Restore it to use it."]


def test_the_same_field_rules_as_the_forms(headers: Headers) -> None:
    account(headers, "Zerodha")
    account(headers, "SBI", "bank")
    data = workbook(
        row(symbol="IN FY"),
        row(quantity=2.5),
        row("fund", "Some Fund", None, "SBI", "1.2345", None, 100),
        row("crypto", "Bitcoin", "BTC", "Zerodha", "0.123456789", None, 100),
        row(day=TODAY + timedelta(days=2)),
        row("stock", None, None, "Zerodha", 1, 10, None),
        row("bond", "Some bond", "X", "Zerodha", 1, 10, None),
        row(quantity="lots"),
        row(average="12.3.4"),
        row(invested="10.123", average=None),
    )

    rows = send(headers, data, preview=True).json()["rows"]

    assert rows[0]["errors"] == ["Symbol: Use 1 to 20 letters, digits, &, - or ."]
    assert rows[1]["errors"] == [
        "Quantity: Enter a whole number of shares, from 1 to 10,00,00,000."
    ]
    assert rows[2]["errors"] == [
        "Quantity: Enter units above 0, with up to 3 decimals, like 35.552."
    ]
    assert rows[3]["errors"] == [
        "Quantity: Enter a quantity above 0, with up to 8 decimals, like 0.00014067."
    ]
    assert rows[4]["errors"] == ["Date: The date can't be in the future."]
    assert rows[5]["errors"] == [
        "Symbol: Use 1 to 20 letters, digits, &, - or .",
        "Name: Enter a name.",
    ]
    assert rows[6]["errors"] == ["Type: use stock, mutual fund or crypto."]
    assert rows[7]["errors"] == [
        "Quantity: Enter a whole number of shares, from 1 to 10,00,00,000."
    ]
    assert rows[8]["errors"] == [
        "Average price: Enter the average price as a number, like 1234.50."
    ]
    assert rows[9]["errors"] == ["Invested: Use at most 2 decimal places in the amount invested."]


def test_a_market_code_links_a_new_holding_and_a_bad_one_is_refused(
    headers: Headers, db_session: Session
) -> None:
    account(headers, "Zerodha")
    db_session.add(MarketCode(kind="stock", code="INFY", name="Infosys"))
    db_session.commit()

    bad = send(headers, workbook(row(code="NOPE")), preview=True).json()["rows"]
    good = send(headers, workbook(row(code="INFY"))).json()

    assert bad[0]["errors"] == ["Market code: Pick a match from the search."]
    assert good["imported"] == 1
    stock = client.get("/api/investments/stocks", headers=headers).json()["stocks"][0]
    assert stock["source_code"] == "INFY"


# Duplicates, all or nothing, and preview


def test_a_second_import_adds_nothing(headers: Headers, db_session: Session) -> None:
    account(headers, "Zerodha")
    account(headers, "SBI", "bank")
    data = workbook(
        row(),
        row("fund", "Some Fund", None, "SBI", "10.5", None, "1051.29"),
        row("crypto", "Bitcoin", "BTC", "Zerodha", "0.5", "100", None),
    )

    first = send(headers, data).json()
    second = send(headers, data).json()

    assert first["imported"] == 3
    assert (second["imported"], second["duplicates"], second["ok"]) == (0, 3, 0)
    assert counts(db_session) == (3, 3)
    # A different quantity is a new holding entry, not a duplicate.
    third = send(headers, workbook(row(quantity=11))).json()
    assert (third["imported"], third["duplicates"]) == (1, 0)


def test_nothing_is_saved_while_any_row_has_a_problem(
    headers: Headers, db_session: Session
) -> None:
    account(headers, "Zerodha")
    data = workbook(row(), row(symbol="TCS", day=TODAY + timedelta(days=1)))

    body = send(headers, data).json()

    assert (body["imported"], body["ok"], body["problems"]) == (0, 1, 1)
    assert counts(db_session) == (0, 0)


def test_preview_saves_nothing(headers: Headers, db_session: Session) -> None:
    account(headers, "Zerodha")

    body = send(headers, workbook(row(), row(symbol="TCS")), preview=True).json()

    assert (body["ok"], body["imported"]) == (2, 0)
    assert counts(db_session) == (0, 0)


def test_imported_trades_are_opening_buys(headers: Headers, db_session: Session) -> None:
    account(headers, "Zerodha")
    send(headers, workbook(row(quantity=4, average=None, invested="1000", day=YESTERDAY)))

    (trade,) = db_session.scalars(select(InvestmentTrade)).all()
    assert (trade.side, trade.opening, trade.date) == ("buy", True, YESTERDAY)
    assert (trade.quantity, trade.price, trade.amount) == (4, Decimal("250.00"), Decimal("1000.00"))


# The file


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"not a spreadsheet", "This isn't an Excel file (.xlsx). Save it as .xlsx and try again."),
        (
            workbook(["x"], header=["Type", "Name", "Something"]),
            "Couldn't find the columns Type, Name, Account and Quantity. "
            "Start from the template, or keep its header row.",
        ),
        (workbook(), "The sheet has headers but no rows to import."),
    ],
)
def test_a_file_that_cant_be_read_says_why(headers: Headers, data: bytes, message: str) -> None:
    response = send(headers, data, preview=True)

    assert response.status_code == 422
    assert response.json()["detail"] == message


def test_a_sheet_called_holdings_is_read_first_and_blank_rows_skipped(headers: Headers) -> None:
    account(headers, "Zerodha")
    book = Workbook()
    other = book.active
    assert other is not None
    other.append(COLUMNS)
    other.append(row("nonsense"))
    ws = book.create_sheet("Holdings")
    ws.append(["Account", "Type", "Quantity", "Name", "Symbol", "Average price"])
    ws.append([None] * 6)
    ws.append(["Zerodha", "share", 2, "Infosys", "INFY", 100])
    out = io.BytesIO()
    book.save(out)

    rows = send(headers, out.getvalue(), preview=True).json()["rows"]

    assert [(r["row"], r["status"]) for r in rows] == [(3, "ok")]


def test_an_empty_body_is_refused(headers: Headers) -> None:
    assert send(headers, b"").status_code == 400


def test_import_needs_sign_in() -> None:
    assert client.post("/api/import/holdings", content=b"x").status_code == 401
    assert client.get("/api/import/holdings/template").status_code == 401
