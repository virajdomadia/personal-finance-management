"""Goal maths: pure functions, no database."""

from collections import defaultdict
from collections.abc import Mapping
from datetime import date
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Literal, NamedTuple

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.balances import balance_of, load_flows
from app.api.dates import clamped_date
from app.api.portfolio import (
    latest_prices,
    load_kinds,
    load_trade_rows,
    replay,
    round_paise,
    summarise,
)
from app.api.routes.accounts import fmt, rupees
from app.models.account import Account
from app.models.goal import Goal, GoalEarmark, GoalHolding
from app.models.insurance import InsurancePolicy
from app.models.investment import Instrument
from app.models.transaction import Transaction

Month = tuple[int, int]  # (year, month)

WINDOW_MONTHS = 6
WHOLE = Decimal(1)


class ExpenseFigure(NamedTuple):
    amount: Decimal | None  # None: no fully recorded month yet
    months: list[Month]  # the months averaged, oldest first


def _index(year: int, month: int) -> int:
    return year * 12 + month - 1


def _month(index: int) -> Month:
    return index // 12, index % 12 + 1


def expense_window(first_tx: date | None, today: date) -> list[Month]:
    """The last 6 calendar months before today's month that were fully recorded."""
    if first_tx is None:
        return []
    this = _index(today.year, today.month)
    first = _index(first_tx.year, first_tx.month)
    if first_tx.day != 1:
        first += 1
    start = max(this - WINDOW_MONTHS, first)
    return [_month(i) for i in range(start, this)]


def monthly_expenses(
    spend: dict[Month, Decimal], first_tx: date | None, today: date
) -> ExpenseFigure:
    months = expense_window(first_tx, today)
    if not months:
        return ExpenseFigure(None, [])
    total = sum((spend.get(m, Decimal(0)) for m in months), Decimal(0))
    return ExpenseFigure(round_paise(total / len(months)), months)


def months_left(target_date: date, today: date) -> int:
    """This month through the target's month, inclusive; 0 if the month is past."""
    gap = _index(target_date.year, target_date.month) - _index(today.year, today.month) + 1
    return max(gap, 0)


class Progress(NamedTuple):
    percent: int | None
    reached: bool
    months_left: int | None
    per_month: Decimal | None
    overdue: bool


def progress(
    target: Decimal | None, saved: Decimal, target_date: date | None, today: date
) -> Progress:
    reached = target is not None and saved >= target
    left = months_left(target_date, today) if target_date is not None else None
    percent = None
    if target is not None and target > 0:
        percent = int((saved / target * 100).quantize(WHOLE, rounding=ROUND_HALF_UP))
    per_month = None
    if target is not None and not reached and left:
        per_month = (
            ((target - saved) / left)
            .quantize(WHOLE, rounding=ROUND_CEILING)
            .quantize(Decimal("0.01"))
        )
    overdue = target_date is not None and target_date < today and not reached
    return Progress(percent, reached, left, per_month, overdue)


def reminder_due(
    monthly_amount: Decimal | None,
    reminder_day: int | None,
    reminder_start: date | None,
    set_aside_this_month: Decimal,
    reached: bool,
    today: date,
) -> Decimal | None:
    """The amount still to set aside this month, or None when nothing is due."""
    if monthly_amount is None or reminder_day is None or reminder_start is None or reached:
        return None
    if _index(today.year, today.month) < _index(reminder_start.year, reminder_start.month):
        return None
    if today < clamped_date(today.year, today.month, reminder_day):
        return None
    if set_aside_this_month >= monthly_amount:
        return None
    return round_paise(monthly_amount - set_aside_this_month)


# Database-aware from here on.
class EmergencyFigures(BaseModel):
    months: int
    monthly: str | None  # the figure used: the override if set, else the computed one
    computed: str | None
    override: str | None
    window: list[str]  # the months averaged, "YYYY-MM", oldest first


class EarmarkLine(BaseModel):
    account_id: int
    account_name: str
    amount: str


class HoldingLine(BaseModel):
    id: int
    kind: Literal["stock", "mutual_fund", "crypto", "ppf", "rd"]
    instrument_id: int | None
    account_id: int | None
    name: str
    value: str
    status: Literal["held", "sold", "closed"]
    note: str | None


class GoalResponse(BaseModel):
    id: int
    name: str
    kind: str
    target: str | None
    target_date: str | None
    note: str | None
    archived: bool
    ef: EmergencyFigures | None
    monthly_amount: str | None
    reminder_day: int | None
    saved: str
    earmarked: str
    holdings_value: str
    percent: int | None
    reached: bool
    months_left: int | None
    per_month: str | None
    overdue: bool
    earmarks: list[EarmarkLine]
    holdings: list[HoldingLine]
    warnings: list[str]


