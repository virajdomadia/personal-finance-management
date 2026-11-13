import pytest

from app.cli import create_user, move_user, revoke_sessions


def test_create_user_lowercases_email(db_session):
    assert create_user(db_session, "Me@Gmail.com").email == "me@gmail.com"


def test_create_user_rejects_a_second_user_with_same_email(db_session):
    create_user(db_session, "me@gmail.com")
    with pytest.raises(ValueError):
        create_user(db_session, "ME@gmail.com")


def test_move_user_clears_link_and_revokes_sessions(db_session):
    user = create_user(db_session, "old@gmail.com")
    user.google_sub = "123"
    moved = move_user(db_session, "old@gmail.com", "new@gmail.com")
    assert (moved.email, moved.google_sub, moved.session_version) == ("new@gmail.com", None, 2)


def test_revoke_sessions_bumps_version(db_session):
    create_user(db_session, "me@gmail.com")
    assert revoke_sessions(db_session, "me@gmail.com").session_version == 2


def test_unknown_email_raises(db_session):
    with pytest.raises(ValueError):
        revoke_sessions(db_session, "nobody@gmail.com")


def test_refresh_prices_runs_the_job_and_closes_the_fetcher(db_session, monkeypatch, capsys):
    from contextlib import nullcontext

    from app import cli
    from tests.price_fakes import FakeFetcher

    fetcher = FakeFetcher()
    monkeypatch.setattr(cli, "SessionLocal", lambda: nullcontext(db_session))
    monkeypatch.setattr(cli, "default_fetcher", lambda: fetcher)
    assert cli.main(["refresh-prices"]) == 0
    out = capsys.readouterr().out
    assert out == "Updated: {'crypto': 0, 'mutual_fund': 2, 'stock': 2}\nFailed: {}\n"
    assert fetcher.client.is_closed


def _cash_user(db, email, added):
    from datetime import UTC, datetime
    from decimal import Decimal

    from app.models.account import Account

    user = create_user(db, email)
    db.add(
        Account(
            user_id=user.id,
            type="cash",
            name="Cash",
            opening_balance=Decimal("500.00"),
            created_at=datetime(added.year, added.month, added.day, tzinfo=UTC),
        )
    )
    db.commit()
    return user


def test_backfill_net_worth_for_one_user_or_everyone(db_session, monkeypatch, capsys):
    from contextlib import nullcontext
    from datetime import date

    from sqlalchemy import select

    from app import cli
    from app.models.snapshot import NetWorthSnapshot

    _cash_user(db_session, "me@gmail.com", date(2026, 9, 10))
    _cash_user(db_session, "mum@gmail.com", date(2026, 10, 2))
    monkeypatch.setattr(cli, "SessionLocal", lambda: nullcontext(db_session))
    monkeypatch.setattr(cli, "today_india", lambda: date(2026, 11, 13))

    assert cli.main(["backfill-net-worth", "ME@gmail.com"]) == 0
    assert capsys.readouterr().out == "me@gmail.com: 2 estimated month-ends\n"

    assert cli.main(["backfill-net-worth", "--months", "1"]) == 0
    assert capsys.readouterr().out == (
        "me@gmail.com: 1 estimated month-ends\nmum@gmail.com: 1 estimated month-ends\n"
    )
    dates = db_session.scalars(select(NetWorthSnapshot.date).order_by(NetWorthSnapshot.id))
    assert len(list(dates)) == 3


def test_backfill_net_worth_unknown_email_is_an_error(db_session, monkeypatch, capsys):
    from contextlib import nullcontext

    from app import cli

    monkeypatch.setattr(cli, "SessionLocal", lambda: nullcontext(db_session))
    assert cli.main(["backfill-net-worth", "nobody@gmail.com"]) == 1
    assert "No user with email nobody@gmail.com" in capsys.readouterr().err
