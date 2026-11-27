"""Bank and card statements from any bank: reading the files, suggestions, and saving."""

import io
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from fpdf import FPDF
from httpx import Response
from openpyxl import Workbook
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.export.importing import FileProblem
from app.export.statement_files import read_grid
from app.export.statements import narration_payee, parse_amount, parse_date, read_statement
from app.main import app
from tests.test_accounts import Headers, auth

client = TestClient(app)
D = Decimal
DAY = today_india() - timedelta(days=5)
NEXT = DAY + timedelta(days=1)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


# Cells


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("01/11/2026", date(2026, 11, 1)),
        ("01-11-26", date(2026, 11, 1)),
        ("1 Nov 2026", date(2026, 11, 1)),
        ("01-Nov-2026", date(2026, 11, 1)),
        ("01Nov26", date(2026, 11, 1)),
        ("Nov 01, 2026", date(2026, 11, 1)),
        ("2026-11-01", date(2026, 11, 1)),
        ("2026-11-01 00:00:00", date(2026, 11, 1)),
        ("31/02/2026", None),
        ("Opening Balance", None),
        ("", None),
    ],
)
def test_dates_are_read_day_first(text: str, expected: date | None) -> None:
    assert parse_date(text) == expected


@pytest.mark.parametrize(
    ("cell", "expected"),
    [
        ("1,234.50", (D("1234.50"), None)),
        ("₹ 1,234.50", (D("1234.50"), None)),
        ("1234.50 Dr", (D("1234.50"), "out")),
        ("1234.50 CR", (D("1234.50"), "in")),
        ("-250", (D("250"), "out")),
        ("(250.00)", (D("250.00"), "out")),
        (250.5, (D("250.5"), None)),
        (-99.0, (D("99.0"), "out")),
        ("", None),
        ("-", None),
        ("0.00", None),
    ],
)
def test_amounts_in_every_shape(cell: Any, expected: Any) -> None:
    assert parse_amount(cell) == expected


def test_a_cell_that_isnt_a_number_is_refused() -> None:
    with pytest.raises(ValueError):
        parse_amount("lots")


@pytest.mark.parametrize(
    ("narration", "payee"),
    [
        ("UPI/DR/412345678901/SWIGGY/YESB/swiggy@yesbank/Payment", "SWIGGY"),
        ("UPI-ZOMATO LTD-ZOMATO@ICICI-ICIC0DC0099-412345678901-PAYMENT", "ZOMATO"),
        ("NEFT-HDFCN52026110112345-ACME CORP PVT LTD-SALARY NOV", "ACME CORP"),
        ("POS 512345XXXXXX1234 AMAZON PAY INDIA", "AMAZON"),
        ("ATW-512345XXXXXX1234-S1ACMU06-MUMBAI", "MUMBAI"),
        ("IMPS/P2A/412345678901/RAVI KUMAR/HDFC", "RAVI KUMAR"),
        ("UPI/412345678901/9876543210@ybl", "9876543210@ybl"),
    ],
)
def test_the_payee_comes_out_of_the_narration(narration: str, payee: str) -> None:
    assert narration_payee(narration) == payee


# Files


def xlsx(rows: list[list[Any]]) -> bytes:
    book = Workbook()
    ws = book.active
    assert ws is not None
    for row in rows:
        ws.append(row)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def hdfc_style() -> bytes:
    """Account details first, two-digit years, withdrawal and deposit columns."""
    d1, d2 = DAY.strftime("%d/%m/%y"), NEXT.strftime("%d/%m/%y")
    return xlsx(
        [
            ["HDFC BANK Ltd."],
            ["Account No : 50100XXXXXXX"],
            [],
            ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.",
             "Deposit Amt.", "Closing Balance"],
            ["********", "********", "********", "********", "********", "********", "*****"],
            [d1, "UPI-SWIGGY-SWIGGY@ICICI-ICIC0DC0099-412345678901-PAY", "0000412345678901",
             d1, 450.0, None, 9550.0],
            [d1, "NEFT-HDFCN5202611-ACME CORP-SALARY", "N1234", d1, None, 50000.0, 59550.0],
            [d2, "POS 512345XXXXXX1234 AMAZON PAY", "0", d2, 1999.0, None, 57551.0],
            [None, "INDIA PVT LTD", None, None, None, None, None],
            ["", "STATEMENT SUMMARY :-", "", "", "", "", ""],
        ]
    )  # fmt: skip


