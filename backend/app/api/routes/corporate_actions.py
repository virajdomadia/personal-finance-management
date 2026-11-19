"""Corporate actions: the review inbox, a stock's history of actions, confirming, dismissing and
undoing them, and linking a dividend to the bank credits that paid it.

See docs/superpowers/specs/2026-11-19-corporate-actions-design.md. Only `applied` actions change
holdings (`portfolio.replay`). Confirming or undoing one replays the user's trades with the
change and is refused if a later sell would then sell more than was held. A dividend link is
informational only: it never creates a ledger entry, so net worth doesn't move.
"""

import re
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.categories import category_family
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import (
    ActionRow,
    Replay,
    load_action_rows,
    load_trade_rows,
    replay,
    round_paise,
)
from app.api.routes.accounts import MAX_ID, field_error, fmt
from app.api.routes.stocks import STOCK, get_owned_stock
from app.api.routes.trades import STOCK_SHORT
from app.api.routes.transactions import Day, lock_accounts
from app.api.trade_checks import shortfall_check
from app.db.session import DbSession
from app.models.account import Account
from app.models.category import Category
from app.models.corporate_action import CorporateAction, DividendLink, StockAction
from app.models.investment import Instrument, InvestmentTrade
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

KINDS = ("split", "consolidation", "bonus", "merger", "demerger", "dividend", "other")
# Kinds that can be entered by hand; "other" only arrives from the exchange, for history.
MANUAL_KINDS = KINDS[:-1]
RATIO_KINDS = ("split", "consolidation", "bonus", "merger", "demerger")
MOVE_KINDS = ("merger", "demerger")
STATUSES = ("pending", "applied", "dismissed")
# (from, to) status changes a PATCH may make. Anything else goes back to pending first.
TRANSITIONS = {
    ("pending", "applied"),
    ("pending", "dismissed"),
    ("applied", "pending"),
    ("dismissed", "pending"),
}
# A dividend's link suggestions: a Dividends credit this many days after the ex-date at most,
# for between 85% and 100% of the account's gross (tax may have been deducted).
LINK_DAYS = 45
LINK_LOW = Decimal("0.85")

_NUMBER = re.compile(r"[0-9]+(\.[0-9]+)?")
_CHOOSE_KIND = "Choose a kind of action."
_RATIO_RULE = "Enter a number greater than 0, like 5."
_AMOUNT_RULE = "Enter an amount per share greater than 0, like 2.50."
_PCT_RULE = "Enter a percentage between 0 and 100, like 25."
_TARGET_RULE = "Choose the stock the shares go to."


def _number(code: str, message: str, places: int, below: Decimal) -> Any:
    """A BeforeValidator for a positive decimal (text or whole number) under `below`."""

    def check(value: Any) -> Decimal | None:
        if value is None:
            return None
        if isinstance(value, int) and not isinstance(value, bool):
            value = str(value)
        text = value.strip() if isinstance(value, str) else ""
        match = _NUMBER.fullmatch(text) if len(text) <= 30 else None
        if match is None:
            raise PydanticCustomError(code, message)
        if len((match.group(1) or ".")[1:].rstrip("0")) > places:
            raise PydanticCustomError(code, f"Use at most {places} decimal places.")
        number = Decimal(text)
        if number <= 0 or number >= below:
            raise PydanticCustomError(code, message)
        return number

    return check


def _choice(options: tuple[str, ...], message: str) -> Any:
    def check(value: Any) -> str | None:
        if value is not None and value not in options:
            raise PydanticCustomError("choice", message)
        return value

    return check


