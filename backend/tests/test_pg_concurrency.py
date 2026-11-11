"""Concurrent saves against today's engine, on PostgreSQL with real connections and commits.

Each worker calls the real route function with its own session, exactly as two simultaneous
requests would. The account row locks (`lock_accounts`) are what keep these correct.
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
from app.api.routes.accounts import (
    AccountCreate,
    AccountUpdate,
    archive_account,
    create_account,
    update_account,
)
from app.api.routes.goals import EarmarkCreate, HoldingCreate, add_earmark, add_holding
from app.api.routes.sips import SipUpdate, delete_sip, update_sip
from app.api.routes.transactions import (
    TransactionCreate,
    TransactionUpdate,
    create_transaction,
    delete_transaction,
    lock_accounts,
    update_transaction,
)
from app.models.account import Account
from app.models.goal import Goal, GoalEarmark, GoalHolding
from app.models.investment import Instrument, InvestmentTrade, Sip
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
        lock_accounts(first, user.id, [cash])  # holds the row lock until commit
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


def _delete_behind_the_back(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, id: int, move_to: int | None = None
) -> None:
    """After the route reads the transaction but before it locks accounts, another request runs."""
    from app.api.routes import transactions as routes

    real = routes.lock_accounts
    done = []

    def lock_after_other_request(*args: Any, **kwargs: Any) -> Any:
        if not done:
            done.append(True)
            with Session(engine) as other:
                tx = other.get(Transaction, id)
                assert tx is not None
                if move_to is None:
                    other.delete(tx)
                else:
                    tx.account_id = move_to
                other.commit()
        return real(*args, **kwargs)

    monkeypatch.setattr(routes, "lock_accounts", lock_after_other_request)


def _one_expense(engine: Engine, *accounts: tuple[str, str]) -> tuple[Any, list[int], int]:
    user, ids = setup(engine, *accounts)
    with Session(engine, expire_on_commit=False) as db:
        return user, ids, expense(user, ids[0], "100.00")(db).id


def test_an_edit_of_a_transaction_deleted_meanwhile_is_not_found(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, _, id = _one_expense(engine, ("cash", "1000.00"))
    _delete_behind_the_back(engine, monkeypatch, id)
    with Session(engine) as db, pytest.raises(HTTPException) as caught:
        update_transaction(id, TransactionUpdate.model_validate({"amount": "50.00"}), user, db)
    assert caught.value.status_code == 404
    assert caught.value.detail == "Transaction not found."


def test_a_delete_of_a_transaction_deleted_meanwhile_is_not_found(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, _, id = _one_expense(engine, ("cash", "1000.00"))
    _delete_behind_the_back(engine, monkeypatch, id)
    with Session(engine) as db, pytest.raises(HTTPException) as caught:
        delete_transaction(id, user, db)
    assert caught.value.status_code == 404
    assert caught.value.detail == "Transaction not found."


def test_an_edit_or_delete_of_a_transaction_moved_meanwhile_asks_to_retry(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    user, [cash, bank], id = _one_expense(engine, ("cash", "1000.00"), ("savings_account", "0"))
    _delete_behind_the_back(engine, monkeypatch, id, move_to=bank)
    with Session(engine) as db, pytest.raises(HTTPException) as caught:
        update_transaction(id, TransactionUpdate.model_validate({"amount": "50.00"}), user, db)
    assert caught.value.status_code == 409
    assert caught.value.detail == "This transaction changed while saving. Try again."

    # The same for a delete: the transaction now sits on the other account.
    _delete_behind_the_back(engine, monkeypatch, id, move_to=cash)
    with Session(engine) as db, pytest.raises(HTTPException) as caught:
        delete_transaction(id, user, db)
    assert caught.value.status_code == 409


def _sip(engine: Engine) -> tuple[Any, int]:
    user, [bank] = setup(engine, ("savings_account", "1000.00"))
    with Session(engine) as db:
        fund = Instrument(user_id=user.id, kind="mutual_fund", symbol="F", name="A fund")
        db.add(fund)
        db.flush()
        sip = Sip(
            user_id=user.id,
            instrument_id=fund.id,
            account_id=bank,
            amount=Decimal("500"),
            day=5,
            start_date=date(2026, 1, 1),
        )
        db.add(sip)
        db.commit()
        return user, sip.id


@pytest.mark.parametrize("action", ["edit", "delete"])
def test_a_sip_deleted_meanwhile_is_not_found(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    from app.api.routes import sips as routes

    user, id = _sip(engine)
    real = routes.lock_accounts

    def delete_first(*args: Any, **kwargs: Any) -> Any:
        with Session(engine) as other:
            other.delete(other.get(Sip, id))
            other.commit()
        return real(*args, **kwargs)

    if action == "edit":
        # Only an edit locks accounts (after reading the SIP), so only then is the patch applied.
        monkeypatch.setattr(routes, "lock_accounts", delete_first)
    else:
        # A delete doesn't lock accounts; it locks the SIP row itself, so hook that re-read.
        monkeypatch.setattr(routes, "_reread_locked", _after_deleting(engine, id, routes))
    with Session(engine) as db, pytest.raises(HTTPException) as caught:
        if action == "edit":
            update_sip(id, SipUpdate.model_validate({"amount": "600"}), user, db)
        else:
            delete_sip(id, user, db)
    assert caught.value.status_code == 404
    assert caught.value.detail == "SIP not found."


def _after_deleting(engine: Engine, id: int, routes: Any) -> Callable[..., Any]:
    real = routes._reread_locked

    def reread(db: Session, user_id: int, sip_id: int) -> Any:
        with Session(engine) as other:
            other.delete(other.get(Sip, id))
            other.commit()
        return real(db, user_id, sip_id)

    return reread


def test_an_edit_of_a_sip_moved_meanwhile_asks_to_retry(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import sips as routes

    user, id = _sip(engine)
    with Session(engine) as db:
        other_bank = Account(
            user_id=user.id, type="savings_account", name="Other", opening_balance=Decimal("0")
        )
        db.add(other_bank)
        db.commit()
        other_id = other_bank.id
    real = routes.lock_accounts
    done = []

    def move_first(*args: Any, **kwargs: Any) -> Any:
        if not done:
            done.append(True)
            with Session(engine) as other:
                other.get(Sip, id).account_id = other_id
                other.commit()
        return real(*args, **kwargs)

    monkeypatch.setattr(routes, "lock_accounts", move_first)
    with Session(engine) as db, pytest.raises(HTTPException) as caught:
        update_sip(id, SipUpdate.model_validate({"amount": "600"}), user, db)
    assert caught.value.status_code == 409
    assert caught.value.detail == "This SIP changed while saving. Try again."


def _rd_body(bank: int) -> dict[str, Any]:
    return {
        "type": "rd",
        "name": "RD",
        "balance": "0",
        "interest_rate": "7.00",
        "opened_on": "2026-01-01",
        "deposit_amount": "1000.00",
        "due_day": 1,
        "tenure_months": 12,
        "deposits_paid": 0,
        "pay_from_id": bank,
    }


def _waits_for_the_bank_lock(engine: Engine, bank: int, action: Callable[[Session], Any]) -> str:
    """Hold the bank's row lock, as an archive would, and archive it before letting go."""
    holder = Session(engine)
    pool = ThreadPoolExecutor(1)
    try:
        holder.execute(select(Account).where(Account.id == bank).with_for_update())
        second = pool.submit(attempt, engine, action)
        time.sleep(0.5)
        waited = not second.done()
        holder.execute(text("UPDATE accounts SET archived_at = now() WHERE id = :id"), {"id": bank})
        holder.commit()
        result = second.result(timeout=10)
    finally:
        holder.close()
        pool.shutdown()
    assert waited, "the save didn't wait for the bank's lock"
    return result


