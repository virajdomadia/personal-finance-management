"""Monthly budgets per expense category. Rules: docs/architecture/financial-calculations.md,
"Monthly budgets". Spent is the month report's figure (`app.api.cash_flow`)."""

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import budgets as bd
from app.api import cash_flow as cf
from app.api.categories import all_categories
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import MAX_ID, Money, field_error, fmt
from app.db.session import DbSession
from app.models.category import Category
from app.models.transaction import Transaction

router = APIRouter(prefix="/budgets", tags=["budgets"], dependencies=[Depends(get_current_user)])

MONTH = r"^[1-9][0-9]{3}-(0[1-9]|1[0-2])$"
_NOT_FOUND = "Category not found."


class BudgetBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount: Money = None


class Totals(BaseModel):
    amount: str
    spent: str
    left: str  # amount − spent; negative when over
    remaining: str  # never below 0
    over_by: str
    percent: int | None  # spent ÷ amount, can pass 100; None for a zero total
    bar: int | None  # percent, capped at 100
    over: bool


class BudgetLine(Totals):
    category_id: int
    name: str
    icon: str | None
    colour: str | None
    parent_id: int | None
    parent_name: str | None
    active: bool
    note: str | None  # why it's inactive
    counted: bool  # in the total
    since: str  # "YYYY-MM" this amount applies from


class Unbudgeted(BaseModel):
    category_id: int
    name: str
    icon: str | None
    colour: str | None
    parent_id: int | None
    parent_name: str | None
    spent: str


class BudgetMonth(BaseModel):
    month: str
    is_current: bool
    start: str
    through: str
    budgets: list[BudgetLine]
    total: Totals
    unbudgeted: list[Unbudgeted]


class Removed(BaseModel):
    category_id: int


def month_text(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def month_rows(db: Session, user_id: int, start: date, through: date) -> list[cf.Row]:
    """The rows the month report counts, dated in the window."""
    return [
        cf.Row(*r)
        for r in db.execute(
            select(
                Transaction.type,
                Transaction.amount,
                Transaction.interest,
                Transaction.category,
                Transaction.date,
            ).where(
                Transaction.user_id == user_id,
                Transaction.type.in_(("income", "expense", "emi")),
                Transaction.date >= start,
                Transaction.date <= through,
            )
        )
    ]


def _totals(f: bd.Figures) -> dict[str, Any]:
    return {
        "amount": fmt(f.amount),
        "spent": fmt(f.spent),
        "left": fmt(f.left),
        "remaining": fmt(f.remaining),
        "over_by": fmt(f.over_by),
        "percent": f.percent,
        "bar": f.bar,
        "over": f.over,
    }


def to_line(b: bd.Line) -> BudgetLine:
    return BudgetLine(
        **_totals(b),
        category_id=b.category.id,
        name=b.category.name,
        icon=b.category.icon,
        colour=b.category.colour,
        parent_id=None if b.parent is None else b.parent.id,
        parent_name=None if b.parent is None else b.parent.name,
        active=b.active,
        note=b.note,
        counted=b.counted,
        since=month_text(b.since),
    )


class MonthBook:
    """A month's budget lines, worked out once."""

    def __init__(self, db: Session, user_id: int, first: date, today: date) -> None:
        self.first = first
        self.start, self.through, _, _ = cf.windows(first, today)
        self.categories = all_categories(db, user_id)
        self.spent = bd.spent_by_category(
            month_rows(db, user_id, self.start, self.through), self.categories
        )
        ended = (first.year, first.month) < (today.year, today.month)
        self.lines = bd.lines(
            bd.load_versions(db, user_id), self.categories, self.spent, first, ended
        )


def _month_param(month: str | None, today: date) -> date:
    first = date(today.year, today.month, 1)
    if month is None:
        return first
    chosen = date(int(month[:4]), int(month[5:]), 1)
    if chosen > today:
        raise RequestValidationError(
            [
                {
                    "loc": ("query", "month"),
                    "msg": "That month hasn't started yet.",
                    "type": "value_error",
                }
            ]
        )
    return chosen


@router.get("")
def month_budgets(
    user: CurrentUser,
    db: DbSession,
    month: Annotated[str | None, Query(pattern=MONTH)] = None,
) -> BudgetMonth:
    today = today_india()
    first = _month_param(month, today)
    book = MonthBook(db, user.id, first, today)
    db.commit()  # a first read seeds the default categories
    by_id = {c.id: c for c in book.categories}
    return BudgetMonth(
        month=month_text(first),
        is_current=(first.year, first.month) == (today.year, today.month),
        start=book.start.isoformat(),
        through=book.through.isoformat(),
        budgets=[to_line(b) for b in book.lines],
        total=Totals(**_totals(bd.total(book.lines))),
        unbudgeted=[
            Unbudgeted(
                category_id=c.id,
                name=c.name,
                icon=c.icon,
                colour=c.colour,
                parent_id=c.parent_id,
                parent_name=None
                if c.parent_id is None or c.parent_id not in by_id
                else by_id[c.parent_id].name,
                spent=fmt(book.spent.get(c.id, bd.ZERO)),
            )
            for c in bd.unbudgeted(book.categories, book.lines)
        ],
    )


def _category(db: Session, user_id: int, category_id: int) -> tuple[Category, list[Category]]:
    """The user's category, with every category locked so budget writes go one at a time."""
    categories = all_categories(db, user_id, lock=True) if 1 <= category_id <= MAX_ID else []
    found = next((c for c in categories if c.id == category_id), None)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)
    return found, categories


