"""Everything due soon, the balance after each item, and safe to spend. The rules are in
docs/architecture/financial-calculations.md, "The next 30 days" and "Safe to spend".

Each kind of item comes from its existing due rules: recurring occurrences, SIP and RD due
months, the loan's next EMI, the dashboard's card bills and goal reminders.
"""

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.balances import balance_of
from app.api.categories import name_key
from app.api.dates import clamped_date
from app.api.deposits import rd_due_months
from app.api.goals import GoalBook, reminder_due
from app.api.loans import Book, next_emi
from app.api.recurring import TemplateRow, open_occurrences
from app.api.routes.dashboard import card_bills, next_due_date
from app.api.sips import load_due
from app.models.account import Account
from app.models.category import Category
from app.models.goal import Goal, GoalEarmark
from app.models.insurance import InsurancePolicy
from app.models.investment import Instrument, Sip
from app.models.recurring import RecurringSkip, RecurringTemplate
from app.models.transaction import Transaction
from app.sms.expected import emis_paid

ZERO = Decimal(0)
WINDOW_DAYS = 30
# Where spendable money is: the running balance and safe to spend count these accounts.
POOL = ("bank", "cash", "wallet")
# How far ahead the next salary is looked for.
PAYDAY_HORIZON = timedelta(days=400)
SALARY = name_key("Salary")


@dataclass(frozen=True)
class Due:
    date: date
    kind: str  # recurring | insurance | emi | sip | rd | card_bill | goal
    name: str
    amount: Decimal
    varies: bool  # a card bill with no statement yet: what is owed now
    change: Decimal  # what it does to the bank, cash and wallet balance
    reserve: Decimal  # what safe to spend keeps for it
    overdue: bool
    ref_id: int
    account_id: int | None
    account_name: str | None
    category: str | None  # for an expense or an EMI (Loan interest)
    spending: Decimal  # the part that is spending under the cash flow rules

    @property
    def direction(self) -> str:
        return "out" if self.change < 0 else "in" if self.change > 0 else "none"


class Context:
    """The accounts and balances every item needs."""

    def __init__(self, accounts: Iterable[Account], book: Book, today: date) -> None:
        self.accounts = {a.id: a for a in accounts}
        self.book = book
        self.today = today
        self.pool = [a for a in self.accounts.values() if a.type in POOL and a.archived_at is None]
        self.pool_ids = {a.id for a in self.pool}

    def money_now(self) -> Decimal:
        return sum((balance_of(a, self.book.flows) for a in self.pool), ZERO)

    def account(self, id_: int | None) -> Account | None:
        return None if id_ is None else self.accounts.get(id_)

    def item(
        self,
        when: date,
        kind: str,
        name: str,
        amount: Decimal,
        ref_id: int,
        out: Account | None = None,
        into: Account | None = None,
        out_unknown: bool = False,
        category: str | None = None,
        spending: Decimal = ZERO,
        varies: bool = False,
        reserve: Decimal | None = None,
    ) -> Due:
        """`out` pays, `into` receives; `out_unknown` means it's paid from an account the app
        doesn't know, taken to be a bank."""
        change = ZERO
        if out_unknown or (out is not None and out.id in self.pool_ids):
            change -= amount
        if into is not None and into.id in self.pool_ids:
            change += amount
        shown = out if out is not None else into
        return Due(
            date=when,
            kind=kind,
            name=name,
            amount=amount,
            varies=varies,
            change=change,
            reserve=max(-change, ZERO) if reserve is None else reserve,
            overdue=when < self.today,
            ref_id=ref_id,
            account_id=None if shown is None else shown.id,
            account_name=None if shown is None else shown.name,
            category=category,
            spending=spending,
        )


