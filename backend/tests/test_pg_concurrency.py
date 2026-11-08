"""Concurrent saves against today's engine, on PostgreSQL with real connections and commits.

Each worker calls the real route function with its own session, exactly as two simultaneous
requests would. The account row locks (`_lock_accounts`) are what keep these correct.
"""

import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.exceptions import RequestValidationError
from sqlalchemy import Engine, create_engine, func, select, text
from sqlalchemy.orm import Session

from app.api.balances import balance_of, load_flows
from app.api.routes.transactions import (
    TransactionCreate,
    TransactionUpdate,
    _lock_accounts,
    create_transaction,
    delete_transaction,
    update_transaction,
)
from app.models.account import Account
from app.models.transaction import Transaction
from app.models.user import User

pytestmark = pytest.mark.postgres

DAY = "2026-01-15"


@pytest.fixture
def engine(pg_engine: Engine) -> Iterator[Engine]:
    # Fail fast instead of hanging if locking ever regresses into a wait that never ends.
    engine = create_engine(
        pg_engine.url,
        pool_size=20,
        connect_args={"options": "-c lock_timeout=10s -c statement_timeout=30s"},
    )
    yield engine
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE users, accounts, transactions RESTART IDENTITY CASCADE"))
    engine.dispose()


def setup(engine: Engine, *accounts: tuple[str, str]) -> tuple[Any, list[int]]:
    with Session(engine) as db:
        user = User(email="me@example.com")
        db.add(user)
        db.flush()
        rows = [
            Account(user_id=user.id, type=type_, name=type_, opening_balance=Decimal(opening))
            for type_, opening in accounts
        ]
        db.add_all(rows)
        db.commit()
        return SimpleNamespace(id=user.id), [a.id for a in rows]


def attempt(engine: Engine, action: Callable[[Session], Any]) -> str:
    """Run one request's work in its own session. Returns how it ended."""
    with Session(engine, expire_on_commit=False) as db:
        try:
            action(db)
            return "ok"
        except (RequestValidationError, HTTPException):
            return "refused"


def together(engine: Engine, actions: list[Callable[[Session], Any]]) -> list[str]:
    """Start every action at the same moment, each on its own connection."""
    gate = threading.Barrier(len(actions))

    def run(action: Callable[[Session], Any]) -> str:
        gate.wait()
        return attempt(engine, action)

    with ThreadPoolExecutor(len(actions)) as pool:
        return list(pool.map(run, actions))


def expense(user: Any, account_id: int, amount: str) -> Callable[[Session], Any]:
    body = TransactionCreate.model_validate(
        {
            "type": "expense",
            "account_id": account_id,
            "amount": amount,
            "date": DAY,
            "category": "Groceries",
        }
    )
    return lambda db: create_transaction(body, user, db)


def transfer(user: Any, from_id: int, to_id: int, amount: str) -> Callable[[Session], Any]:
    body = TransactionCreate.model_validate(
        {
            "type": "transfer",
            "account_id": from_id,
            "to_account_id": to_id,
            "amount": amount,
            "date": DAY,
        }
    )
    return lambda db: create_transaction(body, user, db)


def balances(engine: Engine, user: Any) -> dict[int, Decimal]:
    with Session(engine) as db:
        flows = load_flows(db, user.id)
        accounts = db.scalars(select(Account).where(Account.user_id == user.id))
        return {a.id: balance_of(a, flows) for a in accounts}


def stored(engine: Engine) -> int:
    with Session(engine) as db:
        return db.scalar(select(func.count()).select_from(Transaction)) or 0


def test_simultaneous_expenses_never_overspend_cash(engine: Engine) -> None:
    user, [cash] = setup(engine, ("cash", "1000.00"))

    results = together(engine, [expense(user, cash, "300.00") for _ in range(8)])

    assert results.count("ok") == 3
    assert results.count("refused") == 5
    assert balances(engine, user)[cash] == Decimal("100.00")
    assert stored(engine) == 3  # each refusal left nothing behind


