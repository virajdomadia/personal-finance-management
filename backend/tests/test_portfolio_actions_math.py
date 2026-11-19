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


def test_unhandled_kinds_and_incomplete_actions_are_skipped():
    r = replay(
        [t(1, "buy", D1, 10, 100)],
        [
            a(5, "dividend", D2),
            a(6, "merger", D2, new=1, old=1),
            a(7, "demerger", D2, new=1, old=1, target=2),
            a(4, "demerger", D2, new=1, old=1, pct=20),
            a(8, "other", D2),
        ],
    )
    assert r.positions[(1, 1)].quantity == 10 and r.touched == set()
    assert r.dividends == {} and set(r.positions) == {(1, 1)}


def test_merger_moves_lots_to_target_keeping_cost_and_dates():
    # 10 @100 (D1) + 5 @120 (D2) of stock 1, merger 7:5 into stock 2 on D3
    r = replay(
        [t(1, "buy", D1, 10, 100), t(2, "buy", D2, 5, 120)],
        [a(9, "merger", D3, new=7, old=5, target=2)],
    )
    src, dst = r.positions[(1, 1)], r.positions[(2, 1)]
    assert src.quantity == 0 and src.invested == D("0.00")
    assert dst.quantity == 21 and dst.invested == D("1600.00")  # floor(15 * 7 / 5) = 21
    assert r.touched == {9}


def test_merger_fifo_on_target_follows_original_lot_order():
    # Target already holds a lot bought on D2; moved lots from D1 sell first, D3's after.
    d4, d5 = date(2026, 1, 4), date(2026, 1, 5)
    r = replay(
        [
            t(1, "buy", D1, 10, 100),
            t(2, "buy", D2, 10, 500, stock=2),
            t(3, "buy", D3, 10, 120),
            t(4, "sell", d5, 15, 200, stock=2),
        ],
        [a(9, "merger", d4, new=1, old=1, target=2)],
    )
    # Sell 15: whole moved lot D1 (cost 1000) + 5 of the target's lot D2 (5000 * 5/10 = 2500)
    assert r.realised_by_sell[4] == D("3000.00") - D("1000.00") - D("2500.00")
    dst = r.positions[(2, 1)]
    assert dst.quantity == 15 and dst.invested == D("2500.00") + D("1200.00")


def test_merger_fraction_removed_from_newest_lot():
    # 3 + 3 at 1:2 -> 1.5 + 1.5 = 3 exactly: nothing lost
    r = replay(
        [t(1, "buy", D1, 3, 100), t(2, "buy", D1, 3, 100)],
        [a(9, "merger", D2, new=1, old=2, target=2)],
    )
    assert r.positions[(2, 1)].quantity == 3 and r.positions[(2, 1)].invested == D("600.00")
    # 3 + 2 at 1:2 -> 1.5 + 1 = 2.5 -> 2; newest lot loses 0.5, cost unchanged
    sell = t(3, "sell", D3, D("1.5"), 100, stock=2)
    r = replay(
        [t(1, "buy", D1, 3, 100), t(2, "buy", D1, 2, 100), sell],
        [a(9, "merger", D2, new=1, old=2, target=2)],
    )
    dst = r.positions[(2, 1)]
    # Oldest lot (1.5 shares, 300) sells whole, so the newest lot was the one trimmed to 0.5.
    assert r.realised_by_sell[3] == D("150.00") - D("300.00")
    assert dst.quantity == D("0.5") and dst.invested == D("200.00")


def test_merger_per_account_and_lots_after_ex_date_stay():
    opening = t(3, "buy", D1, 7, 10, opening=True, account=1)._replace(basis_date=D3)
    r = replay(
        [t(1, "buy", D1, 10, 100, account=1), t(2, "buy", D1, 3, 100, account=2), opening],
        [a(9, "merger", D2, new=1, old=2, target=2)],
    )
    assert r.positions[(2, 1)].quantity == 5 and r.positions[(2, 2)].quantity == 1
    assert r.positions[(1, 1)].quantity == 7 and r.positions[(1, 1)].invested == D("70.00")
    assert r.positions[(1, 2)].quantity == 0 and r.positions[(1, 2)].invested == D("0.00")


def test_merger_fraction_larger_than_newest_lot_trims_older_and_keeps_cost():
    # Split 3:2 gives a lot of 1.5; with a 0.4 lot, 1:1 merger total 1.9 -> 1.
    r = replay(
        [t(1, "buy", D1, 1, 100), t(2, "buy", D2, D("0.4"), 100)],
        [a(8, "split", D2, new=3, old=2), a(9, "merger", D3, new=1, old=1, target=2)],
    )
    dst = r.positions[(2, 1)]
    assert dst.quantity == 1 and dst.invested == D("140.00")


THREE_TENS = [t(1, "buy", D1, 10, 100), t(2, "buy", D1, 10, 100), t(3, "buy", D1, 10, 100)]


def _exact(q):
    return q.as_tuple().exponent >= -8


def test_merger_uneven_ratio_keeps_every_whole_share():
    r = replay(THREE_TENS, [a(9, "merger", D2, new=1, old=3, target=2)])
    q = r.positions[(2, 1)].quantity
    assert q == 10 and _exact(q)
    assert r.positions[(2, 1)].invested == D("3000.00")


