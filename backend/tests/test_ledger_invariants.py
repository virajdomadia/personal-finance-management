"""Invariants of the transaction engine, checked against a reference model.

The model tracks what each account is worth to the user: an asset's balance, or minus what a
card owes. Income adds to it, an expense takes from it, a transfer moves it, and net worth is the
sum. That is deliberately simpler than the engine's own bookkeeping, so the two can't share a bug.
"""

import random
from decimal import Decimal

from tests.test_accounts import Headers
from tests.test_transactions import URL, account, client, expense, headers, income, transfer

__all__ = ["headers"]  # the fixture, re-exported so pytest finds it here

CENT = Decimal("0.01")


def balances(headers: Headers) -> dict[int, Decimal]:
    accounts = client.get("/api/accounts", headers=headers).json()["accounts"]
    return {a["id"]: Decimal(a["balance"]) for a in accounts}


def net_worth(headers: Headers) -> Decimal:
    return Decimal(client.get("/api/dashboard", headers=headers).json()["net_worth"])


# Transfers


def test_transfer_between_banks_moves_money_and_keeps_net_worth(headers: Headers) -> None:
    a = account(headers, "bank", "1000.00")
    b = account(headers, "bank", "500.00")
    before = net_worth(headers)

    assert transfer(headers, a, b, "250.75").status_code == 201

    assert balances(headers) == {a: Decimal("749.25"), b: Decimal("750.75")}
    assert net_worth(headers) == before


def test_transfers_are_not_counted_as_income_or_expense(headers: Headers) -> None:
    a = account(headers, "bank", "1000.00")
    b = account(headers, "cash", "0.00")
    assert transfer(headers, a, b, "300.00").status_code == 201

    body = client.get(URL, headers=headers).json()

    assert body["total_income"] == "0.00"
    assert body["total_expense"] == "0.00"


def test_editing_a_transfer_amount_updates_both_sides(headers: Headers) -> None:
    a = account(headers, "bank", "1000.00")
    b = account(headers, "bank", "0.00")
    id = transfer(headers, a, b, "100.00").json()["id"]

    response = client.patch(f"{URL}/{id}", json={"amount": "40.00"}, headers=headers)

    assert response.status_code == 200
    assert balances(headers) == {a: Decimal("960.00"), b: Decimal("40.00")}


def test_editing_a_transfer_destination_returns_money_to_the_old_one(headers: Headers) -> None:
    a = account(headers, "bank", "1000.00")
    b = account(headers, "bank", "0.00")
    c = account(headers, "bank", "0.00")
    id = transfer(headers, a, b, "100.00").json()["id"]

    response = client.patch(f"{URL}/{id}", json={"to_account_id": c}, headers=headers)

    assert response.status_code == 200
    assert balances(headers) == {a: Decimal("900.00"), b: Decimal("0.00"), c: Decimal("100.00")}


def test_deleting_a_transfer_reverses_both_sides(headers: Headers) -> None:
    bank = account(headers, "bank", "1000.00")
    card = account(headers, "credit_card", "400.00")
    id = transfer(headers, bank, card, "400.00").json()["id"]

    assert client.delete(f"{URL}/{id}", headers=headers).status_code == 200

    assert balances(headers) == {bank: Decimal("1000.00"), card: Decimal("400.00")}


# Opening balance and independence


def test_balance_is_opening_plus_its_own_transactions_only(headers: Headers) -> None:
    a = account(headers, "bank", "123.45")
    b = account(headers, "bank", "678.90")
    assert income(headers, a, "10.00").status_code == 201
    assert expense(headers, b, "0.90").status_code == 201

    assert balances(headers) == {a: Decimal("133.45"), b: Decimal("678.00")}


def test_many_cent_amounts_sum_exactly(headers: Headers) -> None:
    bank = account(headers, "bank", "0.00")
    for _ in range(30):
        assert income(headers, bank, "0.10").status_code == 201
    for _ in range(10):
        assert expense(headers, bank, "0.07").status_code == 201

    assert balances(headers)[bank] == Decimal("2.30")


# Randomized run against the model


def test_random_operations_match_the_reference_model(headers: Headers) -> None:
    rng = random.Random(20261108)
    # Cash starts generous, so spending never trips the "cash can't go below zero" rule.
    setup = [("bank", "5000.00"), ("bank", "0.00"), ("cash", "1000000.00"), ("credit_card", "0.00")]
    kinds: dict[int, str] = {}
    worth: dict[int, Decimal] = {}
    for type_, opening in setup:
        id = account(headers, type_, opening)
        kinds[id] = type_
        worth[id] = -Decimal(opening) if type_ == "credit_card" else Decimal(opening)
    ids = list(kinds)
    live: dict[int, tuple[str, Decimal, int, int | None]] = {}

    def apply(type_: str, amount: Decimal, src: int, dst: int | None, sign: int) -> None:
        if type_ == "income":
            worth[src] += sign * amount
        else:
            worth[src] -= sign * amount
        if dst is not None:
            worth[dst] += sign * amount

    def money() -> Decimal:
        return (Decimal(rng.randint(1, 100_000)) * CENT).quantize(CENT)

    for step in range(80):
        roll = rng.random()
        if live and roll < 0.2:
            id = rng.choice(list(live))
            response = client.delete(f"{URL}/{id}", headers=headers)
            assert response.status_code == 200, (step, response.json())
            apply(*live.pop(id), sign=-1)
        elif live and roll < 0.4:
            id = rng.choice(list(live))
            type_, _, src, dst = live[id]
            new_amount = money()
            response = client.patch(
                f"{URL}/{id}", json={"amount": str(new_amount)}, headers=headers
            )
            assert response.status_code == 200, (step, response.json())
            apply(*live[id], sign=-1)
            live[id] = (type_, new_amount, src, dst)
            apply(*live[id], sign=1)
        else:
            type_ = rng.choice(["income", "expense", "transfer"])
            amount = money()
            src = rng.choice(ids)
            dst = rng.choice([i for i in ids if i != src]) if type_ == "transfer" else None
            if type_ == "income":
                response = income(headers, src, str(amount))
            elif type_ == "expense":
                response = expense(headers, src, str(amount))
            else:
                response = transfer(headers, src, dst, str(amount))  # type: ignore[arg-type]
            assert response.status_code == 201, (step, response.json())
            live[response.json()["id"]] = (type_, amount, src, dst)
            apply(type_, amount, src, dst, sign=1)

        shown = balances(headers)
        for i in ids:
            expected = -worth[i] if kinds[i] == "credit_card" else worth[i]
            assert shown[i] == expected, (step, i)
        assert net_worth(headers) == sum(worth.values()), step
