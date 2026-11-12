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
from sqlalchemy.exc import IntegrityError

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
    "recurring_templates",
    "recurring_skips",
    "insurance_policies",
    "policy_periods",
    "goals",
    "goal_earmarks",
    "goal_holdings",
    "market_codes",
    "account_identifiers",
    "sms_entries",
    "payee_rules",
    "sms_samples",
    "categories",
    "budgets",
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
RECURRING_REVISION = "8e4c1b7a2d95"
GOALS_REVISION = "a1d4f7c92b36"
MARKET_REVISION = "c7e2a95d1b48"
CATEGORIES_REVISION = "2d46fef3dab4"
HEAD_REVISION = "7e5d2fc1e167"
SMS_TABLES = {"account_identifiers", "sms_entries", "payee_rules", "sms_samples"}
GOAL_TABLES = {"goals", "goal_earmarks", "goal_holdings"}
RECURRING_TABLES = {
    "recurring_templates",
    "recurring_skips",
    "insurance_policies",
    "policy_periods",
}


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
    assert rows(migrations_db, "SELECT version_num FROM alembic_version") == [(HEAD_REVISION,)]


def test_recurring_migration_round_trip(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, NEW_REVISION)
    seed_investments(migrations_db)
    engine = create_engine(migrations_db)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO transactions (id, user_id, type, amount, date, account_id,"
                    " created_at, updated_at) VALUES (1, 1, 'expense', 10, '2026-10-01', 1, :s, :s)"
                ),
                {"s": STAMP},
            )
    finally:
        engine.dispose()

    command.upgrade(config, "head")
    assert RECURRING_TABLES <= tables(migrations_db)
    assert rows(migrations_db, "SELECT recurring_template_id FROM transactions") == [(None,)]

    command.downgrade(config, NEW_REVISION)
    assert tables(migrations_db) == ALL_TABLES - RECURRING_TABLES - GOAL_TABLES - SMS_TABLES - {
        "categories",
        "budgets",
        "market_codes",
    }
    columns = {c["name"] for c in inspect(create_engine(migrations_db)).get_columns("transactions")}
    assert "recurring_template_id" not in columns
    assert rows(migrations_db, "SELECT id FROM transactions") == [(1,)]


def test_downgrade_refuses_recurring_data(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    seed_investments(migrations_db)
    engine = create_engine(migrations_db)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO recurring_templates (id, user_id, name, type, amount, account_id,"
                    " frequency, day, start_date, remind_days, created_at, updated_at)"
                    " VALUES (1, 1, 'Rent', 'expense', 100, 1, 'monthly', 1, '2026-10-01', 3,"
                    " :s, :s)"
                ),
                {"s": STAMP},
            )
    finally:
        engine.dispose()

    with pytest.raises(
        RuntimeError, match="Recurring or insurance data exists; remove it before downgrading."
    ):
        command.downgrade(config, NEW_REVISION)
    assert tables(migrations_db) == ALL_TABLES
    assert rows(migrations_db, "SELECT name, active FROM recurring_templates") == [("Rent", True)]
    assert rows(migrations_db, "SELECT version_num FROM alembic_version") == [(HEAD_REVISION,)]


def run_sql(url: str, *statements: str) -> None:
    engine = create_engine(url)
    try:
        with engine.begin() as conn:
            for statement in statements:
                conn.execute(text(statement), {"s": STAMP})
    finally:
        engine.dispose()


