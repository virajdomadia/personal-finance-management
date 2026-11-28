"""Any bank's statement file as a grid of cells: CSV, Excel (.xlsx and old .xls), the HTML some
banks save with an .xls name, and PDF (password-protected ones included).

This only turns a file into rows of cells. Finding the header and reading the transactions is
`app.export.statements`.
"""

import csv
import io
import zipfile
from datetime import date, datetime
from html.parser import HTMLParser
from typing import Any

from app.export.importing import MAX_BYTES, FileProblem

Grid = list[list[Any]]

MAX_PDF_PAGES = 200
_ENCODINGS = ("utf-8-sig", "cp1252", "latin-1")
SCANNED = (
    "This PDF is a scanned image, so Gullak can't read it. Download the statement as Excel or "
    "CSV, or use the password-protected PDF your bank emails you."
)


class PasswordNeeded(FileProblem):
    """The PDF is locked; `wrong` when a password was given and didn't open it."""

    def __init__(self, wrong: bool) -> None:
        self.wrong = wrong
        super().__init__(
            "That password didn't open the PDF. Check it and try again."
            if wrong
            else "This PDF is locked. Enter its password (often your date of birth or customer ID)."
        )


def read_grid(data: bytes, password: str | None = None) -> Grid:
    """Every row of every table in the file, in order, as cell values (text, numbers, dates)."""
    if len(data) > MAX_BYTES:
        raise FileProblem("The file is over 4 MB. Split it into smaller files.")
    if not data.strip():
        raise FileProblem("The file is empty.")
    if data.startswith(b"%PDF"):
        return _pdf(data, password)
    if data.startswith(b"PK"):
        return _xlsx(data)
    if data.startswith(b"\xd0\xcf\x11\xe0"):
        return _xls(data)
    text = _decode(data)
    if "<table" in text[:200000].casefold():
        return _html(text)
    return _csv(text)


def _decode(data: bytes) -> str:
    for encoding in _ENCODINGS:
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace")


def _xlsx(data: bytes) -> Grid:
    from openpyxl import load_workbook

    try:
        book = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except (zipfile.BadZipFile, KeyError, ValueError, OSError):
        raise FileProblem("This Excel file couldn't be opened. Save it again and retry.") from None
    try:
        grid: Grid = []
        for ws in book.worksheets:
            grid.extend(list(row) for row in ws.iter_rows(values_only=True))
        return grid
    finally:
        book.close()


def _xls(data: bytes) -> Grid:
    import xlrd

    try:
        book = xlrd.open_workbook(file_contents=data)
    except Exception:  # xlrd raises several unrelated types for a damaged file
        raise FileProblem("This Excel file couldn't be opened. Save it again and retry.") from None
    grid: Grid = []
    for sheet in book.sheets():
        for r in range(sheet.nrows):
            row = []
            for cell in sheet.row(r):
                if cell.ctype == xlrd.XL_CELL_DATE:
                    try:
                        row.append(xlrd.xldate_as_datetime(cell.value, book.datemode))
                    except (ValueError, OverflowError):
                        row.append(cell.value)
                elif cell.ctype == xlrd.XL_CELL_EMPTY:
                    row.append(None)
                else:
                    row.append(cell.value)
            grid.append(row)
    return grid


def _csv(text: str) -> Grid:
    sample = text[:20000]
    try:
        dialect: Any = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel_tab if sample.count("\t") > sample.count(",") else csv.excel
    return [list(row) for row in csv.reader(io.StringIO(text), dialect)]


class _Tables(HTMLParser):
    """Rows of every <table>, cells as their text."""

    def __init__(self) -> None:
        super().__init__()
        self.grid: Grid = []
        self.row: list[Any] | None = None
        self.cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []
        elif tag == "br" and self.cell is not None:
            self.cell.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self.row is not None and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split()) or None)
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.grid.append(self.row)
            self.row = None

    def handle_data(self, data: str) -> None:
        if self.cell is not None:
            self.cell.append(data)


def _html(text: str) -> Grid:
    parser = _Tables()
    parser.feed(text)
    parser.close()
    return parser.grid


def _pdf(data: bytes, password: str | None) -> Grid:
    import pdfplumber
    from pdfminer.pdfdocument import PDFPasswordIncorrect

    try:
        pdf = pdfplumber.open(io.BytesIO(data), password=password or "")
    except Exception as error:  # pdfminer raises many types for a damaged file
        # pdfplumber wraps pdfminer's errors, so the wrong-password one is found in its args.
        if isinstance(error, PDFPasswordIncorrect) or any(
            isinstance(arg, PDFPasswordIncorrect) for arg in error.args
        ):
            raise PasswordNeeded(wrong=bool(password)) from None
        raise FileProblem("This PDF couldn't be opened. Download it again and retry.") from None
    with pdf:
        if len(pdf.pages) > MAX_PDF_PAGES:
            raise FileProblem(f"The PDF has more than {MAX_PDF_PAGES} pages. Split it up.")
        if not any(page.chars for page in pdf.pages) and any(p.images for p in pdf.pages):
            # Saved from a phone or printed: each page is a picture of the statement.
            raise FileProblem(SCANNED)
        grid: Grid = []
        for page in pdf.pages:
            tables = page.extract_tables()
            if not tables:
                # No ruled lines: line the columns up by where the words sit.
                found = page.extract_table(
                    {"vertical_strategy": "text", "horizontal_strategy": "text"}
                )
                tables = [found] if found else []
            for table in tables:
                for row in table:
                    grid.append(
                        [None if c is None else " ".join(str(c).split()) or None for c in row]
                    )
        return grid


def cell_text(value: Any) -> str:
    """A cell as trimmed text ("" for empty)."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, datetime | date):
        return value.isoformat()
    return " ".join(str(value).split())