class GoalBook(NamedTuple):
    set_aside_by_account: dict[int, Decimal]  # non-archived goals only
    holding_goal: dict[tuple[str, int], tuple[int, str]]  # active holdings only
    responses: dict[int, GoalResponse]


class GoalTags(NamedTuple):
    """What accounts and holdings need from goals, without working out each goal's figures."""

    set_aside_by_account: dict[int, Decimal]  # non-archived goals only
    set_aside_for: dict[int, list[str]]  # account -> the active goals with money set aside there
    holding_goal: dict[tuple[str, int], tuple[int, str]]  # active holdings only


def free_balance(
    account: Account, flows: dict[int, Decimal], set_aside_by_account: Mapping[int, Decimal]
) -> Decimal:
    """What's left of an account's balance once active goals' earmarks are taken out.

    Pass `GoalBook.set_aside_by_account`. It goes negative when more is set aside than held.
    """
    return balance_of(account, flows) - set_aside_by_account.get(account.id, Decimal(0))


def _spend_by_month(db: Session, user_id: int) -> tuple[dict[Month, Decimal], date | None]:
    """Expenses plus whole EMIs by calendar month, and the user's earliest transaction date."""
    spend: dict[Month, Decimal] = defaultdict(Decimal)
    first: date | None = None
    for kind, amount, day in db.execute(
        select(Transaction.type, Transaction.amount, Transaction.date).where(
            Transaction.user_id == user_id
        )
    ):
        if first is None or day < first:
            first = day
        if kind in ("expense", "emi"):
            spend[(day.year, day.month)] += amount
    return spend, first


def _goals(db: Session, user_id: int) -> list[Goal]:
    """The user's goals in list order: the emergency fund first, then by name."""
    return sorted(
        db.scalars(select(Goal).where(Goal.user_id == user_id)),
        key=lambda g: (g.kind != "emergency", g.name.casefold(), g.id),
    )


