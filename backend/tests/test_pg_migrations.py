"""The Alembic migrations on PostgreSQL: they match the models, and they go down and up cleanly.

Uses its own database (`<test db>` with `_migrations` added before `_test`), so dropping
everything can't disturb the database the rest of the suite shares.
"""

from collections.abc import Iterator
from datetime import date
from decimal import Decimal

import pytest
from alembic import command
from sqlalchemy import Engine, create_engine, inspect, make_url, text

from app.core.config import Settings
from tests.conftest import PG_URL, _ensure_database, alembic_config, reset_schema

pytestmark = pytest.mark.postgres


@pytest.fixture
def migrations_db() -> Iterator[str]:
    url = make_url(Settings(database_url=PG_URL).database_url)
    name = (url.database or "").removesuffix("_test") + "_migrations_test"
    own = url.set(database=name).render_as_string(hide_password=False)
    _ensure_database(own)
    engine = create_engine(own)
    reset_schema(engine)
    yield own
    reset_schema(engine)
    engine.dispose()


ALL_TABLES = {
    "users",
    "accounts",
    "transactions",
    "instruments",
    "investment_trades",
    "instrument_prices",
    "sips",
}


def tables(url: str) -> set[str]:
    engine: Engine = create_engine(url)
    try:
        return set(inspect(engine).get_table_names()) - {"alembic_version"}
    finally:
        engine.dispose()


