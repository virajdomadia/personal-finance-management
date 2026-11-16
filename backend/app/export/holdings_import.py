"""Holdings you already have (stocks, mutual funds, crypto) from an Excel workbook: read, check
every row, then save all of them or none.

The sheet has a header row naming its columns (any order, any case): Type, Name, Symbol, Account,
Quantity, Average price, Invested, Date, Market code. Blank rows are skipped.

Each row is what adding an existing holding by hand makes: the stock, fund or coin (unless one of
that kind already matches: by symbol for stocks and coins, by symbol or else name for funds) and
an opening buy (`opening`), which moves no cash. The row goes through the same request bodies,
field rules and save checks as the app's own forms, so the messages are the same ones. Two rows
for the same new holding (say, one stock at two brokers) create it once.

A row matching a saved opening buy (same holding, account, quantity, date and amount) is a
duplicate and is skipped, so importing the same file twice adds nothing.

A preview runs exactly the same steps and then rolls back, so it can't drift from the real thing.
"""

import io
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from openpyxl import Workbook
from openpyxl.worksheet.datavalidation import DataValidation
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.portfolio import round_paise, stock_amount
from app.api.routes import crypto_trades, fund_trades, trades
from app.api.routes.accounts import fmt, rupees
from app.api.routes.coins import CRYPTO, QTY_RULE, CoinCreate, add_coin
from app.api.routes.funds import MUTUAL_FUND, UNITS_RULE, FundCreate, add_fund
from app.api.routes.market import check_source_code
from app.api.routes.stocks import STOCK, StockCreate, add_stock
from app.api.routes.transactions import lock_accounts
from app.api.trade_checks import NEW_ID
from app.export.importing import (
    _MONEY_TEXT,
    MAX_ROWS,
    AccountNames,
    Report,
    _date,
    _money,
    _text,
    read_rows,
)
from app.export.xlsx import write_sheet
from app.models.account import Account
from app.models.investment import Instrument, InvestmentTrade

SHEET = "Holdings"
COLUMNS = [
    "Type",
    "Name",
    "Symbol",
    "Account",
    "Quantity",
    "Average price",
    "Invested",
    "Date",
    "Market code",
]
REQUIRED = ["Type", "Name", "Account", "Quantity"]
TYPES = {
    "stock": STOCK,
    "share": STOCK,
    "equity": STOCK,
    "mutual fund": MUTUAL_FUND,
    "mf": MUTUAL_FUND,
    "fund": MUTUAL_FUND,
    "crypto": CRYPTO,
    "coin": CRYPTO,
}
_CENT = Decimal("0.01")
_MAX_NUMBER_TEXT = 40
# Average price and Invested, both given, may differ by ₹1, or by quantity × half a paisa when
# that is more: an average price is often a rounded one.
_MATCH_TOLERANCE = Decimal("1.00")
_PRICE_ROUNDING = Decimal("0.005")


@dataclass(frozen=True)
class Kind:
    """What differs between stocks, funds and coins: their bodies, rules and save checks."""

    kind: str
    words: str  # "Stocks", for messages
    account_type: str
    account_words: str  # "a broker account"
    ref: str  # the trade's field naming its instrument
    quantity: str  # the trade's quantity field
    quantity_rule: str
    instrument_body: type[BaseModel]
    trade_body: type[BaseModel]
    add: Callable[[Session, int, Any], Instrument]
    validate_fields: Callable[[dict[str, Any]], None]
    save: Callable[[Session, int, dict[int, Account], dict[str, Any]], dict[str, Any]]
    columns: dict[str, str]  # the bodies' field names, as the sheet's column names


def _stock_save(
    db: Session, user_id: int, accounts: dict[int, Account], values: dict[str, Any]
) -> dict[str, Any]:
    trades.stock_save_checks(db, user_id, accounts, values, existing_id=None)
    return trades.stock_columns(values)


def _fund_save(
    db: Session, user_id: int, accounts: dict[int, Account], values: dict[str, Any]
) -> dict[str, Any]:
    _, price = fund_trades.fund_save_checks(db, user_id, accounts, values, existing_id=None)
    return fund_trades.fund_columns(values, price)


