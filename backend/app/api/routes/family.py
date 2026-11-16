"""Family members and the family portfolio. Always the signed-in owner's, whatever profile the
request names: see docs/superpowers/specs/2026-11-16-family-portfolio-design.md.

A member is a user with no login (`owner_id` set, a placeholder email no Google account can
have). The owner acts for a member by sending `X-Profile: <member id>` (`app.api.deps`).
"""

from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import SignedInUser, get_signed_in_user
from app.api.portfolio import unrealised_percent
from app.api.routes.accounts import MAX_ID, clean_text, field_error, fmt
from app.api.routes.portfolio import Portfolio, get_portfolio
from app.db.session import DbSession
from app.export.backup import delete_user_data
from app.models.user import User

router = APIRouter(prefix="/family", tags=["family"], dependencies=[Depends(get_signed_in_user)])

MAX_MEMBERS = 10
ME = "Me"
EMAIL_DOMAIN = "members.invalid"  # reserved: no Google account can have it

MemberName = Annotated[
    str | None, BeforeValidator(lambda v: clean_text(v, "Enter a name.", limit=40))
]


class Person(BaseModel):
    id: int
    name: str


class Family(BaseModel):
    me: Person
    members: list[Person]


class MemberBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: MemberName = None


def _members(db: Session, owner_id: int) -> list[User]:
    found = db.scalars(select(User).where(User.owner_id == owner_id)).all()
    return sorted(found, key=lambda m: ((m.name or "").casefold(), m.id))


def _family(db: Session, owner: User) -> Family:
    return Family(
        me=Person(id=owner.id, name=ME),
        members=[Person(id=m.id, name=m.name or "") for m in _members(db, owner.id)],
    )


def _owned_member(db: Session, owner: User, id: int) -> User:
    member = db.get(User, id) if 1 <= id <= MAX_ID else None
    if member is None or member.owner_id != owner.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That family member wasn't found.")
    return member


def _check_name(db: Session, owner: User, name: str | None, except_id: int | None = None) -> str:
    if name is None:
        raise RequestValidationError([field_error("name", "Enter a name.")])
    if name.casefold() == ME.casefold():
        raise RequestValidationError([field_error("name", '"Me" is you. Choose another name.')])
    taken = {(m.name or "").casefold() for m in _members(db, owner.id) if m.id != except_id}
    if name.casefold() in taken:
        raise RequestValidationError([field_error("name", f"You already have {name}.")])
    return name


@router.get("")
def get_family(user: SignedInUser, db: DbSession) -> Family:
    return _family(db, user)


@router.post("/members", status_code=status.HTTP_201_CREATED)
def add_member(body: MemberBody, user: SignedInUser, db: DbSession) -> Person:
    # Locked, so two adds at once can't both pass the limit and the name check.
    db.scalar(select(User.id).where(User.id == user.id).with_for_update())
    if len(_members(db, user.id)) >= MAX_MEMBERS:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"You can have up to {MAX_MEMBERS} family members."
        )
    name = _check_name(db, user, body.name)
    count = db.scalar(select(func.count()).select_from(User).where(User.owner_id == user.id))
    number = (count or 0) + 1
    while db.scalar(
        select(User.id).where(User.email == f"family-{user.id}-{number}@{EMAIL_DOMAIN}")
    ):
        number += 1
    member = User(
        email=f"family-{user.id}-{number}@{EMAIL_DOMAIN}",
        owner_id=user.id,
        name=name,
    )
    db.add(member)
    db.commit()
    return Person(id=member.id, name=name)


@router.patch("/members/{id}")
def rename_member(id: int, body: MemberBody, user: SignedInUser, db: DbSession) -> Person:
    member = _owned_member(db, user, id)
    member.name = _check_name(db, user, body.name, except_id=member.id)
    db.commit()
    return Person(id=member.id, name=member.name)


@router.delete("/members/{id}")
def remove_member(
    id: int, user: SignedInUser, db: DbSession, confirm: Annotated[str, Query()] = ""
) -> Family:
    """Deletes the member and everything recorded for them. `confirm` must be their name."""
    member = _owned_member(db, user, id)
    if confirm.strip().casefold() != (member.name or "").casefold():
        raise RequestValidationError(
            [field_error("confirm", f"Type {member.name} to remove them and all their data.")]
        )
    delete_user_data(db, member.id)
    db.delete(member)
    db.commit()
    return _family(db, user)