def test_migrations_match_the_models(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    command.check(config)  # raises if autogenerate would produce any change


def test_migrations_downgrade_and_upgrade_cleanly(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    assert tables(migrations_db) == ALL_TABLES

    command.downgrade(config, "base")
    assert tables(migrations_db) == set()

    command.upgrade(config, "head")
    assert tables(migrations_db) == ALL_TABLES


STOCKS_REVISION = "65f46a0f545a"
STAMP = "2026-10-01 00:00:00+00"


def seed_before_generalising(url: str) -> None:
    """A user, a broker, a stock, a buy, a sell and a price, in the stock-only tables."""
    engine = create_engine(url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (id, email, session_version, created_at) "
                    "VALUES (1, 'me@example.com', 1, :s)"
                ),
                {"s": STAMP},
            )
            conn.execute(
                text(
                    "INSERT INTO accounts (id, user_id, type, name, opening_balance,"
                    " created_at, updated_at) VALUES (1, 1, 'broker', 'Zerodha', 50000, :s, :s)"
                ),
                {"s": STAMP},
            )
            conn.execute(
                text(
                    "INSERT INTO stocks (id, user_id, symbol, name, created_at, updated_at) "
                    "VALUES (7, 1, 'INFY', 'Infosys', :s, :s)"
                ),
                {"s": STAMP},
            )
            for id_, side, day, qty, price, charges in [
                (11, "buy", "2026-10-01", 10, "1234.56", "20.10"),
                (12, "sell", "2026-10-02", 4, "1300.00", "5.25"),
            ]:
                conn.execute(
                    text(
                        "INSERT INTO stock_trades (id, user_id, stock_id, account_id, side, date,"
                        " quantity, price, charges, opening, note, created_at, updated_at)"
                        " VALUES (:id, 1, 7, 1, :sd, :d, :q, :p, :c, false, 'n', :s, :s)"
                    ),
                    {"id": id_, "sd": side, "d": day, "q": qty, "p": price, "c": charges,
                     "s": STAMP},
                )  # fmt: skip
            conn.execute(
                text(
                    "INSERT INTO stock_prices (id, user_id, stock_id, date, price, created_at) "
                    "VALUES (5, 1, 7, '2026-10-03', 1310.45, :s)"
                ),
                {"s": STAMP},
            )
    finally:
        engine.dispose()


def rows(url: str, sql: str) -> list[tuple]:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            return [tuple(r) for r in conn.execute(text(sql))]
    finally:
        engine.dispose()


def test_migration_keeps_stock_rows(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, STOCKS_REVISION)
    seed_before_generalising(migrations_db)
    command.upgrade(config, "head")

    assert rows(migrations_db, "SELECT id, user_id, kind, symbol, name FROM instruments") == [
        (7, 1, "stock", "INFY", "Infosys")
    ]
    trades = rows(
        migrations_db,
        "SELECT id, user_id, instrument_id, account_id, side, date, quantity, price, charges,"
        " amount, opening, note, sip_id FROM investment_trades ORDER BY id",
    )
    assert trades == [
        (11, 1, 7, 1, "buy", date(2026, 10, 1), Decimal("10.00000000"), Decimal("1234.5600"),
         Decimal("20.10"), Decimal("12365.70"), False, "n", None),
        (12, 1, 7, 1, "sell", date(2026, 10, 2), Decimal("4.00000000"), Decimal("1300.0000"),
         Decimal("5.25"), Decimal("5194.75"), False, "n", None),
    ]  # fmt: skip
    assert str(trades[0][6]) == "10.00000000"
    prices = rows(
        migrations_db,
        "SELECT id, user_id, instrument_id, date, price, trade_id FROM instrument_prices",
    )
    assert prices == [(5, 1, 7, date(2026, 10, 3), Decimal("1310.4500"), None)]

    # The id sequences are renamed with their tables, and still back the id columns.
    sequences = rows(
        migrations_db,
        "SELECT pg_get_serial_sequence('instruments', 'id'),"
        " pg_get_serial_sequence('investment_trades', 'id'),"
        " pg_get_serial_sequence('instrument_prices', 'id')",
    )
    assert sequences == [
        (
            "public.instruments_id_seq",
            "public.investment_trades_id_seq",
            "public.instrument_prices_id_seq",
        )
    ]

    command.downgrade(config, STOCKS_REVISION)
    assert rows(migrations_db, "SELECT id, user_id, symbol, name FROM stocks") == [
        (7, 1, "INFY", "Infosys")
    ]
    old_trades = rows(
        migrations_db,
        "SELECT id, user_id, stock_id, account_id, side, date, quantity, price, charges,"
        " opening, note FROM stock_trades ORDER BY id",
    )
    assert old_trades == [
        (11, 1, 7, 1, "buy", date(2026, 10, 1), 10, Decimal("1234.56"), Decimal("20.10"),
         False, "n"),
        (12, 1, 7, 1, "sell", date(2026, 10, 2), 4, Decimal("1300.00"), Decimal("5.25"),
         False, "n"),
    ]  # fmt: skip
    assert type(old_trades[0][6]) is int
    assert str(old_trades[0][7]) == "1234.56"
    assert rows(migrations_db, "SELECT id, user_id, stock_id, date, price FROM stock_prices") == [
        (5, 1, 7, date(2026, 10, 3), Decimal("1310.45"))
    ]
    assert str(rows(migrations_db, "SELECT price FROM stock_prices")[0][0]) == "1310.45"


def test_downgrade_refuses_fund_data(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    engine = create_engine(migrations_db)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (id, email, session_version, created_at) "
                    "VALUES (1, 'me@example.com', 1, :s)"
                ),
                {"s": STAMP},
            )
            conn.execute(
                text(
                    "INSERT INTO instruments (id, user_id, kind, symbol, name) "
                    "VALUES (1, 1, 'mutual_fund', 'PPFCF', 'Parag Parikh Flexi Cap')"
                )
            )
    finally:
        engine.dispose()

    with pytest.raises(RuntimeError, match="Mutual fund data exists"):
        command.downgrade(config, STOCKS_REVISION)
    assert tables(migrations_db) == ALL_TABLES
    assert rows(migrations_db, "SELECT kind, symbol FROM instruments") == [("mutual_fund", "PPFCF")]


DEPOSITS_REVISION = "3b8f2c61a7d4"
NEW_REVISION = "5d7e3a90c1f2"


