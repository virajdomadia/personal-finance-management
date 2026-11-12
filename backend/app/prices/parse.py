"""Pure parsers for the price sources. No network and no database.

Prices always go text -> Decimal; JSON numbers must be loaded with
``json.loads(..., parse_float=Decimal)`` by the caller so nothing passes through float.
"""

import csv
import io
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

IST = timezone(timedelta(hours=5, minutes=30))
EQUITY_SERIES = {"EQ", "BE"}
COIN_SEARCH_LIMIT = 20
_PLACES = Decimal("0.0001")
_MAX_PRICE = Decimal(10) ** 10  # exclusive: the price column is Numeric(14, 4)


@dataclass(frozen=True)
class Quote:
    kind: str
    code: str
    name: str
    isin: str | None
    price: Decimal | None
    price_date: date | None


def to_price(text: str | int | Decimal | None) -> Decimal | None:
    """Round to 4 places half-up; None unless the value is finite and positive."""
    if text is None or isinstance(text, bool):
        return None
    try:
        value = Decimal(str(text).strip())
    except InvalidOperation:
        return None
    if not value.is_finite() or value <= 0 or value >= _MAX_PRICE:
        return None
    price = value.quantize(_PLACES, rounding=ROUND_HALF_UP)
    return price if 0 < price < _MAX_PRICE else None


def _isin(value: str) -> str | None:
    value = value.strip()
    return None if value in ("", "-") else value


_NAVALL_OLD_HEADER = [
    "scheme code",
    "isin div payout/ isin growth",
    "isin div reinvestment",
    "scheme name",
    "net asset value",
    "date",
]


def _navall_columns(header: list[str]) -> dict[str, int]:
    return {name.strip().lower(): i for i, name in enumerate(header)}


def parse_navall(text: str) -> list[Quote]:
    """Columns are found by name from the header, which AMFI re-sends and has changed before."""
    columns = _navall_columns(_NAVALL_OLD_HEADER)
    width = len(_NAVALL_OLD_HEADER)
    quotes: list[Quote] = []
    for line in text.splitlines():
        fields = [f.strip() for f in line.split(";")]
        if fields[0].lower() == "scheme code":
            columns, width = _navall_columns(fields), len(fields)
            continue
        if len(fields) != width or not fields[0].isdigit():
            continue
        try:
            nav_date = fields[columns["date"]]
            nav = fields[columns["net asset value"]]
            name = fields[columns["scheme name"]]
            isin_growth = fields[columns["isin div payout/ isin growth"]]
        except KeyError:
            continue
        # The newer file splits "Direct Plan" / "Growth" out of the name; keep them in it.
        extras = [fields[columns[c]] for c in ("plan", "option") if c in columns]
        name = " - ".join([name, *(e for e in extras if e and e.lower() not in name.lower())])
        price = to_price(nav)
        try:
            price_date = datetime.strptime(nav_date, "%d-%b-%Y").date()
        except ValueError:
            price_date = None
            price = None
        quotes.append(
            Quote(
                kind="mutual_fund",
                code=fields[columns["scheme code"]],
                name=name,
                isin=_isin(isin_growth),
                price=price,
                price_date=price_date if price is not None else None,
            )
        )
    return quotes


def _rows(text: str) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(text))
    reader.fieldnames = [(name or "").strip() for name in reader.fieldnames or []]
    return [{k: (v or "").strip() for k, v in row.items() if k} for row in reader]


def parse_equity_list(text: str) -> list[Quote]:
    quotes: list[Quote] = []
    for row in _rows(text):
        symbol = row.get("SYMBOL", "")
        if not symbol:
            continue
        quotes.append(
            Quote(
                kind="stock",
                code=symbol,
                name=row.get("NAME OF COMPANY", ""),
                isin=_isin(row.get("ISIN NUMBER", "")),
                price=None,
                price_date=None,
            )
        )
    return quotes


def parse_bhavcopy(text: str) -> dict[str, tuple[Decimal, date]]:
    closes: dict[str, tuple[Decimal, date]] = {}
    for row in _rows(text):
        if row.get("SctySrs") not in EQUITY_SERIES:
            continue
        price = to_price(row.get("ClsPric", ""))
        try:
            trade_date = date.fromisoformat(row.get("TradDt", ""))
        except ValueError:
            continue
        symbol = row.get("TckrSymb", "")
        if symbol and price is not None:
            closes[symbol] = (price, trade_date)
    return closes


def parse_bhavcopy_listings(text: str) -> list[Quote]:
    """Every security in the price file, with its name and ISIN as NSE prints them.

    ETFs (gold, silver, index funds) trade like shares but are missing from NSE's equity list,
    so this is how they become searchable.
    """
    quotes: list[Quote] = []
    for row in _rows(text):
        if row.get("SctySrs") not in EQUITY_SERIES:
            continue
        symbol = row.get("TckrSymb", "")
        price = to_price(row.get("ClsPric", ""))
        try:
            trade_date = date.fromisoformat(row.get("TradDt", ""))
        except ValueError:
            continue
        if not symbol or price is None:
            continue
        name = (row.get("FinInstrmNm") or "").strip() or symbol
        isin = (row.get("ISIN") or "").strip() or None
        quotes.append(Quote("stock", symbol, name, isin, price, trade_date))
    return quotes


def parse_simple_price(data: dict) -> dict[str, Decimal]:
    prices: dict[str, Decimal] = {}
    for coin_id, quote in data.items():
        price = to_price(quote.get("inr")) if isinstance(quote, dict) else None
        if price is not None:
            prices[coin_id] = price
    return prices


def parse_coindcx_ticker(data: list) -> dict[str, Decimal]:
    """CoinDCX's INR markets, like "BTCINR", to their last traded price."""
    prices: dict[str, Decimal] = {}
    for item in data:
        if not isinstance(item, dict):
            continue
        market = str(item.get("market") or "").upper()
        price = to_price(item.get("last_price"))
        if market.endswith("INR") and price is not None:
            prices[market] = price
    return prices


def parse_coin_search(data: dict) -> list[Quote]:
    quotes: list[Quote] = []
    for coin in (data.get("coins") or [])[:COIN_SEARCH_LIMIT]:
        quotes.append(
            Quote(
                kind="crypto",
                code=coin["id"],
                name=f"{coin['name']} ({str(coin['symbol']).upper()})",
                isin=None,
                price=None,
                price_date=None,
            )
        )
    return quotes


def parse_yahoo_close(data: dict) -> tuple[Decimal, date] | None:
    results = (data.get("chart") or {}).get("result") or []
    if not results:
        return None
    result = results[0]
    stamps = result.get("timestamp") or []
    closes = ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    latest: tuple[Decimal, date] | None = None
    for stamp, close in zip(stamps, closes, strict=False):
        price = to_price(close)
        if price is not None:
            latest = (price, datetime.fromtimestamp(int(stamp), UTC).astimezone(IST).date())
    return latest
