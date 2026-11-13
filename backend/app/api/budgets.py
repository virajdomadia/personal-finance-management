"""Monthly budgets per expense category. The rules are in
docs/architecture/financial-calculations.md, "Monthly budgets".

Spent is the month report's figure: `cash_flow.grouped` over the same rows, with subcategories
rolled up into their parent, so a budget and the `/cash-flow` row for its category always agree.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import cash_flow as cf
from app.api.categories import ordered
from app.models.budget import Budget
from app.models.category import Category

ZERO = Decimal(0)


@dataclass(frozen=True)
class Version:
    category_id: int
    effective_from: date
    amount: Decimal | None


def load_versions(db: Session, user_id: int) -> list[Version]:
    return [
        Version(*row)
        for row in db.execute(
            select(Budget.category_id, Budget.effective_from, Budget.amount).where(
                Budget.user_id == user_id
            )
        )
    ]


def in_force(versions: Iterable[Version], first: date) -> dict[int, Version]:
    """Each category's budget for the month starting `first`: its latest row on or before it,
    left out when that row ends the budget."""
    latest: dict[int, Version] = {}
    for v in versions:
        if v.effective_from <= first:
            seen = latest.get(v.category_id)
            if seen is None or v.effective_from > seen.effective_from:
                latest[v.category_id] = v
    return {i: v for i, v in latest.items() if v.amount is not None}


def spent_by_category(rows: Iterable[cf.Row], categories: list[Category]) -> dict[int, Decimal]:
    """Spending by category id, a top-level category including its subcategories."""
    spent: dict[int, Decimal] = {}
    for group in cf.grouped(rows, "expense", categories):
        if group.id is not None:
            spent[group.id] = group.amount
        for child in group.children:
            if child.id is not None:
                spent[child.id] = child.amount
    return spent


def merge_target(category: Category, by_id: dict[int, Category]) -> Category:
    """The live category a merged one ended up in (itself when not merged)."""
    seen = {category.id}
    while category.merged_into_id is not None and category.merged_into_id not in seen:
        nxt = by_id.get(category.merged_into_id)
        if nxt is None:
            break
        seen.add(nxt.id)
        category = nxt
    return category


@dataclass
class Figures:
    amount: Decimal
    spent: Decimal

    @property
    def left(self) -> Decimal:
        return self.amount - self.spent

    @property
    def remaining(self) -> Decimal:
        return max(self.left, ZERO)

    @property
    def over_by(self) -> Decimal:
        return max(-self.left, ZERO)

    @property
    def over(self) -> bool:
        return self.spent > self.amount

    @property
    def percent(self) -> int | None:
        return cf.percent(self.spent, self.amount)

    @property
    def bar(self) -> int | None:
        p = self.percent
        return None if p is None else min(p, 100)


@dataclass
class Line(Figures):
    category: Category  # whose spending it tracks (a merge target, for a budget that followed)
    source_id: int  # the category the budget row belongs to
    since: date
    active: bool
    note: str | None
    parent: Category | None = None
    counted: bool = False


def lines(
    versions: Iterable[Version],
    categories: list[Category],
    spent: dict[int, Decimal],
    first: date,
    ended: bool = False,
) -> list[Line]:
    """The month's budgets in picker order (each subcategory after its parent), then any merged
    one that couldn't follow its merge.

    In an `ended` month a merged budget whose target has its own is added to the target's, so
    a merge made later never changes that month's total."""
    by_id = {c.id: c for c in categories}
    found = in_force(versions, first)
    shown: dict[int, Line] = {}
    stranded: list[Line] = []

    def make(category: Category, version: Version, active: bool, note: str | None) -> Line:
        assert version.amount is not None
        return Line(
            amount=version.amount,
            spent=spent.get(category.id, ZERO) if active or note == "Archived" else ZERO,
            category=category,
            source_id=version.category_id,
            since=version.effective_from,
            active=active,
            note=note,
        )

    merged: list[tuple[Category, Version]] = []
    for category_id, version in sorted(found.items()):
        category = by_id.get(category_id)
        if category is None or category.kind != "expense":
            continue
        if category.merged_into_id is not None:
            merged.append((category, version))
            continue
        archived = category.archived_at is not None
        shown[category.id] = make(category, version, not archived, "Archived" if archived else None)
    for category, version in merged:
        target = merge_target(category, by_id)
        if ended and target.id in shown and target.merged_into_id is None:
            assert version.amount is not None
            shown[target.id].amount += version.amount
            continue
        if target.id in shown or target.merged_into_id is not None:
            note = f"Merged into {target.name}, which has its own budget."
            stranded.append(make(category, version, False, note))
            continue
        archived = target.archived_at is not None
        shown[target.id] = make(target, version, not archived, "Archived" if archived else None)

    for line in shown.values():
        parent_id = line.category.parent_id
        line.parent = None if parent_id is None else by_id.get(parent_id)
        parent_line = None if parent_id is None else shown.get(parent_id)
        line.counted = line.active and not (parent_line is not None and parent_line.active)
    position = {c.id: i for i, c in enumerate(ordered(categories, "expense"))}
    result = sorted(shown.values(), key=lambda b: position.get(b.category.id, len(position)))
    for line in stranded:
        parent_id = line.category.parent_id
        line.parent = None if parent_id is None else by_id.get(parent_id)
    return result + stranded


def total(found: Iterable[Line]) -> Figures:
    counted = [b for b in found if b.counted]
    return Figures(
        amount=sum((b.amount for b in counted), ZERO), spent=sum((b.spent for b in counted), ZERO)
    )


def unbudgeted(categories: list[Category], found: Iterable[Line]) -> list[Category]:
    """Live, unarchived expense categories without an active budget, in picker order."""
    covered = {b.category.id for b in found if b.active}
    return [
        c for c in ordered(categories, "expense") if c.archived_at is None and c.id not in covered
    ]


# Writing


def write(db: Session, user_id: int, category_id: int, first: date, amount: Decimal | None) -> None:
    """Makes `amount` (None: no budget) the category's budget from the month starting `first`.
    A row equal to the one before it is dropped, so going back leaves no trace."""
    rows = list(
        db.scalars(
            select(Budget).where(Budget.user_id == user_id, Budget.category_id == category_id)
        )
    )
    current = next((r for r in rows if r.effective_from == first), None)
    earlier = [r for r in rows if r.effective_from < first]
    before = max(earlier, key=lambda r: r.effective_from).amount if earlier else None
    if amount == before:
        if current is not None:
            db.delete(current)
        return
    if current is None:
        db.add(
            Budget(user_id=user_id, category_id=category_id, effective_from=first, amount=amount)
        )
    else:
        current.amount = amount