def test_creating_an_rd_waits_for_its_bank_and_is_refused_once_archived(engine: Engine) -> None:
    user, [bank] = setup(engine, ("bank", "1000.00"))
    body = AccountCreate.model_validate(_rd_body(bank))
    result = _waits_for_the_bank_lock(engine, bank, lambda db: create_account(body, user, db))
    assert result == "refused"
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Account).where(Account.type == "rd")) == 0


def test_pointing_an_rd_at_a_bank_waits_for_it_and_is_refused_once_archived(
    engine: Engine,
) -> None:
    user, [bank, other] = setup(engine, ("bank", "1000.00"), ("bank", "1000.00"))
    with Session(engine, expire_on_commit=False) as db:
        rd = create_account(AccountCreate.model_validate(_rd_body(other)), user, db)
    change = AccountUpdate.model_validate({"pay_from_id": bank})
    result = _waits_for_the_bank_lock(
        engine, bank, lambda db: update_account(rd.id, change, user, db)
    )
    assert result == "refused"
    with Session(engine) as db:
        assert db.get(Account, rd.id).pay_from_id == other


def _ppf_below_its_bank(engine: Engine) -> tuple[Any, int, int, int]:
    """A PPF whose id is lower than the bank it's paid from, plus a second bank to move it to."""
    user, [ppf, bank, other] = setup(engine, ("ppf", "0.00"), ("bank", "0.00"), ("bank", "0.00"))
    with Session(engine) as db:
        row = db.get(Account, ppf)
        assert row is not None
        row.interest_rate, row.opened_on, row.pay_from_id = Decimal("7.10"), date(2026, 1, 1), bank
        db.commit()
    return user, ppf, bank, other