def _merged_into(target: Category, categories: list[Category]) -> list[int]:
    by_id = {c.id: c for c in categories}
    return [
        c.id
        for c in categories
        if c.merged_into_id is not None and bd.merge_target(c, by_id).id == target.id
    ]


@router.put("/{category_id}")
def set_budget(category_id: int, body: BudgetBody, user: CurrentUser, db: DbSession) -> BudgetLine:
    """Sets the category's budget from this month on."""
    category, categories = _category(db, user.id, category_id)
    by_id = {c.id: c for c in categories}
    problem = None
    if category.kind != "expense":
        problem = "Budgets are for spending categories."
    elif category.merged_into_id is not None:
        target = bd.merge_target(category, by_id)
        problem = f"{category.name} was merged into {target.name}. Set it there."
    elif category.archived_at is not None:
        problem = f"{category.name} is archived. Restore it to set a budget."
    if problem is not None:
        raise RequestValidationError([field_error("category_id", problem)])
    if body.amount is None:
        raise RequestValidationError([field_error("amount", "Enter the budget amount.")])
    if body.amount <= 0:
        raise RequestValidationError([field_error("amount", "Enter an amount above zero.")])

    today = today_india()
    first = date(today.year, today.month, 1)
    bd.write(db, user.id, category.id, first, body.amount)
    # A budget that reached this category by a merge gives way to its own.
    for merged_id in _merged_into(category, categories):
        bd.write(db, user.id, merged_id, first, None)
    db.flush()
    book = MonthBook(db, user.id, first, today)
    db.commit()
    return to_line(next(b for b in book.lines if b.category.id == category.id and b.active))


@router.delete("/{category_id}")
def remove_budget(category_id: int, user: CurrentUser, db: DbSession) -> Removed:
    """Ends the category's budget from this month on (and one that reached it by a merge)."""
    category, categories = _category(db, user.id, category_id)
    today = today_india()
    first = date(today.year, today.month, 1)
    found = bd.in_force(bd.load_versions(db, user.id), first)
    ids = [category.id, *_merged_into(category, categories)]
    ending = [i for i in ids if i in found]
    if not ending:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "There's no budget for this category.")
    for i in ending:
        bd.write(db, user.id, i, first, None)
    db.commit()
    return Removed(category_id=category.id)
