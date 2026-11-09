"""Golden stock figures: today's stock API output, pinned so later schema work can't change it.

Seeds a database at the stocks revision with plain SQL, upgrades it to head, and compares every
stock-related response with `fixtures/stock_figures.json`. The fixture is never edited by hand.
Regenerate it only on code known to be right: `WRITE_STOCK_FIGURES=1 uv run pytest <this file>`.
New keys in a response are allowed; anything the fixture holds must stay exactly as it is.
"""

import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, Engine, create_engine, make_url, text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import create_token
from app.db.session import get_db
from app.main import app
from tests.conftest import PG_URL, _ensure_database, alembic_config, reset_schema

pytestmark = pytest.mark.postgres

STOCKS_REVISION = "65f46a0f545a"
FIXTURE = Path(__file__).parent / "fixtures" / "stock_figures.json"
SECRET = "test-secret"
STAMP = "2026-10-01 00:00:00+00"
INFY, TCS, HDFCBANK = 1, 2, 3


@pytest.fixture
def figures_db() -> Iterator[str]:
    url = make_url(PG_URL)
    name = (url.database or "").removesuffix("_test") + "_figures_test"
    own = url.set(database=name).render_as_string(hide_password=False)
    _ensure_database(own)
    engine = create_engine(own)
    reset_schema(engine)
    yield own
    reset_schema(engine)
    engine.dispose()


def seed_stock_data(conn: Connection) -> None:
    """The owner's shape of data: an opening buy, odd-paise charges, a partial sell, a closed
    position at a second broker, a stock with no price and two prices on one day."""
    conn.execute(
        text(
            "INSERT INTO users (id, email, session_version, created_at) "
            "VALUES (1, 'me@example.com', 1, :s)"
        ),
        {"s": STAMP},
    )
    accounts = [
        (1, "broker", "Zerodha", "50000.00", "Zerodha"),
        (2, "broker", "Groww", "1000.00", "Groww"),
        (3, "bank", "SBI", "25000.00", "SBI"),
    ]
    for id_, type_, name, opening, institution in accounts:
        conn.execute(
            text(
                "INSERT INTO accounts (id, user_id, type, name, opening_balance, institution,"
                " created_at, updated_at) VALUES (:id, 1, :t, :n, :o, :i, :s, :s)"
            ),
            {"id": id_, "t": type_, "n": name, "o": opening, "i": institution, "s": STAMP},
        )
    for id_, symbol, name in [
        (INFY, "INFY", "Infosys"),
        (TCS, "TCS", "Tata Consultancy Services"),
        (HDFCBANK, "HDFCBANK", "HDFC Bank"),
    ]:
        conn.execute(
            text(
                "INSERT INTO stocks (id, user_id, symbol, name, created_at, updated_at) "
                "VALUES (:id, 1, :sy, :n, :s, :s)"
            ),
            {"id": id_, "sy": symbol, "n": name, "s": STAMP},
        )
    trades = [
        # id, stock, account, side, date, quantity, price, charges, opening
        (1, INFY, 1, "buy", "2026-10-01", 10, "1450.25", "0.00", True),
        (2, INFY, 1, "buy", "2026-10-05", 5, "1500.10", "15.33", False),
        (3, INFY, 1, "sell", "2026-10-12", 7, "1620.40", "21.07", False),
        (4, TCS, 2, "buy", "2026-10-03", 4, "3900.50", "9.99", False),
        (5, TCS, 2, "sell", "2026-10-20", 4, "4010.75", "11.05", False),
        (6, HDFCBANK, 1, "buy", "2026-10-15", 3, "1601.00", "4.99", False),
    ]
    for id_, stock, account, side, day, qty, price, charges, opening in trades:
        conn.execute(
            text(
                "INSERT INTO stock_trades (id, user_id, stock_id, account_id, side, date,"
                " quantity, price, charges, opening, created_at, updated_at) VALUES"
                " (:id, 1, :st, :ac, :sd, :d, :q, :p, :c, :op, :s, :s)"
            ),
            {
                "id": id_, "st": stock, "ac": account, "sd": side, "d": day, "q": qty,
                "p": price, "c": charges, "op": opening, "s": STAMP,
            },
        )  # fmt: skip
    prices = [
        (1, INFY, "2026-10-25", "1700.00"),
        (2, INFY, "2026-10-25", "1710.55"),  # same day, later id wins
        (3, TCS, "2026-10-20", "4010.75"),
    ]
    for id_, stock, day, price in prices:
        conn.execute(
            text(
                "INSERT INTO stock_prices (id, user_id, stock_id, date, price, created_at) "
                "VALUES (:id, 1, :st, :d, :p, :s)"
            ),
            {"id": id_, "st": stock, "d": day, "p": price, "s": STAMP},
        )


def stock_responses(engine: Engine) -> dict[str, Any]:
    paths = [
        "/api/investments/stocks",
        "/api/investments/trades",
        "/api/investments/portfolio",
        *(f"/api/investments/stocks/{id_}/prices" for id_ in (INFY, TCS, HDFCBANK)),
        "/api/accounts",
        "/api/dashboard",
    ]
    settings = get_settings()
    saved = (settings.token_secret, settings.environment)
    settings.token_secret, settings.environment = SECRET, "production"
    previous = app.dependency_overrides.get(get_db)
    session = Session(engine, expire_on_commit=False)
    app.dependency_overrides[get_db] = lambda: session
    headers = {"Authorization": f"Bearer {create_token(1, 1, SECRET)}"}
    try:
        client = TestClient(app)
        out: dict[str, Any] = {}
        for path in paths:
            response = client.get(path, headers=headers)
            assert response.status_code == 200, (path, response.text)
            out[path] = response.json()
        return out
    finally:
        session.close()
        settings.token_secret, settings.environment = saved
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous


def assert_holds(actual: Any, golden: Any, where: str) -> None:
    """Everything the fixture holds must be unchanged; dicts may gain keys."""
    if isinstance(golden, dict):
        assert isinstance(actual, dict), where
        for key, value in golden.items():
            assert key in actual, f"{where}.{key} is missing"
            assert_holds(actual[key], value, f"{where}.{key}")
    elif isinstance(golden, list):
        assert isinstance(actual, list), where
        assert len(actual) == len(golden), f"{where}: {len(actual)} items, not {len(golden)}"
        for i, (a, g) in enumerate(zip(actual, golden, strict=True)):
            assert_holds(a, g, f"{where}[{i}]")
    else:
        same = actual == golden and type(actual) is type(golden)
        assert same, f"{where}: {actual!r} != {golden!r}"


def test_stock_figures_survive_every_migration(figures_db: str) -> None:
    config = alembic_config(figures_db)
    command.upgrade(config, STOCKS_REVISION)  # pinned: never `head`, for seeding
    engine = create_engine(figures_db)
    try:
        with engine.begin() as conn:
            seed_stock_data(conn)
        command.upgrade(config, "head")
        responses = stock_responses(engine)
    finally:
        engine.dispose()

    if os.environ.get("WRITE_STOCK_FIGURES") == "1":
        FIXTURE.write_text(json.dumps(responses, indent=2, sort_keys=True) + "\n")
        pytest.skip(f"wrote {FIXTURE.name}")
    golden = json.loads(FIXTURE.read_text())
    assert set(golden) <= set(responses)
    for path, expected in golden.items():
        assert_holds(responses[path], expected, path)