def _coin_save(
    db: Session, user_id: int, accounts: dict[int, Account], values: dict[str, Any]
) -> dict[str, Any]:
    _, price = crypto_trades._save_checks(db, user_id, accounts, values, existing_id=None)
    return crypto_trades._columns(values, price)


_COMMON = {
    "name": "Name",
    "symbol": "Symbol",
    "source_code": "Market code",
    "account_id": "Account",
    "date": "Date",
}
KINDS = {
    STOCK: Kind(
        kind=STOCK,
        words="Stocks",
        account_type="broker",
        account_words="a broker account",
        ref="stock_id",
        quantity="quantity",
        quantity_rule=trades._QUANTITY_RULE,
        instrument_body=StockCreate,
        trade_body=trades.FirstTrade,
        add=add_stock,
        validate_fields=trades._validate_fields,
        save=_stock_save,
        columns={**_COMMON, "quantity": "Quantity", "price": "Average price"},
    ),
    MUTUAL_FUND: Kind(
        kind=MUTUAL_FUND,
        words="Mutual funds",
        account_type="bank",
        account_words="a bank account",
        ref="fund_id",
        quantity="units",
        quantity_rule=UNITS_RULE,
        instrument_body=FundCreate,
        trade_body=fund_trades.FirstFundTrade,
        add=add_fund,
        validate_fields=fund_trades._validate_fields,
        save=_fund_save,
        columns={**_COMMON, "units": "Quantity", "amount": "Invested", "nav": "Average price"},
    ),
    CRYPTO: Kind(
        kind=CRYPTO,
        words="Coins",
        account_type="broker",
        account_words="a broker or exchange account",
        ref="coin_id",
        quantity="quantity",
        quantity_rule=QTY_RULE,
        instrument_body=CoinCreate,
        trade_body=crypto_trades.FirstCryptoTrade,
        add=add_coin,
        validate_fields=crypto_trades._validate_fields,
        save=_coin_save,
        columns={
            **_COMMON,
            "quantity": "Quantity",
            "amount": "Invested",
            "price": "Average price",
        },
    ),
}


@dataclass
class Row:
    number: int  # the spreadsheet's row number, as Excel shows it
    type: str | None
    name: str | None
    symbol: str | None
    account: str | None
    quantity: str | None
    invested: str | None  # the amount that will be stored, once it can be worked out
    date: str | None
    status: str = "ok"  # ok | duplicate | error
    errors: list[str] = field(default_factory=list)


# Reading the cells


def _number(value: Any, label: str) -> Decimal:
    """A number above 0, as typed (no rounding)."""
    problem = ValueError(f"Enter the {label} as a number, like 1234.50.")
    if isinstance(value, bool):
        raise problem
    if isinstance(value, int | float):
        number = Decimal(repr(value)) if isinstance(value, float) else Decimal(value)
        if not number.is_finite():
            raise problem
    else:
        text = (_text(value) or "").replace("₹", "").replace(",", "").replace("Rs.", "").strip()
        if len(text) > _MAX_NUMBER_TEXT or not _MONEY_TEXT.fullmatch(text):
            raise problem
        number = Decimal(text)
    if number <= 0:
        raise ValueError(f"The {label} must be more than 0.")
    return number


def _plain(number: Decimal) -> str:
    """Decimal text without an exponent, as the bodies' validators read it."""
    return format(number.normalize(), "f")


def _labelled(column: str, message: str) -> str:
    return message if message.startswith(f"{column}:") else f"{column}: {message}"


def _messages(errors: list[Any], columns: dict[str, str]) -> list[str]:
    """Pydantic or request-validation errors, worded with the sheet's column names."""
    found = []
    for e in errors:
        key = str(e["loc"][-1]) if e.get("loc") else ""
        column = columns.get(key)
        message = _labelled(column, e["msg"]) if column else e["msg"]
        if message not in found:
            found.append(message)
    return found


def _shown(raw: dict[str, Any], key: str) -> str | None:
    value = raw[key]
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float):
        return _plain(Decimal(repr(value)))
    return _text(value)