def _ref(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise PydanticCustomError("stock", _TARGET_RULE)
    return value


Ratio = Annotated[
    Decimal | None, BeforeValidator(_number("ratio", _RATIO_RULE, 6, Decimal(10) ** 8))
]
PerShare = Annotated[
    Decimal | None, BeforeValidator(_number("amount", _AMOUNT_RULE, 4, Decimal(10) ** 10))
]
Percent = Annotated[Decimal | None, BeforeValidator(_number("percent", _PCT_RULE, 4, Decimal(100)))]
StockRef = Annotated[int | None, BeforeValidator(_ref)]


class ActionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Annotated[str | None, BeforeValidator(_choice(MANUAL_KINDS, _CHOOSE_KIND))] = None
    ex_date: Day = None
    ratio_new: Ratio = None
    ratio_old: Ratio = None
    amount_per_share: PerShare = None
    target_stock_id: StockRef = None
    cost_share_pct: Percent = None


class ActionUpdate(ActionCreate):
    status: Annotated[
        str | None, BeforeValidator(_choice(STATUSES, "Choose applied, dismissed or pending."))
    ] = None


class Preview(BaseModel):
    shares_before: int
    shares_after: int
    average_before: str
    average_after: str


class AccountDividend(BaseModel):
    account_id: int
    account_name: str
    gross: str
    links: list[int]  # transaction ids


class Dividend(BaseModel):
    gross: str
    by_account: list[AccountDividend]


class ActionResponse(BaseModel):
    id: int
    stock_id: int
    symbol: str
    kind: str
    ex_date: str
    ratio_new: str | None
    ratio_old: str | None
    amount_per_share: str | None
    status: str
    purpose: str | None  # the exchange's wording; None for one entered by hand
    target_stock_id: int | None
    cost_share_pct: str | None
    preview: Preview | None
    dividend: Dividend | None


class ActionList(BaseModel):
    actions: list[ActionResponse]
    pending_count: int


class StockActions(BaseModel):
    actions: list[ActionResponse]
    suspect_drop_on: str | None
    backfilled: bool  # False: the past is still being checked for actions


class Credit(BaseModel):
    id: int
    date: str
    amount: str
    account_id: int
    account_name: str
    note: str | None


class AccountSuggestions(BaseModel):
    account_id: int
    account_name: str
    gross: str
    suggestions: list[Credit]


class LinkSuggestions(BaseModel):
    accounts: list[AccountSuggestions]


def _plain(value: Decimal | None) -> str | None:
    """A ratio, per-share amount or percentage without trailing zeros: "5", "2.5"."""
    if value is None:
        return None
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _row(action: StockAction) -> ActionRow:
    return ActionRow(
        action.id,
        action.instrument_id,
        action.kind,
        action.ex_date,
        action.ratio_new,
        action.ratio_old,
        action.amount_per_share,
        action.target_instrument_id,
        action.cost_share_pct,
    )


class _Context:
    """What every response needs, loaded once per request: the user's trades, applied actions,
    the replay with them, account and stock names, purposes and links."""

    def __init__(self, db: Session, user_id: int, actions: list[StockAction]) -> None:
        self.trades = load_trade_rows(db, user_id)
        self.applied = load_action_rows(db, user_id)
        self.current = replay(self.trades, self.applied)
        self.accounts = dict(
            db.execute(select(Account.id, Account.name).where(Account.user_id == user_id)).all()
        )
        self.symbols = dict(
            db.execute(
                select(Instrument.id, Instrument.symbol).where(Instrument.user_id == user_id)
            ).all()
        )
        feed_ids = {a.corporate_action_id for a in actions if a.corporate_action_id is not None}
        self.purposes: dict[int, str] = {}
        if feed_ids:
            self.purposes = dict(
                db.execute(
                    select(CorporateAction.id, CorporateAction.purpose).where(
                        CorporateAction.id.in_(feed_ids)
                    )
                ).all()
            )
        self.links: dict[int, list[tuple[int, Decimal]]] = defaultdict(list)
        ids = [a.id for a in actions if a.kind == "dividend"]
        if ids:
            rows = db.execute(
                select(DividendLink.stock_action_id, Transaction.id, Transaction.amount)
                .join(Transaction, Transaction.id == DividendLink.transaction_id)
                .where(DividendLink.user_id == user_id, DividendLink.stock_action_id.in_(ids))
                .order_by(Transaction.date, Transaction.id)
            )
            for action_id, tx_id, amount in rows:
                self.links[action_id].append((tx_id, amount))

    def with_and_without(self, action: StockAction) -> tuple[Replay, Replay]:
        """Replays without this action and with it applied as it now stands."""
        others = [a for a in self.applied if a.id != action.id]
        is_applied = len(others) != len(self.applied)
        if is_applied:
            return replay(self.trades, others), self.current
        return self.current, replay(self.trades, [*others, _row(action)])

    def dividend_replay(self, action: StockAction) -> Replay:
        if action.status == "applied":
            return self.current
        return self.with_and_without(action)[1]


def _shares(result: Replay, instrument_id: int) -> tuple[int, Decimal]:
    shares, invested = 0, Decimal("0.00")
    for (inst, _), pos in result.positions.items():
        if inst == instrument_id and pos.quantity > 0:
            shares += int(pos.quantity)
            invested += pos.invested
    return shares, invested


def _average(shares: int, invested: Decimal) -> str:
    return fmt(round_paise(invested / shares) if shares else Decimal("0.00"))


def _preview(ctx: _Context, action: StockAction) -> Preview | None:
    """Shares and average cost of the stock across accounts now, without and with the action.

    None for a dividend or "other" (no holding changes) and for a merger or demerger that can't
    run yet (no target, or a demerger without its cost share)."""
    if action.kind not in RATIO_KINDS:
        return None
    if action.kind in MOVE_KINDS and action.target_instrument_id is None:
        return None
    if action.kind == "demerger" and action.cost_share_pct is None:
        return None
    without, with_it = ctx.with_and_without(action)
    before, after = _shares(without, action.instrument_id), _shares(with_it, action.instrument_id)
    return Preview(
        shares_before=before[0],
        shares_after=after[0],
        average_before=_average(*before),
        average_after=_average(*after),
    )


def _per_account(ctx: _Context, action: StockAction) -> dict[int, Decimal]:
    """Gross by account; for a dividend not applied, what it would pay if it were."""
    result = ctx.dividend_replay(action)
    return {acct: gross for (id_, acct), gross in result.dividends.items() if id_ == action.id}


def _sorted_accounts(ctx: _Context, gross: dict[int, Decimal]) -> list[int]:
    return sorted(gross, key=lambda a: (ctx.accounts.get(a, "").casefold(), a))


def _attribute(gross: dict[int, Decimal], order: list[int], links: list[tuple[int, Decimal]]):
    """Which account each linked credit belongs to. A link records only the transaction, so a
    credit goes to the account whose gross it fits (85%-100%), fewest links first; failing
    that, the account whose gross is nearest."""
    found: dict[int, list[int]] = {a: [] for a in order}
    if not order:
        return found
    for tx_id, amount in links:
        fits = [a for a in order if gross[a] * LINK_LOW <= amount <= gross[a]]
        if fits:
            account = min(fits, key=lambda a: len(found[a]))
        else:
            account = min(order, key=lambda a: abs(gross[a] - amount))
        found[account].append(tx_id)
    return found


def _dividend(ctx: _Context, action: StockAction) -> Dividend | None:
    if action.kind != "dividend":
        return None
    gross = _per_account(ctx, action)
    order = _sorted_accounts(ctx, gross)
    links = _attribute(gross, order, ctx.links.get(action.id, []))
    return Dividend(
        gross=fmt(sum(gross.values(), Decimal("0.00"))),
        by_account=[
            AccountDividend(
                account_id=a,
                account_name=ctx.accounts.get(a, ""),
                gross=fmt(gross[a]),
                links=links[a],
            )
            for a in order
        ],
    )


def _response(ctx: _Context, action: StockAction) -> ActionResponse:
    return ActionResponse(
        id=action.id,
        stock_id=action.instrument_id,
        symbol=ctx.symbols.get(action.instrument_id, ""),
        kind=action.kind,
        ex_date=action.ex_date.isoformat(),
        ratio_new=_plain(action.ratio_new),
        ratio_old=_plain(action.ratio_old),
        amount_per_share=_plain(action.amount_per_share),
        status=action.status,
        purpose=None
        if action.corporate_action_id is None
        else ctx.purposes.get(action.corporate_action_id),
        target_stock_id=action.target_instrument_id,
        cost_share_pct=_plain(action.cost_share_pct),
        preview=_preview(ctx, action),
        dividend=_dividend(ctx, action),
    )


def _responses(db: Session, user_id: int, actions: list[StockAction]) -> list[ActionResponse]:
    ctx = _Context(db, user_id, actions)
    return [_response(ctx, a) for a in actions]


def _one(db: Session, user_id: int, action: StockAction) -> ActionResponse:
    return _responses(db, user_id, [action])[0]


def _get_owned(db: Session, user_id: int, id: int, lock: bool = False) -> StockAction:
    action = None
    if 1 <= id <= MAX_ID:
        query = select(StockAction).where(StockAction.id == id, StockAction.user_id == user_id)
        if lock:
            query = query.with_for_update().execution_options(populate_existing=True)
        action = db.scalar(query)
    if action is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Corporate action not found.")
    return action


def _check_target(db: Session, user_id: int, stock_id: int, target: int | None) -> list:
    if target is None:
        return []
    if target == stock_id:
        return [field_error("target_stock_id", "Choose a different stock from this one.")]
    found = None
    if 1 <= target <= MAX_ID:
        found = db.scalar(
            select(Instrument.id).where(
                Instrument.id == target, Instrument.user_id == user_id, Instrument.kind == STOCK
            )
        )
    return [] if found is not None else [field_error("target_stock_id", _TARGET_RULE)]


def _check_fields(action: StockAction) -> list:
    """The fields the action's kind needs to mean anything, whatever its status."""
    errors = []
    if action.kind in RATIO_KINDS:
        if action.ratio_new is None:
            errors.append(field_error("ratio_new", _RATIO_RULE))
        if action.ratio_old is None:
            errors.append(field_error("ratio_old", _RATIO_RULE))
    if action.kind == "dividend" and action.amount_per_share is None:
        errors.append(field_error("amount_per_share", _AMOUNT_RULE))
    return errors


def _check_apply(action: StockAction) -> list:
    """What confirming needs on top of `_check_fields`."""
    errors = []
    if action.kind == "other":
        errors.append(field_error("kind", "Choose what kind of action this was to confirm it."))
    if action.kind in MOVE_KINDS and action.target_instrument_id is None:
        errors.append(field_error("target_stock_id", _TARGET_RULE))
    if action.kind == "demerger" and action.cost_share_pct is None:
        errors.append(field_error("cost_share_pct", _PCT_RULE))
    return errors


def _lock_holders(db: Session, user_id: int, instruments: list[int | None]) -> None:
    """Locks every account with trades in these stocks, as a trade save locks its account, so a
    sell saved meanwhile can't slip past the shortfall check."""
    ids = db.scalars(
        select(InvestmentTrade.account_id)
        .where(
            InvestmentTrade.user_id == user_id,
            InvestmentTrade.instrument_id.in_([i for i in instruments if i is not None]),
        )
        .distinct()
    )
    lock_accounts(db, user_id, list(ids))


@router.get("/actions")
def list_actions(
    user: CurrentUser,
    db: DbSession,
    status_: Annotated[Literal["pending", "applied", "dismissed"], Query(alias="status")] = (
        "pending"
    ),
) -> ActionList:
    """The review inbox (or the applied or dismissed ones), oldest ex-date first, and how many
    are pending, for a badge."""
    actions = list(
        db.scalars(
            select(StockAction)
            .where(StockAction.user_id == user.id, StockAction.status == status_)
            .order_by(StockAction.ex_date, StockAction.id)
        )
    )
    pending = db.scalar(
        select(func.count())
        .select_from(StockAction)
        .where(StockAction.user_id == user.id, StockAction.status == "pending")
    )
    return ActionList(actions=_responses(db, user.id, actions), pending_count=pending or 0)


def _stock_actions(db: Session, user_id: int, stock: Instrument) -> StockActions:
    actions = list(
        db.scalars(
            select(StockAction).where(
                StockAction.user_id == user_id, StockAction.instrument_id == stock.id
            )
        )
    )
    today = today_india()
    upcoming = sorted((a for a in actions if a.ex_date >= today), key=lambda a: (a.ex_date, a.id))
    past = sorted(
        (a for a in actions if a.ex_date < today), key=lambda a: (a.ex_date, a.id), reverse=True
    )
    return StockActions(
        actions=_responses(db, user_id, [*upcoming, *past]),
        suspect_drop_on=stock.suspect_drop_on and stock.suspect_drop_on.isoformat(),
        # A stock not linked to the exchange is never checked, so there is nothing to wait for.
        backfilled=stock.source_code is None or stock.actions_backfilled_at is not None,
    )


@router.get("/stocks/{id}/actions")
def list_stock_actions(id: int, user: CurrentUser, db: DbSession) -> StockActions:
    """All of the stock's actions, upcoming first (soonest first), then past (latest first)."""
    return _stock_actions(db, user.id, get_owned_stock(db, user.id, id))


@router.post("/stocks/{id}/actions", status_code=status.HTTP_201_CREATED)
def create_action(id: int, body: ActionCreate, user: CurrentUser, db: DbSession) -> ActionResponse:
    """An action entered by hand: pending until confirmed."""
    stock = get_owned_stock(db, user.id, id)
    errors = []
    if body.kind is None:
        errors.append(field_error("kind", _CHOOSE_KIND))
    if body.ex_date is None:
        errors.append(field_error("ex_date", "Choose the ex-date."))
    errors += _check_target(db, user.id, stock.id, body.target_stock_id)
    if errors:
        raise RequestValidationError(errors)
    assert body.kind is not None and body.ex_date is not None
    action = StockAction(
        user_id=user.id,
        instrument_id=stock.id,
        corporate_action_id=None,
        kind=body.kind,
        ex_date=body.ex_date,
        ratio_new=body.ratio_new,
        ratio_old=body.ratio_old,
        amount_per_share=body.amount_per_share,
        status="pending",
        target_instrument_id=body.target_stock_id,
        cost_share_pct=body.cost_share_pct,
    )
    errors = _check_fields(action)
    if errors:
        raise RequestValidationError(errors)
    db.add(action)
    db.commit()
    return _one(db, user.id, action)


_EDITABLE = (
    ("kind", "kind"),
    ("ex_date", "ex_date"),
    ("ratio_new", "ratio_new"),
    ("ratio_old", "ratio_old"),
    ("amount_per_share", "amount_per_share"),
    ("target_stock_id", "target_instrument_id"),
    ("cost_share_pct", "cost_share_pct"),
)


@router.patch("/actions/{id}")
def update_action(id: int, body: ActionUpdate, user: CurrentUser, db: DbSession) -> ActionResponse:
    """Edits fields while pending, and/or moves the status: confirm (applied), dismiss, or back
    to pending. Confirming or undoing is refused if a later sell would then be short."""
    action = _get_owned(db, user.id, id)
    changes = body.model_dump(exclude_unset=True)
    if "status" in changes and changes["status"] is None:
        raise RequestValidationError(
            [field_error("status", "Choose applied, dismissed or pending.")]
        )
    new_status = changes.pop("status", action.status)
    if new_status != action.status:
        target = changes.get("target_stock_id", action.target_instrument_id)
        _lock_holders(db, user.id, [action.instrument_id, action.target_instrument_id, target])
        action = _get_owned(db, user.id, id, lock=True)  # re-read under the locks
    old_status = action.status
    if new_status != old_status and (old_status, new_status) not in TRANSITIONS:
        raise HTTPException(status.HTTP_409_CONFLICT, "Move it back to pending first.")

    if changes:
        if old_status != "pending":
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Move it back to pending before changing it."
            )
        errors = []
        if "kind" in changes and changes["kind"] is None:
            errors.append(field_error("kind", _CHOOSE_KIND))
        if "ex_date" in changes:
            if changes["ex_date"] is None:
                errors.append(field_error("ex_date", "Choose the ex-date."))
            elif action.corporate_action_id is not None:
                errors.append(field_error("ex_date", "The exchange's ex-date can't be changed."))
        if "target_stock_id" in changes:
            errors += _check_target(db, user.id, action.instrument_id, changes["target_stock_id"])
        if errors:
            db.rollback()
            raise RequestValidationError(errors)
        for field, column in _EDITABLE:
            if field in changes:
                setattr(action, column, changes[field])
    action.status = new_status

    # Dismissing or undoing needs nothing more; an edit or a confirmation must make sense.
    errors = _check_fields(action) if changes or new_status == "applied" else []
    if new_status == "applied":
        errors += _check_apply(action)
    if errors:
        db.rollback()
        raise RequestValidationError(errors)

    if (old_status == "applied") != (new_status == "applied"):
        # The applied set with this action confirmed, or without it if undone.
        applied = [a for a in load_action_rows(db, user.id) if a.id != action.id]
        if new_status == "applied":
            applied.append(_row(action))
        try:
            shortfall_check(
                db, user.id, load_trade_rows(db, user.id), None, STOCK_SHORT, actions=applied
            )
        except HTTPException:
            db.rollback()
            raise
    db.commit()
    return _one(db, user.id, action)


