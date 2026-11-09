from datetime import date
from decimal import Decimal

from app.api.portfolio import TradeRow, replay, stock_amount, trade_cash

D = Decimal


def t(id, side, d, q, price, charges="0", stock=1, account=1, opening=False):
    p, c = D(str(price)), D(charges)
    amount = stock_amount(side, q, p, c)
    return TradeRow(id, stock, account, side, d, D(q), p, c, opening, amount)


D1, D2, D3 = date(2026, 1, 1), date(2026, 1, 2), date(2026, 1, 3)


def test_buys_add_cost_with_charges():
    r = replay([t(1, "buy", D1, 10, 100, "20"), t(2, "buy", D2, 5, 120)])
    p = r.positions[(1, 1)]
    assert p.quantity == 15
    assert p.invested == D("1620.00")


def test_sell_takes_oldest_lot_first():
    sell = t(3, "sell", D3, 12, 130, "10")
    r = replay([t(1, "buy", D1, 10, 100), t(2, "buy", D2, 5, 120), sell])
    p = r.positions[(1, 1)]
    assert p.quantity == 3
    assert p.invested == D("360.00")
    assert p.realised == D("310.00")
    assert r.realised_by_sell[sell.id] == D("310.00")
    assert r.shortfall is None


def test_partial_lot_rounding_remainder_stays():
    r = replay([t(1, "buy", D1, 3, 10, "0.01"), t(2, "sell", D2, 1, 10)])
    p = r.positions[(1, 1)]
    assert p.invested == D("20.01")
    assert r.realised_by_sell[2] == D("0.00")  # 10.00 proceeds - 10.00 cost


def test_same_day_buy_before_sell():
    r = replay([t(1, "sell", D1, 5, 100), t(2, "buy", D1, 5, 100)])
    assert r.shortfall is None
    assert r.positions[(1, 1)].quantity == 0


def test_shortfall_reports_first_short_sell():
    r = replay([t(1, "buy", D1, 5, 100), t(2, "sell", D2, 3, 100), t(3, "sell", D3, 3, 100)])
    assert r.shortfall is not None
    assert r.shortfall.id == 3


def test_positions_are_per_broker():
    r = replay([t(1, "buy", D1, 5, 100, account=1), t(2, "buy", D1, 5, 100, account=2)])
    assert set(r.positions) == {(1, 1), (1, 2)}


def test_sell_all_then_buy_again():
    r = replay([t(1, "buy", D1, 10, 100), t(2, "sell", D2, 10, 110), t(3, "buy", D3, 2, 90)])
    p = r.positions[(1, 1)]
    assert p.quantity == 2
    assert p.invested == D("180.00")
    assert p.realised == D("100.00")
    assert p.sold_any is True


def test_trade_cash():
    assert trade_cash(t(1, "buy", D1, 2, 100, "5")) == D("-205.00")
    assert trade_cash(t(2, "sell", D1, 2, 100, "5")) == D("195.00")
    assert trade_cash(t(3, "buy", D1, 2, 100, "5", opening=True)) == 0