# Matching holdings already in the app (or added by an earlier row)


class Holdings:
    def __init__(self, instruments: list[Instrument]) -> None:
        self.by_symbol: dict[tuple[str, str], Instrument] = {}
        self.funds_by_name: dict[str, list[Instrument]] = {}
        for i in sorted(instruments, key=lambda i: i.id):
            self.remember(i)

    def remember(self, instrument: Instrument) -> None:
        self.by_symbol.setdefault((instrument.kind, instrument.symbol.upper()), instrument)
        if instrument.kind == MUTUAL_FUND:
            self.funds_by_name.setdefault(instrument.name.strip().casefold(), []).append(instrument)

    def find(self, kind: str, symbol: str | None, name: str | None) -> Instrument | None:
        if symbol is not None:
            return self.by_symbol.get((kind, symbol.upper()))
        if kind == MUTUAL_FUND and name is not None:
            found = self.funds_by_name.get(name.casefold(), [])
            if len(found) > 1:
                raise ValueError(f"Name: more than one fund is called {name}. Give its symbol.")
            return found[0] if found else None
        return None


# Checking and saving


def _stored_money(
    kind: Kind, quantity: Decimal, average: Decimal | None, invested: Decimal | None
) -> tuple[Decimal, Decimal]:
    """(the field the trade body takes: a stock's price or a fund's or coin's amount, the
    amount stored)."""
    if average is None and invested is None:
        raise ValueError("Average price: give the average price or the amount invested.")
    if average is not None and invested is not None:
        worth = quantity * average
        if abs(worth - invested) > max(_MATCH_TOLERANCE, quantity * _PRICE_ROUNDING):
            raise ValueError(
                f"Invested: {rupees(invested)} doesn't match quantity × average price "
                f"({rupees(round_paise(worth))}). Give one of them, or check both."
            )
    if kind.kind == STOCK:
        each = average if average is not None else Decimal(invested or 0) / quantity
        price = each.quantize(_CENT, rounding=ROUND_HALF_UP)
        return price, stock_amount("buy", quantity, price, Decimal(0))
    amount = invested if invested is not None else round_paise(quantity * Decimal(average or 0))
    return amount, amount


def _read(
    raw: dict[str, Any], names: AccountNames, accounts: dict[int, Account]
) -> tuple[Kind | None, dict[str, Any], list[str]]:
    """The row's kind and what was read from it, and whatever couldn't be read."""
    errors: list[str] = []
    kind = KINDS.get(TYPES.get((_text(raw["Type"]) or "").casefold(), ""))
    if kind is None:
        errors.append("Type: use stock, mutual fund or crypto.")
    got: dict[str, Any] = {
        "name": _text(raw["Name"]),
        "symbol": _text(raw["Symbol"]),
        "source_code": _text(raw["Market code"]),
        "account_id": None,
        "quantity": None,
        "average": None,
        "invested": None,
        "date": today_india(),
    }
    readers: list[tuple[str, str, Callable[[], Any]]] = [
        ("account_id", "Account", lambda: names.find(_text(raw["Account"]), "Account")),
        (
            "average",
            "Average price",
            lambda: (
                _number(raw["Average price"], "average price")
                if _text(raw["Average price"])
                else None
            ),
        ),
        (
            "invested",
            "Invested",
            lambda: _money(raw["Invested"], "amount invested") if _text(raw["Invested"]) else None,
        ),
        ("date", "Date", lambda: _date(raw["Date"]) if _text(raw["Date"]) else today_india()),
    ]
    for key, column, read in readers:
        try:
            got[key] = read()
        except ValueError as error:
            errors.append(_labelled(column, str(error)))
    if got["invested"] is not None and got["invested"] <= 0:
        errors.append("Invested: The amount invested must be more than 0.")
    if kind is not None:
        try:
            got["quantity"] = (
                _number(raw["Quantity"], "quantity") if _text(raw["Quantity"]) else None
            )
        except ValueError:
            pass
        if got["quantity"] is None:
            errors.append(_labelled("Quantity", kind.quantity_rule))
        account = accounts.get(got["account_id"]) if got["account_id"] is not None else None
        if account is not None and account.type != kind.account_type:
            errors.append(
                f"Account: {account.name} isn't {kind.account_words}. "
                f"{kind.words} are held in {kind.account_words}."
            )
    return kind, got, errors