def _owned_dividend(db: Session, user_id: int, id: int, applied: bool) -> StockAction:
    action = _get_owned(db, user_id, id)
    if action.kind != "dividend":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a dividend can be linked to a payment.")
    if applied and action.status != "applied":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Confirm the dividend before linking a payment to it."
        )
    return action


def _dividend_names(db: Session, user_id: int) -> set[str]:
    """Lower-cased names of the user's Dividends income category, its subcategories and the
    names merged into them. Found by name or by its dividends icon, so a rename still counts."""
    found = db.scalars(
        select(Category.name).where(
            Category.user_id == user_id,
            Category.kind == "income",
            Category.merged_into_id.is_(None),
            (Category.name_key == "dividends") | (Category.icon == "dividends"),
        )
    ).all()
    names = {"dividends"}
    for name in found:
        names.update(n.lower() for n in category_family(db, user_id, name))
    return names


@router.get("/actions/{id}/link-suggestions")
def link_suggestions(id: int, user: CurrentUser, db: DbSession) -> LinkSuggestions:
    """For each account the dividend paid into: Dividends credits from the ex-date to 45 days
    after it, for 85% to 100% of that account's gross, not linked to any dividend yet."""
    action = _owned_dividend(db, user.id, id, applied=False)
    ctx = _Context(db, user.id, [action])
    gross = _per_account(ctx, action)
    order = _sorted_accounts(ctx, gross)
    linked = select(DividendLink.transaction_id).where(DividendLink.user_id == user.id)
    credits = list(
        db.scalars(
            select(Transaction)
            .where(
                Transaction.user_id == user.id,
                Transaction.type == "income",
                func.lower(Transaction.category).in_(_dividend_names(db, user.id)),
                Transaction.date >= action.ex_date,
                Transaction.date <= action.ex_date + timedelta(days=LINK_DAYS),
                Transaction.id.not_in(linked),
            )
            .order_by(Transaction.date, Transaction.id)
        )
    )
    return LinkSuggestions(
        accounts=[
            AccountSuggestions(
                account_id=a,
                account_name=ctx.accounts.get(a, ""),
                gross=fmt(gross[a]),
                suggestions=[
                    Credit(
                        id=t.id,
                        date=t.date.isoformat(),
                        amount=fmt(t.amount),
                        account_id=t.account_id,
                        account_name=ctx.accounts.get(t.account_id, ""),
                        note=t.note,
                    )
                    for t in credits
                    if gross[a] * LINK_LOW <= t.amount <= gross[a]
                ],
            )
            for a in order
        ]
    )


