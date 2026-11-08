"""Test database setup.

By default the suite runs on in-memory SQLite, for speed. With TEST_DATABASE_URL set to a
PostgreSQL database whose name ends in `_test`, the same suite runs on PostgreSQL instead:
the schema is built by the real Alembic migrations, each test runs inside a transaction that
is rolled back afterwards, and the PostgreSQL-only tests (marked `postgres`) run too.

    TEST_DATABASE_URL=postgresql+psycopg://pfm:pfm@localhost:5434/pfm_test uv run pytest
"""

import os
from collections.abc import Iterator

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, make_url, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (registers models on Base.metadata)
from app.core.config import Settings
from app.db.base import Base
from app.db.session import get_db
from app.main import app

PG_URL = os.environ.get("TEST_DATABASE_URL", "")
ON_POSTGRES = bool(PG_URL)


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "postgres: needs TEST_DATABASE_URL (PostgreSQL)")


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    if ON_POSTGRES:
        return
    skip = pytest.mark.skip(reason="PostgreSQL only; set TEST_DATABASE_URL to run")
    for item in items:
        if "postgres" in item.keywords:
            item.add_marker(skip)


def _ensure_database(url: str) -> None:
    """Create the test database if it's missing. Refuses anything not named *_test."""
    name = make_url(url).database or ""
    if not name.endswith("_test"):
        raise pytest.UsageError(f"TEST_DATABASE_URL must name a *_test database, not {name!r}")
    admin = create_engine(make_url(url).set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        exists = conn.scalar(text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": name})
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{name}"'))
    admin.dispose()


BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def alembic_config(url: str) -> Config:
    config = Config(os.path.join(BACKEND, "alembic.ini"))
    config.set_main_option("script_location", os.path.join(BACKEND, "migrations"))
    config.attributes["database_url"] = url
    return config


def reset_schema(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))


@pytest.fixture(scope="session")
def pg_engine() -> Iterator[Engine]:
    """A migrated, empty PostgreSQL test database, shared by the whole run."""
    if not ON_POSTGRES:
        pytest.skip("PostgreSQL only; set TEST_DATABASE_URL to run")
    url = Settings(database_url=PG_URL).database_url
    _ensure_database(url)
    engine = create_engine(url)
    reset_schema(engine)
    command.upgrade(alembic_config(url), "head")
    yield engine
    engine.dispose()


@pytest.fixture
def db_session(request: pytest.FixtureRequest) -> Iterator[Session]:
    previous = app.dependency_overrides.get(get_db)
    if ON_POSTGRES:
        engine: Engine = request.getfixturevalue("pg_engine")
        connection = engine.connect()
        outer = connection.begin()
        # The code under test commits; those commits release savepoints inside `outer`,
        # which is rolled back at the end, so every test starts from an empty database.
        session = Session(
            bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False
        )
    else:
        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(engine)
        session = Session(engine, expire_on_commit=False)
    app.dependency_overrides[get_db] = lambda: session
    try:
        yield session
    finally:
        session.close()
        if ON_POSTGRES:
            outer.rollback()
            connection.close()
        else:
            engine.dispose()
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous
