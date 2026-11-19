from datetime import date
from decimal import Decimal

from app.api.portfolio import ActionRow, TradeRow, replay, stock_amount

D = Decimal


def t(id, side, d, q, price, charges="0", stock=1, account=1, opening=False):
    p, c = D(str(price)), D(charges)
    amount = stock_amount(side, q, p, c)
    return TradeRow(id, stock, account, side, d, D(q), p, c, opening, amount)


def a(id, kind, ex, new=None, old=None, amt=None, stock=1, target=None, pct=None):
    def dec(v):
        return None if v is None else D(str(v))

    return ActionRow(id, stock, kind, ex, dec(new), dec(old), dec(amt), target, dec(pct))


D1, D2, D3 = date(2026, 1, 1), date(2026, 1, 2), date(2026, 1, 3)


def test_trade_row_basis_date_defaults_to_none():
    assert t(1, "buy", D1, 1, 1).basis_date is None


def test_split_multiplies_quantity_keeps_cost():
    r = replay([t(1, "buy", D1, 40, 1500)], [a(9, "split", D2, new=5, old=1)])
    p = r.positions[(1, 1)]
    assert p.quantity == 200 and p.invested == D("60000.00")
    assert r.touched == {9}


def test_consolidation_divides_quantity():
    r = replay([t(1, "buy", D1, 100, 10)], [a(9, "consolidation", D2, new=1, old=10)])
    p = r.positions[(1, 1)]
    assert p.quantity == 10 and p.invested == D("1000.00")
    assert r.touched == {9}


def test_bonus_adds_zero_cost_lot_and_fifo_sells_it_last():
    sell = t(2, "sell", D3, 10, 150)
    r = replay([t(1, "buy", D1, 10, 100), sell], [a(9, "bonus", D2, new=1, old=1)])
    p = r.positions[(1, 1)]
    assert r.realised_by_sell[sell.id] == D("500.00")  # 1500 - original lot's 1000
    assert p.quantity == 10 and p.invested == D("0.00")
    assert r.touched == {9}


def test_bonus_floors_per_position():
    r = replay([t(1, "buy", D1, 3, 100)], [a(9, "bonus", D2, new=1, old=2)])
    assert r.positions[(1, 1)].quantity == 4
    r = replay(
        [t(1, "buy", D1, 1, 100), t(2, "buy", D1, 1, 100), t(3, "buy", D1, 1, 100)],
        [a(9, "bonus", D2, new=1, old=2)],
    )
    assert r.positions[(1, 1)].quantity == 4  # floor(3/2) = 1, not 3 * floor(1/2) = 0


def test_bonus_too_small_for_one_share_touches_nothing():
    r = replay([t(1, "buy", D1, 1, 100)], [a(9, "bonus", D2, new=1, old=2)])
    assert r.positions[(1, 1)].quantity == 1 and r.touched == set()


def test_trade_on_ex_date_is_not_adjusted():
    r = replay(
        [t(1, "buy", D1, 10, 100), t(2, "buy", D2, 5, 20)], [a(9, "split", D2, new=5, old=1)]
    )
    assert r.positions[(1, 1)].quantity == 55


def test_sell_on_ex_date_sees_adjusted_quantity():
    r = replay(
        [t(1, "buy", D1, 10, 100), t(2, "sell", D2, 50, 20)], [a(9, "split", D2, new=5, old=1)]
    )
    assert r.shortfall is None
    assert r.positions[(1, 1)].quantity == 0
    assert r.realised_by_sell[2] == D("0.00")


def test_lot_with_basis_on_or_after_ex_date_is_untouched():
    opening = t(1, "buy", date(2020, 1, 1), 200, 300, opening=True)._replace(
        basis_date=date(2026, 11, 19)
    )
    r = replay([opening], [a(9, "split", date(2023, 5, 1), new=5, old=1)])
    assert r.positions[(1, 1)].quantity == 200 and 9 not in r.touched


def test_basis_equal_to_ex_date_is_untouched():
    row = t(1, "buy", D1, 10, 100)._replace(basis_date=D2)
    r = replay([row], [a(9, "split", D2, new=2, old=1)])
    assert r.positions[(1, 1)].quantity == 10 and r.touched == set()


def test_only_lots_before_ex_date_are_adjusted_in_a_mixed_position():
    opening = t(1, "buy", D1, 100, 10, opening=True)._replace(basis_date=D3)
    r = replay([opening, t(2, "buy", D1, 10, 100)], [a(9, "split", D2, new=2, old=1)])
    p = r.positions[(1, 1)]
    assert p.quantity == 120 and p.invested == D("2000.00")
    assert r.touched == {9}


def test_bonus_counts_only_eligible_lots():
    opening = t(1, "buy", D1, 100, 10, opening=True)._replace(basis_date=D3)
    r = replay([opening, t(2, "buy", D1, 10, 100)], [a(9, "bonus", D2, new=1, old=1)])
    assert r.positions[(1, 1)].quantity == 120


def test_action_applies_in_every_account():
    r = replay(
        [t(1, "buy", D1, 10, 100, account=1), t(2, "buy", D1, 4, 100, account=2)],
        [a(9, "split", D2, new=2, old=1)],
    )
    assert r.positions[(1, 1)].quantity == 20
    assert r.positions[(1, 2)].quantity == 8
    assert r.touched == {9}


def test_action_ignores_other_instruments():
    r = replay([t(1, "buy", D1, 10, 100, stock=2)], [a(9, "split", D2, new=2, old=1)])
    assert r.positions[(2, 1)].quantity == 10 and r.touched == set()


def test_partial_sell_after_split_keeps_paise_exact():
    # 10 @ 100 + 0.01 charges = 1000.01; split 3:1 -> 30 shares; sell 7.
    r = replay(
        [t(1, "buy", D1, 10, 100, "0.01"), t(2, "sell", D3, 7, 40)],
        [a(9, "split", D2, new=3, old=1)],
    )
    p = r.positions[(1, 1)]
    taken = D("233.34")  # round_paise(1000.01 * 7 / 30) = 233.3356...
    assert r.realised_by_sell[2] == D("280.00") - taken
    assert p.quantity == 23 and p.invested == D("1000.01") - taken


def test_action_after_position_closed_touches_nothing():
    r = replay(
        [t(1, "buy", D1, 10, 100), t(2, "sell", D2, 10, 100)], [a(9, "split", D3, new=2, old=1)]
    )
    assert r.positions[(1, 1)].quantity == 0 and r.touched == set()


def test_unhandled_kinds_are_skipped():
    r = replay(
        [t(1, "buy", D1, 10, 100)],
        [
            a(5, "dividend", D2, amt="2.5"),
            a(6, "merger", D2, new=1, old=1, target=2),
            a(7, "demerger", D2, new=1, old=1, target=2, pct=20),
            a(8, "other", D2),
        ],
    )
    assert r.positions[(1, 1)].quantity == 10 and r.touched == set()
    assert r.dividends == {}


def test_existing_behaviour_without_actions_unchanged():
    r = replay([t(1, "buy", D1, 10, 100), t(2, "sell", D2, 4, 110)])
    p = r.positions[(1, 1)]
    assert p.quantity == 6 and p.invested == D("600.00") and p.realised == D("40.00")
    assert r.dividends == {} and r.touched == set()
