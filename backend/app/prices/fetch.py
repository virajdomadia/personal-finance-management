"""The only place that touches the network: one Fetcher over an injected httpx client."""

import io
import json
import zipfile
from datetime import date
from decimal import Decimal

import httpx

from app.core.config import get_settings

AMFI_URL = "https://portal.amfiindia.com/spages/NAVAll.txt"
EQUITY_LIST_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
BHAVCOPY_URL = (
    "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{day}_F_0000.csv.zip"
)
YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}.NS"
COINGECKO_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price"
COINGECKO_SEARCH_URL = "https://api.coingecko.com/api/v3/search"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TIMEOUT_SECONDS = 20


class SourceError(Exception):
    """A network, status or format failure from a price source."""


class Fetcher:
    def __init__(self, client: httpx.Client, coingecko_key: str = ""):
        self.client = client
        self.coingecko_key = coingecko_key

    def _get(self, url: str, params: dict | None = None, headers: dict | None = None):
        try:
            return self.client.get(url, params=params, headers=headers)
        except httpx.HTTPError as exc:
            raise SourceError(f"request failed: {exc.__class__.__name__}") from exc

    def _ok(self, url: str, params=None, headers=None) -> httpx.Response:
        response = self._get(url, params, headers)
        if not response.is_success:
            raise SourceError(f"HTTP {response.status_code} from {response.url.host}")
        return response

    def _text(self, url: str) -> str:
        return self._ok(url).content.decode("utf-8-sig", errors="replace")

    def _json(self, url: str, params=None, headers=None) -> dict:
        body = self._ok(url, params, headers).content.decode("utf-8-sig", errors="replace")
        try:
            data = json.loads(body, parse_float=Decimal)
        except ValueError as exc:
            raise SourceError("response was not valid JSON") from exc
        if not isinstance(data, dict):
            raise SourceError("unexpected JSON shape")
        return data

    def _coingecko_headers(self) -> dict | None:
        return {"x-cg-demo-api-key": self.coingecko_key} if self.coingecko_key else None

    def navall(self) -> str:
        return self._text(AMFI_URL)

    def equity_list(self) -> str:
        return self._text(EQUITY_LIST_URL)

    def bhavcopy(self, day: date) -> str | None:
        response = self._get(BHAVCOPY_URL.format(day=day.strftime("%Y%m%d")))
        if response.status_code == 404:
            return None
        if not response.is_success:
            raise SourceError(f"HTTP {response.status_code} from {response.url.host}")
        try:
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                names = archive.namelist()
                if len(names) != 1:
                    raise SourceError("bhavcopy zip did not hold exactly one file")
                raw = archive.read(names[0])
        except zipfile.BadZipFile as exc:
            raise SourceError("bhavcopy was not a valid zip") from exc
        return raw.decode("utf-8-sig", errors="replace")

    def simple_price(self, ids: list[str]) -> dict:
        params = {"ids": ",".join(ids), "vs_currencies": "inr"}
        return self._json(COINGECKO_PRICE_URL, params, self._coingecko_headers())

    def coin_search(self, query: str) -> dict:
        return self._json(COINGECKO_SEARCH_URL, {"query": query}, self._coingecko_headers())

    def yahoo_chart(self, symbol: str) -> dict:
        return self._json(YAHOO_URL.format(symbol=symbol))


def default_fetcher() -> Fetcher:
    key = get_settings().coingecko_api_key
    client = httpx.Client(
        timeout=TIMEOUT_SECONDS, headers={"User-Agent": USER_AGENT}, follow_redirects=True
    )
    return Fetcher(client, coingecko_key=key)