# The family portfolio


class Figures(BaseModel):
    invested: str
    value: str
    unrealised: str
    unrealised_percent: str


class TypeFigures(BaseModel):
    stocks: Figures
    funds: Figures
    crypto: Figures
    deposits: Figures


class FamilyHolding(BaseModel):
    kind: str  # stock | mutual_fund | crypto | ppf | rd | fd
    name: str
    symbol: str | None
    account: str | None  # the account when a deposit; instruments can be in several
    quantity: str | None
    invested: str
    value: str


class PersonPortfolio(BaseModel):
    id: int
    name: str
    is_me: bool
    overall: Figures
    by_type: TypeFigures
    holdings: list[FamilyHolding]


class FamilyPortfolio(BaseModel):
    people: list[PersonPortfolio]
    overall: Figures
    by_type: TypeFigures


ZERO = Decimal(0)


def _figures(invested: Decimal, value: Decimal) -> Figures:
    unrealised = value - invested
    return Figures(
        invested=fmt(invested),
        value=fmt(value),
        unrealised=fmt(unrealised),
        unrealised_percent=fmt(unrealised_percent(unrealised, invested)),
    )


def _pair(totals: Any) -> tuple[Decimal, Decimal]:
    return Decimal(totals.invested), Decimal(totals.value)


def _person(user: User, name: str, is_me: bool, p: Portfolio) -> tuple[PersonPortfolio, dict]:
    deposits = Decimal(p.deposits.value)
    pairs = {
        "stocks": _pair(p.totals),
        "funds": _pair(p.funds.totals),
        "crypto": _pair(p.crypto.totals),
        "deposits": (deposits, deposits),  # at their balance, as on the Investments page
    }
    holdings = [
        *(
            FamilyHolding(kind="stock", name=s.name, symbol=s.symbol, account=None,
                          quantity=str(s.shares), invested=s.invested, value=s.value)
            for s in p.by_stock
        ),
        *(
            FamilyHolding(kind="mutual_fund", name=f.name, symbol=f.symbol, account=None,
                          quantity=f.units, invested=f.invested, value=f.value)
            for f in p.funds.by_fund
        ),
        *(
            FamilyHolding(kind="crypto", name=c.name, symbol=c.symbol, account=None,
                          quantity=c.quantity, invested=c.invested, value=c.value)
            for c in p.crypto.by_coin
        ),
        *(
            FamilyHolding(kind=d.type, name=d.name, symbol=None, account=d.name, quantity=None,
                          invested=d.balance, value=d.balance)
            for d in p.deposits.accounts
        ),
    ]  # fmt: skip
    invested = sum((i for i, _ in pairs.values()), ZERO)
    value = sum((v for _, v in pairs.values()), ZERO)
    return (
        PersonPortfolio(
            id=user.id,
            name=name,
            is_me=is_me,
            overall=_figures(invested, value),
            by_type=TypeFigures(**{k: _figures(*v) for k, v in pairs.items()}),
            holdings=holdings,
        ),
        pairs,
    )


@router.get("/portfolio")
def family_portfolio(user: SignedInUser, db: DbSession) -> FamilyPortfolio:
    """Each person's investments exactly as their own Investments page shows them, and the
    family's totals. Bank accounts, cards and loans are not part of it."""
    people = []
    totals: dict[str, list[Decimal]] = {
        k: [ZERO, ZERO] for k in ("stocks", "funds", "crypto", "deposits")
    }
    for person, name, is_me in [(user, ME, True)] + [
        (m, m.name or "", False) for m in _members(db, user.id)
    ]:
        row, pairs = _person(person, name, is_me, get_portfolio(person, db))
        people.append(row)
        for kind, (invested, value) in pairs.items():
            totals[kind][0] += invested
            totals[kind][1] += value
    invested = sum((t[0] for t in totals.values()), ZERO)
    value = sum((t[1] for t in totals.values()), ZERO)
    return FamilyPortfolio(
        people=people,
        overall=_figures(invested, value),
        by_type=TypeFigures(**{k: _figures(*v) for k, v in totals.items()}),
    )
