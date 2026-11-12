"""Managed categories: seeding, resolving a typed name, and rename, merge, archive and nesting.

Transactions, recurring templates and payee rules carry a category *name*; the `categories`
table is the registry of those names (see the cash flow design). So a rename or a merge rewrites
the name on every row that uses it, inside the caller's database transaction.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, NoReturn

from fastapi.exceptions import RequestValidationError
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.category import Category
from app.models.recurring import RecurringTemplate
from app.models.sms import PayeeRule
from app.models.transaction import Transaction

KINDS = ("income", "expense")
UNCATEGORISED = "Uncategorised"

# The defaults every user starts with: (name, icon, colour), in picker order.
DEFAULTS: dict[str, list[tuple[str, str, str]]] = {
    "income": [
        ("Salary", "salary", "#2e9e5b"),
        ("Business", "business", "#1f7a8c"),
        ("Interest", "interest", "#4cb944"),
        ("Dividends", "dividends", "#5c80bc"),
        ("Refund", "refund", "#669bbc"),
        ("Gift", "gift", "#a06cd5"),
        ("Other", "other", "#8a8a8a"),
    ],
    "expense": [
        ("Groceries", "groceries", "#4cb944"),
        ("Food and dining", "food", "#f3a712"),
        ("Transport", "transport", "#5c80bc"),
        ("Fuel", "fuel", "#e4572e"),
        ("Housing", "home", "#8d6a9f"),
        ("Utilities", "utilities", "#2ec4b6"),
        ("Shopping", "shopping", "#db5375"),
        ("Health", "health", "#e63946"),
        ("Entertainment", "entertainment", "#a06cd5"),
        ("Education", "education", "#1f7a8c"),
        ("Insurance", "insurance", "#29335c"),
        ("Loan payments", "loan", "#6c757d"),
        ("Travel", "travel", "#ff9f1c"),
        ("Gifts and donations", "gift", "#c77dff"),
        ("Fees and charges", "fees", "#b5651d"),
        ("Other", "other", "#8a8a8a"),
        ("Loan interest", "loan", "#495057"),
    ],
}

# Names the code itself writes (PPF/RD interest, premiums, an RD's early-closure fee, EMIs):
# they can't be renamed, archived or merged away, or the next one would bring the old name back.
FIXED = {
    ("income", "interest"),
    ("expense", "insurance"),
    ("expense", "fees and charges"),
    ("expense", "loan interest"),
}

# Icon keys; each client maps them to its own icon set.
ICONS = (
    "salary",
    "business",
    "interest",
    "dividends",
    "refund",
    "gift",
    "other",
    "groceries",
    "food",
    "transport",
    "fuel",
    "home",
    "utilities",
    "shopping",
    "health",
    "entertainment",
    "education",
    "insurance",
    "loan",
    "travel",
    "fees",
    "pets",
    "kids",
    "phone",
    "clothes",
    "fitness",
    "personal",
    "subscriptions",
    "tax",
    "savings",
)
COLOUR = re.compile(r"^#[0-9a-f]{6}$")
NAME_LIMIT = 40


def kind_of(type_: str) -> str | None:
    """The category kind a transaction type uses: an EMI's interest is spending."""
    return {"income": "income", "expense": "expense", "emi": "expense"}.get(type_)


def name_key(name: str) -> str:
    return name.casefold()[:NAME_LIMIT]


def is_fixed(category: Category) -> bool:
    return (category.kind, category.name_key) in FIXED


def picker_order(kind: str) -> Any:
    """Defaults in their order, then the rest by name: the order pickers have always used."""
    order = {name_key(name): i for i, (name, _, _) in enumerate(DEFAULTS[kind])}

    def key(category: Category) -> tuple[int, str]:
        return (order.get(category.name_key, len(order)), category.name_key)

    return key


def _error(field: str, message: str) -> NoReturn:
    raise RequestValidationError([{"loc": ("body", field), "msg": message, "type": "value_error"}])


# Reading


def ensure_seeded(db: Session, user_id: int) -> None:
    """Gives a user without categories the defaults. Two first requests at once are fine: the
    loser's insert hits the unique index and is dropped."""
    if db.scalar(select(Category.id).where(Category.user_id == user_id).limit(1)) is not None:
        return
    try:
        with db.begin_nested():
            for kind, rows in DEFAULTS.items():
                for name, icon, colour in rows:
                    db.add(
                        Category(
                            user_id=user_id,
                            kind=kind,
                            name=name,
                            name_key=name_key(name),
                            icon=icon,
                            colour=colour,
                        )
                    )
            db.flush()
    except IntegrityError:
        pass