def seed_investments(url: str, *quantities: str, kind: str = "stock") -> None:
    """A user, a broker, one instrument of `kind`, and a buy for each quantity (ids from 1)."""
    engine = create_engine(url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO users (id, email, session_version, created_at) "
                    "VALUES (1, 'me@example.com', 1, :s)"
                ),
                {"s": STAMP},
            )
            conn.execute(
                text(
                    "INSERT INTO accounts (id, user_id, type, name, opening_balance,"
                    " created_at, updated_at) VALUES (1, 1, 'broker', 'Zerodha', 50000, :s, :s)"
                ),
                {"s": STAMP},
            )
            conn.execute(
                text(
                    "INSERT INTO instruments (id, user_id, kind, symbol, name, created_at,"
                    " updated_at) VALUES (1, 1, :k, 'SYM', 'Some instrument', :s, :s)"
                ),
                {"k": kind, "s": STAMP},
            )
            for id_, qty in enumerate(quantities, start=1):
                conn.execute(
                    text(
                        "INSERT INTO investment_trades (id, user_id, instrument_id, account_id,"
                        " side, date, quantity, price, charges, amount, opening, note,"
                        " created_at, updated_at) VALUES (:id, 1, 1, 1, 'buy', '2026-10-01', :q,"
                        " 10, 0, 10, false, 'n', :s, :s)"
                    ),
                    {"id": id_, "q": qty, "s": STAMP},
                )
    finally:
        engine.dispose()


def test_migration_widens_quantity_keeping_values(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, DEPOSITS_REVISION)
    seed_investments(migrations_db, "10", "253.462")
    command.upgrade(config, "head")

    quantities = rows(migrations_db, "SELECT quantity FROM investment_trades ORDER BY id")
    assert quantities == [(Decimal("10"),), (Decimal("253.462"),)]
    assert str(quantities[1][0]) == "253.46200000"

    seed_new = text(
        "INSERT INTO investment_trades (id, user_id, instrument_id, account_id, side, date,"
        " quantity, price, charges, amount, opening, created_at, updated_at)"
        " VALUES (3, 1, 1, 1, 'buy', '2026-10-02', 0.00014067, 10, 0, 10, false, :s, :s)"
    )
    engine = create_engine(migrations_db)
    try:
        with engine.begin() as conn:
            conn.execute(seed_new, {"s": STAMP})
    finally:
        engine.dispose()
    assert rows(migrations_db, "SELECT quantity FROM investment_trades WHERE id = 3") == [
        (Decimal("0.00014067"),)
    ]

    # Downgrading works once no quantity has more than 3 decimals.
    engine = create_engine(migrations_db)
    try:
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM investment_trades WHERE id = 3"))
    finally:
        engine.dispose()
    command.downgrade(config, DEPOSITS_REVISION)
    assert rows(migrations_db, "SELECT quantity FROM investment_trades ORDER BY id") == [
        (Decimal("10.000"),),
        (Decimal("253.462"),),
    ]


@pytest.mark.parametrize(
    ("kind", "quantity"),
    [("crypto", "1"), ("stock", "0.00014067")],
    ids=["a crypto instrument", "a quantity past 3 decimals"],
)
def test_downgrade_refuses_crypto_data(migrations_db: str, kind: str, quantity: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    seed_investments(migrations_db, quantity, kind=kind)

    with pytest.raises(RuntimeError, match="Crypto data exists; remove it before downgrading."):
        command.downgrade(config, DEPOSITS_REVISION)
    assert tables(migrations_db) == ALL_TABLES
    assert rows(migrations_db, "SELECT kind FROM instruments") == [(kind,)]
    assert rows(migrations_db, "SELECT quantity FROM investment_trades") == [(Decimal(quantity),)]
    assert rows(migrations_db, "SELECT version_num FROM alembic_version") == [(NEW_REVISION,)]