def _owned_transaction(db: Session, user_id: int, id: int) -> Transaction:
    tx = None
    if 1 <= id <= MAX_ID:
        tx = db.scalar(
            select(Transaction).where(Transaction.id == id, Transaction.user_id == user_id)
        )
    if tx is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    return tx


@router.post("/actions/{id}/links/{transaction_id}")
def link_payment(id: int, transaction_id: int, user: CurrentUser, db: DbSession) -> ActionResponse:
    """Notes that this credit paid (part of) the dividend. No money moves."""
    action = _owned_dividend(db, user.id, id, applied=True)
    tx = _owned_transaction(db, user.id, transaction_id)
    if tx.type != "income":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Only money received can be linked to a dividend."
        )
    if not _per_account(_Context(db, user.id, [action]), action):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "No shares were held on the record date for this dividend."
        )
    exists = db.scalar(
        select(DividendLink.id).where(
            DividendLink.stock_action_id == action.id, DividendLink.transaction_id == tx.id
        )
    )
    if exists is None:
        db.add(DividendLink(user_id=user.id, stock_action_id=action.id, transaction_id=tx.id))
        db.commit()
    return _one(db, user.id, action)


@router.delete("/actions/{id}/links/{transaction_id}")
def unlink_payment(
    id: int, transaction_id: int, user: CurrentUser, db: DbSession
) -> ActionResponse:
    action = _owned_dividend(db, user.id, id, applied=False)
    link = None
    if 1 <= transaction_id <= MAX_ID:
        link = db.scalar(
            select(DividendLink).where(
                DividendLink.user_id == user.id,
                DividendLink.stock_action_id == action.id,
                DividendLink.transaction_id == transaction_id,
            )
        )
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "That payment isn't linked.")
    db.delete(link)
    db.commit()
    return _one(db, user.id, action)


@router.delete("/stocks/{id}/suspect-drop")
def clear_suspect_drop(id: int, user: CurrentUser, db: DbSession) -> StockActions:
    """Dismisses the "possible missed corporate action" notice."""
    stock = get_owned_stock(db, user.id, id)
    stock.suspect_drop_on = None
    db.commit()
    return _stock_actions(db, user.id, stock)
