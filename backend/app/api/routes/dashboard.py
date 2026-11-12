from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.balances import balance_of
from app.api.dates import clamped_date, today_india
from app.api.deposits import deposit_rows, with_deposits
from app.api.deps import CurrentUser, get_current_user
from app.api.goals import GoalDue, goals_due, load_goal_book
from app.api.loans import linked_owed, load_book
from app.api.portfolio import (
    latest_prices,
    load_kinds,
    load_trade_rows,
    replay,
    summarise,
    unrealised_percent,
)
from app.api.routes.accounts import fmt, list_sort_key, totals
from app.api.routes.recurring import DueItem, due_items
from app.db.session import DbSession
from app.models.account import Account
from app.models.sms import SmsEntry
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/dashboard", tags=["dashboard"], dependencies=[Depends(get_current_user)]
)


def next_due_date(due_day: int, today: date) -> date:
    """This month's due date (clamped to the month's length), or next month's if already past."""
    this_month = clamped_date(today.year, today.month, due_day)
    if this_month >= today:
        return this_month
    year, month = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
    return clamped_date(year, month, due_day)


class NextCardDue(BaseModel):
    account_id: int
    name: str
    due_date: str


class CardBill(BaseModel):
    account_id: int
    name: str
    amount: str  # what is still to pay of the latest statement
    due_date: str


class CreditUsed(BaseModel):
    percent: int


class Investments(BaseModel):
    value: str
    unrealised: str
    unrealised_percent: str


class GoalCard(BaseModel):
    id: int
    name: str
    kind: str
    saved: str
    target: str | None
    percent: int | None
    reached: bool


AssetGroup = Literal["bank_cash", "deposits", "stocks", "funds", "crypto"]


class AssetSlice(BaseModel):
    group: AssetGroup
    value: str


class DashboardResponse(BaseModel):
    has_accounts: bool
    net_worth: str
    total_have: str
    total_owe: str
    next_card_due: NextCardDue | None
    credit_used: CreditUsed | None
    investments: Investments | None
    recurring: list[DueItem]
    goals_due: list[GoalDue]
    goals: list[GoalCard]
    asset_split: list[AssetSlice]
    # SMS entries waiting for the owner (review or draft).
    to_review: int
    card_bill: CardBill | None


# A statement's bill stays on the dashboard this long after its due date.
BILL_GRACE = timedelta(days=3)


def _to_review(db: Session, user_id: int) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(SmsEntry)
            .where(SmsEntry.user_id == user_id, SmsEntry.status.in_(("review", "draft")))
        )
        or 0
    )


def card_bill(db: Session, user_id: int, cards: list[Account], today: date) -> CardBill | None:
    """The unpaid card bill due soonest. Shown until 3 days past due."""
    bills = card_bills(db, user_id, cards, today)
    return bills[0] if bills else None


def card_bills(db: Session, user_id: int, cards: list[Account], today: date) -> list[CardBill]:
    """Every card's unpaid bill, soonest first: its latest statement SMS, less what was
    transferred into the card after the statement's date. Shown until 3 days past due."""
    bills: list[tuple[date, int, CardBill]] = []
    for card in cards:
        statement = db.scalar(
            select(SmsEntry)
            .where(
                SmsEntry.user_id == user_id,
                SmsEntry.account_id == card.id,
                SmsEntry.kind == "card_statement",
                SmsEntry.status == "recorded",
                SmsEntry.amount.is_not(None),
                SmsEntry.due_date.is_not(None),
            )
            .order_by(SmsEntry.occurred_on.desc(), SmsEntry.id.desc())
            .limit(1)
        )
        if statement is None or statement.amount is None or statement.due_date is None:
            continue
        if statement.due_date < today - BILL_GRACE:
            continue
        paid = db.scalar(
            select(func.coalesce(func.sum(Transaction.amount), 0)).where(
                Transaction.user_id == user_id,
                Transaction.type == "transfer",
                Transaction.to_account_id == card.id,
                Transaction.date > statement.occurred_on,
            )
        )
        left = statement.amount - Decimal(paid or 0)
        if left > 0:
            bill = CardBill(
                account_id=card.id,
                name=card.name,
                amount=fmt(left),
                due_date=statement.due_date.isoformat(),
            )
            bills.append((statement.due_date, card.id, bill))
    return [b[2] for b in sorted(bills, key=lambda b: (b[0], b[1]))]


