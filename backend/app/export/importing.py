"""Transactions from an Excel workbook: read, check every row, then save all of them or none.

The sheet has a header row naming its columns (any order, any case): Date, Type, Amount, Account,
To account, Category, Interest, Note. Other columns are ignored, so the Transactions sheet of our
own Excel export loads back in. Blank rows are skipped.

Every row goes through the same rules as a transaction typed in by hand
(`validate_transaction_values`, the category registry and the below-₹0 check), run one row after
another so each row's balance check sees the rows before it. A row that matches a saved
transaction (same date, type, amount and accounts) is a duplicate and is skipped, so importing
the same file twice adds nothing.

A preview runs exactly the same steps and then rolls back, so it can't drift from the real thing.
"""

import io
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi.exceptions import RequestValidationError
from openpyxl import Workbook, load_workbook
from openpyxl.worksheet.datavalidation import DataValidation
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.balances import Movement, balance_of, load_movements, net_flows
from app.api.categories import UNCATEGORISED, ensure_seeded, exists, kind_of, name_key, resolve
from app.api.dates import today_india
from app.api.routes.accounts import CAN_BE_NEGATIVE, MAX_MONEY, rupees
from app.api.routes.transactions import (
    EMI_CATEGORY,
    lock_accounts,
    validate_transaction_values,
)
from app.export.xlsx import write_sheet
from app.models.account import Account
from app.models.category import Category
from app.models.transaction import Transaction

MAX_BYTES = 4 * 1024 * 1024  # Vercel refuses request bodies over 4.5 MB
MAX_ROWS = 2000
SOURCE = "import"

COLUMNS = ["Date", "Type", "Amount", "Account", "To account", "Category", "Interest", "Note"]
REQUIRED = ["Date", "Type", "Amount", "Account"]
TYPES = {"expense": "expense", "income": "income", "transfer": "transfer", "emi": "emi"}
FIELD_COLUMNS = {
    "date": "Date",
    "type": "Type",
    "amount": "Amount",
    "account_id": "Account",
    "to_account_id": "To account",
    "category": "Category",
    "interest": "Interest",
    "note": "Note",
}
_MONEY_TEXT = re.compile(r"[0-9]+(\.[0-9]+)?")
_DAY_FIRST = re.compile(r"([0-9]{1,2})[/.-]([0-9]{1,2})[/.-]([0-9]{4})")


class FileProblem(Exception):
    """The file as a whole can't be read; the message says why."""


@dataclass
class Row:
    number: int  # the spreadsheet's row number, as Excel shows it
    date: str | None
    type: str | None
    amount: str | None
    account: str | None
    to_account: str | None
    category: str | None
    note: str | None
    status: str = "ok"  # ok | duplicate | error
    errors: list[str] = field(default_factory=list)


@dataclass
class Report:
    rows: list[Row]
    imported: int = 0

    @property
    def ok(self) -> int:
        return sum(r.status == "ok" for r in self.rows)

    @property
    def duplicates(self) -> int:
        return sum(r.status == "duplicate" for r in self.rows)

    @property
    def problems(self) -> int:
        return sum(r.status == "error" for r in self.rows)


# Reading the file


def read_rows(data: bytes) -> list[tuple[int, dict[str, Any]]]:
    """(row number, {column: raw value}) for each non-blank row of the first sheet that has
    the needed headers (a sheet named Transactions is tried first)."""
    if len(data) > MAX_BYTES:
        raise FileProblem("The file is over 4 MB. Split it into smaller files.")
    try:
        book = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except (zipfile.BadZipFile, KeyError, ValueError, OSError):
        message = "This isn't an Excel file (.xlsx). Save it as .xlsx and try again."
        raise FileProblem(message) from None
    try:
        worksheets = sorted(book.worksheets, key=lambda ws: ws.title.casefold() != "transactions")
        for ws in worksheets:
            lines = ws.iter_rows(values_only=True)
            header = next(lines, None)
            if header is None:
                continue
            columns = {str(h).strip().casefold(): i for i, h in enumerate(header) if h is not None}
            if not all(c.casefold() in columns for c in REQUIRED):
                continue
            found = []
            for number, line in enumerate(lines, start=2):
                values = {
                    c: line[columns[c.casefold()]]
                    if c.casefold() in columns and columns[c.casefold()] < len(line)
                    else None
                    for c in COLUMNS
                }
                if all(v is None or str(v).strip() == "" for v in values.values()):
                    continue
                found.append((number, values))
                if len(found) > MAX_ROWS:
                    raise FileProblem(f"The file has more than {MAX_ROWS} rows. Split it up.")
            if not found:
                raise FileProblem("The sheet has headers but no rows to import.")
            return found
    finally:
        book.close()
    raise FileProblem(
        "Couldn't find the columns Date, Type, Amount and Account. "
        "Start from the template, or keep its header row."
    )


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    return text or None


def _date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = _text(value) or ""
    try:
        return date.fromisoformat(text)
    except ValueError:
        pass
    match = _DAY_FIRST.fullmatch(text)
    if match:
        day, month, year = (int(g) for g in match.groups())
        try:
            return date(year, month, day)
        except ValueError:
            pass
    raise ValueError("Enter the date as a date, like 16-11-2026.")


