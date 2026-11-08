"""The Alembic migrations on PostgreSQL: they match the models, and they go down and up cleanly.

Uses its own database (`<test db>` with `_migrations` added before `_test`), so dropping
everything can't disturb the database the rest of the suite shares.
"""

from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import Engine, create_engine, inspect, make_url

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
    "stocks",
    "stock_trades",
    "stock_prices",
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
