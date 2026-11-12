"""Recording an SMS entry's money, and the review states it can be left in.

Shared by `ingest` (the decision steps) and `expected` (EMIs, SIPs and reminders).
"""

from typing import Any

from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes.transactions import lock_accounts, save_checks
from app.models.sms import SmsEntry
from app.models.transaction import Transaction
from app.models.user import User


def lock_user(db: Session, user_id: int) -> None:
    """Takes the user's row lock until commit, so an SMS sync and a review answer for the same
    user run one at a time and can't lock accounts and entries in opposite orders. Taken first,
    before any other lock. (SQLite has no row locks; its writes are serialised anyway.)"""
    db.execute(select(User.id).where(User.id == user_id).with_for_update())


def review(entry: SmsEntry, reason: str, message: str | None = None) -> SmsEntry:
    entry.status = "review"
    entry.reason = reason
    entry.message = None if message is None else message[:200]
    return entry


def link(entry: SmsEntry, tx_id: int) -> None:
    entry.transaction_id = tx_id
    entry.status, entry.reason, entry.message, entry.candidates = "recorded", None, None, None


def record(db: Session, user_id: int, entry: SmsEntry, values: dict[str, Any]) -> bool:
    """Saves the transaction under the usual checks and links it to the entry.

    When a check fails (below ₹0, say) nothing is recorded: the entry waits in review with the
    checker's message.
    """
    values = {
        "to_account_id": None,
        "interest": None,
        "note": None,
        "recurring_template_id": None,
        **values,
    }
    accounts = lock_accounts(db, user_id, [values["account_id"], values["to_account_id"]])
    try:
        save_checks(db, user_id, accounts, values, existing_id=None, allow_uncategorised=True)
    except RequestValidationError as error:
        review(entry, "balance", error.errors()[0]["msg"])
        entry.transaction_id = None
        return False
    tx = Transaction(user_id=user_id, source="sms", **values)
    db.add(tx)
    db.flush()
    entry.transaction_id = tx.id
    return True
