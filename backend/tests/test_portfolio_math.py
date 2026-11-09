from datetime import date
from decimal import Decimal

from app.api.portfolio import (
    TradeRow,
    fmt_nav,
    fmt_units,
    holding_value,
    replay,
    round_paise,
    stamp_duty,
    stock_amount,
    summarise,
    trade_cash,
)

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


def fund(id, side, d, units, nav, amount, charges="0", fund_id=2, account=1):
    return TradeRow(
        id, fund_id, account, side, d, D(units), D(nav), D(charges), False, D(amount)
    )


def test_fund_buy_cost_is_amount():
    r = replay([fund(1, "buy", D1, "35.552", "84.3793", "3000.00", "0.15")])
    p = r.positions[(2, 1)]
    assert p.invested == D("3000.00")
    assert p.quantity == D("35.552")


def _two_buys_and_sell():
    return [
        fund(1, "buy", D1, "35.552", "84.3793", "3000.00"),
        fund(2, "buy", D2, "35.549", "84.4000", "3000.00"),
        fund(3, "sell", D3, "50.000", "86.0000", "4300.00"),
    ]


def test_fractional_partial_redemption():
    r = replay(_two_buys_and_sell())
    p = r.positions[(2, 1)]
    cost = D("3000.00") + round_paise(D("3000.00") * D("14.448") / D("35.549"))
    assert cost == D("4219.27")
    assert r.realised_by_sell[3] == D("80.73")
    assert p.realised == D("80.73")
    assert p.quantity == D("21.101")
    assert p.invested == D("6000.00") - D("4219.27")


def test_redeeming_everything_closes_the_position():
    rows = _two_buys_and_sell() + [fund(4, "sell", date(2026, 1, 4), "21.101", "86", "1900.00")]
    p = replay(rows).positions[(2, 1)]
    assert p.quantity == D("0.000")
    assert p.invested == D("0.00")


def test_fund_value():
    assert holding_value(D("253.462"), D("20000.00"), D("84.3793")) == D("21386.95")


def test_summarise_only():
    rows = [t(1, "buy", D1, 10, 100), fund(2, "buy", D1, "10.000", "50", "500.00")]
    r = replay(rows)
    prices = {1: (D1, D("110")), 2: (D1, D("60"))}
    only = summarise(r, prices, only={2})
    assert (only.invested, only.value, only.unrealised) == (D("500.00"), D("600.00"), D("100.00"))
    both = summarise(r, prices)
    assert both.invested == D("1500.00")


def test_formatters_and_stamp_duty():
    assert stamp_duty(D("3000")) == D("0.15")
    assert stamp_duty(D("2000")) == D("0.10")
    assert fmt_units(D("21.984")) == "21.984"
    assert fmt_nav(D("635.0943")) == "635.0943"
    assert fmt_units(D("1.0005")) == "1.001"
    assert fmt_units(D("2.5")) == "2.500"
    assert fmt_nav(D("1.00005")) == "1.0001"
