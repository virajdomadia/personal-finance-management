from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.main import app

client = TestClient(app)


def use_database(engine: Engine) -> None:
    def override() -> Iterator[Session]:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_db] = override


@pytest.fixture(autouse=True)
def reset_overrides() -> Iterator[None]:
    yield
    app.dependency_overrides.clear()


def test_health_ok_when_database_reachable() -> None:
    use_database(create_engine("sqlite://"))

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["database"] == "ok"


def test_health_returns_503_when_database_unreachable() -> None:
    # Nothing listens on port 1, so connecting fails the way a real outage does.
    use_database(
        create_engine(
            "postgresql+psycopg://pfm:pfm@127.0.0.1:1/pfm",
            connect_args={"connect_timeout": 2},
        )
    )

    response = client.get("/api/health")

    assert response.status_code == 503
    assert response.json()["status"] == "error"
    assert response.json()["database"] == "unreachable"
