"""Golden fund figures: today's mutual fund API output, pinned so later schema work can't change it.

Seeds a database at the deposits revision with plain SQL, upgrades it to head, and compares every
fund-related response with `fixtures/fund_figures.json`. The fixture is never edited by hand.
Regenerate it only on code known to be right: `WRITE_FUND_FIGURES=1 uv run pytest <this file>`.
New keys in a response are allowed; anything the fixture holds must stay exactly as it is.
"""

import json
import os
from collections.abc import Iterator
from datetime import date
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

DEPOSITS_REVISION = "3b8f2c61a7d4"
FIXTURE = Path(__file__).parent / "fixtures" / "fund_figures.json"
SECRET = "test-secret"
STAMP = "2026-10-01 00:00:00+00"
PPFCRG, SECOND = 1, 2
TODAY = date(2026, 11, 9)


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


def seed_fund_data(conn: Connection) -> None:
    """The owner's shape of data: a SIP-linked opening lot, a SIP purchase with charges and its
    NAV, a partial redemption, and a second fund with an opening lot and a manual NAV."""
    conn.execute(
        text(
            "INSERT INTO users (id, email, session_version, created_at) "
            "VALUES (1, 'me@example.com', 1, :s)"
        ),
        {"s": STAMP},
    )
    conn.execute(
        text(
            "INSERT INTO accounts (id, user_id, type, name, opening_balance, institution,"
            " created_at, updated_at) VALUES (1, 1, 'bank', 'SBI', '50000.00', 'SBI', :s, :s)"
        ),
        {"s": STAMP},
    )
    for id_, symbol, name in [
        (PPFCRG, "PPFCRG", "Parag Parikh Flexi Cap"),
        (SECOND, "SECOND", "Second Fund"),
    ]:
        conn.execute(
            text(
                "INSERT INTO instruments (id, user_id, kind, symbol, name, created_at, updated_at)"
                " VALUES (:id, 1, 'mutual_fund', :sy, :n, :s, :s)"
            ),
            {"id": id_, "sy": symbol, "n": name, "s": STAMP},
        )
    conn.execute(
        text(
            "INSERT INTO sips (id, user_id, instrument_id, account_id, amount, day, start_date,"
            " active, created_at, updated_at) VALUES (1, 1, :f, 1, '3000.00', 5, '2026-05-05',"
            " true, :s, :s)"
        ),
        {"f": PPFCRG, "s": STAMP},
    )
    trades = [
        # id, fund, side, date, units, nav, charges, amount, opening, sip
        (1, PPFCRG, "buy", "2026-05-05", "253.462", "82.8527", "0.00", "21000.00", True, 1),
        (2, PPFCRG, "buy", "2026-11-05", "35.552", "84.3793", "0.15", "3000.00", False, None),
        (3, PPFCRG, "sell", "2026-11-07", "10.000", "86.0000", "0.00", "860.00", False, None),
        (4, SECOND, "buy", "2026-09-01", "21.984", "636.8268", "0.00", "14000.00", True, None),
    ]
    for id_, fund, side, day, units, nav, charges, amount, opening, sip in trades:
        conn.execute(
            text(
                "INSERT INTO investment_trades (id, user_id, instrument_id, account_id, side, date,"
                " quantity, price, charges, amount, opening, sip_id, created_at, updated_at)"
                " VALUES (:id, 1, :f, 1, :sd, :d, :q, :p, :c, :a, :op, :sip, :s, :s)"
            ),
            {
                "id": id_, "f": fund, "sd": side, "d": day, "q": units, "p": nav, "c": charges,
                "a": amount, "op": opening, "sip": sip, "s": STAMP,
            },
        )  # fmt: skip
    prices = [
        # id, fund, date, nav, trade
        (1, PPFCRG, "2026-11-05", "84.3793", 2),  # the purchase's own NAV
        (2, SECOND, "2026-11-08", "635.0943", None),  # entered by hand
    ]
    for id_, fund, day, price, trade in prices:
        conn.execute(
            text(
                "INSERT INTO instrument_prices (id, user_id, instrument_id, date, price, trade_id,"
                " created_at) VALUES (:id, 1, :f, :d, :p, :t, :s)"
            ),
            {"id": id_, "f": fund, "d": day, "p": price, "t": trade, "s": STAMP},
        )


def fund_responses(engine: Engine) -> dict[str, Any]:
    paths = [
        "/api/investments/funds",
        "/api/investments/fund-trades",
        "/api/investments/sips",
        "/api/investments/portfolio",
        *(f"/api/investments/funds/{id_}/navs" for id_ in (PPFCRG, SECOND)),
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


def test_fund_figures_survive_every_migration(
    figures_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    for module in (
        "dates",
        "routes.dashboard",
        "routes.funds",
        "routes.fund_trades",
        "routes.sips",
        "routes.accounts",
        "routes.portfolio",
    ):
        monkeypatch.setattr(f"app.api.{module}.today_india", lambda: TODAY)
    config = alembic_config(figures_db)
    command.upgrade(config, DEPOSITS_REVISION)  # pinned: never `head`, for seeding
    engine = create_engine(figures_db)
    try:
        with engine.begin() as conn:
            seed_fund_data(conn)
        command.upgrade(config, "head")
        responses = fund_responses(engine)
    finally:
        engine.dispose()

    if os.environ.get("WRITE_FUND_FIGURES") == "1":
        FIXTURE.write_text(json.dumps(responses, indent=2, sort_keys=True) + "\n")
        pytest.skip(f"wrote {FIXTURE.name}")
    golden = json.loads(FIXTURE.read_text())
    assert set(golden) <= set(responses)
    for path, expected in golden.items():
        assert_holds(responses[path], expected, path)