def all_categories(db: Session, user_id: int, lock: bool = False) -> list[Category]:
    """Every category of the user, merged ones included, in id order (locked, when asked)."""
    ensure_seeded(db, user_id)
    query = select(Category).where(Category.user_id == user_id).order_by(Category.id)
    if lock:
        query = query.with_for_update()
    return list(db.scalars(query))


def live(categories: Iterable[Category], kind: str | None = None) -> list[Category]:
    """Not merged (archived ones included), of `kind` when given."""
    return [c for c in categories if c.merged_into_id is None and (kind is None or c.kind == kind)]


def ordered(categories: list[Category], kind: str) -> list[Category]:
    """Live categories of a kind: each top-level one in picker order, its subcategories after it
    by name. A subcategory whose parent isn't listed comes on its own."""
    mine = live(categories, kind)
    ids = {c.id for c in mine}
    tops = sorted((c for c in mine if c.parent_id not in ids), key=picker_order(kind))
    children: dict[int, list[Category]] = {}
    for c in mine:
        if c.parent_id in ids:
            children.setdefault(c.parent_id or 0, []).append(c)
    result: list[Category] = []
    for top in tops:
        result.append(top)
        result.extend(sorted(children.get(top.id, []), key=lambda c: c.name_key))
    return result


def picker_names(db: Session, user_id: int, kind: str) -> list[str]:
    """The names a picker offers: live and unarchived, in picker order, each subcategory right
    after its parent."""
    return [c.name for c in ordered(all_categories(db, user_id), kind) if c.archived_at is None]


def _find(db: Session, user_id: int, kind: str, key: str) -> Category | None:
    """The live category with this name, else the one a category of this name was merged into."""
    rows = db.scalars(
        select(Category)
        .where(Category.user_id == user_id, Category.kind == kind, Category.name_key == key)
        .order_by(Category.merged_into_id.is_not(None), Category.id.desc())
    ).all()
    if not rows:
        return None
    found = rows[0]
    if found.merged_into_id is not None:
        found = db.get(Category, found.merged_into_id) or found
    return found


def category_family(db: Session, user_id: int, name: str) -> list[str]:
    """A category's name (of either kind) with its subcategories' names, for filtering. An old,
    merged name finds the category it went into; an unknown name finds just itself."""
    key = name_key(name)
    names = [name]
    for kind in KINDS:
        found = _find(db, user_id, kind, key)
        if found is None:
            continue
        names.append(found.name)
        children = db.scalars(
            select(Category.name).where(
                Category.user_id == user_id,
                Category.parent_id == found.id,
                Category.merged_into_id.is_(None),
            )
        )
        names.extend(children)
    return names


# Resolving a typed name


def resolve(
    db: Session,
    user_id: int,
    kind: str,
    name: str,
    keep: str | None = None,
    field: str = "category",
) -> str:
    """The registry's spelling of a typed category, creating the category when it's new.

    A merged name gives the category it was merged into. An archived category is refused unless
    it is `keep`, the value the row already had (an edit may keep an archived category).
    """
    ensure_seeded(db, user_id)
    key = name_key(name)
    found = _find(db, user_id, kind, key)
    if found is None:
        try:
            with db.begin_nested():
                found = Category(user_id=user_id, kind=kind, name=name, name_key=key)
                db.add(found)
                db.flush()
        except IntegrityError:  # another request created it first
            found = _find(db, user_id, kind, key)
            if found is None:
                raise
    if found.archived_at is not None and (keep is None or name_key(keep) != found.name_key):
        _error(field, f"{found.name} is archived. Restore it to use it.")
    return found.name


def usable(db: Session, user_id: int, kind: str, name: str) -> str | None:
    """`resolve` for automatic categorising (SMS): None when the category is archived."""
    try:
        return resolve(db, user_id, kind, name)
    except RequestValidationError:
        return None


def rule_kind(db: Session, user_id: int, name: str) -> str:
    """A payee rule has no type: its category is income only if no expense one has the name."""
    ensure_seeded(db, user_id)
    key = name_key(name)
    for kind in ("expense", "income"):
        if _find(db, user_id, kind, key) is not None:
            return kind
    return "expense"


# Changing


@dataclass
class Moved:
    transactions: int = 0
    templates: int = 0
    rules: int = 0


def _transaction_types(kind: str) -> tuple[str, ...]:
    return ("income",) if kind == "income" else ("expense", "emi")


