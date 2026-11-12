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


def parse_navall(text: str) -> list[Quote]:
    quotes: list[Quote] = []
    for line in text.splitlines():
        fields = [f.strip() for f in line.split(";")]
        if len(fields) != 6 or not fields[0].isdigit():
            continue
        code, isin_growth, _reinvest, name, nav, nav_date = fields
        price = to_price(nav)
        try:
            price_date = datetime.strptime(nav_date, "%d-%b-%Y").date()
        except ValueError:
            price_date = None
            price = None
        quotes.append(
            Quote(
                kind="mutual_fund",
                code=code,
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


def parse_simple_price(data: dict) -> dict[str, Decimal]:
    prices: dict[str, Decimal] = {}
    for coin_id, quote in data.items():
        price = to_price(quote.get("inr")) if isinstance(quote, dict) else None
        if price is not None:
            prices[coin_id] = price
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