def test_an_hdfc_style_workbook_is_read() -> None:
    lines = read_statement(read_grid(hdfc_style()))

    assert [(line.date, line.amount, line.direction) for line in lines] == [
        (DAY, D("450.0"), "out"),
        (DAY, D("50000.0"), "in"),
        (NEXT, D("1999.0"), "out"),
    ]
    assert lines[2].narration == "POS 512345XXXXXX1234 AMAZON PAY INDIA PVT LTD"


def sbi_style_csv() -> bytes:
    d1 = f"{DAY.day} {DAY.strftime('%b %Y')}"
    return (
        "Account Name :,Me\n"
        "Account Number :,'000012345678\n"
        "\n"
        "Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance\n"
        f'{d1},{d1},"TO TRANSFER-UPI/DR/412345678901/BLINKIT/YESB/blinkit@yes/Pay",'
        'TRANSFER TO 123,"1,250.00", ,"8,750.00"\n'
        f"{d1},{d1},BY TRANSFER-INB INTEREST,, ,35.00,8785.00\n"
    ).encode("utf-8-sig")


def test_an_sbi_style_csv_is_read() -> None:
    lines = read_statement(read_grid(sbi_style_csv()))

    assert [(line.amount, line.direction) for line in lines] == [
        (D("1250.00"), "out"),
        (D("35.00"), "in"),
    ]


def test_a_single_amount_column_with_dr_cr() -> None:
    d1 = DAY.strftime("%d-%m-%Y")
    data = xlsx(
        [
            ["S No.", "Transaction Date", "Transaction Remarks", "Amount (INR)", "Type"],
            [1, d1, "UPI/412345678901/Payment/zepto@ybl", 300, "DR"],
            [2, d1, "REFUND FROM AMAZON", 120, "CR"],
        ]
    )

    lines = read_statement(read_grid(data))

    assert [(line.amount, line.direction) for line in lines] == [(300, "out"), (120, "in")]


def test_html_saved_as_xls_is_read() -> None:
    d1 = DAY.strftime("%d/%m/%Y")
    page = (
        "<html><body><table><tr><th>Date</th><th>Particulars</th><th>Withdrawals</th>"
        f"<th>Deposits</th></tr><tr><td>{d1}</td><td>ATM CASH<br>MUMBAI</td><td>2,000.00</td>"
        "<td></td></tr></table></body></html>"
    )

    (line,) = read_statement(read_grid(page.encode()))

    assert (line.narration, line.amount, line.direction) == ("ATM CASH MUMBAI", 2000, "out")


def pdf_statement(password: str | None = None) -> bytes:
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=9)
    rows = [
        ["Date", "Narration", "Withdrawal", "Deposit", "Balance"],
        [DAY.strftime("%d/%m/%Y"), "UPI/DR/4123/NETFLIX/HDFC", "649.00", "", "9351.00"],
        [NEXT.strftime("%d/%m/%Y"), "SALARY NOV", "", "40000.00", "49351.00"],
    ]
    with pdf.table() as table:
        for row in rows:
            cells = table.row()
            for value in row:
                cells.cell(value)
    if password:
        pdf.set_encryption(owner_password="owner", user_password=password)
    return bytes(pdf.output())


def test_a_pdf_statement_is_read() -> None:
    lines = read_statement(read_grid(pdf_statement()))

    assert [(line.amount, line.direction) for line in lines] == [
        (D("649.00"), "out"),
        (D("40000.00"), "in"),
    ]


def test_a_locked_pdf_needs_its_password() -> None:
    data = pdf_statement(password="01011990")

    with pytest.raises(FileProblem, match="This PDF is locked"):
        read_grid(data)
    with pytest.raises(FileProblem, match="didn't open"):
        read_grid(data, "wrong")
    assert len(read_statement(read_grid(data, "01011990"))) == 2


def scanned_pdf() -> bytes:
    """A statement saved as a picture: one image per page, no text."""
    from PIL import Image

    picture = io.BytesIO()
    Image.new("RGB", (40, 40), "white").save(picture, format="PNG")
    pdf = FPDF()
    pdf.add_page()
    pdf.image(io.BytesIO(picture.getvalue()), x=10, y=10, w=100)
    return bytes(pdf.output())


def test_a_scanned_pdf_says_so() -> None:
    with pytest.raises(FileProblem, match="scanned image"):
        read_grid(scanned_pdf())