def test_goals_migration_round_trip(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    assert GOAL_TABLES <= tables(migrations_db)

    command.downgrade(config, RECURRING_REVISION)
    assert tables(migrations_db) == ALL_TABLES - GOAL_TABLES - SMS_TABLES - {
        "market_codes",
        "categories",
        "budgets",
    }
    assert rows(migrations_db, "SELECT version_num FROM alembic_version") == [(RECURRING_REVISION,)]

    command.upgrade(config, "head")
    assert tables(migrations_db) == ALL_TABLES


def test_downgrade_refuses_goal_data(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    seed_investments(migrations_db)
    run_sql(
        migrations_db,
        "INSERT INTO goals (id, user_id, name, kind, created_at, updated_at)"
        " VALUES (1, 1, 'Car', 'custom', :s, :s)",
    )

    with pytest.raises(RuntimeError, match="Goal data exists; remove it before downgrading."):
        command.downgrade(config, RECURRING_REVISION)
    assert tables(migrations_db) == ALL_TABLES
    assert rows(migrations_db, "SELECT name FROM goals") == [("Car",)]
    assert rows(migrations_db, "SELECT version_num FROM alembic_version") == [(HEAD_REVISION,)]


def test_goal_indexes_and_checks_on_postgres(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    seed_investments(migrations_db)
    run_sql(
        migrations_db,
        "INSERT INTO goals (id, user_id, name, kind, created_at, updated_at)"
        " VALUES (1, 1, 'Safety', 'emergency', :s, :s)",
        "INSERT INTO goals (id, user_id, name, kind, archived_at, created_at, updated_at)"
        " VALUES (2, 1, 'Old safety', 'emergency', :s, :s, :s)",
        "INSERT INTO goals (id, user_id, name, kind, created_at, updated_at)"
        " VALUES (3, 1, 'Car', 'custom', :s, :s)",
        "INSERT INTO goal_holdings (id, user_id, goal_id, instrument_id, created_at)"
        " VALUES (1, 1, 3, 1, :s)",
        "INSERT INTO goal_holdings (id, user_id, goal_id, instrument_id, active, created_at)"
        " VALUES (2, 1, 3, 1, false, :s)",
    )

    def fails(sql: str) -> None:
        with pytest.raises(IntegrityError):
            run_sql(migrations_db, sql)

    fails(
        "INSERT INTO goals (id, user_id, name, kind, created_at, updated_at)"
        " VALUES (4, 1, 'Second', 'emergency', :s, :s)"
    )
    fails(
        "INSERT INTO goal_holdings (id, user_id, goal_id, instrument_id, created_at)"
        " VALUES (3, 1, 3, 1, :s)"
    )
    fails(
        "INSERT INTO goal_holdings (id, user_id, goal_id, account_id, created_at)"
        " VALUES (3, 1, 3, 1, :s)"
        ", (4, 1, 3, 1, :s)"
    )
    fails("INSERT INTO goal_holdings (id, user_id, goal_id, created_at) VALUES (3, 1, 3, :s)")
    fails(
        "INSERT INTO goal_holdings (id, user_id, goal_id, instrument_id, account_id, created_at)"
        " VALUES (3, 1, 3, 1, 1, :s)"
    )
    fails(
        "INSERT INTO goal_earmarks (id, user_id, goal_id, account_id, amount, date, created_at)"
        " VALUES (1, 1, 3, 1, 0, '2026-10-01', :s)"
    )


def test_market_migration_round_trip(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, GOALS_REVISION)
    seed_investments(migrations_db, "5")
    run_sql(
        migrations_db,
        "INSERT INTO instrument_prices (user_id, instrument_id, date, price, created_at)"
        " VALUES (1, 1, '2026-11-01', 10, :s)",
    )

    command.upgrade(config, "head")
    assert "market_codes" in tables(migrations_db)
    assert rows(migrations_db, "SELECT source FROM instrument_prices") == [("manual",)]
    assert rows(migrations_db, "SELECT source_code FROM instruments") == [(None,)]

    command.downgrade(config, GOALS_REVISION)
    assert "market_codes" not in tables(migrations_db)
    assert rows(migrations_db, "SELECT version_num FROM alembic_version") == [(GOALS_REVISION,)]

    command.upgrade(config, "head")
    assert tables(migrations_db) == ALL_TABLES


def test_market_downgrade_deletes_auto_prices(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    seed_investments(migrations_db, "5")
    run_sql(
        migrations_db,
        "INSERT INTO instrument_prices (user_id, instrument_id, date, price, source, created_at)"
        " VALUES (1, 1, '2026-11-01', 10, 'manual', :s), (1, 1, '2026-11-02', 11, 'auto', :s)",
    )

    command.downgrade(config, GOALS_REVISION)

    assert rows(migrations_db, "SELECT date, price FROM instrument_prices") == [
        (date(2026, 11, 1), Decimal("10.0000"))
    ]


def test_sms_migration_round_trip(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, MARKET_REVISION)
    seed_investments(migrations_db, "5")
    run_sql(
        migrations_db,
        "INSERT INTO transactions (user_id, type, amount, date, account_id, created_at, updated_at)"
        " VALUES (1, 'expense', 10, '2026-11-01', 1, :s, :s)",
    )

    command.upgrade(config, "head")
    assert SMS_TABLES <= tables(migrations_db)
    assert rows(migrations_db, "SELECT source FROM transactions") == [("manual",)]
    assert rows(migrations_db, "SELECT estimated FROM investment_trades") == [(False,)]

    command.downgrade(config, MARKET_REVISION)
    assert not SMS_TABLES & tables(migrations_db)
    assert rows(migrations_db, "SELECT version_num FROM alembic_version") == [(MARKET_REVISION,)]

    command.upgrade(config, "head")
    assert tables(migrations_db) == ALL_TABLES


SMS_REVISION = "e3b81f46a0d7"


def test_categories_migration_seeds_and_round_trips(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, SMS_REVISION)
    seed_investments(migrations_db, "5")
    for category in ("groceries", "Swiggy"):
        run_sql(
            migrations_db,
            "INSERT INTO transactions (user_id, type, amount, date, account_id, category,"
            f" created_at, updated_at) VALUES (1, 'expense', 10, '2026-11-01', 1, '{category}',"
            " :s, :s)",
        )

    command.upgrade(config, "head")
    assert rows(migrations_db, "SELECT category FROM transactions ORDER BY id") == [
        ("Groceries",),
        ("Swiggy",),
    ]
    expense = rows(migrations_db, "SELECT name FROM categories WHERE kind = 'expense' ORDER BY id")
    assert expense[0] == ("Groceries",) and expense[-1] == ("Swiggy",)
    # One live category per name, ignoring case.
    with pytest.raises(IntegrityError):
        run_sql(
            migrations_db,
            "INSERT INTO categories (user_id, kind, name, name_key, created_at, updated_at)"
            " VALUES (1, 'expense', 'SWIGGY', 'swiggy', :s, :s)",
        )
    # A parent must be the same user's category of the same kind.
    with pytest.raises(IntegrityError):
        run_sql(
            migrations_db,
            "INSERT INTO categories (user_id, kind, name, name_key, parent_id, created_at,"
            " updated_at) SELECT 1, 'income', 'Odd', 'odd', id, :s, :s FROM categories"
            " WHERE name = 'Swiggy'",
        )

    command.downgrade(config, SMS_REVISION)
    assert "categories" not in tables(migrations_db)
    command.upgrade(config, "head")
    assert tables(migrations_db) == ALL_TABLES


def test_budgets_migration_round_trips_and_guards_data(migrations_db: str) -> None:
    config = alembic_config(migrations_db)
    command.upgrade(config, "head")
    seed_investments(migrations_db)
    run_sql(
        migrations_db,
        "INSERT INTO categories (user_id, kind, name, name_key, created_at, updated_at)"
        " VALUES (1, 'expense', 'Groceries', 'groceries', :s, :s),"
        " (1, 'income', 'Salary', 'salary', :s, :s)",
        "INSERT INTO budgets (user_id, category_id, effective_from, amount, created_at,"
        " updated_at) SELECT 1, id, '2026-11-01', 8000, :s, :s FROM categories"
        " WHERE user_id = 1 AND kind = 'expense' AND name = 'Groceries'",
    )
    assert rows(migrations_db, "SELECT kind, amount FROM budgets") == [
        ("expense", Decimal("8000.00"))
    ]
    # Only an expense category of the same user, once per month, and never zero.
    for statement in (
        "INSERT INTO budgets (user_id, category_id, effective_from, amount, created_at,"
        " updated_at) SELECT 1, id, '2026-11-01', 5, :s, :s FROM categories"
        " WHERE user_id = 1 AND kind = 'income' AND name = 'Salary'",
        "INSERT INTO budgets (user_id, category_id, effective_from, amount, created_at,"
        " updated_at) SELECT 1, id, '2026-11-01', 5, :s, :s FROM categories"
        " WHERE user_id = 1 AND kind = 'expense' AND name = 'Groceries'",
        "INSERT INTO budgets (user_id, category_id, effective_from, amount, created_at,"
        " updated_at) SELECT 1, id, '2026-12-01', 0, :s, :s FROM categories"
        " WHERE user_id = 1 AND kind = 'expense' AND name = 'Groceries'",
    ):
        with pytest.raises(IntegrityError):
            run_sql(migrations_db, statement)

    with pytest.raises(RuntimeError, match="Budget data exists; remove it before downgrading."):
        command.downgrade(config, CATEGORIES_REVISION)
    assert rows(migrations_db, "SELECT version_num FROM alembic_version") == [(HEAD_REVISION,)]

    run_sql(migrations_db, "DELETE FROM budgets")
    command.downgrade(config, CATEGORIES_REVISION)
    assert "budgets" not in tables(migrations_db)
    command.upgrade(config, "head")
    assert tables(migrations_db) == ALL_TABLES