def test_simultaneous_transfers_never_overspend_the_source(engine: Engine) -> None:
    user, [cash, bank] = setup(engine, ("cash", "1000.00"), ("bank", "0.00"))

    results = together(engine, [transfer(user, cash, bank, "250.00") for _ in range(8)])

    assert results.count("ok") == 4
    assert balances(engine, user) == {cash: Decimal("0.00"), bank: Decimal("1000.00")}
    assert stored(engine) == 4


def test_opposite_transfers_do_not_deadlock(engine: Engine) -> None:
    user, [a, b] = setup(engine, ("bank", "0.00"), ("bank", "0.00"))
    rounds = 15
    actions = [transfer(user, a, b, "1.00") for _ in range(rounds)]
    actions += [transfer(user, b, a, "2.00") for _ in range(rounds)]

    # A deadlock would surface as an OperationalError and fail the test here.
    results = together(engine, actions)

    assert results == ["ok"] * (2 * rounds)
    assert balances(engine, user) == {a: Decimal("15.00"), b: Decimal("-15.00")}
    assert stored(engine) == 2 * rounds


def test_only_one_of_two_competing_saves_passes_the_check(engine: Engine) -> None:
    user, [cash] = setup(engine, ("cash", "500.00"))

    results = together(engine, [expense(user, cash, "400.00"), expense(user, cash, "300.00")])

    assert sorted(results) == ["ok", "refused"]
    assert balances(engine, user)[cash] in {Decimal("100.00"), Decimal("200.00")}


def test_a_save_waits_for_the_lock_and_then_sees_the_new_balance(engine: Engine) -> None:
    """Deterministic: the second save must block on the first's lock, not read a stale balance."""
    user, [cash] = setup(engine, ("cash", "500.00"))
    first = Session(engine, expire_on_commit=False)
    pool = ThreadPoolExecutor(1)
    try:
        _lock_accounts(first, user.id, [cash])  # holds the row lock until commit
        second = pool.submit(attempt, engine, expense(user, cash, "300.00"))
        time.sleep(0.5)
        waited = not second.done()

        first.add(
            Transaction(
                user_id=user.id,
                type="expense",
                amount=Decimal("300.00"),
                date=date(2026, 1, 15),
                account_id=cash,
                category="Groceries",
            )
        )
        first.commit()
        result = second.result(timeout=10)
    finally:
        first.close()  # never leave the lock held for the next test
        pool.shutdown()

    assert waited, "the second save didn't wait for the lock"
    assert result == "refused"
    assert balances(engine, user)[cash] == Decimal("200.00")


def test_simultaneous_edits_and_deletes_keep_cash_at_or_above_zero(engine: Engine) -> None:
    user, [cash] = setup(engine, ("cash", "1000.00"))
    ids = []
    for _ in range(4):
        with Session(engine, expire_on_commit=False) as db:
            ids.append(expense(user, cash, "100.00")(db).id)

    raise_each = TransactionUpdate.model_validate({"amount": "400.00"})
    actions: list[Callable[[Session], Any]] = [
        (lambda db, id=id: update_transaction(id, raise_each, user, db)) for id in ids
    ]
    actions.append(lambda db: delete_transaction(ids[0], user, db))

    together(engine, actions)

    assert balances(engine, user)[cash] >= 0


def test_a_failure_after_writing_leaves_nothing_behind(engine: Engine) -> None:
    """Today's engine: the edit is flushed to the database, then the request fails before commit."""
    user, [cash] = setup(engine, ("cash", "1000.00"))
    with Session(engine, expire_on_commit=False) as db:
        id = expense(user, cash, "100.00")(db).id

    class CrashingSession(Session):
        def commit(self) -> None:
            self.flush()  # the UPDATE reaches PostgreSQL...
            raise RuntimeError("crash")  # ...and the request dies before COMMIT

    with CrashingSession(engine) as db, pytest.raises(RuntimeError):
        update_transaction(id, TransactionUpdate.model_validate({"amount": "900.00"}), user, db)

    assert balances(engine, user)[cash] == Decimal("900.00")