def _months(start: date, end: date) -> list[tuple[int, int]]:
    found = []
    index, last = start.year * 12 + start.month - 1, end.year * 12 + end.month - 1
    while index <= last:
        found.append((index // 12, index % 12 + 1))
        index += 1
    return found


# Recurring reminders and insurance premiums


@dataclass(frozen=True)
class Template:
    template: RecurringTemplate
    policy: bool
    paid: list[date]
    skips: set[date]

    @property
    def row(self) -> TemplateRow:
        t = self.template
        return TemplateRow(
            t.id, t.frequency, t.day, t.month, t.start_date, t.end_date, t.remind_days, t.active
        )


def load_templates(db: Session, user_id: int, ctx: Context) -> list[Template]:
    """Active reminders that can still be recorded: none on an archived account, except a
    policy's (only lapsing the policy stops it)."""
    paid: dict[int, list[date]] = defaultdict(list)
    for template_id, day in db.execute(
        select(Transaction.recurring_template_id, Transaction.date).where(
            Transaction.user_id == user_id, Transaction.recurring_template_id.is_not(None)
        )
    ):
        paid[template_id].append(day)
    skips: dict[int, set[date]] = defaultdict(set)
    for template_id, occurrence in db.execute(
        select(RecurringSkip.template_id, RecurringSkip.occurrence).where(
            RecurringSkip.user_id == user_id
        )
    ):
        skips[template_id].add(occurrence)
    policies = set(
        db.scalars(select(InsurancePolicy.template_id).where(InsurancePolicy.user_id == user_id))
    )
    found = []
    for t in db.scalars(
        select(RecurringTemplate)
        .where(RecurringTemplate.user_id == user_id, RecurringTemplate.active.is_(True))
        .order_by(RecurringTemplate.id)
    ):
        accounts = [ctx.account(t.account_id), ctx.account(t.to_account_id)]
        closed = any(a is not None and a.archived_at is not None for a in accounts)
        if closed and t.id not in policies:
            continue
        found.append(Template(t, t.id in policies, paid[t.id], skips[t.id]))
    return found


def template_items(templates: list[Template], ctx: Context, until: date) -> list[Due]:
    items = []
    for entry in templates:
        t = entry.template
        account, other = ctx.account(t.account_id), ctx.account(t.to_account_id)
        for when in open_occurrences(entry.row, entry.paid, entry.skips, until):
            kind = "insurance" if entry.policy else "recurring"
            if t.type == "income":
                items.append(ctx.item(when, kind, t.name, t.amount, t.id, into=account))
            elif t.type == "transfer":
                items.append(ctx.item(when, kind, t.name, t.amount, t.id, out=account, into=other))
            else:
                items.append(
                    ctx.item(
                        when,
                        kind,
                        t.name,
                        t.amount,
                        t.id,
                        out=account,
                        category=t.category,
                        spending=t.amount,
                    )
                )
    return items


# EMIs, SIPs and RD instalments


def emi_items(db: Session, user_id: int, ctx: Context, until: date) -> list[Due]:
    """Each active loan's instalment day in the window (this month's too, when passed and
    unpaid), unless an EMI is already recorded for that period."""
    items = []
    loans = sorted(
        (
            a
            for a in ctx.accounts.values()
            if a.type == "loan" and a.archived_at is None and a.due_day is not None
        ),
        key=lambda a: a.id,
    )
    for loan in loans:
        upcoming = next_emi(loan, ctx.book)
        if upcoming is None or loan.due_day is None:
            continue
        amount = Decimal(upcoming.amount)
        interest = Decimal(upcoming.interest) if upcoming.interest is not None else ZERO
        payer = ctx.account(loan.pay_from_id)
        for year, month in _months(ctx.today, until):
            when = clamped_date(year, month, loan.due_day)
            if when > until or emis_paid(db, user_id, loan.id, when):
                continue
            items.append(
                ctx.item(
                    when,
                    "emi",
                    f"{loan.name} EMI",
                    amount,
                    loan.id,
                    out=payer,
                    into=loan,
                    out_unknown=payer is None,
                    category="Loan interest",
                    spending=interest,
                )
            )
    return items


def sip_items(db: Session, user_id: int, ctx: Context, until: date) -> list[Due]:
    due = load_due(db, user_id, until)
    rows = db.execute(
        select(Sip, Instrument.name)
        .join(Instrument, Instrument.id == Sip.instrument_id)
        .where(Sip.user_id == user_id, Sip.active.is_(True))
        .order_by(Sip.id)
    ).all()
    items = []
    for sip, fund in rows:
        account = ctx.account(sip.account_id)
        for when in due.get(sip.id, []):
            items.append(ctx.item(when, "sip", f"{fund} SIP", sip.amount, sip.id, out=account))
    return items


def rd_items(ctx: Context, until: date) -> list[Due]:
    items = []
    for rd in sorted(ctx.accounts.values(), key=lambda a: a.id):
        if rd.type != "rd" or rd.archived_at is not None:
            continue
        opened, amount, tenure = rd.opened_on, rd.deposit_amount, rd.tenure_months
        if opened is None or amount is None or tenure is None:
            continue
        if rd.due_day is None or rd.deposits_at_opening is None:
            continue
        transfers = [m.date for m in ctx.book.deposit_moves.get(rd.id, []) if m.kind == "in"]
        for when in rd_due_months(
            opened, rd.due_day, tenure, rd.deposits_at_opening, transfers, until
        ):
            items.append(
                ctx.item(when, "rd", f"{rd.name} instalment", amount, rd.id, out_unknown=True)
            )
    return items


# Card bills


def card_items(
    db: Session, user_id: int, ctx: Context, templates: list[Template], until: date
) -> list[Due]:
    """One bill per card: the unpaid statement, else what is owed now on the next due date. A
    card that a transfer reminder pays is left to the reminder."""
    paid_by_reminder = {
        e.template.to_account_id for e in templates if e.template.type == "transfer"
    }
    cards = sorted(
        (
            a
            for a in ctx.accounts.values()
            if a.type == "credit_card" and a.archived_at is None and a.id not in paid_by_reminder
        ),
        key=lambda a: a.id,
    )
    statements = {b.account_id: b for b in card_bills(db, user_id, cards, ctx.today)}
    items = []
    for card in cards:
        bill = statements.get(card.id)
        if bill is not None:
            when, amount, varies = date.fromisoformat(bill.due_date), Decimal(bill.amount), False
        else:
            owed = balance_of(card, ctx.book.flows)
            if card.due_day is None or owed <= 0:
                continue
            when, amount, varies = next_due_date(card.due_day, ctx.today), owed, True
        items.append(
            ctx.item(
                when,
                "card_bill",
                f"{card.name} bill",
                amount,
                card.id,
                out_unknown=True,
                varies=varies,
            )
        )
    return items


# Goal set-asides


def goal_items(db: Session, user_id: int, ctx: Context, goals: GoalBook, until: date) -> list[Due]:
    """Each goal reminder's set-aside in the window: this month's part still to set aside, then
    the full amount for a later month. Nothing moves, so the balance doesn't change."""
    today = ctx.today
    first = today.replace(day=1)
    this_month: dict[int, Decimal] = defaultdict(Decimal)
    for goal_id, amount in db.execute(
        select(GoalEarmark.goal_id, GoalEarmark.amount).where(
            GoalEarmark.user_id == user_id,
            GoalEarmark.amount > 0,
            GoalEarmark.date >= first,
            GoalEarmark.date <= clamped_date(today.year, today.month, 31),
        )
    ):
        this_month[goal_id] += amount
    items = []
    for goal in db.scalars(
        select(Goal).where(Goal.user_id == user_id, Goal.archived_at.is_(None)).order_by(Goal.id)
    ):
        response = goals.responses.get(goal.id)
        if response is None or goal.reminder_day is None:
            continue
        for year, month in _months(today, until):
            when = clamped_date(year, month, goal.reminder_day)
            current = (year, month) == (today.year, today.month)
            left = reminder_due(
                goal.monthly_amount,
                goal.reminder_day,
                goal.reminder_start,
                this_month[goal.id] if current else ZERO,
                response.reached,
                max(when, today) if current else when,
            )
            if left is None or when > until:
                continue
            items.append(ctx.item(when, "goal", goal.name, left, goal.id, reserve=left))
    return items


# Putting it together


def _order(item: Due) -> tuple[date, int, str, str, int]:
    """Soonest first; on the same day money out, then nothing moving, then money in."""
    side = 0 if item.change < 0 else 2 if item.change > 0 else 1
    return (item.date, side, item.kind, item.name.casefold(), item.ref_id)


def due_items(
    db: Session,
    user_id: int,
    ctx: Context,
    goals: GoalBook,
    until: date,
    templates: list[Template] | None = None,
) -> list[Due]:
    """Everything due up to `until`, overdue items included, in list order."""
    if templates is None:
        templates = load_templates(db, user_id, ctx)
    items = [
        *template_items(templates, ctx, until),
        *emi_items(db, user_id, ctx, until),
        *sip_items(db, user_id, ctx, until),
        *rd_items(ctx, until),
        *card_items(db, user_id, ctx, templates, until),
        *goal_items(db, user_id, ctx, goals, until),
    ]
    return sorted((i for i in items if i.date <= until), key=_order)


def running(start: Decimal, items: Iterable[Due]) -> list[Decimal]:
    """The balance after each item."""
    after = []
    for item in items:
        start += item.change
        after.append(start)
    return after


# Safe to spend


def salary_categories(categories: Iterable[Category]) -> set[str]:
    """Name keys of Salary and its subcategories."""
    live = [c for c in categories if c.kind == "income" and c.merged_into_id is None]
    salary = {c.id for c in live if c.name_key == SALARY}
    return {c.name_key for c in live if c.id in salary or c.parent_id in salary}


def payday(
    templates: list[Template], categories: Iterable[Category], today: date
) -> tuple[date, str] | None:
    """The next occurrence after today of a Salary income reminder, the earliest of them."""
    keys = salary_categories(categories)
    found: list[tuple[date, str]] = []
    for entry in templates:
        t = entry.template
        if t.type != "income" or t.category is None or name_key(t.category) not in keys:
            continue
        later = [
            d
            for d in open_occurrences(entry.row, entry.paid, entry.skips, today + PAYDAY_HORIZON)
            if d > today
        ]
        if later:
            found.append((later[0], t.name))
    return min(found) if found else None


def in_budget(category: str | None, budget: Category, categories: Iterable[Category]) -> bool:
    """Whether spending in `category` counts toward a budget on `budget` (itself or a
    subcategory of it)."""
    if category is None:
        return False
    key = name_key(category)
    for c in categories:
        if c.kind == "expense" and c.merged_into_id is None and c.name_key == key:
            return c.id == budget.id or c.parent_id == budget.id
    return False
