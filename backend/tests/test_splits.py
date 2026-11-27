"""Split transactions: one expense split across several of the owner's own categories."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import app
from tests.test_accounts import Headers, auth
from tests.test_adjustments import account, days_ago, spend

client = TestClient(app)
TX = "/api/transactions"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def rows(headers: Headers) -> list[dict[str, Any]]:
    return client.get(TX, headers=headers).json()["transactions"]


def test_unsplit_has_no_tag(headers: Headers) -> None:
    tx = spend(headers, account(headers), "3000.00", days_ago(1))
    assert client.get(f"{TX}/{tx}", headers=headers).json()["split"] is None
    assert [r["split"] for r in rows(headers)] == [None]
