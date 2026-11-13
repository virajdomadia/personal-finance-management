"""Export a rich user, restore the backup into a fresh user on the same database, and every
figure the app shows comes out the same."""

import json
from contextlib import nullcontext
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import cli
from app.core.security import create_token
from app.export.backup import RestoreError, _metadata_plan, restore, row_counts
from app.main import app
from app.models.account import Account
from app.models.category import Category
from app.models.transaction import Transaction
from app.models.user import User
from tests import export_fixture
from tests.test_accounts import SECRET, Headers, auth

client = TestClient(app)

# What the dashboard, month, budgets, safe-to-spend and portfolio pages read.
PAGES = [
    "/api/accounts",
    "/api/accounts?archived=true",
    "/api/dashboard",
    "/api/cash-flow",
    "/api/budgets",
    "/api/safe-to-spend",
    "/api/upcoming",
    "/api/investments/portfolio",
    "/api/investments/funds",
    "/api/investments/coins",
    "/api/investments/sips",
    "/api/goals",
    "/api/goals?archived=true",
    "/api/insurance",
    "/api/recurring",
    "/api/categories",
    "/api/transactions",
    "/api/payee-rules",
]


def _without_ids(value: Any) -> Any:
    """The same data with ids (which restore renumbers) left out."""
    if isinstance(value, dict):
        return {
            k: _without_ids(v)
            for k, v in value.items()
            if k != "id" and not k.endswith("_id") and not k.endswith("_ids")
        }
    if isinstance(value, list):
        return [_without_ids(v) for v in value]
    return value


def _get(headers: Headers, url: str) -> Any:
    response = client.get(url, headers=headers)
    assert response.status_code == 200, (url, response.json())
    return response.json()


def _headers_for(db: Session, email: str) -> Headers:
    user = db.scalars(select(User).where(User.email == email)).one()
    return {"Authorization": f"Bearer {create_token(user.id, user.session_version, SECRET)}"}


@pytest.fixture
def me(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    headers = auth(db_session, monkeypatch, "me@example.com")
    user = db_session.scalars(select(User).where(User.email == "me@example.com")).one()
    export_fixture.build(db_session, headers, user.id, date.today())
    # Someone else on the same database, whose rows must never appear in my export.
    other = auth(db_session, monkeypatch, "other@example.com")
    bank = client.post(
        "/api/accounts",
        json={"type": "bank", "name": "Other bank", "bank_kind": "savings", "balance": "1.00"},
        headers=other,
    ).json()["id"]
    client.post(
        "/api/transactions",
        json={
            "type": "expense",
            "date": date.today().isoformat(),
            "account_id": bank,
            "amount": "1.00",
            "category": "Groceries",
        },
        headers=other,
    )
    return headers


def _backup(headers: Headers) -> dict[str, Any]:
    response = client.get("/api/export/backup", headers=headers)
    assert response.status_code == 200
    assert response.headers["content-disposition"].startswith('attachment; filename="pfm-backup-')
    return response.json()


def _restore_into(db: Session, email: str, document: dict[str, Any], **kw: Any) -> Headers:
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email)
        db.add(user)
        db.flush()
    restore(db, user, document, **kw)
    db.commit()
    return _headers_for(db, email)


def test_the_fixture_fills_every_exported_table(me: Headers, db_session: Session) -> None:
    user = db_session.scalars(select(User).where(User.email == "me@example.com")).one()
    empty = [name for name, n in row_counts(db_session, user.id).items() if n == 0]
    assert empty == [], "add rows for these tables to tests/export_fixture.py"


def test_restore_gives_identical_figures(me: Headers, db_session: Session) -> None:
    document = _backup(me)
    copy = _restore_into(db_session, "copy@example.com", json.loads(json.dumps(document)))

    for url in PAGES:
        assert _without_ids(_get(copy, url)) == _without_ids(_get(me, url)), url
    month = date.today().replace(day=1)
    last = date(month.year - (month.month == 1), (month.month - 2) % 12 + 1, 1)
    for url in (f"/api/cash-flow?month={last:%Y-%m}", f"/api/budgets?month={last:%Y-%m}"):
        assert _without_ids(_get(copy, url)) == _without_ids(_get(me, url)), url

    # Each account's balance, matched by name.
    def balances(headers: Headers) -> dict[str, str]:
        rows = _get(headers, "/api/accounts")["accounts"]
        rows += _get(headers, "/api/accounts?archived=true")["accounts"]
        return {a["name"]: a["balance"] for a in rows}

    assert balances(copy) == balances(me)
    assert len(balances(me)) == 12

    # The copy's own backup is the same data, apart from ids and the one stale SMS choice.
    again = _backup(copy)
    for entry in document["tables"]["sms_entries"]:
        if entry["candidates"]:
            entry["candidates"] = [c for c in entry["candidates"] if c["id"] != 999999]

    # Rows of one table may come back in another order (a merged category waits for its target).
    def rows(tables: dict[str, Any]) -> dict[str, list[str]]:
        return {
            name: sorted(json.dumps(r, sort_keys=True) for r in _without_ids(found))
            for name, found in tables.items()
        }

    assert rows(again["tables"]) == rows(document["tables"])

    # Net worth history last: its first read of a day writes that day's snapshot for each user.
    url = "/api/net-worth?range=all"
    assert _without_ids(_get(copy, url)) == _without_ids(_get(me, url)), url
    assert len(_get(me, url)["points"]) >= 3


