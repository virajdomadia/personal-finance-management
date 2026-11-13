"""Export a rich user, restore the backup into a fresh user on the same database, and every
figure the app shows comes out the same."""

import json
import random
from contextlib import nullcontext
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import cli
from app.core.security import create_token
from app.export.backup import (
    RestoreError,
    _metadata_plan,
    decode,
    encode,
    restore,
    row_counts,
)
from app.main import app
from app.models.account import Account
from app.models.category import Category
from app.models.market import MarketCode
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
    "/api/sms/review",
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
    assert response.headers["content-type"] == "application/gzip"
    disposition = response.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="pfm-backup-')
    assert disposition.endswith('.json.gz"')
    return decode(response.content)


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

    # The copy's own backup is the same data, apart from ids.
    again = _backup(copy)

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
    assert json.loads(out.read_text(encoding="utf-8"))["format"] == "pfm-backup"

    # The website's download is gzipped; restore-user reads it as it is.
    gz = tmp_path / "pfm-backup.json.gz"
    gz.write_bytes(client.get("/api/export/backup", headers=me).content)
    assert cli.main(["restore-user", "gz@example.com", str(gz)]) == 0
    gzipped = _headers_for(db_session, "gz@example.com")
    assert _without_ids(_get(gzipped, "/api/dashboard")) == _without_ids(_get(me, "/api/dashboard"))
    assert cli.main(["export-user", "me@example.com", str(tmp_path / "again.json.gz")]) == 0
    assert (tmp_path / "again.json.gz").read_bytes()[:2] == b"\x1f\x8b"
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    capsys.readouterr()
    assert cli.main(["restore-user", "gz@example.com", str(tmp_path / "broken.json")]) == 1
    assert "readable backup" in capsys.readouterr().err


def test_every_table_in_the_plan_is_in_the_backup(me: Headers) -> None:
    names = {t.name for t in _metadata_plan().exported}
    assert set(_backup(me)["tables"]) == names


def _accounts_of(db: Session, email: str) -> dict[str, Account]:
    user = db.scalars(select(User).where(User.email == email)).one()
    return {a.name: a for a in db.scalars(select(Account).where(Account.user_id == user.id))}


