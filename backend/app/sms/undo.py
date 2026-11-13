"""Taking back one SMS read: the messages the phone sent from a moment on, and the transactions
they added. For a read started by mistake (a start date 90 days back, say). Balances are worked
out from transactions, so removing them is all a balance needs.

Only what those messages made on their own goes. A transaction typed by hand that a message was
matched to stays, and so does anything an earlier message also points at: a message may have
turned it into a transfer, which can't be told apart from an edit, so it is listed to check.
"""

import datetime as dt
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.insurance import PolicyPeriod
from app.models.sms import SmsEntry
from app.models.transaction import Transaction
from app.sms.recording import lock_user

INDIA = ZoneInfo("Asia/Kolkata")
# Messages sent less than this far apart count as one read.
READ_GAP = dt.timedelta(minutes=5)


@dataclass
class Read:
    """One run of messages the phone sent together."""

    started: dt.datetime
    ended: dt.datetime
    messages: int
    first_day: dt.date
    last_day: dt.date


@dataclass
class Undo:
    entries: list[SmsEntry] = field(default_factory=list)
    remove: list[Transaction] = field(default_factory=list)
    # Linked to these messages but kept, with why.
    keep: list[tuple[Transaction, str]] = field(default_factory=list)


def _aware(moment: dt.datetime) -> dt.datetime:
    # SQLite hands back naive times; they are UTC.
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=dt.UTC)


def recent_reads(db: Session, user_id: int, limit: int = 10) -> list[Read]:
    """The latest reads, newest first, worked out from when each message arrived."""
    rows = db.execute(
        select(SmsEntry.created_at, SmsEntry.occurred_on)
        .where(SmsEntry.user_id == user_id)
        .order_by(SmsEntry.created_at, SmsEntry.id)
    ).all()
    reads: list[Read] = []
    for created, day in rows:
        created = _aware(created)
        last = reads[-1] if reads else None
        if last is not None and created - last.ended <= READ_GAP:
            last.ended = created
            last.messages += 1
            last.first_day = min(last.first_day, day)
            last.last_day = max(last.last_day, day)
        else:
            reads.append(Read(created, created, 1, day, day))
    return list(reversed(reads))[:limit]


def plan(db: Session, user_id: int, since: dt.datetime, before: dt.date | None = None) -> Undo:
    """What undoing the messages that arrived from `since` on would remove. `before` keeps
    messages about that day or later (today's real ones, say)."""
    since = since.astimezone(dt.UTC)  # stored in UTC; SQLite compares the text
    query = select(SmsEntry).where(SmsEntry.user_id == user_id, SmsEntry.created_at >= since)
    if before is not None:
        query = query.where(SmsEntry.occurred_on < before)
    entries = list(db.scalars(query.order_by(SmsEntry.occurred_on, SmsEntry.id)))
    undo = Undo(entries=entries)
    ids = {e.id for e in entries}
    linked = {e.transaction_id for e in entries if e.transaction_id is not None}
    if not linked:
        return undo
    shared = set(
        db.scalars(
            select(SmsEntry.transaction_id).where(
                SmsEntry.transaction_id.in_(linked), SmsEntry.id.not_in(ids)
            )
        )
    )
    insured = set(
        db.scalars(
            select(PolicyPeriod.transaction_id).where(PolicyPeriod.transaction_id.in_(linked))
        )
    )
    found = db.scalars(
        select(Transaction)
        .where(Transaction.id.in_(linked), Transaction.user_id == user_id)
        .order_by(Transaction.date, Transaction.id)
    )
    for tx in found:
        if tx.source != "sms":
            why = "typed by hand; only its link to the message goes"
            if tx.type == "transfer":
                why += ". A message may have made it a transfer: check it"
            undo.keep.append((tx, why))
        elif tx.id in shared:
            undo.keep.append((tx, "an earlier message points at it too: check it"))
        elif _aware(tx.created_at) < since:
            undo.keep.append((tx, "recorded before this read: check it"))
        elif tx.id in insured:
            undo.keep.append((tx, "an insurance period is paid by it"))
        else:
            undo.remove.append(tx)
    return undo


def describe(undo: Undo) -> list[str]:
    """The plan in words, one line each."""
    counts: dict[str, int] = {}
    for entry in undo.entries:
        counts[entry.status] = counts.get(entry.status, 0) + 1
    lines = [f"Messages: {len(undo.entries)}"]
    lines += [f"  {status}: {n}" for status, n in sorted(counts.items())]
    if undo.entries:
        days = [e.occurred_on for e in undo.entries]
        lines.append(f"  about {min(days)} to {max(days)}")
    lines.append(f"Transactions removed: {len(undo.remove)}")
    lines += [f"  {_tx(tx)}" for tx in undo.remove]
    lines.append(f"Transactions kept: {len(undo.keep)}")
    lines += [f"  {_tx(tx)} ({why})" for tx, why in undo.keep]
    return lines


def _tx(tx: Transaction) -> str:
    what = tx.category or tx.note or ""
    return f"#{tx.id} {tx.date} {tx.type} {tx.amount} {what}".rstrip()


def apply(
    db: Session, user_id: int, since: dt.datetime, before: dt.date | None = None
) -> list[str]:
    """Removes what `plan` lists, all at once, under the same lock an SMS sync takes. Returns
    `describe` of what went."""
    lock_user(db, user_id)
    undo = plan(db, user_id, since, before)
    lines = describe(undo)
    entry_ids = [e.id for e in undo.entries]
    tx_ids = [tx.id for tx in undo.remove]
    # Messages first: they point at the transactions.
    if entry_ids:
        db.execute(delete(SmsEntry).where(SmsEntry.id.in_(entry_ids)))
    if tx_ids:
        db.execute(delete(Transaction).where(Transaction.id.in_(tx_ids)))
    db.commit()
    return lines
