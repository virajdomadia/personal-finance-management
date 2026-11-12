"""Well-known Indian merchants mapped to expense categories (names from DEFAULT_CATEGORIES)."""

import re

MERCHANT_KEYWORDS: list[tuple[str, str]] = [
    *((k, "Food and dining") for k in ("swiggy", "zomato", "dominos", "mcdonald", "starbucks")),
    *((k, "Transport") for k in ("uber", "ola", "rapido", "irctc", "redbus", "metro")),
    *((k, "Shopping") for k in ("amazon", "flipkart", "myntra", "ajio", "meesho", "nykaa")),
    *((k, "Groceries") for k in ("bigbasket", "blinkit", "zepto", "dmart", "jiomart", "instamart")),
    *((k, "Fuel") for k in ("petrol", "fuel", "hpcl", "bpcl", "iocl", "indianoil", "shell")),
    *(
        (k, "Utilities")
        for k in (
            "airtel",
            "jio",
            "vodafone",
            "vi",
            "bsnl",
            "tatapower",
            "adani electricity",
            "bescom",
            "mahavitaran",
            "act fibernet",
        )
    ),
    *((k, "Entertainment") for k in ("netflix", "spotify", "hotstar", "primevideo", "bookmyshow")),
    *((k, "Health") for k in ("apollo", "pharmeasy", "1mg", "netmeds", "practo")),
    *((k, "Travel") for k in ("makemytrip", "goibibo", "cleartrip", "indigo", "airindia", "oyo")),
]

_PATTERNS = [
    (re.compile(rf"(?:^|[ @._/-]){re.escape(word)}(?=$|[ @._/-])"), category)
    for word, category in MERCHANT_KEYWORDS
]


def builtin_category(key: str) -> str | None:
    """Category of the first keyword found as a whole token in the payee key."""
    for pattern, category in _PATTERNS:
        if pattern.search(key):
            return category
    return None
