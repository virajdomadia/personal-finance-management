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
