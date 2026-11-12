"""Normalise payee names pulled out of bank SMS."""

import re

_PREFIXES = ("vpa ", "upi/", "to ", "by ")
_MAX_DISPLAY = 60
# Card gateways put their own code before the merchant: "RSP*AMITY", "RAZ*...", "PAYU*...".
_GATEWAY = re.compile(r"^[A-Za-z]{2,6}\*\s*(?=\S)")


def payee_key(raw: str) -> str:
    """Stable lookup key: casefolded, single-spaced, without a leading VPA/UPI/TO/BY."""
    key = " ".join(raw.split()).casefold()
    for prefix in _PREFIXES:
        if key.startswith(prefix):
            key = key[len(prefix) :].strip()
            break
    return key


def display_name(raw: str) -> str:
    """Readable name for a payee. UPI ids show the part before the @, or the whole id when that
    part is only digits (a phone number)."""
    text = " ".join(raw.split())
    if "@" in text:
        local = text.split("@", 1)[0]
        local = re.sub(r"\d+", " ", re.sub(r"[._]", " ", local))
        name = " ".join(local.split()).title()[:_MAX_DISPLAY].strip()
        return name or text[:_MAX_DISPLAY].strip()
    text = _GATEWAY.sub("", text)
    # Words with digits (masked accounts such as XX650) stay as written.
    words = [w if any(c.isdigit() for c in w) else w.title() for w in text.split()]
    return " ".join(words)[:_MAX_DISPLAY].strip()
