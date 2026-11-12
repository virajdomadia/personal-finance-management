"""A Fetcher that serves the fixture files instead of the network, for the price job's tests."""

import json
from collections import Counter
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx

from app.prices.fetch import Fetcher, SourceError

FIXTURES = Path(__file__).parent / "fixtures" / "prices"

# What the fixtures hold, so tests can assert on it.
FUND_CODE, FUND_NAV, FUND_DATE = "119551", Decimal("101.2345"), date(2026, 11, 11)
STOCK_CODE, STOCK_CLOSE, STOCK_DATE = "RELIANCE", Decimal("1312.45"), date(2026, 11, 11)
COIN_ID, COIN_PRICE = "bitcoin", Decimal("9123456.78")


def read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeFetcher(Fetcher):
    """`fail` names the methods that raise SourceError; `holiday` makes bhavcopy return None."""

    def __init__(self, fail: set[str] | None = None, holiday: bool = False):
        super().__init__(httpx.Client())
        self.fail = fail or set()
        self.holiday = holiday
        self.calls: Counter[str] = Counter()

    def _hit(self, method: str) -> None:
        self.calls[method] += 1
        if method in self.fail:
            raise SourceError(f"{method} is down")

    def navall(self) -> str:
        self._hit("navall")
        return read("navall.txt")

    def equity_list(self) -> str:
        self._hit("equity_list")
        return read("equity_l.csv")

    def bhavcopy(self, day: date) -> str | None:
        self._hit("bhavcopy")
        return None if self.holiday else read("bhavcopy.csv")

    def simple_price(self, ids: list[str]) -> dict:
        self._hit("simple_price")
        data = json.loads(read("simple_price.json"), parse_float=Decimal)
        return {k: v for k, v in data.items() if k in ids}

    def coin_search(self, query: str) -> dict:
        self._hit("coin_search")
        return json.loads(read("search.json"), parse_float=Decimal)

    def yahoo_chart(self, symbol: str) -> dict:
        self._hit("yahoo_chart")
        return json.loads(read("yahoo_chart.json"), parse_float=Decimal)
