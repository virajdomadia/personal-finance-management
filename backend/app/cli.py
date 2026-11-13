"""Admin commands for users and their data: python -m app.cli <command>."""

import argparse
import json
import sys
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.snapshots import BACKFILL_MONTHS, backfill
from app.db.session import SessionLocal
from app.export.backup import dump, restore
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


def export_user(db: Session, email: str, path: str) -> int:
    """Writes the user's backup to `path`. Returns the number of rows written."""
    document = dump(db, _find(db, email))
    with open(path, "w", encoding="utf-8") as out:
        json.dump(document, out, ensure_ascii=False, indent=1)
    return sum(len(rows) for rows in document["tables"].values())


def restore_user(db: Session, email: str, path: str, replace: bool = False) -> int:
    """Loads a backup into the user (created if missing) in one transaction. Returns the rows."""
    try:
        with open(path, encoding="utf-8") as source:
            document = json.load(source)
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Can't read {path}: {error}") from error
    email = email.strip().lower()
    try:
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(email=email)
            db.add(user)
            db.flush()
        count = restore(db, user, document, replace=replace)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return count


def backfill_net_worth(
    db: Session, email: str | None, today: date, months: int = BACKFILL_MONTHS
) -> list[tuple[str, int]]:
    """Estimated month-ends for one user, or for every user; (email, points written) each."""
    users = [_find(db, email)] if email else list(db.scalars(select(User).order_by(User.id)))
    return [(user.email, backfill(db, user.id, today, months)) for user in users]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("create-user", help="add a user").add_argument("email")
    move = commands.add_parser("move-user", help="point a user at a new Google account")
    move.add_argument("old_email")
    move.add_argument("new_email")
    commands.add_parser("revoke-sessions", help="sign a user out everywhere").add_argument("email")
    export = commands.add_parser("export-user", help="write a user's JSON backup to a file")
    export.add_argument("email")
    export.add_argument("out")
    load = commands.add_parser("restore-user", help="load a JSON backup into a user")
    load.add_argument("email")
    load.add_argument("backup")
    load.add_argument(
        "--replace", action="store_true", help="delete the user's data first, in one transaction"
    )
    commands.add_parser("refresh-prices", help="fetch today's prices now, as the nightly job does")
    estimate = commands.add_parser(
        "backfill-net-worth",
        help="estimate past month-end net worth from transactions (investments left out)",
    )
    estimate.add_argument("email", nargs="?", help="one user; every user when left out")
    estimate.add_argument(
        "--months", type=int, default=BACKFILL_MONTHS, choices=range(1, 61), metavar="N"
    )
    args = parser.parse_args(argv)

    try:
        with SessionLocal() as db:
            if args.command == "create-user":
                user = create_user(db, args.email)
                print(f"Created {user.email}")
            elif args.command == "move-user":
                user = move_user(db, args.old_email, args.new_email)
                print(f"Moved to {user.email}; Google link cleared and sessions revoked")
            elif args.command == "export-user":
                rows = export_user(db, args.email, args.out)
                print(f"Wrote {rows} rows to {args.out}")
            elif args.command == "restore-user":
                rows = restore_user(db, args.email, args.backup, replace=args.replace)
                print(f"Restored {rows} rows into {args.email.strip().lower()}")
            elif args.command == "refresh-prices":
                with default_fetcher() as fetcher:
                    report = run_nightly(db, fetcher, today_india())
                print(f"Updated: {report.updated}")
                print(f"Failed: {report.failed}")
            elif args.command == "backfill-net-worth":
                for email, written in backfill_net_worth(
                    db, args.email, today_india(), args.months
                ):
                    print(f"{email}: {written} estimated month-ends")
            else:
                user = revoke_sessions(db, args.email)
                print(f"Revoked sessions for {user.email}")
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