def test_a_text_pdf_with_a_logo_is_still_read() -> None:
    from PIL import Image

    picture = io.BytesIO()
    Image.new("RGB", (20, 20), "red").save(picture, format="PNG")
    pdf = FPDF()
    pdf.add_page()
    pdf.image(io.BytesIO(picture.getvalue()), x=10, y=10, w=20)
    pdf.set_font("Helvetica", size=9)
    pdf.set_y(40)
    with pdf.table() as table:
        for row in [["Date", "Narration", "Withdrawal", "Deposit"],
                    [DAY.strftime("%d/%m/%Y"), "UPI/NETFLIX", "649.00", ""]]:  # fmt: skip
            cells = table.row()
            for value in row:
                cells.cell(value)

    (line,) = read_statement(read_grid(bytes(pdf.output())))

    assert line.amount == D("649.00")


def test_a_file_without_statement_columns_says_so() -> None:
    with pytest.raises(FileProblem, match="Couldn't find the statement's columns"):
        read_statement(read_grid(xlsx([["Name", "Age"], ["A", 1]])))


# The endpoints


def account(headers: Headers, name: str, type_: str = "bank", **extra: Any) -> int:
    body: dict[str, Any] = {"type": type_, "name": name, "balance": "10000.00", **extra}
    if type_ == "bank":
        body["bank_kind"] = "savings"
    if type_ == "credit_card":
        body["balance"] = "0.00"
    response = client.post("/api/accounts", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def preview(
    headers: Headers, account_id: int, data: bytes, password: str | None = None
) -> Response:
    extra = {"X-File-Password": password} if password else {}
    return client.post(
        f"/api/import/statement/preview?account_id={account_id}",
        content=data,
        headers={**headers, **extra},
    )


def save(headers: Headers, account_id: int, lines: list[dict]) -> Response:
    return client.post(
        "/api/import/statement", json={"account_id": account_id, "lines": lines}, headers=headers
    )


def added_days_ago(db: Session, account_id: int, days: int) -> None:
    """Pretends the account was added `days` ago, so statement lines after that move it."""
    from app.models.account import Account

    db.get(Account, account_id).created_at = datetime.now(UTC) - timedelta(days=days)
    db.commit()


def balances(headers: Headers) -> dict[int, str]:
    listed = client.get("/api/accounts", headers=headers).json()["accounts"]
    return {a["id"]: a["balance"] for a in listed}


def kept(line: dict, **changes: Any) -> dict:
    fields = ("line", "date", "narration", "amount", "direction", "type", "category",
              "other_account_id", "payee")  # fmt: skip
    return {**{k: line[k] for k in fields}, **changes}


def test_preview_suggests_and_saves_nothing(headers: Headers) -> None:
    sbi = account(headers, "SBI")

    response = preview(headers, sbi, hdfc_style())

    assert response.status_code == 200
    body = response.json()
    assert (body["new"], body["duplicates"], body["problems"]) == (3, 0, 0)
    swiggy, salary, amazon = body["lines"]
    assert (swiggy["payee"], swiggy["type"], swiggy["category"]) == (
        "Swiggy",
        "expense",
        "Food and dining",
    )
    assert (salary["type"], salary["category"]) == ("income", "Salary")
    assert amazon["category"] == "Shopping"
    assert client.get("/api/transactions", headers=headers).json()["transactions"] == []


def test_saving_adds_the_lines_and_remembers_payees(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    lines = preview(headers, sbi, hdfc_style()).json()["lines"]
    to_send = [kept(lines[0], category="Groceries", remember=True), kept(lines[1]), kept(lines[2])]

    result = save(headers, sbi, to_send).json()

    assert (result["imported"], result["rules_saved"], result["errors"]) == (3, 1, [])
    saved = client.get("/api/transactions", headers=headers).json()["transactions"]
    assert sorted(t["amount"] for t in saved) == ["1999.00", "450.00", "50000.00"]
    again = preview(headers, sbi, hdfc_style()).json()
    assert (again["new"], again["duplicates"]) == (0, 3)
    # The remembered payee now suggests its category.
    assert again["lines"][0]["category"] == "Groceries"


def test_a_card_payment_is_a_transfer_from_the_named_bank(
    headers: Headers, db_session: Session
) -> None:
    sbi = account(headers, "SBI", last4="4321")
    card = account(headers, "Regalia", "credit_card", last4="9876", credit_limit="100000.00")
    added_days_ago(db_session, sbi, 10)
    added_days_ago(db_session, card, 10)
    d1 = DAY.strftime("%d/%m/%Y")
    data = xlsx(
        [
            ["Date", "Description", "Amount", "Dr/Cr"],
            [d1, "SWIGGY BANGALORE", "500.00", "Dr"],
            [d1, "PAYMENT RECEIVED - THANK YOU XX4321", "500.00", "Cr"],
        ]
    )

    lines = preview(headers, card, data).json()["lines"]

    assert lines[1]["type"] == "transfer"
    assert lines[1]["other_account_id"] == sbi
    result = save(headers, card, [kept(lines[0]), kept(lines[1])]).json()
    assert result["imported"] == 2
    balances = {
        a["id"]: a["balance"]
        for a in client.get("/api/accounts", headers=headers).json()["accounts"]
    }
    assert balances[card] == "0.00"
    assert balances[sbi] == "9500.00"


def test_one_bad_line_saves_nothing(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    lines = preview(headers, sbi, hdfc_style()).json()["lines"]

    result = save(
        headers,
        sbi,
        [kept(lines[0]), kept(lines[1], type="expense"), kept(lines[2], type="transfer")],
    ).json()

    assert result["imported"] == 0
    assert result["errors"] == [
        {
            "line": lines[1]["line"],
            "errors": ["Type: money came in, so it's income or a transfer."],
        },
        {"line": lines[2]["line"], "errors": ["Choose the other account of this transfer."]},
    ]
    assert client.get("/api/transactions", headers=headers).json()["transactions"] == []


def test_lines_can_be_left_uncategorised(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    line = preview(headers, sbi, hdfc_style()).json()["lines"][0]

    result = save(headers, sbi, [kept(line, category=None)]).json()

    assert result["imported"] == 1
    (saved,) = client.get("/api/transactions", headers=headers).json()["transactions"]
    assert saved["category"] is None


def test_a_locked_pdf_asks_for_its_password(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    data = pdf_statement(password="secret")

    locked = preview(headers, sbi, data)
    wrong = preview(headers, sbi, data, password="nope")
    opened = preview(headers, sbi, data, password="secret")

    assert locked.status_code == 422
    assert (locked.json()["needs_password"], locked.json()["wrong_password"]) == (True, False)
    assert wrong.json()["wrong_password"] is True
    assert opened.status_code == 200
    assert opened.json()["new"] == 2


def test_only_the_owners_active_money_accounts(headers: Headers) -> None:
    fd = client.post(
        "/api/accounts",
        json={"type": "ppf", "name": "PPF", "balance": "0.00", "interest_rate": "7.10",
              "opened_on": "2020-06-10"},
        headers=headers,
    ).json()["id"]  # fmt: skip

    assert preview(headers, 999999, hdfc_style()).status_code == 404
    assert preview(headers, fd, hdfc_style()).status_code == 422


def test_an_unreadable_file_says_why(headers: Headers) -> None:
    sbi = account(headers, "SBI")

    response = preview(headers, sbi, b"just some words\nno table here\n")

    assert response.status_code == 422
    assert "Couldn't find the statement's columns" in response.json()["detail"]


def test_an_atm_withdrawal_is_a_transfer_to_cash(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    cash = account(headers, "Wallet cash", "cash")
    d1 = DAY.strftime("%d/%m/%Y")
    data = xlsx(
        [
            ["Txn Date", "Narration", "Withdrawal", "Deposit"],
            [d1, "ATM WDL/MUMBAI", "2000.00", None],
        ]
    )

    (line,) = preview(headers, sbi, data).json()["lines"]

    assert (line["type"], line["other_account_id"], line["payee"]) == ("transfer", cash, "Mumbai")


def test_a_line_a_few_paise_off_a_saved_one_is_a_duplicate(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    body = {"type": "expense", "account_id": sbi, "amount": "227.00", "date": DAY.isoformat()}
    assert (
        client.post(
            "/api/transactions", json={**body, "category": "Food"}, headers=headers
        ).status_code
        == 201
    )
    data = xlsx([["Txn Date", "Narration", "Withdrawal", "Deposit"],
                 [DAY.strftime("%d/%m/%Y"), "UPI/DR/Zomato/HDFC", "227.05", None]])  # fmt: skip

    (line,) = preview(headers, sbi, data).json()["lines"]

    assert line["duplicate"] is True


def test_an_exact_amount_is_matched_before_a_near_one() -> None:
    from app.export.statements import Line, _take

    saved = [(DAY, D("227.50"), "out"), (DAY, D("227.05"), "out")]

    assert _take(saved, Line(1, DAY, "Zomato", D("227.05"), "out"))
    assert saved == [(DAY, D("227.50"), "out")]


def test_a_rupee_apart_is_not_a_duplicate() -> None:
    from app.export.statements import Line, _take

    assert not _take([(DAY, D("226.00"), "out")], Line(1, DAY, "Zomato", D("227.00"), "out"))


# Lines from before the account was added: its opening balance already holds them.


def test_lines_before_the_account_was_added_keep_todays_balance(headers: Headers) -> None:
    sbi = account(headers, "SBI")
    lines = preview(headers, sbi, hdfc_style()).json()["lines"]

    assert save(headers, sbi, [kept(line) for line in lines]).json()["imported"] == 3

    assert balances(headers)[sbi] == "10000.00"
    assert len(client.get("/api/transactions", headers=headers).json()["transactions"]) == 3


def test_lines_after_the_account_was_added_move_the_balance(
    headers: Headers, db_session: Session
) -> None:
    sbi = account(headers, "SBI")
    added_days_ago(db_session, sbi, 10)
    lines = preview(headers, sbi, hdfc_style()).json()["lines"]
    change = sum(
        (D(x["amount"]) if x["direction"] == "in" else -D(x["amount"]) for x in lines), D(0)
    )

    save(headers, sbi, [kept(line) for line in lines])

    assert D(balances(headers)[sbi]) == D("10000.00") + change


def test_a_card_line_before_it_was_added_keeps_what_is_owed(headers: Headers) -> None:
    card = account(headers, "Regalia", "credit_card", last4="9876", credit_limit="100000.00")
    data = xlsx([["Date", "Description", "Amount", "Dr/Cr"],
                 [DAY.strftime("%d/%m/%Y"), "SWIGGY BANGALORE", "500.00", "Dr"]])  # fmt: skip
    (line,) = preview(headers, card, data).json()["lines"]

    assert save(headers, card, [kept(line)]).json()["imported"] == 1

    assert balances(headers)[card] == "0.00"


def test_a_transfer_shifts_each_side_by_its_own_added_day(
    headers: Headers, db_session: Session
) -> None:
    sbi = account(headers, "SBI", last4="4321")
    card = account(headers, "Regalia", "credit_card", last4="9876", credit_limit="100000.00")
    added_days_ago(db_session, sbi, 10)  # the bank was added before the payment, the card after
    paid = [DAY.strftime("%d/%m/%Y"), "PAYMENT RECEIVED - THANK YOU XX4321", "500.00", "Cr"]
    data = xlsx([["Date", "Description", "Amount", "Dr/Cr"], paid])
    (line,) = preview(headers, card, data).json()["lines"]
    assert line["other_account_id"] == sbi

    assert save(headers, card, [kept(line)]).json()["imported"] == 1

    assert balances(headers)[sbi] == "9500.00"
    assert balances(headers)[card] == "0.00"


def test_preview_counts_lines_before_the_account(headers: Headers, db_session: Session) -> None:
    sbi = account(headers, "SBI")
    added_days_ago(db_session, sbi, 5)  # added on DAY: lines that day are before it too
    data = xlsx([["Txn Date", "Narration", "Withdrawal", "Deposit"],
                 [DAY.strftime("%d/%m/%Y"), "UPI/DR/Swiggy", "100.00", None],
                 [NEXT.strftime("%d/%m/%Y"), "UPI/DR/Zomato", "200.00", None]])  # fmt: skip

    body = preview(headers, sbi, data).json()

    assert body["added_on"] == DAY.isoformat()
    assert body["before_start"] == 1


def refund_statement() -> bytes:
    d1 = DAY.strftime("%d/%m/%y")
    return xlsx(
        [
            ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.",
             "Deposit Amt.", "Closing Balance"],
            [d1, "REFUND-AMAZON PAY-ORDER 123", "0", d1, None, 799.0, 10799.0],
        ]
    )  # fmt: skip


def test_a_refund_already_recorded_is_a_duplicate_and_not_called_income(
    headers: Headers,
) -> None:
    sbi = account(headers, "SBI")
    body = {"type": "refund", "account_id": sbi, "amount": "799.00", "date": DAY.isoformat()}
    typed = client.post("/api/transactions", json={**body, "category": "Shopping"}, headers=headers)
    assert typed.status_code == 201, typed.json()

    found = preview(headers, sbi, refund_statement()).json()

    assert (found["new"], found["duplicates"]) == (0, 1)
    # "Refund" is not an income category new users have, so it isn't suggested.
    assert found["lines"][0]["category"] is None