def _money(value: Any, label: str) -> Decimal:
    if isinstance(value, bool):
        raise ValueError(f"Enter the {label} as a number, like 1234.50.")
    if isinstance(value, int | float):
        amount = Decimal(repr(value)) if isinstance(value, float) else Decimal(value)
    else:
        text = (_text(value) or "").replace("₹", "").replace(",", "").replace("Rs.", "").strip()
        if not _MONEY_TEXT.fullmatch(text):
            raise ValueError(f"Enter the {label} as a number, like 1234.50.")
        amount = Decimal(text)
    try:
        rounded = amount.quantize(Decimal("0.01"))
    except InvalidOperation:
        raise ValueError(f"The {label} is too large.") from None
    if rounded != amount:
        raise ValueError(f"Use at most 2 decimal places in the {label}.")
    return rounded


class AccountNames:
    def __init__(self, accounts: list[Account]) -> None:
        self.by_name: dict[str, list[Account]] = {}
        for a in accounts:
            self.by_name.setdefault(a.name.strip().casefold(), []).append(a)

    def find(self, name: str | None, label: str) -> int | None:
        if name is None:
            return None
        found = self.by_name.get(name.casefold(), [])
        active = [a for a in found if a.archived_at is None]
        if len(active) > 1 or (not active and len(found) > 1):
            raise ValueError(f"{label}: more than one account is called {name}. Rename one.")
        if not found:
            raise ValueError(f"{label}: no account called {name}.")
        return (active or found)[0].id


# Checking and saving


def _values(raw: dict[str, Any], names: AccountNames) -> tuple[dict[str, Any], list[str]]:
    """The row as transaction values, and whatever couldn't be read."""
    errors: list[str] = []
    values: dict[str, Any] = {
        "type": None,
        "account_id": None,
        "to_account_id": None,
        "amount": None,
        "date": None,
        "category": _text(raw["Category"]),
        "interest": None,
        "note": _text(raw["Note"]),
        "recurring_template_id": None,
    }
    type_text = (_text(raw["Type"]) or "").casefold()
    values["type"] = TYPES.get(type_text)
    if values["type"] is None:
        errors.append("Type: use expense, income, transfer or EMI.")
    readers = [
        ("date", lambda: _date(raw["Date"]) if _text(raw["Date"]) else None),
        ("amount", lambda: _money(raw["Amount"], "amount") if _text(raw["Amount"]) else None),
        (
            "interest",
            lambda: _money(raw["Interest"], "interest") if _text(raw["Interest"]) else None,
        ),
        ("account_id", lambda: names.find(_text(raw["Account"]), "Account")),
        ("to_account_id", lambda: names.find(_text(raw["To account"]), "To account")),
    ]
    for key, read in readers:
        try:
            values[key] = read()
        except ValueError as error:
            message = str(error)
            label = FIELD_COLUMNS[key]
            errors.append(message if message.startswith(label) else f"{label}: {message}")
    if values["note"] is not None and len(values["note"]) > 200:
        errors.append("Note: use 200 characters or fewer.")
    if values["category"] is not None and len(values["category"]) > 40:
        errors.append("Category: use 40 characters or fewer.")
    return values, errors


def _rule_errors(error: RequestValidationError) -> list[str]:
    messages = []
    for e in error.errors():
        key = e["loc"][-1] if e.get("loc") else ""
        label = FIELD_COLUMNS.get(str(key))
        messages.append(f"{label}: {e['msg']}" if label else e["msg"])
    return messages


def _step_problem(
    accounts: dict[int, Account], flows: dict[int, Decimal], movement: Movement
) -> str | None:
    """The below-₹0 and largest-balance checks for one more movement, as a save makes them."""
    after = dict(flows)
    for account_id, change in net_flows([movement]).items():
        after[account_id] = after.get(account_id, Decimal(0)) + change
    for account_id in net_flows([movement]):
        account = accounts.get(account_id)
        if account is None:
            continue
        old, new = balance_of(account, flows), balance_of(account, after)
        if account.type not in CAN_BE_NEGATIVE and new < 0 and new < old:
            return f"This would take {account.name} below ₹0 ({rupees(new)})."
        if abs(new) >= MAX_MONEY and abs(new) > abs(old):
            return f"This would take {account.name} past the largest balance allowed."
    return None


def _shown(raw: dict[str, Any], key: str) -> str | None:
    value = raw[key]
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat()
    return _text(value)