def _earmark_sums(db: Session, user_id: int) -> dict[int, dict[int, Decimal]]:
    """goal -> account -> the sum of its entries there, which may be zero once released."""
    sums: dict[int, dict[int, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
    for e in db.scalars(select(GoalEarmark).where(GoalEarmark.user_id == user_id)):
        sums[e.goal_id][e.account_id] += e.amount
    return sums


def _active_holdings(db: Session, user_id: int) -> dict[int, list[GoalHolding]]:
    holdings: dict[int, list[GoalHolding]] = defaultdict(list)
    for h in db.scalars(
        select(GoalHolding)
        .where(GoalHolding.user_id == user_id, GoalHolding.active.is_(True))
        .order_by(GoalHolding.id)
    ):
        holdings[h.goal_id].append(h)
    return holdings


def _holding_key(h: GoalHolding) -> tuple[str, int]:
    if h.instrument_id is not None:
        return ("instrument", h.instrument_id)
    assert h.account_id is not None
    return ("account", h.account_id)


def _tags(
    goals: list[Goal],
    sums: dict[int, dict[int, Decimal]],
    holdings: dict[int, list[GoalHolding]],
) -> GoalTags:
    set_aside: dict[int, Decimal] = defaultdict(Decimal)
    set_aside_for: dict[int, list[str]] = defaultdict(list)
    holding_goal: dict[tuple[str, int], tuple[int, str]] = {}
    for g in goals:
        if g.archived_at is None:
            for account_id, amount in sums[g.id].items():
                if amount != 0:
                    set_aside[account_id] += amount
                    set_aside_for[account_id].append(g.name)
        for h in holdings[g.id]:
            holding_goal[_holding_key(h)] = (g.id, g.name)
    return GoalTags(dict(set_aside), dict(set_aside_for), holding_goal)


def load_goal_tags(db: Session, user_id: int) -> GoalTags:
    """Each account's set-aside total and goals, and the goal each holding is in. Light enough
    for every account and portfolio list: no prices, replay or expense window."""
    goals = _goals(db, user_id)
    if not goals:
        return GoalTags({}, {}, {})
    return _tags(goals, _earmark_sums(db, user_id), _active_holdings(db, user_id))


def load_goal_book(db: Session, user_id: int, today: date) -> GoalBook:
    """Every goal with its earmarks and holdings, loaded once."""
    goals = _goals(db, user_id)
    if not goals:
        return GoalBook({}, {}, {})
    accounts = {a.id: a for a in db.scalars(select(Account).where(Account.user_id == user_id))}
    instruments = {
        i.id: i for i in db.scalars(select(Instrument).where(Instrument.user_id == user_id))
    }
    flows = load_flows(db, user_id)
    result = replay(load_trade_rows(db, user_id))
    prices = latest_prices(db, user_id)
    kinds = load_kinds(db, user_id)
    held_units = {pos.instrument_id for pos in result.positions.values() if pos.quantity > 0}
    funded_premium = {
        p.funded_by_id: p.insurer
        for p in db.scalars(
            select(InsurancePolicy).where(
                InsurancePolicy.user_id == user_id,
                InsurancePolicy.active.is_(True),
                InsurancePolicy.funded_by_id.is_not(None),
            )
        )
    }
    spend, first_tx = _spend_by_month(db, user_id)
    figure = monthly_expenses(spend, first_tx, today)

    sums = _earmark_sums(db, user_id)
    holdings = _active_holdings(db, user_id)
    tags = _tags(goals, sums, holdings)

    responses: dict[int, GoalResponse] = {}
    zero = Decimal("0.00")
    for g in goals:
        earmarks = [(a, amount) for a, amount in sums[g.id].items() if amount != 0]
        earmarks.sort(key=lambda e: (accounts[e[0]].name.casefold(), e[0]))
        earmarked = sum((amount for _, amount in earmarks), zero)

        lines: list[HoldingLine] = []
        holdings_value = zero
        for h in holdings[g.id]:
            if h.instrument_id is not None:
                held = h.instrument_id in held_units
                value = summarise(result, prices, only={h.instrument_id}).value if held else zero
                line = HoldingLine(
                    id=h.id,
                    kind=kinds[h.instrument_id],  # type: ignore[arg-type]
                    instrument_id=h.instrument_id,
                    account_id=None,
                    name=instruments[h.instrument_id].name,
                    value=fmt(value),
                    status="held" if held else "sold",
                    note=None,
                )
            else:
                assert h.account_id is not None
                account = accounts[h.account_id]
                closed = account.archived_at is not None
                value = zero if closed else balance_of(account, flows)
                insurer = funded_premium.get(account.id)
                line = HoldingLine(
                    id=h.id,
                    kind=account.type,  # type: ignore[arg-type]
                    instrument_id=None,
                    account_id=account.id,
                    name=account.name,
                    value=fmt(value),
                    status="closed" if closed else "held",
                    note=None if insurer is None else f"Also funds the {insurer} premium.",
                )
            holdings_value += value
            lines.append(line)
        lines.sort(key=lambda x: (x.name.casefold(), x.id))

        ef = None
        target = g.target_amount
        if g.kind == "emergency":
            monthly = g.ef_monthly_override if g.ef_monthly_override is not None else figure.amount
            months = g.ef_months or 6
            target = None if monthly is None else round_paise(months * monthly)
            override = g.ef_monthly_override
            ef = EmergencyFigures(
                months=months,
                monthly=None if monthly is None else fmt(monthly),
                computed=None if figure.amount is None else fmt(figure.amount),
                override=None if override is None else fmt(override),
                window=[f"{y}-{m:02d}" for y, m in figure.months],
            )
        saved = earmarked + holdings_value
        p = progress(target, saved, g.target_date, today)
        responses[g.id] = GoalResponse(
            id=g.id,
            name=g.name,
            kind=g.kind,
            target=None if target is None else fmt(target),
            target_date=None if g.target_date is None else g.target_date.isoformat(),
            note=g.note,
            archived=g.archived_at is not None,
            ef=ef,
            monthly_amount=None if g.monthly_amount is None else fmt(g.monthly_amount),
            reminder_day=g.reminder_day,
            saved=fmt(saved),
            earmarked=fmt(earmarked),
            holdings_value=fmt(holdings_value),
            percent=p.percent,
            reached=p.reached,
            months_left=p.months_left,
            per_month=None if p.per_month is None else fmt(p.per_month),
            overdue=p.overdue,
            earmarks=[
                EarmarkLine(account_id=a, account_name=accounts[a].name, amount=fmt(amount))
                for a, amount in earmarks
            ],
            holdings=lines,
            warnings=[],
        )

    # Every active goal's earmarks are in the tags, so each account's free balance is known.
    set_aside_by_account = tags.set_aside_by_account
    for g in goals:
        if g.archived_at is not None:
            continue
        for line in responses[g.id].earmarks:
            account = accounts[line.account_id]
            free = free_balance(account, flows, set_aside_by_account)
            if free < 0:
                responses[g.id].warnings.append(
                    f"{rupees(-free)} more is set aside than {account.name} holds."
                )
    return GoalBook(set_aside_by_account, tags.holding_goal, responses)
