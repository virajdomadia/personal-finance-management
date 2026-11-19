"""Suggesting a category from a transaction's note, so small items need no deciding.

The owner's own history comes first: the category of their latest transaction of the same kind
with the same note. Then a built-in list of everyday words, mapped to the default categories.
Either answer goes through the registry, so a merged or renamed category gives its current name
and an archived one gives nothing. Nothing here creates a category.
"""

import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.categories import current_name
from app.models.transaction import Transaction

# Everyday words and phrases (already normalised) and the default category each belongs to.
_EXPENSE: dict[str, list[str]] = {
    "Food and dining": [
        "ice cream",
        "kulfi",
        "chai",
        "tea",
        "coffee",
        "cold drink",
        "juice",
        "lassi",
        "milkshake",
        "shake",
        "snacks",
        "samosa",
        "vada pav",
        "pav bhaji",
        "pani puri",
        "chaat",
        "momos",
        "pizza",
        "burger",
        "sandwich",
        "biryani",
        "thali",
        "dosa",
        "idli",
        "noodles",
        "maggi",
        "rolls",
        "frankie",
        "shawarma",
        "cake",
        "pastry",
        "sweets",
        "mithai",
        "chocolate",
        "breakfast",
        "lunch",
        "dinner",
        "restaurant",
        "cafe",
        "canteen",
        "dhaba",
        "uber eats",
        "tiffin",
        "swiggy",
        "zomato",
        "dominos",
        "mcdonalds",
        "kfc",
        "starbucks",
        "eating out",
        "food",
        "party",
    ],
    "Groceries": [
        "groceries",
        "grocery",
        "kirana",
        "milk",
        "curd",
        "dahi",
        "paneer",
        "butter",
        "ghee",
        "bread",
        "eggs",
        "vegetables",
        "veggies",
        "sabzi",
        "fruits",
        "onion",
        "potato",
        "tomato",
        "rice",
        "atta",
        "dal",
        "cooking oil",
        "sugar",
        "salt",
        "masala",
        "spices",
        "flour",
        "dmart",
        "bigbasket",
        "blinkit",
        "zepto",
        "instamart",
        "jiomart",
        "amazon fresh",
        "supermarket",
    ],
    "Transport": [
        "uber",
        "ola",
        "rapido",
        "auto rickshaw",
        "auto fare",
        "rickshaw",
        "taxi",
        "cab",
        "metro",
        "bus",
        "local train",
        "parking",
        "toll",
        "fastag",
        "bike service",
        "car service",
        "car wash",
    ],
    "Fuel": ["petrol", "diesel", "cng", "fuel"],
    "Housing": [
        "rent",
        "house rent",
        "maintenance",
        "society",
        "plumber",
        "electrician",
        "carpenter",
        "repairs",
        "furniture",
        "painting",
    ],
    "Utilities": [
        "electricity",
        "light bill",
        "water bill",
        "gas",
        "gas cylinder",
        "lpg",
        "piped gas",
        "wifi",
        "broadband",
        "internet",
        "mobile recharge",
        "recharge",
        "postpaid",
        "dth",
        "cable",
    ],
    "Shopping": [
        "amazon",
        "flipkart",
        "myntra",
        "meesho",
        "ajio",
        "nykaa",
        "clothes",
        "shirt",
        "jeans",
        "kurta",
        "saree",
        "shoes",
        "chappal",
        "slippers",
        "wrist watch",
        "smartwatch",
        "bag",
        "electronics",
        "headphones",
        "earphones",
        "charger",
        "phone cover",
        "gadget",
        "cosmetics",
        "shopping",
        "stationery",
    ],
    "Health": [
        "medicine",
        "medicines",
        "tablets",
        "pharmacy",
        "chemist",
        "medical",
        "doctor",
        "clinic",
        "hospital",
        "dentist",
        "lab test",
        "blood test",
        "checkup",
        "physiotherapy",
        "gym",
        "yoga",
        "apollo",
        "pharmeasy",
        "1mg",
    ],
    "Entertainment": [
        "netflix",
        "prime video",
        "hotstar",
        "spotify",
        "youtube premium",
        "movie",
        "watch movie",
        "movies",
        "cinema",
        "pvr",
        "inox",
        "bookmyshow",
        "concert",
        "game",
        "games",
        "gaming",
        "bowling",
        "outing",
    ],
    "Education": [
        "school fees",
        "college fees",
        "tuition",
        "coaching",
        "online course",
        "books",
        "exam fee",
        "udemy",
        "coursera",
        "classes",
    ],
    "Travel": [
        "flight",
        "hotel",
        "train ticket",
        "irctc",
        "bus ticket",
        "trip",
        "holiday",
        "vacation",
        "makemytrip",
        "goibibo",
        "airbnb",
        "oyo",
        "resort",
        "visa fee",
    ],
    "Gifts and donations": [
        "gift",
        "gifts",
        "donation",
        "charity",
        "temple",
        "church",
        "mosque",
        "gurudwara",
        "birthday gift",
        "wedding gift",
        "shagun",
    ],
}
_INCOME: dict[str, list[str]] = {
    "Salary": ["salary", "bonus", "stipend", "incentive"],
    "Refund": ["refund", "cashback", "reversal"],
    "Interest": ["interest", "savings interest", "fd interest"],
    "Dividends": ["dividend", "dividends"],
    "Gift": ["gift", "shagun"],
    "Business": ["freelance", "client payment", "invoice", "consulting"],
}