def _move_references(
    db: Session, user_id: int, categories: list[Category], kind: str, old: str, new: str
) -> Moved:
    """Rewrites the category name `old` to `new` on transactions, templates and payee rules."""
    old_lower = old.lower()
    moved = Moved()
    moved.transactions = db.execute(
        update(Transaction)
        .where(
            Transaction.user_id == user_id,
            Transaction.type.in_(_transaction_types(kind)),
            func.lower(Transaction.category) == old_lower,
        )
        .values(category=new)
        .execution_options(synchronize_session="fetch")
    ).rowcount
    moved.templates = db.execute(
        update(RecurringTemplate)
        .where(
            RecurringTemplate.user_id == user_id,
            RecurringTemplate.type == kind,
            func.lower(RecurringTemplate.category) == old_lower,
        )
        .values(category=new)
        .execution_options(synchronize_session="fetch")
    ).rowcount
    other = "expense" if kind == "income" else "income"
    shared = any(c.name_key == name_key(old) for c in live(categories, other))
    if not shared:
        moved.rules = db.execute(
            update(PayeeRule)
            .where(PayeeRule.user_id == user_id, func.lower(PayeeRule.category) == old_lower)
            .values(category=new)
            .execution_options(synchronize_session="fetch")
        ).rowcount
    return moved


def owned(categories: list[Category], id: int) -> Category | None:
    return next((c for c in categories if c.id == id and c.merged_into_id is None), None)


def check_name(categories: list[Category], kind: str, name: str, itself: int | None) -> None:
    key = name_key(name)
    for c in live(categories, kind):
        if c.name_key == key and c.id != itself:
            if c.archived_at is not None:
                _error("name", f"{c.name} is archived. Restore it instead.")
            if itself is None:
                _error("name", f"You already have {c.name}.")
            _error("name", f"You already have {c.name}. Merge them instead.")


def check_parent(categories: list[Category], category: Category | None, parent_id: int) -> Category:
    """The parent a category (None when new) may be nested under."""
    kind = None if category is None else category.kind
    parent = owned(categories, parent_id)
    if parent is None or (kind is not None and parent.kind != kind):
        _error("parent_id", "Choose a category of the same kind.")
    if category is not None and parent.id == category.id:
        _error("parent_id", "A category can't be inside itself.")
    if parent.parent_id is not None:
        _error("parent_id", f"{parent.name} is already inside another category.")
    if parent.archived_at is not None:
        _error("parent_id", f"{parent.name} is archived. Restore it to use it.")
    if category is not None and any(c.parent_id == category.id for c in live(categories)):
        _error("parent_id", f"{category.name} has its own subcategories.")
    return parent


def rename(db: Session, user_id: int, categories: list[Category], c: Category, name: str) -> None:
    if name == c.name:
        return
    if is_fixed(c) and name_key(name) != c.name_key:
        _error("name", f"{c.name} is used by the app itself, so it can't be renamed.")
    check_name(categories, c.kind, name, itself=c.id)
    _move_references(db, user_id, categories, c.kind, c.name, name)
    c.name, c.name_key = name, name_key(name)


def archive(categories: list[Category], c: Category, archived: bool) -> None:
    if archived == (c.archived_at is not None):
        return
    if archived:
        if is_fixed(c):
            _error("archived", f"{c.name} is used by the app itself, so it can't be archived.")
        children = [x for x in live(categories) if x.parent_id == c.id and x.archived_at is None]
        if children:
            names = ", ".join(x.name for x in children)
            _error("archived", f"Move or archive its subcategories first: {names}.")
        c.archived_at = datetime.now(UTC)
    else:
        parent = None if c.parent_id is None else owned(categories, c.parent_id)
        if parent is not None and parent.archived_at is not None:
            _error("archived", f"Restore {parent.name} first.")
        c.archived_at = None


def merge(
    db: Session, user_id: int, categories: list[Category], source: Category, target: Category
) -> Moved:
    """Moves everything of `source` into `target`, then marks `source` merged."""
    if target.id == source.id:
        _error("into_id", "Choose another category to merge into.")
    if target.kind != source.kind:
        _error("into_id", "Choose a category of the same kind.")
    if is_fixed(source):
        _error("into_id", f"{source.name} is used by the app itself, so it can't be merged away.")
    if target.archived_at is not None:
        _error("into_id", f"{target.name} is archived. Restore it first.")
    if target.parent_id == source.id:
        _error("into_id", f"{target.name} is inside {source.name}. Move it out first.")
    children = [c for c in live(categories) if c.parent_id == source.id]
    if children and target.parent_id is not None:
        _error(
            "into_id",
            f"{source.name} has subcategories, and {target.name} is inside another category.",
        )
    moved = _move_references(db, user_id, categories, source.kind, source.name, target.name)
    for child in children:
        child.parent_id = target.id
    for earlier in categories:
        if earlier.merged_into_id == source.id:
            earlier.merged_into_id = target.id
    source.merged_into_id = target.id
    source.parent_id = None
    return moved
