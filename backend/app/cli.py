"""Admin commands for the users table: python -m app.cli <command>."""

import argparse
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.db.session import SessionLocal
from app.models.user import User
from app.prices.fetch import default_fetcher
from app.prices.refresh import run_nightly


def _find(db: Session, email: str) -> User:
    user = db.scalar(select(User).where(User.email == email.strip().lower()))
    if user is None:
        raise ValueError(f"No user with email {email.strip().lower()}")
    return user


def create_user(db: Session, email: str) -> User:
    email = email.strip().lower()
    if db.scalar(select(User).where(User.email == email)) is not None:
        raise ValueError(f"A user with email {email} already exists")
    user = User(email=email)
    db.add(user)
    db.commit()
    return user


def move_user(db: Session, old_email: str, new_email: str) -> User:
    user = _find(db, old_email)
    new_email = new_email.strip().lower()
    if new_email != user.email and db.scalar(select(User).where(User.email == new_email)):
        raise ValueError(f"A user with email {new_email} already exists")
    user.email = new_email
    user.google_sub = None
    user.session_version += 1
    db.commit()
    return user


def revoke_sessions(db: Session, email: str) -> User:
    user = _find(db, email)
    user.session_version += 1
    db.commit()
    return user


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("create-user", help="add a user").add_argument("email")
    move = commands.add_parser("move-user", help="point a user at a new Google account")
    move.add_argument("old_email")
    move.add_argument("new_email")
    commands.add_parser("revoke-sessions", help="sign a user out everywhere").add_argument("email")
    commands.add_parser("refresh-prices", help="fetch today's prices now, as the nightly job does")
    args = parser.parse_args(argv)

    try:
        with SessionLocal() as db:
            if args.command == "create-user":
                user = create_user(db, args.email)
                print(f"Created {user.email}")
            elif args.command == "move-user":
                user = move_user(db, args.old_email, args.new_email)
                print(f"Moved to {user.email}; Google link cleared and sessions revoked")
            elif args.command == "refresh-prices":
                with default_fetcher() as fetcher:
                    report = run_nightly(db, fetcher, today_india())
                print(f"Updated: {report.updated}")
                print(f"Failed: {report.failed}")
            else:
                user = revoke_sessions(db, args.email)
                print(f"Revoked sessions for {user.email}")
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
