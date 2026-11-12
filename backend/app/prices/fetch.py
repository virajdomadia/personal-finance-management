"""The only place that touches the network: one Fetcher over an injected httpx client."""

import io
import json
import zipfile
import zlib
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
# CoinDCX's public ticker: every market's last traded price, no key needed.
COINDCX_TICKER_URL = "https://api.coindcx.com/exchange/ticker"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TIMEOUT_SECONDS = 20
# NSE can hang from cloud IPs; give up on it sooner so the nightly job stays inside its limit.
NSE_TIMEOUT = httpx.Timeout(8, connect=5)


class SourceError(Exception):
    """A network, status or format failure from a price source."""


class SourceTimeout(SourceError):
    """The source did not answer in time."""


class Fetcher:
    """Owns its client: use it as a context manager, or call close(), when done."""

    def __init__(self, client: httpx.Client, coingecko_key: str = ""):
        self.client = client
        self.coingecko_key = coingecko_key

    def __enter__(self) -> "Fetcher":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        self.client.close()

    def _get(
        self,
        url: str,
        params: dict | None = None,
        headers: dict | None = None,
        timeout: httpx.Timeout | None = None,
    ):
        kwargs = {} if timeout is None else {"timeout": timeout}
        try:
            return self.client.get(url, params=params, headers=headers, **kwargs)
        except httpx.TimeoutException as exc:
            raise SourceTimeout(f"request timed out: {exc.__class__.__name__}") from exc
        except httpx.HTTPError as exc:
            raise SourceError(f"request failed: {exc.__class__.__name__}") from exc

    def _ok(self, url: str, params=None, headers=None, timeout=None) -> httpx.Response:
        response = self._get(url, params, headers, timeout)
        if not response.is_success:
            raise SourceError(f"HTTP {response.status_code} from {response.url.host}")
        return response

    def _text(self, url: str, timeout: httpx.Timeout | None = None) -> str:
        return self._ok(url, timeout=timeout).content.decode("utf-8-sig", errors="replace")

    def _any_json(self, url: str, params=None, headers=None):
        body = self._ok(url, params, headers).content.decode("utf-8-sig", errors="replace")
        try:
            return json.loads(body, parse_float=Decimal)
        except ValueError as exc:
            raise SourceError("response was not valid JSON") from exc

    def _json(self, url: str, params=None, headers=None) -> dict:
        data = self._any_json(url, params, headers)
        if not isinstance(data, dict):
            raise SourceError("unexpected JSON shape")
        return data

    def _coingecko_headers(self) -> dict | None:
        return {"x-cg-demo-api-key": self.coingecko_key} if self.coingecko_key else None

    def navall(self) -> str:
        return self._text(AMFI_URL)

    def equity_list(self) -> str:
        return self._text(EQUITY_LIST_URL, NSE_TIMEOUT)

    def bhavcopy(self, day: date) -> str | None:
        response = self._get(BHAVCOPY_URL.format(day=day.strftime("%Y%m%d")), timeout=NSE_TIMEOUT)
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
        except (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError) as exc:
            raise SourceError("bhavcopy was not a readable zip") from exc
        return raw.decode("utf-8-sig", errors="replace")

    def simple_price(self, ids: list[str]) -> dict:
        params = {"ids": ",".join(ids), "vs_currencies": "inr"}
        return self._json(COINGECKO_PRICE_URL, params, self._coingecko_headers())

    def coindcx_ticker(self) -> list:
        data = self._any_json(COINDCX_TICKER_URL)
        if not isinstance(data, list):
            raise SourceError("unexpected JSON shape")
        return data

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
