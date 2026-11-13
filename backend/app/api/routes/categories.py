from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import categories as cats
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import MAX_ID, clean_text, field_error
from app.db.session import DbSession
from app.models.category import Category
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/categories", tags=["categories"], dependencies=[Depends(get_current_user)]
)


def _kind(value: Any) -> Any:
    if value is not None and value not in cats.KINDS:
        raise PydanticCustomError("kind", "Choose income or expense.")
    return value


def _icon(value: Any) -> Any:
    if value is not None and value not in cats.ICONS:
        raise PydanticCustomError("icon", "Choose an icon.")
    return value


def _colour(value: Any) -> Any:
    if value is None:
        return None
    if not isinstance(value, str) or not cats.COLOUR.match(value.lower()):
        raise PydanticCustomError("colour", "Choose a colour.")
    return value.lower()


def _id(message: str) -> Any:
    def check(value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_ID:
            raise PydanticCustomError("id", message)
        return value

    return check


def _flag(value: Any) -> Any:
    if value is not None and not isinstance(value, bool):
        raise PydanticCustomError("flag", "Choose yes or no.")
    return value


Name = Annotated[
    str | None,
    BeforeValidator(lambda v: clean_text(v, "Enter a name.", limit=cats.NAME_LIMIT)),
]
Kind = Annotated[str | None, BeforeValidator(_kind)]
Icon = Annotated[str | None, BeforeValidator(_icon)]
Colour = Annotated[str | None, BeforeValidator(_colour)]
ParentRef = Annotated[int | None, BeforeValidator(_id("Choose a category of the same kind."))]
IntoRef = Annotated[int | None, BeforeValidator(_id("Choose a category to merge into."))]
Flag = Annotated[bool | None, BeforeValidator(_flag)]


class CategoryCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Kind = None
    name: Name = None
    parent_id: ParentRef = None
    icon: Icon = None
    colour: Colour = None


class CategoryUpdate(BaseModel):
    """Rename, icon, colour, nest (`parent_id`, null to take it out) and archive or restore."""

    model_config = ConfigDict(extra="forbid")

    name: Name = None
    parent_id: ParentRef = None
    icon: Icon = None
    colour: Colour = None
    archived: Flag = None


class MergeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    into_id: IntoRef = None


class CategoryResponse(BaseModel):
    id: int
    kind: str
    name: str
    parent_id: int | None
    icon: str | None
    colour: str | None
    archived: bool
    # Used by the app itself (premiums, EMIs, PPF interest): can't be renamed, archived or merged.
    fixed: bool
    transaction_count: int


class CategoryTree(BaseModel):
    # Each kind's live categories (archived ones too): a top-level one, then its subcategories.
    income: list[CategoryResponse]
    expense: list[CategoryResponse]
    icons: list[str]


class MergeResult(BaseModel):
    category: CategoryResponse
    moved_transactions: int
    moved_templates: int
    moved_rules: int


def _counts(db: Session, user_id: int) -> dict[tuple[str, str], int]:
    rows = db.execute(
        select(Transaction.type, func.lower(Transaction.category), func.count())
        .where(Transaction.user_id == user_id, Transaction.category.is_not(None))
        .group_by(Transaction.type, func.lower(Transaction.category))
    )
    counts: dict[tuple[str, str], int] = {}
    for type_, lowered, count in rows:
        kind = cats.kind_of(type_)
        if kind is not None:
            key = (kind, cats.name_key(lowered))
            counts[key] = counts.get(key, 0) + count
    return counts


def _response(c: Category, counts: dict[tuple[str, str], int]) -> CategoryResponse:
    return CategoryResponse(
        id=c.id,
        kind=c.kind,
        name=c.name,
        parent_id=c.parent_id,
        icon=c.icon,
        colour=c.colour,
        archived=c.archived_at is not None,
        fixed=cats.is_fixed(c),
        transaction_count=counts.get((c.kind, c.name_key), 0),
    )


def _owned(categories: list[Category], id: int) -> Category:
    found = cats.owned(categories, id) if 1 <= id <= MAX_ID else None
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Category not found.")
    return found


@router.get("")
def list_categories(user: CurrentUser, db: DbSession) -> CategoryTree:
    categories = cats.all_categories(db, user.id)
    counts = _counts(db, user.id)
    db.commit()  # a first read seeds the defaults
    return CategoryTree(
        income=[_response(c, counts) for c in cats.ordered(categories, "income")],
        expense=[_response(c, counts) for c in cats.ordered(categories, "expense")],
        icons=list(cats.ICONS),
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_category(body: CategoryCreate, user: CurrentUser, db: DbSession) -> CategoryResponse:
    errors = []
    if body.kind is None:
        errors.append(field_error("kind", "Choose income or expense."))
    if body.name is None:
        errors.append(field_error("name", "Enter a name."))
    if errors:
        raise RequestValidationError(errors)
    assert body.kind is not None and body.name is not None
    categories = cats.all_categories(db, user.id, lock=True)
    cats.check_name(categories, body.kind, body.name, itself=None)
    parent = None
    if body.parent_id is not None:
        parent = cats.check_parent(categories, None, body.parent_id)
        if parent.kind != body.kind:
            raise RequestValidationError(
                [field_error("parent_id", "Choose a category of the same kind.")]
            )
    category = Category(
        user_id=user.id,
        kind=body.kind,
        name=body.name,
        name_key=cats.name_key(body.name),
        parent_id=None if parent is None else parent.id,
        icon=body.icon,
        colour=body.colour,
    )
    db.add(category)
    db.commit()
    return _response(category, {})


@router.patch("/{id}")
def update_category(
    id: int, body: CategoryUpdate, user: CurrentUser, db: DbSession
) -> CategoryResponse:
    changes = body.model_dump(exclude_unset=True)
    categories = cats.all_categories(db, user.id, lock=True)
    category = _owned(categories, id)
    if "name" in changes:
        if changes["name"] is None:
            raise RequestValidationError([field_error("name", "Enter a name.")])
        cats.rename(db, user.id, categories, category, changes["name"])
    if "parent_id" in changes:
        parent_id = changes["parent_id"]
        if parent_id is None:
            category.parent_id = None
        elif parent_id != category.parent_id:
            category.parent_id = cats.check_parent(categories, category, parent_id).id
    if "icon" in changes:
        category.icon = changes["icon"]
    if "colour" in changes:
        category.colour = changes["colour"]
    if changes.get("archived") is not None:
        cats.archive(categories, category, changes["archived"])
    db.commit()
    return _response(category, _counts(db, user.id))


@router.post("/{id}/merge")
def merge_category(id: int, body: MergeBody, user: CurrentUser, db: DbSession) -> MergeResult:
    """Moves every transaction, template and payee rule of this category into another."""
    if body.into_id is None:
        raise RequestValidationError([field_error("into_id", "Choose a category to merge into.")])
    categories = cats.all_categories(db, user.id, lock=True)
    source = _owned(categories, id)
    target = cats.owned(categories, body.into_id)
    if target is None:
        raise RequestValidationError([field_error("into_id", "Choose a category to merge into.")])
    moved = cats.merge(db, user.id, categories, source, target)
    db.commit()
    return MergeResult(
        category=_response(target, _counts(db, user.id)),
        moved_transactions=moved.transactions,
        moved_templates=moved.templates,
        moved_rules=moved.rules,
    )