def test_demerger_uneven_ratio_keeps_every_whole_share():
    r = replay(THREE_TENS, [a(9, "demerger", D2, new=1, old=3, target=2, pct=10)])
    q = r.positions[(2, 1)].quantity
    assert q == 10 and _exact(q)
    assert r.positions[(1, 1)].quantity == 30


def test_uneven_consolidation_totals_exactly():
    sell = t(4, "sell", D3, 10, 300)
    r = replay(THREE_TENS, [a(9, "consolidation", D2, new=1, old=3)])
    q = r.positions[(1, 1)].quantity
    assert q == 10 and _exact(q)
    r = replay([*THREE_TENS, sell], [a(9, "consolidation", D2, new=1, old=3)])
    assert r.shortfall is None and r.positions[(1, 1)].quantity == 0
    assert r.positions[(1, 1)].invested == D("0.00") and r.realised_by_sell[4] == D("0.00")


def test_merger_flooring_to_nothing_keeps_cost_on_target():
    r = replay([t(1, "buy", D1, 1, 100)], [a(9, "merger", D2, new=1, old=2, target=2)])
    assert r.positions[(1, 1)].quantity == 0 and r.positions[(1, 1)].invested == D("0.00")
    assert r.positions[(2, 1)].quantity == 0 and r.positions[(2, 1)].invested == D("100.00")
    assert r.touched == {9}


def test_demerger_giving_no_whole_share_changes_nothing():
    r = replay([t(1, "buy", D1, 1, 100)], [a(9, "demerger", D2, new=1, old=2, target=2, pct=10)])
    assert r.positions[(1, 1)].invested == D("100.00") and (2, 1) not in r.positions
    assert r.touched == set()


def test_demerger_splits_cost_by_pct():
    r = replay(
        [t(1, "buy", D1, 10, 100)], [a(9, "demerger", D2, new=1, old=1, target=2, pct="6.5")]
    )
    parent, child = r.positions[(1, 1)], r.positions[(2, 1)]
    assert parent.quantity == 10 and parent.invested == D("935.00")
    assert child.quantity == 10 and child.invested == D("65.00")
    assert r.touched == {9}


def test_demerger_cost_rounding_never_loses_paise():
    r = replay(
        [t(1, "buy", D1, 3, 100, "0.01"), t(2, "buy", D1, 7, D("33.33"), "0.02")],
        [a(9, "demerger", D2, new=1, old=3, target=2, pct="33.33")],
    )
    parent, child = r.positions[(1, 1)], r.positions[(2, 1)]
    total = D("300.01") + D("233.33")
    # Each lot: round_paise(cost * 33.33%): 300.01 -> 99.99, 233.33 -> 77.77
    assert child.invested == D("99.99") + D("77.77")
    assert parent.invested + child.invested == total
    assert child.quantity == 3  # 1 + 7/3 = 3.333.. -> 3
    assert parent.quantity == 10


def test_demerger_child_sells_from_original_lot():
    r = replay(
        [t(1, "buy", D1, 10, 100), t(2, "sell", D3, 10, 20, stock=2)],
        [a(9, "demerger", D2, new=1, old=1, target=2, pct=10)],
    )
    assert r.realised_by_sell[2] == D("200.00") - D("100.00")
    assert r.positions[(2, 1)].quantity == 0


def test_dividend_entitlement_is_eve_of_ex_date_per_account():
    amt = D("2.5")
    r = replay(
        [
            t(1, "buy", D1, 10, 100, account=1),
            t(2, "buy", D1, 5, 100, account=2),
            t(3, "buy", D2, 5, 100, account=1),
        ],
        [a(9, "dividend", D2, amt=amt)],
    )
    assert r.dividends == {(9, 1): 10 * amt, (9, 2): 5 * amt}


def test_dividend_rounds_to_paise_and_skips_empty_accounts():
    r = replay(
        [
            t(1, "buy", D1, 3, 100, account=1),
            t(2, "buy", D1, 3, 100, account=2),
            t(3, "sell", D1, 3, 100, account=2),
        ],
        [a(9, "dividend", D2, amt="0.335")],
    )
    assert r.dividends == {(9, 1): D("1.01")}  # 1.005 rounds half up


def test_dividend_ignores_lots_with_basis_on_or_after_ex_date():
    opening = t(1, "buy", D1, 100, 10, opening=True)._replace(basis_date=D2)
    r = replay([opening, t(2, "buy", D1, 4, 10)], [a(9, "dividend", D2, amt=1)])
    assert r.dividends == {(9, 1): D("4.00")}
    r = replay([opening], [a(9, "dividend", D2, amt=1)])
    assert r.dividends == {}


def test_dividend_not_in_touched():
    r = replay([t(1, "buy", D1, 10, 100)], [a(9, "dividend", D2, amt=1)])
    assert r.dividends == {(9, 1): D("10.00")} and r.touched == set()
    assert r.positions[(1, 1)].quantity == 10 and r.positions[(1, 1)].invested == D("1000.00")


def test_existing_behaviour_without_actions_unchanged():
    r = replay([t(1, "buy", D1, 10, 100), t(2, "sell", D2, 4, 110)])
    p = r.positions[(1, 1)]
    assert p.quantity == 6 and p.invested == D("600.00") and p.realised == D("40.00")
    assert r.dividends == {} and r.touched == set()
