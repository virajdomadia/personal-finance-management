"""The next 30 days and safe to spend. Rules: docs/architecture/financial-calculations.md,
"The next 30 days" and "Safe to spend"; the logic is in `app.api.upcoming`."""

from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from app.api import upcoming as up
from app.api.balances import balance_of
from app.api.cash_flow import last_day
from app.api.categories import all_categories
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.goals import load_goal_book
from app.api.loans import load_book
from app.api.routes.accounts import fmt
from app.api.routes.budgets import MonthBook
from app.db.session import DbSession
from app.models.account import Account

router = APIRouter(tags=["upcoming"], dependencies=[Depends(get_current_user)])

Kind = Literal["recurring", "insurance", "emi", "sip", "rd", "card_bill", "goal"]


class UpcomingItem(BaseModel):
    date: str
    kind: Kind
    name: str
    account_id: int | None
    account_name: str | None
    amount: str
    varies: bool  # a card bill with no statement yet: `amount` is what is owed now
    direction: Literal["out", "in", "none"]
    overdue: bool
    balance_after: str  # bank, cash and wallet together, after this item
    ref_id: int  # the reminder, loan, SIP, RD, card or goal


class Upcoming(BaseModel):
    start: str
    through: str
    starting_balance: str
    ending_balance: str
    items: list[UpcomingItem]


class Part(BaseModel):
    name: str
    amount: str


class DuePart(Part):
    date: str
    kind: Kind
    overdue: bool
    varies: bool


class BudgetPart(Part):
    category_id: int
    remaining: str  # this month's budget not yet spent
    due: str  # bills above in this category, already counted


class Payday(BaseModel):
    name: str
    date: str


class SafeToSpend(BaseModel):
    amount: str  # can be negative: money short
    until: str  # the last day the dues count to
    reason: Literal["salary", "month_end"]
    payday: Payday | None
    note: str | None  # e.g. "Today's salary isn't recorded yet."
    money: str
    due: str
    goals: str
    budgets: str
    money_items: list[Part]  # each bank, cash and wallet account
    due_items: list[DuePart]
    goal_items: list[Part]
    budget_items: list[BudgetPart]


def _context(db: DbSession, user_id: int, today: date) -> up.Context:
    accounts = list(db.scalars(select(Account).where(Account.user_id == user_id)))
    return up.Context(accounts, load_book(db, user_id, accounts), today)


@router.get("/upcoming")
def upcoming(user: CurrentUser, db: DbSession) -> Upcoming:
    """Everything due in the next 30 days (and anything overdue), with the balance of bank,
    cash and wallet accounts after each item."""
    today = today_india()
    until = today + timedelta(days=up.WINDOW_DAYS)
    ctx = _context(db, user.id, today)
    goals = load_goal_book(db, user.id, today)
    items = up.due_items(db, user.id, ctx, goals, until)
    start = ctx.money_now()
    after = up.running(start, items)
    return Upcoming(
        start=today.isoformat(),
        through=until.isoformat(),
        starting_balance=fmt(start),
        ending_balance=fmt(after[-1] if after else start),
        items=[
            UpcomingItem(
                date=i.date.isoformat(),
                kind=i.kind,  # type: ignore[arg-type]
                name=i.name,
                account_id=i.account_id,
                account_name=i.account_name,
                amount=fmt(i.amount),
                varies=i.varies,
                direction=i.direction,  # type: ignore[arg-type]
                overdue=i.overdue,
                balance_after=fmt(balance),
                ref_id=i.ref_id,
            )
            for i, balance in zip(items, after, strict=True)
        ],
    )


@router.get("/safe-to-spend")
def safe_to_spend(user: CurrentUser, db: DbSession) -> SafeToSpend:
    """money now − due before payday − set aside for goals − budgets left, with every line."""
    today = today_india()
    ctx = _context(db, user.id, today)
    categories = all_categories(db, user.id)
    templates = up.load_templates(db, user.id, ctx)
    found = up.payday(templates, categories, today)
    note = None
    if found is None:
        until = date(today.year, today.month, last_day(today.year, today.month))
        reason = "month_end"
    elif found.pending_today:
        # It is payday but the salary isn't in yet: count what is due up to today only.
        until, reason, note = today, "salary", "Today's salary isn't recorded yet."
    else:
        until, reason = found.date - timedelta(days=1), "salary"
    goals = load_goal_book(db, user.id, today)
    dues = [i for i in up.due_items(db, user.id, ctx, goals, until, templates) if i.reserve > 0]

    money_items = [Part(name=a.name, amount=fmt(balance_of(a, ctx.book.flows))) for a in ctx.pool]
    money = ctx.money_now()
    due = sum((i.reserve for i in dues), up.ZERO)

    goal_items = []
    for r in goals.responses.values():
        if r.archived:
            continue
        held = sum((Decimal(e.amount) for e in r.earmarks if e.account_id in ctx.pool_ids), up.ZERO)
        if held != 0:
            goal_items.append(Part(name=r.name, amount=fmt(held)))
    set_aside = sum((Decimal(p.amount) for p in goal_items), up.ZERO)

    first = date(today.year, today.month, 1)
    book = MonthBook(db, user.id, first, today)
    db.commit()  # a first read seeds the default categories
    this_month = [i for i in dues if (i.date.year, i.date.month) == (today.year, today.month)]
    budget_items = []
    for line in (b for b in book.lines if b.counted):
        already = sum(
            (
                min(i.spending, i.reserve)
                for i in this_month
                if up.in_budget(i.category, line.category, categories)
            ),
            up.ZERO,
        )
        left = max(line.remaining - already, up.ZERO)
        budget_items.append(
            BudgetPart(
                category_id=line.category.id,
                name=line.category.name,
                remaining=fmt(line.remaining),
                due=fmt(already),
                amount=fmt(left),
            )
        )
    budgets_left = sum((Decimal(b.amount) for b in budget_items), up.ZERO)

    return SafeToSpend(
        amount=fmt(money - due - set_aside - budgets_left),
        until=until.isoformat(),
        reason=reason,  # type: ignore[arg-type]
        payday=None if found is None else Payday(name=found.name, date=found.date.isoformat()),
        note=note,
        money=fmt(money),
        due=fmt(due),
        goals=fmt(set_aside),
        budgets=fmt(budgets_left),
        money_items=money_items,
        due_items=[
            DuePart(
                name=i.name,
                amount=fmt(i.reserve),
                date=i.date.isoformat(),
                kind=i.kind,  # type: ignore[arg-type]
                overdue=i.overdue,
                varies=i.varies,
            )
            for i in dues
        ],
        goal_items=goal_items,
        budget_items=budget_items,
    )
