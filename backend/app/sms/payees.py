"""Normalise payee names pulled out of bank SMS."""

import re

_PREFIXES = ("vpa ", "upi/", "to ", "by ")
_MAX_DISPLAY = 60


def payee_key(raw: str) -> str:
    """Stable lookup key: casefolded, single-spaced, without a leading VPA/UPI/TO/BY."""
    key = " ".join(raw.split()).casefold()
    for prefix in _PREFIXES:
        if key.startswith(prefix):
            key = key[len(prefix) :].strip()
            break
    return key


def display_name(raw: str) -> str:
    """Readable name for a payee. UPI ids show the part before the @."""
    text = " ".join(raw.split())
    if "@" in text:
        local = text.split("@", 1)[0]
        local = re.sub(r"\d+", " ", re.sub(r"[._]", " ", local))
        return " ".join(local.split()).title()[:_MAX_DISPLAY].strip()
    # Words with digits (masked accounts such as XX650) stay as written.
    words = [w if any(c.isdigit() for c in w) else w.title() for w in text.split()]
    return " ".join(words)[:_MAX_DISPLAY].strip()
