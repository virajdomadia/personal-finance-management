"""The nightly corporate-actions step: fetch, store once, match to holders, backfill history."""

import json
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.main import app
from app.models.account import Account
from app.models.corporate_action import CorporateAction, StockAction
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade
from app.models.market import MarketCode
from app.models.user import User
from app.prices.actions_refresh import flag_suspect_drops, follow_renames, refresh_actions
from app.prices.fetch import SourceTimeout
from app.prices.refresh import RefreshReport, refresh_market, run_nightly
from tests.price_fakes import STOCK_CLOSE, STOCK_CODE, FakeFetcher
from tests.test_accounts import Headers, auth

client = TestClient(app)
TODAY = date(2026, 11, 19)
SPLIT = "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share"
INFY_ISIN = "INE009A01021"


def nse_row(subject: str, ex: str, symbol: str = "INFY") -> dict:
    return {"symbol": symbol, "isin": INFY_ISIN, "exDate": ex, "recDate": ex, "subject": subject}


def bse_row(purpose: str, ex: str, isin: str = INFY_ISIN) -> dict:
    return {"scrip_code": "500209", "ISIN": isin, "Ex_date": ex, "Purpose": purpose}


def fake(nse: list[dict] | None = None, bse: list[dict] | None = None, **kw: object) -> FakeFetcher:
    texts = {"nse_actions.json": json.dumps(nse or []), "bse_actions.json": json.dumps(bse or [])}
    return FakeFetcher(texts=texts, **kw)  # type: ignore[arg-type]


class Holder:
    def __init__(self, db: Session, email: str = "a@example.com", code: str = "INFY") -> None:
        self.db = db
        user = User(email=email)
        db.add(user)
        db.flush()
        self.user_id = user.id
        broker = Account(user_id=user.id, type="broker", name="Zerodha", opening_balance=0)
        self.stock = Instrument(
            user_id=user.id, kind="stock", symbol=code, name=code, source_code=code
        )
        db.add_all([broker, self.stock])
        db.commit()
        self.broker_id = broker.id

    def trade(
        self,
        day: date,
        qty: str = "10",
        side: str = "buy",
        opening: bool = False,
        basis: date | None = None,
    ) -> None:
        self.db.add(
            InvestmentTrade(
                user_id=self.user_id,
                instrument_id=self.stock.id,
                account_id=self.broker_id,
                side=side,
                date=day,
                quantity=Decimal(qty),
                price=Decimal("100"),
                charges=Decimal("0"),
                amount=Decimal(qty) * 100,
                opening=opening,
                basis_date=basis or day,
            )
        )
        self.db.commit()

    def rows(self) -> list[StockAction]:
        return list(
            self.db.scalars(
                select(StockAction)
                .where(StockAction.instrument_id == self.stock.id)
                .order_by(StockAction.id)
            )
        )


def run(db: Session, fetcher: FakeFetcher, clock=None) -> RefreshReport:  # noqa: ANN001
    report = RefreshReport()
    if clock is None:
        refresh_actions(db, fetcher, TODAY, report)
    else:
        refresh_actions(db, fetcher, TODAY, report, clock=clock)
    db.commit()
    return report


def done(h: Holder) -> None:
    """Mark the holding's history as fetched, so a test sees only the window fetch."""
    h.stock.actions_backfilled_at = datetime(2026, 11, 1, tzinfo=UTC)
    h.db.commit()


def count(db: Session, model: type) -> int:
    return db.scalar(select(func.count()).select_from(model)) or 0


def test_split_for_held_stock_creates_pending_row(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)

    report = run(db_session, fake(nse=[nse_row(SPLIT, "15-Nov-2026")]))

    [row] = h.rows()
    assert (row.kind, row.status, row.ex_date) == ("split", "pending", date(2026, 11, 15))
    assert (row.ratio_new, row.ratio_old) == (Decimal("10"), Decimal("1"))
    assert row.user_id == h.user_id and row.corporate_action_id is not None
    assert report.updated["actions"] == 1 and "actions" not in report.failed


def test_split_for_opening_lot_entered_after_ex_date_is_silently_dismissed(
    db_session: Session,
) -> None:
    h = Holder(db_session)
    # Copied from the broker app on the 18th: already split, though dated 2020.
    h.trade(date(2020, 1, 1), opening=True, basis=date(2026, 11, 18))
    done(h)

    run(db_session, fake(nse=[nse_row(SPLIT, "15-Nov-2026")]))

    [row] = h.rows()
    assert (row.kind, row.status) == ("split", "dismissed")


