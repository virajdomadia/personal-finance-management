"""Net worth, what is had and owed, and where it is: the dashboard's figures, worked out now.

The dashboard and the net worth snapshots both use `worth_of`, so a snapshot always holds exactly
what the dashboard showed that day.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.api.deposits import DepositRow, deposit_rows
from app.api.loans import Book, load_book
from app.api.portfolio import (
    PortfolioTotals,
    Replay,
    latest_prices,
    load_kinds,
    load_trade_rows,
    replay,
    summarise,
)
from app.api.routes.accounts import totals
from app.models.account import Account

# The dashboard's asset groups, in the order it lists them.
GROUPS = ("bank_cash", "deposits", "stocks", "funds", "crypto")


@dataclass(frozen=True)
class Worth:
    have: Decimal
    owe: Decimal
    split: dict[str, Decimal]  # every group in GROUPS, zero and negative ones included
    # The pieces the dashboard reuses for its other cards.
    book: Book
    result: Replay
    market: PortfolioTotals
    deposits: list[DepositRow]

    @property
    def net_worth(self) -> Decimal:
        return self.have - self.owe


def worth_of(db: Session, user_id: int, active: list[Account], today: date) -> Worth:
    """The figures over `active`, the user's accounts that aren't archived."""
    book = load_book(db, user_id, active)
    have, owe = totals(active, book.flows)
    result = replay(load_trade_rows(db, user_id))
    prices = latest_prices(db, user_id)
    market = summarise(result, prices)
    have += market.value  # deposits are already in `have` as accounts
    deposits = deposit_rows(active, book, today)
    kinds = load_kinds(db, user_id)

    def held(kind: str) -> Decimal:
        ids = {i for i, k in kinds.items() if k == kind}
        return summarise(result, prices, only=ids).value

    deposits_value = sum((r.balance for r in deposits), Decimal(0))
    stocks, funds, crypto = held("stock"), held("mutual_fund"), held("crypto")
    # Whatever isn't a deposit or a market holding is money in bank, cash, wallet and card
    # accounts, so the slices always add up to `have`.
    bank_cash = have - deposits_value - stocks - funds - crypto
    split = {
        "bank_cash": bank_cash,
        "deposits": deposits_value,
        "stocks": stocks,
        "funds": funds,
        "crypto": crypto,
    }
    return Worth(have, owe, split, book, result, market, deposits)