def _settled(engine: Engine, action: Callable[[Session], Any]) -> str:
    """Like attempt, but any other error (a deadlock is an OperationalError) is returned too."""
    try:
        return attempt(engine, action)
    except Exception as error:
        return f"{type(error).__name__}: {error}"


def _archive_while_moving_its_ppf(engine: Engine) -> tuple[list[str], int, int, int]:
    """One round: archive the bank and move its PPF to the other bank at the same moment."""
    user, ppf, bank, other = _ppf_below_its_bank(engine)
    move = AccountUpdate.model_validate({"pay_from_id": other})
    actions: list[Callable[[Session], Any]] = [
        lambda db: archive_account(bank, user, db),
        lambda db: update_account(ppf, move, user, db),
    ]
    gate = threading.Barrier(len(actions))

    def run(action: Callable[[Session], Any]) -> str:
        gate.wait()
        return _settled(engine, action)

    with ThreadPoolExecutor(len(actions)) as pool:
        return list(pool.map(run, actions)), ppf, bank, other


def test_archive_bank_and_ppf_edit_lock_in_id_order(engine: Engine) -> None:
    """Archiving a bank while its PPF moves to another bank, in rounds to vary who goes first."""
    for _ in range(10):
        results, ppf, bank, other = _archive_while_moving_its_ppf(engine)

        assert results == ["ok", "ok"]  # neither side deadlocked or was refused
        with Session(engine) as db:
            assert db.get(Account, bank).archived_at is not None
            # The archive clears only a PPF still paid from the bank; the move always stands.
            assert db.get(Account, ppf).pay_from_id == other
        with engine.begin() as conn:
            conn.execute(text("TRUNCATE users, accounts, transactions RESTART IDENTITY CASCADE"))


def test_one_instrument_joins_only_one_of_two_goals_added_at_once(engine: Engine) -> None:
    """Both adds pass the 'already in a goal' check; the partial unique index stops the second."""
    for _ in range(5):
        user, [broker] = setup(engine, ("broker", "10000.00"))
        with Session(engine) as db:
            fund = Instrument(user_id=user.id, kind="mutual_fund", symbol="F", name="A fund")
            goals = [Goal(user_id=user.id, name=n, kind="custom") for n in ("EF", "Bike")]
            db.add_all([fund, *goals])
            db.flush()
            db.add(
                InvestmentTrade(
                    user_id=user.id,
                    instrument_id=fund.id,
                    account_id=broker,
                    side="buy",
                    date=date(2026, 1, 1),
                    quantity=Decimal("10"),
                    price=Decimal("100"),
                    charges=Decimal("0.00"),
                    amount=Decimal("1000.00"),
                )
            )
            db.commit()
            fund_id, goal_ids = fund.id, [g.id for g in goals]
        body = HoldingCreate.model_validate({"instrument_id": fund_id})

        results = together(
            engine, [(lambda db, g=g, b=body, u=user: add_holding(g, b, u, db)) for g in goal_ids]
        )

        assert sorted(results) == ["ok", "refused"]
        with Session(engine) as db:
            assert db.scalar(select(func.count()).select_from(GoalHolding)) == 1
        with engine.begin() as conn:
            conn.execute(text("TRUNCATE users, accounts, transactions RESTART IDENTITY CASCADE"))


def test_setting_money_aside_and_archiving_the_bank_never_both_succeed(engine: Engine) -> None:
    """Both lock the bank first, so the second sees the first: earmarked or archived, not both."""
    for _ in range(10):
        user, [bank] = setup(engine, ("bank", "1000.00"))
        with Session(engine) as db:
            goal = Goal(user_id=user.id, name="EF", kind="custom")
            db.add(goal)
            db.commit()
            goal_id = goal.id
        body = EarmarkCreate.model_validate(
            {"account_id": bank, "action": "set_aside", "amount": "500.00"}
        )

        results = together(
            engine,
            [
                lambda db, g=goal_id, b=body, u=user: add_earmark(g, b, u, db),
                lambda db, a=bank, u=user: archive_account(a, u, db),
            ],
        )

        assert sorted(results) == ["ok", "refused"]
        with Session(engine) as db:
            archived = db.get(Account, bank).archived_at is not None
            earmarked = db.scalar(select(func.count()).select_from(GoalEarmark)) == 1
            assert archived != earmarked
            assert results == (["refused", "ok"] if archived else ["ok", "refused"])
        with engine.begin() as conn:
            conn.execute(text("TRUNCATE users, accounts, transactions RESTART IDENTITY CASCADE"))