def _check_row(
    db: Session,
    user_id: int,
    kind: Kind,
    got: dict[str, Any],
    holdings: Holdings,
    accounts: dict[int, Account],
    existing: set[tuple[Any, ...]],
    row: Row,
) -> InvestmentTrade | None:
    """The row's opening buy, added to the session (with its new holding, if any), or None for
    a duplicate. Raises ValueError, RequestValidationError or HTTPException for a problem."""
    errors: list[str] = []
    instrument_body = None
    try:
        instrument_body = kind.instrument_body.model_validate(
            {"name": got["name"], "symbol": got["symbol"], "source_code": got["source_code"]}
        )
    except ValidationError as error:
        errors += _messages(error.errors(), kind.columns)

    quantity: Decimal = got["quantity"]
    money_field, money = None, None
    try:
        money, stored = _stored_money(kind, quantity, got["average"], got["invested"])
        row.invested = fmt(stored)
        money_field = "price" if kind.kind == STOCK else "amount"
    except ValueError as error:
        errors.append(str(error))
    if kind.kind == STOCK:
        # Whole shares only: anything else is passed on as is for the rule to refuse.
        sent_quantity: Any = (
            int(quantity) if quantity == quantity.to_integral() else _plain(quantity)
        )
    else:
        sent_quantity = _plain(quantity)
    trade_fields: dict[str, Any] = {
        "account_id": got["account_id"],
        "date": got["date"].isoformat(),
        kind.quantity: sent_quantity,
        "opening": True,
    }
    if money_field is not None:
        trade_fields[money_field] = fmt(Decimal(money or 0))
    trade_body = None
    try:
        trade_body = kind.trade_body.model_validate(trade_fields)
    except ValidationError as error:
        errors += _messages(error.errors(), kind.columns)
    if errors or instrument_body is None or trade_body is None:
        raise ValueError(*errors)

    values: dict[str, Any] = {
        **trade_body.model_dump(),
        "side": "buy",
        "charges": Decimal(0),
        kind.ref: NEW_ID,
    }
    if kind.kind == MUTUAL_FUND:
        values["sip_id"] = None
    # The trade's own field rules first, so a bad market code and a future date are both heard.
    try:
        kind.validate_fields(values)
    except RequestValidationError as error:
        errors += _messages(list(error.errors()), kind.columns)
    body: Any = instrument_body
    errors += _messages(check_source_code(db, kind.kind, body.source_code), kind.columns)
    instrument = holdings.find(kind.kind, body.symbol, body.name)
    if errors:
        raise ValueError(*errors)

    if instrument is not None:
        key = (instrument.id, values["account_id"], quantity, values["date"], Decimal(row.invested))
        if key in existing:
            return None
    else:
        instrument = kind.add(db, user_id, body)
        holdings.remember(instrument)
    values[kind.ref] = instrument.id
    trade = InvestmentTrade(user_id=user_id, **kind.save(db, user_id, accounts, values))
    db.add(trade)
    return trade


