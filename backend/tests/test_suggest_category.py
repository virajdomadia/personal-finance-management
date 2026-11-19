"""Suggesting a category from a transaction's note: the owner's history first, then keywords."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.main import app
from app.models.category import Category
from tests.test_accounts import Headers, auth
from tests.test_categories import find, merge, patch
from tests.test_transactions import account, expense, income

client = TestClient(app)

URL = "/api/transactions/suggest-category"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def suggest(headers: Headers, note: str, type_: str = "expense") -> dict[str, Any]:
    response = client.get(URL, params={"type": type_, "note": note}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


# Keywords


def test_keywords_pick_ice_cream_for_a_new_user(headers: Headers) -> None:
    assert suggest(headers, "ice cream") == {"category": "Food and dining", "source": "keywords"}


@pytest.mark.parametrize(
    ("note", "category"),
    [
        ("milk", "Groceries"),
        ("petrol", "Fuel"),
        ("uber to office", "Transport"),
        ("Netflix", "Entertainment"),
        ("medicine", "Health"),
        ("electricity bill", "Utilities"),
        ("rent", "Housing"),
    ],
)
def test_everyday_keywords(headers: Headers, note: str, category: str) -> None:
    assert suggest(headers, note)["category"] == category


def test_income_keywords(headers: Headers) -> None:
    assert suggest(headers, "salary", "income")["category"] == "Salary"


def test_messy_spacing_and_case(headers: Headers) -> None:
    assert suggest(headers, "  Ice   Cream ")["category"] == "Food and dining"


def test_plurals_match_but_words_inside_words_do_not(headers: Headers) -> None:
    assert suggest(headers, "ice creams")["category"] == "Food and dining"
    assert suggest(headers, "steam iron")["category"] != "Food and dining"  # not "tea"
    assert suggest(headers, "scream")["category"] is None  # not "cream"


def test_longest_phrase_wins(headers: Headers) -> None:
    assert suggest(headers, "milk")["category"] == "Groceries"
    assert suggest(headers, "milkshake")["category"] == "Food and dining"


def test_unknown_word_gives_nothing(headers: Headers) -> None:
    assert suggest(headers, "zxqv") == {"category": None, "source": None}


def test_blank_note_gives_nothing(headers: Headers) -> None:
    assert suggest(headers, "   ") == {"category": None, "source": None}


# History


def test_history_beats_keywords(headers: Headers) -> None:
    cash = account(headers)
    assert expense(headers, cash, category="Shopping", note="Ice Cream").status_code == 201
    assert suggest(headers, "ice cream") == {"category": "Shopping", "source": "history"}


def test_most_recent_history_wins(headers: Headers) -> None:
    cash = account(headers)
    assert (
        expense(
            headers, cash, category="Food and dining", note="momos", date="2026-02-01"
        ).status_code
        == 201
    )
    assert (
        expense(headers, cash, category="Shopping", note="momos", date="2026-01-01").status_code
        == 201
    )
    assert suggest(headers, "momos") == {"category": "Food and dining", "source": "history"}


def test_history_is_per_kind(headers: Headers) -> None:
    cash = account(headers)
    assert income(headers, cash, category="Gift", note="ice cream").status_code == 201
    assert suggest(headers, "ice cream")["source"] == "keywords"
    assert suggest(headers, "ice cream", "income") == {"category": "Gift", "source": "history"}


def test_history_follows_a_rename(headers: Headers) -> None:
    cash = account(headers)
    assert expense(headers, cash, category="Shopping", note="momos").status_code == 201
    assert patch(headers, find(headers, "Shopping")["id"], name="Stuff").status_code == 200
    assert suggest(headers, "momos")["category"] == "Stuff"


def test_archived_history_falls_through_to_keywords(headers: Headers) -> None:
    cash = account(headers)
    assert expense(headers, cash, category="Treats", note="ice cream").status_code == 201
    assert patch(headers, find(headers, "Treats")["id"], archived=True).status_code == 200
    assert suggest(headers, "ice cream") == {"category": "Food and dining", "source": "keywords"}


def test_keyword_follows_a_merge(headers: Headers) -> None:
    food = find(headers, "Food and dining")["id"]
    assert merge(headers, food, find(headers, "Groceries")["id"]).status_code == 200
    assert suggest(headers, "ice cream")["category"] == "Groceries"


def test_keyword_skips_an_archived_category(headers: Headers) -> None:
    assert patch(headers, find(headers, "Fuel")["id"], archived=True).status_code == 200
    assert suggest(headers, "petrol") == {"category": None, "source": None}


def test_suggesting_creates_no_category(headers: Headers, db_session: Session) -> None:
    suggest(headers, "ice cream")  # seeds the defaults
    before = db_session.scalar(select(func.count()).select_from(Category))
    suggest(headers, "zxqv")
    suggest(headers, "ice cream")
    assert db_session.scalar(select(func.count()).select_from(Category)) == before


def test_another_users_history_is_private(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers
) -> None:
    cash = account(headers)
    assert expense(headers, cash, category="Shopping", note="zxqv").status_code == 201
    other = auth(db_session, monkeypatch, "other@example.com")
    assert suggest(other, "zxqv") == {"category": None, "source": None}


def test_bad_type_is_rejected(headers: Headers) -> None:
    response = client.get(URL, params={"type": "transfer", "note": "rent"}, headers=headers)
    assert response.status_code == 422


def test_needs_sign_in(headers: Headers) -> None:
    # `headers` sets up the test database and a production-mode token secret, as elsewhere.
    assert client.get(URL, params={"type": "expense", "note": "rent"}).status_code == 401


@pytest.mark.parametrize(
    "note",
    ["auto debit", "of course", "engine oil", "visa card bill", "watch"],
)
def test_common_words_do_not_misfire(headers: Headers, note: str) -> None:
    assert suggest(headers, note)["category"] is None


@pytest.mark.parametrize(
    ("note", "category"),
    [
        ("auto rickshaw", "Transport"),
        ("watch movie", "Entertainment"),
        ("uber eats", "Food and dining"),
        ("amazon fresh", "Groceries"),
        ("cooking oil", "Groceries"),
    ],
)
def test_more_specific_phrases(headers: Headers, note: str, category: str) -> None:
    assert suggest(headers, note)["category"] == category


@pytest.mark.parametrize(
    ("note", "category"),
    [
        ("McDonald's", "Food and dining"),
        ("ice-cream", "Food and dining"),
        ("Domino’s", "Food and dining"),
    ],
)
def test_apostrophes_and_hyphens(headers: Headers, note: str, category: str) -> None:
    assert suggest(headers, note)["category"] == category