def _flatten(groups: dict[str, list[str]]) -> dict[str, str]:
    return {phrase: category for category, phrases in groups.items() for phrase in phrases}


KEYWORDS: dict[str, dict[str, str]] = {"expense": _flatten(_EXPENSE), "income": _flatten(_INCOME)}

# Each kind's phrases as one pattern, longest first so "ice cream" beats "cream" and "milkshake"
# beats "milk". A phrase matches as whole words, plurals included ("ice creams").
_PATTERNS = {
    kind: re.compile(
        r"\b("
        + "|".join(re.escape(p) for p in sorted(phrases, key=len, reverse=True))
        + r")(?:e?s)?\b"
    )
    for kind, phrases in KEYWORDS.items()
}


def normalise(note: str) -> str:
    """Case-folded, trimmed, with each run of spaces made one."""
    return " ".join(note.casefold().split())


def _keyword_text(note: str) -> str:
    """The note as keywords see it: "McDonald's" as "mcdonalds", "ice-cream" as "ice cream"."""
    return normalise(re.sub(r"[-‐–—]", " ", re.sub(r"['’`]", "", note)))


def keyword_category(note: str, kind: str) -> str | None:
    """The default category of the longest known phrase in the note, or None."""
    pattern = _PATTERNS.get(kind)
    if pattern is None:
        return None
    text = _keyword_text(note)
    matches = [m.group(1) for m in pattern.finditer(text)]
    if not matches:
        return None
    return KEYWORDS[kind][max(matches, key=len)]


def suggest_category(
    db: Session, user_id: int, kind: str, note: str
) -> tuple[str | None, str | None]:
    """(category, source) for a note: source is "history", "keywords" or None."""
    text = normalise(note)
    if not text:
        return None, None
    # EMIs are left out on purpose: their category is always the app's own Loan interest.
    previous = db.scalar(
        select(Transaction.category)
        .where(
            Transaction.user_id == user_id,
            Transaction.type == kind,
            Transaction.category.is_not(None),
            func.lower(func.trim(Transaction.note)) == text,
        )
        .order_by(Transaction.date.desc(), Transaction.id.desc())
        .limit(1)
    )
    if previous is not None:
        name = current_name(db, user_id, kind, previous)
        if name is not None:
            return name, "history"
    found = keyword_category(text, kind)
    if found is not None:
        name = current_name(db, user_id, kind, found)
        if name is not None:
            return name, "keywords"
    return None, None