def run_import(db: Session, user_id: int, data: bytes, save: bool) -> Report:
    """Checks every row and, with `save` and no row in error, saves the rows that aren't
    duplicates. Otherwise everything is rolled back, holdings added on the way included."""
    raw_rows = read_rows(data, SHEET, COLUMNS, REQUIRED)
    all_accounts = list(db.scalars(select(Account).where(Account.user_id == user_id)))
    names = AccountNames(all_accounts)
    accounts = lock_accounts(db, user_id, [a.id for a in all_accounts])
    holdings = Holdings(
        list(
            db.scalars(
                select(Instrument).where(
                    Instrument.user_id == user_id,
                    Instrument.kind.in_([STOCK, MUTUAL_FUND, CRYPTO]),
                )
            )
        )
    )
    existing = {
        (t.instrument_id, t.account_id, t.quantity, t.date, t.amount)
        for t in db.scalars(
            select(InvestmentTrade).where(
                InvestmentTrade.user_id == user_id, InvestmentTrade.opening.is_(True)
            )
        )
    }

    report = Report([])
    added = 0
    for number, raw in raw_rows:
        row = Row(
            number,
            _shown(raw, "Type"),
            _shown(raw, "Name"),
            _shown(raw, "Symbol"),
            _shown(raw, "Account"),
            _shown(raw, "Quantity"),
            _shown(raw, "Invested"),
            _shown(raw, "Date"),
        )
        report.rows.append(row)  # type: ignore[arg-type]
        kind, got, errors = _read(raw, names, accounts)
        if row.date is None:
            row.date = got["date"].isoformat()
        if errors or kind is None:
            row.status, row.errors = "error", errors
            continue
        try:
            trade = _check_row(db, user_id, kind, got, holdings, accounts, existing, row)
        except ValueError as error:
            row.status, row.errors = "error", [str(e) for e in error.args]
            continue
        except RequestValidationError as error:
            row.status, row.errors = "error", _messages(list(error.errors()), kind.columns)
            continue
        except HTTPException as error:
            row.status, row.errors = "error", [str(error.detail)]
            continue
        if trade is None:
            row.status = "duplicate"
            continue
        added += 1

    if save and report.problems == 0 and added:
        db.commit()
        report.imported = added
    else:
        db.rollback()
    return report


# The template


def template(db: Session, user_id: int) -> bytes:
    """An empty Holdings sheet with dropdowns for type and accounts, an example row, and a sheet
    explaining each column."""
    accounts = list(
        db.scalars(
            select(Account)
            .where(
                Account.user_id == user_id,
                Account.archived_at.is_(None),
                Account.type.in_(["broker", "bank"]),
            )
            .order_by(Account.name)
        )
    )
    book = Workbook()
    ws = book.active
    assert ws is not None
    ws.title = SHEET
    broker = next((a.name for a in accounts if a.type == "broker"), "My broker")
    write_sheet(
        ws,
        COLUMNS,
        [["stock", "Infosys", "INFY", broker, 10, "1500.00", "", today_india(), ""]],
    )

    lists = book.create_sheet("Lists")
    lists.append(["Type", "Account"])
    types = ["stock", "mutual fund", "crypto"]
    for i in range(max(len(types), len(accounts))):
        lists.append(
            [
                types[i] if i < len(types) else None,
                accounts[i].name if i < len(accounts) else None,
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

    dropdown("A", "A", len(types), True)
    dropdown("D", "B", len(accounts), False)

    help_sheet = book.create_sheet("How to fill")
    write_sheet(
        help_sheet,
        ["Column", "What to put"],
        [
            ["Type", "stock, mutual fund or crypto."],
            ["Name", "The company, fund or coin, like Infosys or Parag Parikh Flexi Cap."],
            [
                "Symbol",
                "Stocks and crypto: the ticker, like INFY or BTC. Funds: optional; one is made "
                "from the name if you leave it blank.",
            ],
            [
                "Account",
                "Where you hold it, named as in the app: a broker account for stocks and "
                "crypto, the bank account you buy from for mutual funds.",
            ],
            [
                "Quantity",
                "Shares (whole numbers), units (up to 3 decimals) or coins (up to 8 decimals).",
            ],
            ["Average price", "What you paid for each one, on average. Or leave it blank and"],
            ["Invested", "give the total you paid instead. If you give both, they must agree."],
            ["Date", "When you bought them, like 16-11-2026. Blank means today."],
            [
                "Market code",
                "Optional: the code that links live prices (an NSE symbol, an AMFI scheme code "
                "or a CoinGecko id). Used when the row adds a new holding.",
            ],
            [
                "",
                "Delete the example row before importing. Holdings you already have in the app "
                "are matched by symbol (funds: by symbol, or else by name), and a row matching "
                "an existing holding entry (same account, quantity, date and amount) is skipped. "
                "No money moves: these are holdings you already own.",
            ],
        ],
    )
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()