def test_dividend_for_held_stock_is_applied(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)

    run(db_session, fake(nse=[nse_row("Interim Dividend - Rs 2.50 Per Share", "14-Nov-2026")]))

    [row] = h.rows()
    assert (row.kind, row.status, row.amount_per_share) == ("dividend", "applied", Decimal("2.5"))


def test_upcoming_actions_match_current_holders(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)

    run(db_session, fake(nse=[nse_row("Bonus 1:1", "20-Dec-2026")]))

    [row] = h.rows()
    assert (row.kind, row.status, row.ex_date) == ("bonus", "pending", date(2026, 12, 20))


def test_not_held_stock_gets_no_row(db_session: Session) -> None:
    sold = Holder(db_session)
    sold.trade(date(2026, 1, 5))
    sold.trade(date(2026, 11, 10), side="sell")  # all gone before the ex-date
    done(sold)
    later = Holder(db_session, "b@example.com")
    later.trade(date(2026, 11, 16))  # bought after the ex-date
    done(later)
    other = Holder(db_session, "c@example.com", code="TCS")  # holds a different stock
    other.trade(date(2026, 1, 5))
    done(other)

    report = run(
        db_session,
        fake(
            nse=[
                nse_row(SPLIT, "15-Nov-2026"),
                nse_row("Interim Dividend - Rs 2.50 Per Share", "14-Nov-2026"),
            ]
        ),
    )

    assert sold.rows() == [] and later.rows() == [] and other.rows() == []
    assert report.updated["actions"] == 0
    assert count(db_session, CorporateAction) == 2  # still stored: it's the shared feed


