"""The categories migration's seeding, run against the models' tables on SQLite."""

import importlib.util
from datetime import date
from decimal import Decimal
from pathlib import Path
from types import ModuleType

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.category import Category
from app.models.recurring import RecurringTemplate
from app.models.sms import PayeeRule
from app.models.transaction import Transaction
from app.models.user import User

MIGRATION = next(
    (Path(__file__).parent.parent / "migrations" / "versions").glob("*_add_categories.py")
)


def _module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("add_categories", MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _user(db: Session, email: str) -> tuple[int, int]:
    user = User(email=email)
    db.add(user)
    db.flush()
    account = Account(user_id=user.id, name="Cash", type="cash", opening_balance=Decimal("1000.00"))
    db.add(account)
    db.flush()
    return user.id, account.id


def _tx(db: Session, user_id: int, account_id: int, type_: str, category: str) -> Transaction:
    tx = Transaction(
        user_id=user_id,
        type=type_,
        amount=Decimal("10.00"),
        date=date(2026, 1, 1),
        account_id=account_id,
        category=category,
    )
    db.add(tx)
    return tx


def test_seeding_collapses_spellings_and_rewrites_references(db_session: Session) -> None:
    db = db_session
    owner, cash = _user(db, "owner@example.com")
    other, _ = _user(db, "other@example.com")
    tx = _tx(db, owner, cash, "expense", "groceries")
    _tx(db, owner, cash, "expense", "Swiggy")
    _tx(db, owner, cash, "income", "Side gig")
    template = RecurringTemplate(
        user_id=owner,
        name="Food",
        type="expense",
        amount=Decimal("5.00"),
        account_id=cash,
        category="SWIGGY",
        frequency="monthly",
        day=1,
        start_date=date(2026, 1, 1),
        remind_days=3,
    )
    db.add(template)
    rule = PayeeRule(user_id=owner, payee_key="gig", display="Gig", category="side GIG")
    db.add(rule)
    db.commit()
    db.execute(delete(Category))

    _module().seed(db.connection())

    def names(user_id: int, kind: str) -> list[str]:
        query = select(Category.name).where(Category.user_id == user_id, Category.kind == kind)
        return list(db.scalars(query.order_by(Category.id)))

    expense = names(owner, "expense")
    assert expense[0] == "Groceries"
    assert "Loan interest" in expense
    assert expense[-1] == "Swiggy"
    assert names(owner, "income")[-1] == "Side gig"
    assert "Swiggy" not in names(other, "expense")
    assert len(names(other, "expense")) == 17
    db.expire_all()
    assert db.get(Transaction, tx.id).category == "Groceries"  # type: ignore[union-attr]
    assert db.get(RecurringTemplate, template.id).category == "Swiggy"  # type: ignore[union-attr]
    assert db.get(PayeeRule, rule.id).category == "Side gig"  # type: ignore[union-attr]
    keys = db.scalars(select(Category.name_key).where(Category.name == "Food and dining"))
    assert set(keys) == {"food and dining"}
