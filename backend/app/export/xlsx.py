"""The user's data as one Excel workbook: the same tables as the CSV zip, one sheet each.

Cells are typed so Excel can sum and sort them: money and quantities are numbers, dates are
dates, yes/no stays text. Every text cell is stored as text, never as a formula, so a name that
starts with "=" is shown as written.
"""

import io
import re
from collections.abc import Iterable
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from openpyxl import Workbook
from openpyxl.cell.cell import Cell
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet
from sqlalchemy.orm import Session

from app.export.csv_export import Sheet, sheets

XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
# A number we wrote ourselves: no leading zeros (so "0123", the last 4 digits, stays text).
NUMBER = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?")
ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
DATE_FORMAT = "d mmm yyyy"
MONEY_FORMAT = "#,##0.00"
HEADER_FONT = Font(bold=True)
HEADER_FILL = PatternFill("solid", fgColor="FFF2CC")
MAX_WIDTH = 50


def typed(value: Any) -> Any:
    """The value as Excel should hold it."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date | Decimal | int):
        return value
    text = str(value)
    if NUMBER.fullmatch(text):
        return Decimal(text)
    if ISO_DATE.fullmatch(text):
        try:
            return date.fromisoformat(text)
        except ValueError:
            return text
    return text


def _format(cell: Cell, value: Any) -> None:
    if isinstance(value, str):
        cell.data_type = "s"  # never a formula
    elif isinstance(value, date):
        cell.number_format = DATE_FORMAT
    elif isinstance(value, Decimal) and value.as_tuple().exponent == -2:
        cell.number_format = MONEY_FORMAT


def write_sheet(ws: Worksheet, headers: list[str], rows: Iterable[list[Any]]) -> None:
    ws.append(headers)
    for cell in ws[1]:
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
    widths = [len(h) for h in headers]
    for row in rows:
        values = [typed(v) for v in row]
        ws.append(values)
        for i, (cell, value) in enumerate(zip(ws[ws.max_row], values, strict=False)):
            _format(cell, value)
            shown = 11 if isinstance(value, date) else len(str(value)) if value is not None else 0
            widths[i] = max(widths[i], shown)
    for i, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = min(width + 2, MAX_WIDTH)
    ws.freeze_panes = "A2"


def sheet_title(name: str) -> str:
    """`stock_trades` -> `Stock trades` (Excel allows 31 characters)."""
    return name.replace("_", " ").capitalize()[:31]


def to_xlsx(tables: dict[str, Sheet]) -> bytes:
    workbook = Workbook()
    first = True
    for name, sheet in tables.items():
        if first:
            ws = workbook.active
            assert ws is not None
            ws.title = sheet_title(name)
            first = False
        else:
            ws = workbook.create_sheet(sheet_title(name))
        write_sheet(ws, sheet.headers, sheet.rows)
    out = io.BytesIO()
    workbook.save(out)
    return out.getvalue()


def build_workbook(db: Session, user_id: int) -> bytes:
    return to_xlsx(sheets(db, user_id))