@router.get("")
def get_dashboard(user: CurrentUser, db: DbSession) -> DashboardResponse:
    active = list(
        db.scalars(
            select(Account).where(Account.user_id == user.id, Account.archived_at.is_(None))
        ).all()
    )
    book = load_book(db, user.id, active)
    flows = book.flows
    have, owe = totals(active, flows)
    result = replay(load_trade_rows(db, user.id))
    prices = latest_prices(db, user.id)
    market = summarise(result, prices)
    has_holdings = any(pos.quantity > 0 for pos in result.positions.values())
    have += market.value  # deposits are already in `have` as accounts
    today = today_india()
    deposits = deposit_rows(active, book, today)
    overall = with_deposits(market, deposits)
    cards = sorted(
        (a for a in active if a.type == "credit_card"),
        key=list_sort_key,
    )

    dated = [(next_due_date(a.due_day, today), a) for a in cards if a.due_day is not None]
    due = min(dated, key=lambda pair: pair[0], default=None)  # min keeps the first of equal dates

    limited = [a for a in cards if a.credit_limit is not None]
    credit_used = None
    if limited:
        # Loans paid from a card use up its limit as well.
        blocked = linked_owed(active, flows)
        used = sum((balance_of(a, flows) + blocked.get(a.id, 0) for a in limited), Decimal(0))
        limit = sum((a.credit_limit for a in limited if a.credit_limit is not None), Decimal(0))
        percent = (used * 100 / limit).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        credit_used = CreditUsed(percent=int(max(percent, Decimal(0))))

    investments = None
    if has_holdings or deposits:
        investments = Investments(
            value=fmt(overall.value),
            unrealised=fmt(overall.unrealised),
            unrealised_percent=fmt(unrealised_percent(overall.unrealised, overall.invested)),
        )

    kinds = load_kinds(db, user.id)

    def held(kind: str) -> Decimal:
        ids = {i for i, k in kinds.items() if k == kind}
        return summarise(result, prices, only=ids).value

    deposits_value = sum((r.balance for r in deposits), Decimal(0))
    stocks, funds, crypto = held("stock"), held("mutual_fund"), held("crypto")
    # Whatever isn't a deposit or a market holding is money in bank, cash, wallet and card
    # accounts, so the slices always add up to `total_have`.
    bank_cash = have - deposits_value - stocks - funds - crypto
    split = [
        ("bank_cash", bank_cash),
        ("deposits", deposits_value),
        ("stocks", stocks),
        ("funds", funds),
        ("crypto", crypto),
    ]

    goal_book = load_goal_book(db, user.id, today)
    return DashboardResponse(
        has_accounts=bool(active),
        net_worth=fmt(have - owe),
        total_have=fmt(have),
        total_owe=fmt(owe),
        next_card_due=None
        if due is None
        else NextCardDue(account_id=due[1].id, name=due[1].name, due_date=due[0].isoformat()),
        credit_used=credit_used,
        investments=investments,
        recurring=due_items(db, user.id, today),
        asset_split=[AssetSlice(group=g, value=fmt(v)) for g, v in split if v > 0],
        goals_due=goals_due(db, user.id, today, goal_book),
        to_review=_to_review(db, user.id),
        card_bill=card_bill(db, user.id, cards, today),
        goals=[
            GoalCard(
                id=r.id,
                name=r.name,
                kind=r.kind,
                saved=r.saved,
                target=r.target,
                percent=r.percent,
                reached=r.reached,
            )
            for r in goal_book.responses.values()
            if not r.archived
        ],
    )