def test_rows_keep_their_order_and_may_point_at_each_other(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An RD paid from a bank opened after it, and two accounts that pay each other."""
    me = auth(db_session, monkeypatch, "me@example.com")
    user = db_session.scalars(select(User).where(User.email == "me@example.com")).one()

    def add(name: str, type_: str) -> Account:
        row = Account(user_id=user.id, type=type_, name=name, opening_balance=Decimal("1.00"))
        db_session.add(row)
        db_session.flush()
        return row

    rd, a, b, bank = add("RD", "rd"), add("A", "bank"), add("B", "credit_card"), add("Bank", "bank")
    rd.pay_from_id, a.pay_from_id, b.pay_from_id = bank.id, b.id, a.id
    db_session.commit()

    _restore_into(db_session, "copy@example.com", _backup(me))
    copy = _accounts_of(db_session, "copy@example.com")
    assert sorted(copy, key=lambda n: copy[n].id) == ["RD", "A", "B", "Bank"]
    assert copy["RD"].pay_from_id == copy["Bank"].id
    assert (copy["A"].pay_from_id, copy["B"].pay_from_id) == (copy["B"].id, copy["A"].id)


def _choices(headers: Headers) -> list[dict[str, Any]]:
    return [c for e in _get(headers, "/api/sms/review")["items"] for c in e["candidates"] or []]


def test_a_stale_sms_choice_is_dropped(me: Headers, db_session: Session) -> None:
    document = _backup(me)
    entry = next(e for e in document["tables"]["sms_entries"] if e["candidates"])
    entry["candidates"].append({"kind": "transaction", "id": 999999, "label": "Deleted since"})
    labels = [c["label"] for c in _choices(_restore_into(db_session, "copy@example.com", document))]
    assert labels and "Deleted since" not in labels


def test_market_choices_travel_by_code(me: Headers, db_session: Session) -> None:
    document = _backup(me)
    entry = next(e for e in document["tables"]["sms_entries"] if e["candidates"])
    market = next(c for c in entry["candidates"] if c["kind"] == "market")
    assert (market["market_kind"], market["market_code"]) == ("stock", "INFY")
    market["id"] = 10**9  # another database's id: the code finds this database's row
    entry["candidates"].append({**market, "market_code": "NOT-LISTED", "label": "Gone"})
    copy = _restore_into(db_session, "copy@example.com", document)
    expected = db_session.scalars(
        select(MarketCode.id).where(MarketCode.kind == "stock", MarketCode.code == "INFY")
    ).one()
    found = [c for c in _choices(copy) if c["kind"] == "market"]
    assert [c["id"] for c in found] == [expected]
    assert all("market_code" not in c for c in found)


def _first_with_choices(d: dict[str, Any]) -> dict[str, Any]:
    return next(e for e in d["tables"]["sms_entries"] if e["candidates"])


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda d: d.update(tables=[]), "must be an object"),
        (lambda d: d["tables"].update(accounts={}), "accounts must be a list"),
        (lambda d: d["tables"]["accounts"].append("x"), "isn't an object"),
        (lambda d: d["tables"]["accounts"].append({"name": "No id"}), "whole-number id"),
        (lambda d: d["tables"]["accounts"].append({"id": "7"}), "whole-number id"),
        (lambda d: d["tables"]["accounts"].append(dict(d["tables"]["accounts"][0])), "twice"),
        (lambda d: _first_with_choices(d).update(candidates=["x"]), "list of objects"),
    ],
)
def test_restore_refuses_a_malformed_backup(
    me: Headers, db_session: Session, change: Any, message: str
) -> None:
    document = _backup(me)
    change(document)
    with pytest.raises(RestoreError, match=message):
        _restore_into(db_session, "copy@example.com", document)


def test_a_large_backup_stays_well_under_vercels_limit() -> None:
    """15,000 rows of prices, SMS and transactions: Vercel refuses responses over 4.5 MB."""
    rng = random.Random(7)
    start = date(2024, 1, 1)

    def day(n: int) -> str:
        return (start + timedelta(days=n)).isoformat()

    tables: dict[str, list[dict[str, Any]]] = {
        "instrument_prices": [
            {
                "id": i,
                "instrument_id": 1 + i % 40,
                "date": day(i // 40),
                "price": f"{rng.uniform(10, 5000):.4f}",
                "trade_id": None,
                "source": "auto",
                "created_at": f"{day(i // 40)}T16:30:{i % 60:02d}+00:00",
            }
            for i in range(1, 7001)
        ],
        "sms_entries": [
            {
                "id": i,
                "hash": f"{rng.getrandbits(256):064x}",
                "sender": "VM-HDFCBK",
                "bank": "hdfc",
                "kind": "debit",
                "amount": f"{rng.uniform(10, 20000):.2f}",
                "occurred_on": day(i // 5),
                "payee": f"merchant{rng.randint(1, 400)}@okicici",
                "status": "recorded",
                "candidates": None,
            }
            for i in range(1, 4001)
        ],
        "transactions": [
            {
                "id": i,
                "type": "expense",
                "amount": f"{rng.uniform(10, 20000):.2f}",
                "date": day(i // 4),
                "account_id": 1 + i % 6,
                "category": rng.choice(["Groceries", "Food and dining", "Fuel", "Shopping"]),
                "note": f"note {rng.randint(1, 10**6)}",
                "source": "sms",
            }
            for i in range(1, 4001)
        ],
    }
    gz, raw = encode({"format": "pfm-backup", "tables": tables})
    print(f"15,000 rows: {raw} bytes of JSON, {len(gz)} gzipped")
    assert len(gz) < 1_500_000  # a third of the 4.5 MB limit
    assert raw > 3 * len(gz)
