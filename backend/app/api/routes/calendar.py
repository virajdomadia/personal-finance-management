from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api import cash_flow as cf
from app.api import spend_calendar as sc
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.recurring import TemplateRow
from app.api.reminder_payments import fixed_payment_ids, load_reminder_payments
from app.api.routes.accounts import fmt
from app.api.routes.cash_flow import _future, _month
from app.db.session import DbSession
from app.models.investment import Instrument, Sip
from app.models.recurring import RecurringTemplate
from app.models.transaction import Transaction

router = APIRouter(prefix="/calendar", tags=["calendar"], dependencies=[Depends(get_current_user)])


class FixedLine(BaseModel):
    id: int  # the reminder's id, or the SIP's
    source: str  # "reminder" or "sip"
    name: str
    kind: str  # "income" or "out"
    type: str  # the reminder's transaction type; "sip" for a SIP
    amount: str
    day: int
    account_id: int


class CalendarDayOut(BaseModel):
    date: str
    spent: str | None  # None after today
    over: bool | None  # None after today, or when there's no daily amount


class Mark(BaseModel):
    """A reminder's occurrence on a day of the month."""

    date: str
    template_id: int
    name: str
    amount: str
    kind: str  # "income" or "out"
    state: str  # "paid", "skipped", "due" or "coming"


class SpendCalendar(BaseModel):
    month: str  # "YYYY-MM"
    is_current: bool
    through: str  # the last day counted
    income: str
    fixed_out: str
    free: str
    per_day: str | None  # None without a monthly income reminder
    spent: str  # month to date, payments of fixed items left out
    left: str  # free − spent
    pace: str | None  # positive: under the daily amount so far
    fixed: list[FixedLine]  # income first, then outgoings, each by day
    days: list[CalendarDayOut]
    marks: list[Mark]  # every active reminder's occurrences this month, by date
    previous_month: str | None
    next_month: str | None


@router.get("")
def spend_calendar(
    user: CurrentUser,
    db: DbSession,
    month: Annotated[str | None, Query(pattern=r"^[1-9][0-9]{3}-(0[1-9]|1[0-2])$")] = None,
) -> SpendCalendar:
    """A month's fixed money, its daily amount, and what was spent each day. Rules:
    docs/architecture/financial-calculations.md, "Spend calendar"."""
    today = today_india()
    this_month = date(today.year, today.month, 1)
    first = this_month if month is None else date(int(month[:4]), int(month[5:]), 1)
    if first > today:
        raise _future()
    end = date(first.year, first.month, cf.last_day(first.year, first.month))
    through = min(end, today)

    lines: list[tuple[sc.Fixed, FixedLine]] = []
    templates = list(
        db.scalars(select(RecurringTemplate).where(RecurringTemplate.user_id == user.id))
    )
    payments = load_reminder_payments(db, user.id)
    marks: list[Mark] = []
    rows = {
        t.id: TemplateRow(
            t.id, t.frequency, t.day, t.month, t.start_date, t.end_date, t.remind_days, t.active
        )
        for t in templates
    }
    for t in templates:
        if not t.active:
            continue
        row = rows[t.id]
        for day, state in sc.month_marks(
            row, payments.paid.get(t.id, []), payments.skips.get(t.id, set()), first, today
        ):
            marks.append(
                Mark(
                    date=day.isoformat(),
                    template_id=t.id,
                    name=t.name,
                    amount=fmt(t.amount),
                    kind="income" if t.type == "income" else "out",
                    state=state,
                )
            )
    marks.sort(key=lambda m: (m.date, m.name))
    for t in templates:
        if t.frequency != "monthly":
            continue
        kind = "income" if t.type == "income" else "out"
        # A stopped reminder counts up to the last occurrence a payment recorded through it settled.
        last = sc.last_settled(
            rows[t.id], payments.linked.get(t.id, []), payments.skips.get(t.id, set())
        )
        fixed = sc.Fixed(t.name, kind, t.amount, t.day, t.start_date, t.end_date, t.active, last)
        line = FixedLine(
            id=t.id,
            source="reminder",
            name=t.name,
            kind=kind,
            type=t.type,
            amount=fmt(t.amount),
            day=t.day,
            account_id=t.account_id,
        )
        lines.append((fixed, line))
    plans = db.execute(
        select(Sip, Instrument.name)
        .join(Instrument, Instrument.id == Sip.instrument_id)
        .where(Sip.user_id == user.id)
    )
    for s, name in plans:
        fixed = sc.Fixed(name, "out", s.amount, s.day, s.start_date, None, s.active)
        line = FixedLine(
            id=s.id,
            source="sip",
            name=name,
            kind="out",
            type="sip",
            amount=fmt(s.amount),
            day=s.day,
            account_id=s.account_id,
        )
        lines.append((fixed, line))
    counted = [(f, line) for f, line in lines if sc.counts_in(f, first)]
    counted.sort(key=lambda p: (p[1].kind != "income", p[1].day, p[1].name))
    allowance = sc.allowance([f for f, _ in counted], first)

    # Paying any fixed outgoing is never everyday spending, even in a month it doesn't count in
    # (stopped, not started yet, or paid late).
    fixed_reminders = {
        line.id for _, line in lines if line.source == "reminder" and line.kind == "out"
    }
    skip = fixed_payment_ids(db, user.id, fixed_reminders)
    rows = [
        cf.Row(*r[1:])
        for r in db.execute(
            select(
                Transaction.id,
                Transaction.type,
                Transaction.amount,
                Transaction.interest,
                Transaction.category,
                Transaction.date,
            ).where(
                Transaction.user_id == user.id,
                Transaction.type.in_(cf.COUNTED_TYPES),
                Transaction.date >= first,
                Transaction.date <= through,
            )
        )
        if r[0] not in skip
    ]
    days = sc.calendar_days(rows, first, through, allowance.per_day)
    spent = sum((d.spent for d in days if d.spent is not None), cf.ZERO)
    pace = sc.pace(allowance.per_day, through, first, spent)

    earliest = db.scalar(select(func.min(Transaction.date)).where(Transaction.user_id == user.id))
    earliest_first = None if earliest is None else date(earliest.year, earliest.month, 1)
    prev, nxt = cf.previous_month(first), cf.next_month(first)
    return SpendCalendar(
        month=_month(first),
        is_current=first == this_month,
        through=through.isoformat(),
        income=fmt(allowance.income),
        fixed_out=fmt(allowance.fixed_out),
        free=fmt(allowance.free),
        per_day=None if allowance.per_day is None else fmt(allowance.per_day),
        spent=fmt(spent),
        left=fmt(allowance.free - spent),
        pace=None if pace is None else fmt(pace),
        fixed=[line for _, line in counted],
        marks=marks,
        days=[
            CalendarDayOut(
                date=d.date.isoformat(),
                spent=None if d.spent is None else fmt(d.spent),
                over=d.over,
            )
            for d in days
        ],
        previous_month=(
            _month(prev) if earliest_first is not None and prev >= earliest_first else None
        ),
        next_month=None if nxt > today else _month(nxt),
    )