def run_import(db: Session, user_id: int, data: bytes, save: bool) -> Report:
    """Checks every row and, with `save` and no row in error, saves the rows that aren't
    duplicates. Otherwise everything is rolled back, categories created on the way included.
    A preview never creates a category."""
    raw_rows = read_rows(data)
    all_accounts = list(db.scalars(select(Account).where(Account.user_id == user_id)))
    names = AccountNames(all_accounts)
    accounts = lock_accounts(db, user_id, [a.id for a in all_accounts])
    flows = net_flows(load_movements(db, user_id))
    existing = {
        (t.date, t.type, t.amount, t.account_id, t.to_account_id)
        for t in db.scalars(select(Transaction).where(Transaction.user_id == user_id))
    }

    report = Report([])
    to_save: list[Transaction] = []
    for number, raw in raw_rows:
        row = Row(
            number,
            _shown(raw, "Date"),
            _shown(raw, "Type"),
            _shown(raw, "Amount"),
            _shown(raw, "Account"),
            _shown(raw, "To account"),
            _shown(raw, "Category"),
            _shown(raw, "Note"),
        )
        report.rows.append(row)
        values, errors = _values(raw, names)
        if not errors:
            try:
                validate_transaction_values(values, accounts)
            except RequestValidationError as error:
                errors = _rule_errors(error)
        if errors:
            row.status, row.errors = "error", errors
            continue
        key = (
            values["date"],
            values["type"],
            values["amount"],
            values["account_id"],
            values["to_account_id"],
        )
        if key in existing:
            row.status = "duplicate"
            continue
        movement = Movement(
            0,
            values["type"],
            values["amount"],
            values["account_id"],
            values["to_account_id"],
            values["interest"],
        )
        problem = _step_problem(accounts, flows, movement)
        if problem:
            row.status, row.errors = "error", [f"Amount: {problem}"]
            continue
        try:
            if values["type"] == "emi":
                values["category"] = EMI_CATEGORY
            elif values["category"] is not None:
                kind = kind_of(values["type"]) or "expense"
                name = values["category"]
                # A preview creates nothing: a name that isn't a category yet will be a new one.
                creates = name_key(name) != name_key(UNCATEGORISED) and not exists(
                    db, user_id, kind, name
                )
                if save or not creates:
                    values["category"] = resolve(db, user_id, kind, name)
        except RequestValidationError as error:
            row.status, row.errors = "error", _rule_errors(error)
            continue
        for account_id, change in net_flows([movement]).items():
            flows[account_id] = flows.get(account_id, Decimal(0)) + change
        to_save.append(Transaction(user_id=user_id, source=SOURCE, **values))

    if save and report.problems == 0 and to_save:
        db.add_all(to_save)
        db.commit()
        report.imported = len(to_save)
    else:
        db.rollback()
    return report


# The template


def template(db: Session, user_id: int) -> bytes:
    """An empty Transactions sheet with dropdowns for type, accounts and categories, an example
    row, and a sheet explaining each column."""
    ensure_seeded(db, user_id)
    accounts = list(
        db.scalars(
            select(Account)
            .where(Account.user_id == user_id, Account.archived_at.is_(None))
            .order_by(Account.name)
        )
    )
    categories = list(
        db.scalars(
            select(Category.name)
            .where(
                Category.user_id == user_id,
                Category.archived_at.is_(None),
                Category.merged_into_id.is_(None),
            )
            .order_by(Category.kind, Category.name)
        )
    )
    book = Workbook()
    ws = book.active
    assert ws is not None
    ws.title = "Transactions"
    example_account = accounts[0].name if accounts else "My bank"
    write_sheet(
        ws,
        COLUMNS,
        [[today_india(), "expense", "250.00", example_account, "", "Groceries", "", "Example row"]],
    )

    lists = book.create_sheet("Lists")
    lists.append(["Type", "Account", "Category"])
    rows = max(4, len(accounts), len(categories))
    types = ["expense", "income", "transfer", "emi"]
    for i in range(rows):
        lists.append(
            [
                types[i] if i < len(types) else None,
                accounts[i].name if i < len(accounts) else None,
                categories[i] if i < len(categories) else None,
            ]
        )
    lists.sheet_state = "hidden"

    def dropdown(column: str, source: str, count: int, strict: bool) -> None:
        if count == 0:
            return
        check = DataValidation(
            type="list",
            formula1=f"=Lists!${source}$2:${source}${count + 1}",
            allow_blank=True,
            showErrorMessage=strict,
        )
        check.add(f"{column}2:{column}{MAX_ROWS + 1}")
        ws.add_data_validation(check)

    dropdown("B", "A", len(types), True)
    dropdown("D", "B", len(accounts), False)
    dropdown("E", "B", len(accounts), False)
    dropdown("F", "C", len(categories), False)  # a new category name is allowed

    help_sheet = book.create_sheet("How to fill")
    write_sheet(
        help_sheet,
        ["Column", "What to put"],
        [
            ["Date", "The day it happened, like 16-11-2026. Not in the future."],
            ["Type", "expense, income, transfer or emi."],
            ["Amount", "A number above 0, like 1234.50. No minus sign."],
            ["Account", "The account it was paid from or into, named as in the app."],
            ["To account", "Transfers and EMIs only: where the money went (an EMI's loan)."],
            ["Category", "Expense and income only. A new name creates a new category."],
            ["Interest", "EMIs only: the interest part, if you know it."],
            ["Note", "Anything you like, up to 200 characters."],
            [
                "",
                "Delete the example row before importing. A row that matches a saved "
                "transaction (same date, type, amount and accounts) is skipped.",
            ],
        ],
    )
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()
