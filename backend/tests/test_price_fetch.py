import io
import zipfile
from datetime import date
from decimal import Decimal

import httpx
import pytest

from app.prices.fetch import Fetcher, SourceError, SourceTimeout


def make_fetcher(handler, headers=None) -> tuple[Fetcher, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client = httpx.Client(transport=httpx.MockTransport(wrapped), headers=headers or {})
    return Fetcher(client), seen


def zipped(name: str, body: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(name, body)
    return buf.getvalue()


def test_bhavcopy_404_is_none():
    fetcher, seen = make_fetcher(lambda r: httpx.Response(404))
    assert fetcher.bhavcopy(date(2026, 11, 12)) is None
    assert seen[0].url.path.endswith("BhavCopy_NSE_CM_0_0_0_20261112_F_0000.csv.zip")


def test_bhavcopy_unzips_csv():
    body = zipped("bhav.csv", "\ufeffTckrSymb,ClsPric\nTCS,4000.5\n".encode())
    fetcher, _ = make_fetcher(lambda r: httpx.Response(200, content=body))
    text = fetcher.bhavcopy(date(2026, 11, 12))
    assert text == "TckrSymb,ClsPric\nTCS,4000.5\n"


def test_bad_zip_raises_source_error():
    fetcher, _ = make_fetcher(lambda r: httpx.Response(200, content=b"not a zip"))
    with pytest.raises(SourceError):
        fetcher.bhavcopy(date(2026, 11, 12))


def test_html_error_page_raises_source_error():
    fetcher, _ = make_fetcher(
        lambda r: httpx.Response(
            200, text="<html>blocked</html>", headers={"content-type": "text/html"}
        )
    )
    with pytest.raises(SourceError):
        fetcher.yahoo_chart("TCS")


def test_non_2xx_raises_source_error():
    fetcher, _ = make_fetcher(lambda r: httpx.Response(503))
    with pytest.raises(SourceError):
        fetcher.navall()


def test_network_error_raises_source_error():
    def boom(request):
        raise httpx.ConnectError("down")

    fetcher, _ = make_fetcher(boom)
    with pytest.raises(SourceError):
        fetcher.equity_list()


def test_equity_list_strips_bom():
    fetcher, _ = make_fetcher(lambda r: httpx.Response(200, content=b"\xef\xbb\xbfSYMBOL,NAME\n"))
    assert fetcher.equity_list().startswith("SYMBOL")


def test_simple_price_keeps_decimal():
    fetcher, seen = make_fetcher(
        lambda r: httpx.Response(200, text='{"bitcoin": {"inr": 5400000.12}}')
    )
    data = fetcher.simple_price(["bitcoin", "ethereum"])
    assert data["bitcoin"]["inr"] == Decimal("5400000.12")
    assert seen[0].url.params["ids"] == "bitcoin,ethereum"
    assert seen[0].url.params["vs_currencies"] == "inr"


def test_coin_search_and_yahoo_urls():
    fetcher, seen = make_fetcher(lambda r: httpx.Response(200, text="{}"))
    fetcher.coin_search("bit")
    fetcher.yahoo_chart("TCS")
    assert seen[0].url.params["query"] == "bit"
    assert seen[1].url.path.endswith("/v8/finance/chart/TCS.NS")


def test_no_api_key_header_when_unset(monkeypatch):
    from app.core.config import get_settings
    from app.prices.fetch import default_fetcher

    monkeypatch.setenv("COINGECKO_API_KEY", "")
    get_settings.cache_clear()
    try:
        fetcher = default_fetcher()
        assert fetcher.coingecko_key == ""
        assert "x-cg-demo-api-key" not in fetcher.client.headers
        assert "user-agent" in fetcher.client.headers
    finally:
        get_settings.cache_clear()


def test_api_key_only_on_coingecko_requests(monkeypatch):
    from app.core.config import get_settings
    from app.prices.fetch import default_fetcher

    monkeypatch.setenv("COINGECKO_API_KEY", "secret")
    get_settings.cache_clear()
    try:
        fetcher = default_fetcher()
        seen: list[httpx.Request] = []

        def handler(request):
            seen.append(request)
            return httpx.Response(200, text="{}")

        fetcher.client = httpx.Client(transport=httpx.MockTransport(handler))
        fetcher.simple_price(["bitcoin"])
        fetcher.yahoo_chart("TCS")
        assert seen[0].headers["x-cg-demo-api-key"] == "secret"
        assert "x-cg-demo-api-key" not in seen[1].headers
    finally:
        get_settings.cache_clear()


def test_corrupt_deflate_member_raises_source_error():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("bhav.csv", b"TckrSymb,ClsPric\n" + b"TCS,4000.5\n" * 200)
    data = bytearray(buf.getvalue())
    start = 30 + len("bhav.csv")
    for i in range(start, start + 20):
        data[i] ^= 0xFF
    fetcher, _ = make_fetcher(lambda r: httpx.Response(200, content=bytes(data)))
    with pytest.raises(SourceError):
        fetcher.bhavcopy(date(2026, 11, 12))


def test_timeout_is_a_source_timeout():
    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    fetcher, _ = make_fetcher(slow)
    with pytest.raises(SourceTimeout):
        fetcher.bhavcopy(date(2026, 11, 12))


def test_nse_requests_get_a_shorter_timeout():
    fetcher, seen = make_fetcher(lambda r: httpx.Response(404))
    fetcher.client.timeout = httpx.Timeout(20)
    fetcher.bhavcopy(date(2026, 11, 12))
    assert seen[0].extensions["timeout"] == {"connect": 5, "read": 8, "write": 8, "pool": 8}


def test_other_requests_keep_the_client_timeout():
    fetcher, seen = make_fetcher(lambda r: httpx.Response(200, content=b"x"))
    fetcher.client.timeout = httpx.Timeout(20)
    fetcher.navall()
    assert seen[0].extensions["timeout"]["read"] == 20


def test_fetcher_closes_its_client():
    fetcher, _ = make_fetcher(lambda r: httpx.Response(200))
    with fetcher as f:
        assert f is fetcher
    assert fetcher.client.is_closed