def test_running_twice_creates_no_duplicates(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    rows = [nse_row(SPLIT, "15-Nov-2026"), nse_row("Interim Dividend - Rs 2.50", "14-Nov-2026")]

    run(db_session, fake(nse=rows))
    report = run(db_session, fake(nse=rows))

    assert count(db_session, CorporateAction) == 2
    assert len(h.rows()) == 2
    assert report.updated["actions"] == 0


def test_same_event_from_nse_and_bse_stored_once(db_session: Session) -> None:
    db_session.add(MarketCode(kind="stock", code="INFY", name="Infosys", isin=INFY_ISIN))
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    nse = [
        nse_row("Bonus 1:1", "15-Nov-2026"),
        nse_row("Interim Dividend - Rs 2.50", "14-Nov-2026"),
    ]
    bse = [bse_row("Bonus issue 1:1", "15 Nov 2026"), bse_row("Dividend - Rs. 2.50", "14 Nov 2026")]

    run(db_session, fake(nse=nse, bse=bse, fail={"nse_actions"}))  # BSE first
    run(db_session, fake(nse=nse, bse=bse))  # then NSE
    run(db_session, fake(nse=nse, bse=bse, fail={"nse_actions"}))  # and BSE again

    assert count(db_session, CorporateAction) == 2
    assert sorted(r.kind for r in h.rows()) == ["bonus", "dividend"]


def test_nse_and_bse_dividends_of_different_amounts_are_different_events(
    db_session: Session,
) -> None:
    db_session.add(MarketCode(kind="stock", code="INFY", name="Infosys", isin=INFY_ISIN))
    db_session.commit()

    run(db_session, fake(nse=[nse_row("Interim Dividend - Rs 2.50", "14-Nov-2026")]))
    run(
        db_session,
        fake(bse=[bse_row("Special Dividend - Rs. 9.00", "14 Nov 2026")], fail={"nse_actions"}),
    )

    assert count(db_session, CorporateAction) == 2


def test_dismissed_row_not_reopened(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    fetcher_rows = [nse_row(SPLIT, "15-Nov-2026")]
    run(db_session, fake(nse=fetcher_rows))
    [row] = h.rows()
    row.status = "dismissed"
    db_session.commit()

    run(db_session, fake(nse=fetcher_rows))

    assert [(r.id, r.status) for r in h.rows()] == [(row.id, "dismissed")]


def test_restored_row_without_feed_link_is_not_duplicated(db_session: Session) -> None:
    # A restored backup brings stock_actions back with no corporate_action_id.
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    restored = StockAction(
        user_id=h.user_id,
        instrument_id=h.stock.id,
        corporate_action_id=None,
        kind="split",
        ex_date=date(2026, 11, 15),
        ratio_new=Decimal("10"),
        ratio_old=Decimal("1"),
        status="dismissed",
    )
    db_session.add(restored)
    db_session.commit()

    report = run(db_session, fake(nse=[nse_row(SPLIT, "15-Nov-2026")]))

    assert [(r.id, r.status) for r in h.rows()] == [(restored.id, "dismissed")]
    assert report.updated["actions"] == 0


def test_nse_down_falls_back_to_bse(db_session: Session) -> None:
    db_session.add(MarketCode(kind="stock", code="INFY", name="Infosys", isin=INFY_ISIN))
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    fetcher = fake(bse=[bse_row("Bonus issue 1:1", "15 Nov 2026")], fail={"nse_actions"})

    report = run(db_session, fetcher)

    assert fetcher.calls["bse_actions"] == 1
    [row] = h.rows()
    assert (row.kind, row.status) == ("bonus", "pending")
    assert report.updated["actions"] == 1 and "actions" not in report.failed
    stored = db_session.scalar(select(CorporateAction))
    assert stored is not None and stored.source == "bse"


def test_both_down_reports_failure_and_prices_still_saved(db_session: Session) -> None:
    h = Holder(db_session, code=STOCK_CODE)
    h.trade(date(2026, 1, 5))

    report = run_nightly(db_session, fake(fail={"nse_actions", "bse_actions"}), TODAY)
    db_session.rollback()  # anything not committed is gone

    assert "nse_actions is down" in report.failed["actions"]
    assert "bse_actions is down" in report.failed["actions"]
    assert report.updated["stock"] >= 1
    prices = db_session.scalars(
        select(InstrumentPrice.price).where(InstrumentPrice.instrument_id == h.stock.id)
    ).all()
    assert prices == [STOCK_CLOSE]
    assert h.rows() == []


def test_a_crash_in_the_actions_step_never_raises_out_of_the_nightly_job(
    db_session: Session,
) -> None:
    h = Holder(db_session, code=STOCK_CODE)
    h.trade(date(2026, 1, 5))

    report = run_nightly(db_session, fake(crash={"nse_actions"}), TODAY)

    assert report.failed["actions"] == "unexpected RuntimeError"
    assert report.updated["stock"] >= 1


def test_nightly_runs_actions_after_prices(db_session: Session) -> None:
    h = Holder(db_session, code=STOCK_CODE)
    h.trade(date(2026, 1, 5))
    done(h)
    split = [nse_row(SPLIT, "15-Nov-2026", symbol=STOCK_CODE)]

    report = run_nightly(db_session, fake(nse=split), TODAY)

    assert report.updated["actions"] == 1 and "actions" not in report.failed
    assert list(report.updated)[-1] == "actions"
    assert [r.status for r in h.rows()] == ["pending"]


class Clocked(FakeFetcher):
    """An empty window; each per-symbol (backfill) call takes ten seconds of the clock."""

    def __init__(self, nse: list[dict], **kw: object) -> None:
        super().__init__(texts={"nse_actions.json": json.dumps(nse)}, **kw)  # type: ignore[arg-type]
        self.now = 0.0
        self.asked: list[tuple[date, date, str | None]] = []

    def nse_actions(self, start: date, end: date, symbol: str | None = None) -> list:
        self.asked.append((start, end, symbol))
        if symbol is None:
            self._hit("nse_actions")
            return []  # nothing in this week's window; the history comes per symbol
        self.now += 10
        return super().nse_actions(start, end, symbol)


def test_backfill_respects_budget_and_resumes_next_night(db_session: Session) -> None:
    holders = [Holder(db_session, f"{c}@example.com", code=c) for c in ("INFY", "TCS", "WIPRO")]
    for i, h in enumerate(holders):
        h.trade(date(2023, 1, 2 + i))
    old = [nse_row(SPLIT, "10-Jun-2024", symbol=c) for c in ("INFY", "TCS", "WIPRO")]
    fetcher = Clocked(old)

    report = run(db_session, fetcher, clock=lambda: fetcher.now)

    # 0 s: INFY, 10 s: TCS, then 20 s is past the 15 s budget.
    assert [a[2] for a in fetcher.asked] == [None, "INFY", "TCS"]
    assert fetcher.asked[1] == (date(2023, 1, 2), TODAY, "INFY")
    assert [h.stock.actions_backfilled_at is not None for h in holders] == [True, True, False]
    assert [len(h.rows()) for h in holders] == [1, 1, 0]
    assert holders[0].rows()[0].status == "pending"  # a past split arrives for review
    assert report.updated["actions"] == 2

    fetcher.asked.clear()
    run(db_session, fetcher, clock=lambda: fetcher.now)

    assert [a[2] for a in fetcher.asked] == [None, "WIPRO"]
    assert all(h.stock.actions_backfilled_at is not None for h in holders)
    assert [len(h.rows()) for h in holders] == [1, 1, 1]


def test_backfill_failure_leaves_it_queued(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2023, 1, 2))

    class Flaky(FakeFetcher):
        def nse_actions(self, start: date, end: date, symbol: str | None = None) -> list:
            if symbol is not None:
                self._hit("nse_backfill")
                raise SourceTimeout("request timed out")
            return super().nse_actions(start, end, symbol)

    report = run(db_session, Flaky(texts={"nse_actions.json": "[]"}))

    assert h.stock.actions_backfilled_at is None
    assert "INFY" in report.failed["actions"]


def test_backfill_skips_stocks_without_trades(db_session: Session) -> None:
    h = Holder(db_session)
    fetcher = fake()

    run(db_session, fetcher)

    assert fetcher.calls["nse_actions"] == 1  # the window only
    assert h.stock.actions_backfilled_at is None  # its first trade will queue the fetch


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def test_linking_a_stock_queues_backfill(db_session: Session, headers: Headers) -> None:
    refresh_market(db_session, FakeFetcher(), TODAY, kinds={"stock"})
    db_session.commit()
    url = "/api/investments/stocks"
    created = client.post(url, json={"symbol": "RELI", "name": "Reliance"}, headers=headers)
    stock_id = created.json()["id"]

    def backfilled_at() -> datetime | None:
        db_session.expire_all()
        stock = db_session.get(Instrument, stock_id)
        assert stock is not None
        return stock.actions_backfilled_at

    def mark() -> None:
        stock = db_session.get(Instrument, stock_id)
        assert stock is not None
        stock.actions_backfilled_at = datetime(2026, 11, 1, tzinfo=UTC)
        db_session.commit()

    linked = client.patch(f"{url}/{stock_id}", json={"source_code": "RELIANCE"}, headers=headers)
    assert linked.status_code == 200 and backfilled_at() is None
    mark()

    renamed = client.patch(f"{url}/{stock_id}", json={"name": "Reliance Ind"}, headers=headers)
    assert renamed.status_code == 200 and backfilled_at() is not None  # no relink, no refetch
    same = client.patch(f"{url}/{stock_id}", json={"source_code": "RELIANCE"}, headers=headers)
    assert same.status_code == 200 and backfilled_at() is not None

    moved = client.patch(f"{url}/{stock_id}", json={"source_code": "TCS"}, headers=headers)
    assert moved.status_code == 200 and backfilled_at() is None


INTERIM = "Interim Dividend - Rs 2.50 Per Share"
SPECIAL = "Special Dividend - Rs 2.50 Per Share"  # same amount, a different event


def restored_dividend(h: Holder, amount: str) -> StockAction:
    row = StockAction(
        user_id=h.user_id,
        instrument_id=h.stock.id,
        corporate_action_id=None,
        kind="dividend",
        ex_date=date(2026, 11, 14),
        amount_per_share=Decimal(amount),
        status="applied",
    )
    h.db.add(row)
    h.db.commit()
    return row


def test_two_same_day_dividends_are_two_rows(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    rows = [nse_row(INTERIM, "14-Nov-2026"), nse_row(SPECIAL, "14-Nov-2026")]

    report = run(db_session, fake(nse=rows))
    run(db_session, fake(nse=rows))

    first, second = h.rows()
    assert first.corporate_action_id != second.corporate_action_id
    assert {(r.kind, r.amount_per_share, r.status) for r in h.rows()} == {
        ("dividend", Decimal("2.5"), "applied")
    }
    assert report.updated["actions"] == 2


def test_two_dividends_in_one_notice_are_two_events(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    both = "Interim Dividend - Rs 2 Per Share / Special Dividend - Rs 3 Per Share"
    rows = [nse_row(both, "14-Nov-2026")]

    report = run(db_session, fake(nse=rows))
    again = run(db_session, fake(nse=rows))

    stored = db_session.scalars(select(CorporateAction).order_by(CorporateAction.id)).all()
    assert [(c.kind, c.amount_per_share, c.purpose) for c in stored] == [
        ("dividend", Decimal("2"), both),
        ("dividend", Decimal("3"), both),
    ]
    assert sorted((r.amount_per_share, r.status) for r in h.rows()) == [
        (Decimal("2"), "applied"),
        (Decimal("3"), "applied"),
    ]
    assert report.updated["actions"] == 2 and again.updated["actions"] == 0


def test_restored_dividend_with_the_same_amount_is_not_duplicated(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    restored = restored_dividend(h, "2.50")

    report = run(db_session, fake(nse=[nse_row(INTERIM, "14-Nov-2026")]))

    assert [r.id for r in h.rows()] == [restored.id]
    assert report.updated["actions"] == 0


def test_restored_dividend_with_another_amount_lets_the_new_one_in(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    done(h)
    restored = restored_dividend(h, "9.00")

    report = run(db_session, fake(nse=[nse_row(INTERIM, "14-Nov-2026")]))

    [old, new] = h.rows()
    assert old.id == restored.id
    assert (new.amount_per_share, new.corporate_action_id is not None) == (Decimal("2.5"), True)
    assert report.updated["actions"] == 1


# Renames and suspect drops.
def listing(db: Session, code: str, isin: str | None = INFY_ISIN) -> None:
    db.add(MarketCode(kind="stock", code=code, name=code, isin=isin))
    db.commit()


def test_rename_follows_isin_to_new_symbol(db_session: Session) -> None:
    h = Holder(db_session, code="OLDSYM")
    listing(db_session, "OLDSYM")
    listing(db_session, "NEWSYM")
    # Old rows linger after a rename: only tonight's list says OLDSYM is gone.
    assert follow_renames(db_session, {"NEWSYM"}) == 1
    db_session.refresh(h.stock)
    assert (h.stock.source_code, h.stock.symbol) == ("NEWSYM", "OLDSYM")


def test_rename_without_listing_info_needs_old_code_gone(db_session: Session) -> None:
    h = Holder(db_session, code="OLDSYM")
    listing(db_session, "NEWSYM")
    h.db.add(
        CorporateAction(
            symbol="OLDSYM",
            isin=INFY_ISIN,
            kind="split",
            ex_date=TODAY,
            purpose="x",
            purpose_key="x",
            source="nse",
        )
    )
    h.db.commit()
    assert follow_renames(db_session) == 1
    db_session.refresh(h.stock)
    assert h.stock.source_code == "NEWSYM"


def test_no_rename_while_old_symbol_is_listed_or_isin_unknown(db_session: Session) -> None:
    h = Holder(db_session, code="OLDSYM")
    listing(db_session, "OLDSYM")
    listing(db_session, "NEWSYM")
    assert follow_renames(db_session, {"OLDSYM", "NEWSYM"}) == 0
    assert follow_renames(db_session) == 0
    db_session.refresh(h.stock)
    assert h.stock.source_code == "OLDSYM"


def priced(h: Holder, prev: str, last: str, day: date = TODAY) -> None:
    for d, p in ((date(2026, 11, 17), prev), (day, last)):
        h.db.add(
            InstrumentPrice(
                user_id=h.user_id, instrument_id=h.stock.id, date=d, price=Decimal(p), source="auto"
            )
        )
    h.db.commit()


def test_forty_percent_drop_on_held_stock_is_flagged(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    priced(h, "1000", "600")
    assert flag_suspect_drops(db_session, TODAY) == 1
    db_session.refresh(h.stock)
    assert h.stock.suspect_drop_on == TODAY


def test_thirty_percent_drop_is_not_flagged(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    priced(h, "1000", "700")
    assert flag_suspect_drops(db_session, TODAY) == 0


def test_drop_of_a_stock_no_longer_held_is_not_flagged(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    h.trade(date(2026, 11, 10), side="sell")
    priced(h, "1000", "600")
    assert flag_suspect_drops(db_session, TODAY) == 0


def test_drop_with_known_split_nearby_is_not_flagged_and_flag_clears(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    priced(h, "1000", "600")
    h.db.add(
        StockAction(
            user_id=h.user_id,
            instrument_id=h.stock.id,
            kind="split",
            ex_date=date(2026, 11, 17),
            status="pending",
        )
    )
    h.db.commit()
    assert flag_suspect_drops(db_session, TODAY) == 0
    h.stock.suspect_drop_on = TODAY
    h.db.commit()
    flag_suspect_drops(db_session, TODAY)
    db_session.refresh(h.stock)
    assert h.stock.suspect_drop_on is None


def test_dismissed_action_does_not_count_as_known(db_session: Session) -> None:
    h = Holder(db_session)
    h.trade(date(2026, 1, 5))
    priced(h, "1000", "600")
    h.db.add(
        StockAction(
            user_id=h.user_id,
            instrument_id=h.stock.id,
            kind="split",
            ex_date=TODAY,
            status="dismissed",
        )
    )
    h.db.commit()
    assert flag_suspect_drops(db_session, TODAY) == 1