def test_links_point_at_the_copys_own_rows(me: Headers, db_session: Session) -> None:
    _restore_into(db_session, "copy@example.com", _backup(me))
    copy = db_session.scalars(select(User).where(User.email == "copy@example.com")).one()
    mine = set(db_session.scalars(select(Account.id).where(Account.user_id == copy.id)))
    rows = db_session.scalars(select(Transaction).where(Transaction.user_id == copy.id)).all()
    assert rows and all(t.account_id in mine for t in rows)
    assert all(t.to_account_id in mine for t in rows if t.to_account_id)
    rd = db_session.scalars(
        select(Account).where(Account.user_id == copy.id, Account.type == "rd")
    ).one()
    assert rd.pay_from_id in mine
    names = {
        c.id: c for c in db_session.scalars(select(Category).where(Category.user_id == copy.id))
    }

    def link(name: str, column: str) -> str | None:
        found = next(c for c in names.values() if c.name == name and c.kind == "expense")
        target = getattr(found, column)
        return None if target is None else names[target].name

    assert link("Groceries", "parent_id") == "Food and dining"
    assert link("Pets", "parent_id") == "Food and dining"
    assert link("Snacks", "merged_into_id") == "Food and dining"
    assert link("Fuel", "merged_into_id") == "Petrol"
    review = _get(_headers_for(db_session, "copy@example.com"), "/api/sms/review")
    choices = [c for e in review["items"] for c in (e.get("candidates") or [])]
    kinds = {c["kind"] for c in choices}
    assert {"transaction", "account", "emi", "sip", "template", "stock", "market"} <= kinds


def test_the_backup_holds_only_my_rows(me: Headers, db_session: Session) -> None:
    document = _backup(me)
    assert document["user"] == {"email": "me@example.com"}
    assert document["format"] == "pfm-backup" and document["format_version"] == 1
    text = json.dumps(document)
    assert "Other bank" not in text and "other@example.com" not in text
    assert "users" not in document["tables"] and "market_codes" not in document["tables"]
    assert all("user_id" not in row for rows in document["tables"].values() for row in rows)
    user = db_session.scalars(select(User).where(User.email == "me@example.com")).one()
    counts = row_counts(db_session, user.id)
    assert {k: len(v) for k, v in document["tables"].items()} == counts
    amount = document["tables"]["transactions"][0]["amount"]
    assert isinstance(amount, str) and "." in amount


def test_restore_refuses_another_schema_revision(me: Headers, db_session: Session) -> None:
    document = _backup(me)
    document["alembic_revision"] = "0123abcd"
    with pytest.raises(RestoreError, match="schema revision 0123abcd"):
        _restore_into(db_session, "copy@example.com", document)


def test_restore_refuses_a_user_with_data_unless_replace(me: Headers, db_session: Session) -> None:
    document = _backup(me)
    copy = _restore_into(db_session, "copy@example.com", document)
    with pytest.raises(RestoreError, match="already has data.*--replace"):
        _restore_into(db_session, "copy@example.com", document)
    db_session.rollback()
    copy = _restore_into(db_session, "copy@example.com", document, replace=True)
    assert _without_ids(_get(copy, "/api/dashboard")) == _without_ids(_get(me, "/api/dashboard"))
    user = db_session.scalars(select(User).where(User.email == "copy@example.com")).one()
    mine = db_session.scalars(select(User).where(User.email == "me@example.com")).one()
    assert row_counts(db_session, user.id) == row_counts(db_session, mine.id)


def test_restore_refuses_rows_pointing_outside_the_backup(me: Headers, db_session: Session) -> None:
    document = _backup(me)
    document["tables"]["transactions"][0]["account_id"] = 10**9
    with pytest.raises(RestoreError, match="isn't in the backup"):
        _restore_into(db_session, "copy@example.com", document)


def test_cli_export_and_restore(
    me: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: Any
) -> None:
    monkeypatch.setattr(cli, "SessionLocal", lambda: nullcontext(db_session))
    out = tmp_path / "backup.json"
    assert cli.main(["export-user", "ME@example.com", str(out)]) == 0
    assert "rows to" in capsys.readouterr().out
    assert cli.main(["restore-user", "fresh@example.com", str(out)]) == 0
    assert "Restored" in capsys.readouterr().out
    fresh = _headers_for(db_session, "fresh@example.com")
    assert _without_ids(_get(fresh, "/api/accounts")) == _without_ids(_get(me, "/api/accounts"))
    # A second restore is refused, and says how to replace.
    assert cli.main(["restore-user", "fresh@example.com", str(out)]) == 1
    assert "--replace" in capsys.readouterr().err
    assert cli.main(["restore-user", "fresh@example.com", str(out), "--replace"]) == 0


def test_every_table_in_the_plan_is_in_the_backup(me: Headers) -> None:
    names = {t.name for t in _metadata_plan().exported}
    assert set(_backup(me)["tables"]) == names
