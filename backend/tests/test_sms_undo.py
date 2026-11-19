from contextlib import nullcontext
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app import cli
from app.cli import create_user
from app.models.account import Account
from app.models.corporate_action import DividendLink, StockAction
from app.models.investment import Instrument
from app.models.sms import SmsEntry
from app.models.transaction import Transaction
from app.sms import undo
from tests.conftest import ON_POSTGRES

BEFORE = datetime(2026, 11, 13, 10, 0, tzinfo=UTC)  # an earlier, wanted read
READ = datetime(2026, 11, 13, 12, 30, tzinfo=UTC)  # the mistaken one: 18:00 in India
_seq = iter(range(1_000_000))


def _setup(db: Session) -> tuple[int, int]:
    user = create_user(db, "me@gmail.com")
    acct = Account(user_id=user.id, type="cash", name="Cash", opening_balance=Decimal("500.00"))
    db.add(acct)
    db.commit()
    return user.id, acct.id


def _tx(db: Session, user: int, acct: int, at: datetime, source: str = "sms", **kw) -> Transaction:
    tx = Transaction(
        user_id=user,
        type=kw.pop("type", "expense"),
        amount=Decimal("100.00"),
        date=date(2026, 9, 1),
        account_id=acct,
        category="Food",
        source=source,
        created_at=at,
        **kw,
    )
    db.add(tx)
    db.flush()
    return tx


def _sms(db: Session, user: int, at: datetime, tx: Transaction | None = None, **kw) -> SmsEntry:
    entry = SmsEntry(
        user_id=user,
        hash=f"{next(_seq):064d}",
        sender="AD-HDFCBK",
        bank="hdfc",
        kind="debit",
        amount=Decimal("100.00"),
        occurred_on=kw.pop("occurred_on", date(2026, 9, 1)),
        status=kw.pop("status", "recorded" if tx else "review"),
        transaction_id=None if tx is None else tx.id,
        created_at=at,
    )
    db.add(entry)
    db.flush()
    return entry


def test_undo_removes_the_read_and_only_what_it_recorded(db_session: Session):
    user, acct = _setup(db_session)
    old_tx = _tx(db_session, user, acct, BEFORE)
    _sms(db_session, user, BEFORE, old_tx)
    _sms(db_session, user, BEFORE)  # an earlier review card

    mine = _tx(db_session, user, acct, READ)
    _sms(db_session, user, READ, mine)
    typed = _tx(db_session, user, acct, BEFORE, source="manual")
    _sms(db_session, user, READ + timedelta(minutes=1), typed)
    _sms(db_session, user, READ + timedelta(minutes=1))  # waiting in review
    db_session.commit()

    planned = undo.plan(db_session, user, READ)
    assert len(planned.entries) == 3
    assert [tx.id for tx in planned.remove] == [mine.id]
    assert [tx.id for tx, _ in planned.keep] == [typed.id]

    undo.apply(db_session, user, READ)
    left = set(db_session.scalars(select(Transaction.id)))
    assert left == {old_tx.id, typed.id}
    assert db_session.scalar(select(func.count()).select_from(SmsEntry)) == 2


def test_undo_keeps_what_an_earlier_message_points_at(db_session: Session):
    user, acct = _setup(db_session)
    # A transfer made of an earlier message's expense and a mistaken one's other side.
    joined = _tx(db_session, user, acct, BEFORE, type="transfer")
    _sms(db_session, user, BEFORE, joined)
    _sms(db_session, user, READ, joined)
    db_session.commit()

    planned = undo.plan(db_session, user, READ)
    assert planned.remove == []
    assert {tx.id for tx, _ in planned.keep} == {joined.id}
    undo.apply(db_session, user, READ)
    assert set(db_session.scalars(select(Transaction.id))) == {joined.id}


def test_before_keeps_messages_about_later_days(db_session: Session):
    user, acct = _setup(db_session)
    _sms(db_session, user, READ, occurred_on=date(2026, 9, 1))
    today = _sms(db_session, user, READ, occurred_on=date(2026, 11, 13))
    db_session.commit()
    undo.apply(db_session, user, READ, before=date(2026, 11, 13))
    assert list(db_session.scalars(select(SmsEntry.id))) == [today.id]


def test_cli_lists_reads_and_only_removes_with_apply(db_session: Session, monkeypatch, capsys):
    user, acct = _setup(db_session)
    _sms(db_session, user, BEFORE, occurred_on=date(2026, 11, 13))
    mine = _tx(db_session, user, acct, READ)
    _sms(db_session, user, READ, mine, occurred_on=date(2026, 8, 15))
    _sms(db_session, user, READ + timedelta(minutes=3), occurred_on=date(2026, 9, 1))
    db_session.commit()
    monkeypatch.setattr(cli, "SessionLocal", lambda: nullcontext(db_session))

    assert cli.main(["sms-reads", "me@gmail.com"]) == 0
    assert capsys.readouterr().out == (
        "2026-11-13 18:00-18:03  2 messages about 2026-08-15 to 2026-09-01\n"
        "2026-11-13 15:30-15:30  1 messages about 2026-11-13 to 2026-11-13\n"
    )

    assert cli.main(["undo-sms-read", "me@gmail.com", "2026-11-13 18:00"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("Would remove (nothing changed")
    assert "Messages: 2" in out and f"#{mine.id} 2026-09-01 expense 100.00 Food" in out
    assert db_session.scalar(select(func.count()).select_from(SmsEntry)) == 3

    assert cli.main(["undo-sms-read", "me@gmail.com", "2026-11-13 18:00", "--apply"]) == 0
    assert capsys.readouterr().out.startswith("Removed:\nMessages: 2\n")
    assert db_session.scalar(select(func.count()).select_from(SmsEntry)) == 1
    assert db_session.get(Transaction, mine.id) is None

    assert cli.main(["undo-sms-read", "me@gmail.com", "yesterday"]) == 1
    assert "Not a date and time" in capsys.readouterr().err


def _foreign_keys_on(db: Session) -> None:
    """SQLite checks foreign keys only when asked, as PostgreSQL always does."""
    if ON_POSTGRES:
        return
    db.commit()
    db.execute(text("PRAGMA foreign_keys=ON"))
    db.commit()
    assert db.execute(text("PRAGMA foreign_keys")).scalar() == 1


def link_dividend(db: Session, user: int, tx: Transaction) -> int:
    """Links `tx` to an applied dividend of a new stock; returns the link's id."""
    infy = Instrument(user_id=user, kind="stock", symbol="INFY", name="Infosys")
    db.add(infy)
    db.flush()
    paid = StockAction(
        user_id=user, instrument_id=infy.id, kind="dividend", ex_date=date(2026, 8, 20),
        amount_per_share=Decimal("10"), status="applied",
    )  # fmt: skip
    db.add(paid)
    db.flush()
    link = DividendLink(user_id=user, stock_action_id=paid.id, transaction_id=tx.id)
    db.add(link)
    db.commit()
    return link.id


def test_undo_removes_a_credit_linked_to_a_dividend(db_session: Session):
    user, acct = _setup(db_session)
    credit = _tx(db_session, user, acct, READ, type="income")
    _sms(db_session, user, READ, credit)
    link_dividend(db_session, user, credit)
    _foreign_keys_on(db_session)

    undo.apply(db_session, user, READ)

    assert db_session.scalars(select(Transaction)).all() == []
    assert db_session.scalars(select(DividendLink)).all() == []
    assert len(db_session.scalars(select(StockAction)).all()) == 1  # the dividend stays
