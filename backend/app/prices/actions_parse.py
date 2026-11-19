"""Pure parsers for NSE/BSE corporate-action feeds. No network and no database.

Ratio convention: ``ratio_new : ratio_old`` is how many shares you hold after per share(s)
before. A split from face value Rs 10 to Re 1 is 10:1; a consolidation from Re 1 to Rs 10 is
1:10; "Bonus 3:2" is 3 new for every 2 held. Numbers always go text -> Decimal.

JSON must be loaded with ``parse_float=Decimal`` by the caller if it holds numeric values.
"""

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, NamedTuple


class ParsedAction(NamedTuple):
    symbol: str
    isin: str | None
    kind: str
    ex_date: date
    record_date: date | None
    ratio_new: Decimal | None
    ratio_old: Decimal | None
    amount_per_share: Decimal | None
    purpose: str
    source: str
    # The part of `purpose` this action came from; one notice can hold several actions.
    segment: str = ""


PurposeItem = tuple[str, Decimal | None, Decimal | None, Decimal | None]

# An amount after Rs/Re, thousands commas allowed (Indian or Western grouping): "Rs 1,25,000.50".
_MONEY = r"\b(?:rs|re)\b\.?\s*-?\s*(\d+(?:,\d{2,3})*(?:\.\d+)?)"
# Several actions in one notice are joined by "/", spaced or not; the "/-" in "Rs 10/-" is not.
_SEGMENTS = re.compile(r"\s*/(?!-)\s*")
_BONUS = re.compile(r"\bbonus\b[^\d]*(\d+)\s*:\s*(\d+)")
_IGNORED = re.compile(
    r"annual general meeting|extra[- ]ordinary general meeting|\bagm\b|\begm\b|"
    r"postal ballot|book closure|\bboard meeting\b|"
    r"buy[- ]?back|open offer|delisting"
)
_OTHER_HINT = re.compile(r"\b(?:rs|re)\b|\d+\s*:\s*\d+|\bratio\b")


def _positive(value: str) -> Decimal | None:
    try:
        number = Decimal(value)
    except InvalidOperation:
        return None
    return number if number.is_finite() and number > 0 else None


def _parse_segment(segment: str) -> PurposeItem | None:
    text = segment.lower()
    if re.search(r"\brights?\b", text) or _IGNORED.search(text):
        return None
    amounts = [_positive(m.replace(",", "")) for m in re.findall(_MONEY, text)]
    if "consolidation" in text or re.search(r"split|sub[- ]?division", text):
        if len(amounts) >= 2 and amounts[0] and amounts[1]:
            kind = "consolidation" if "consolidation" in text else "split"
            return (kind, amounts[0], amounts[1], None)
        return ("other", None, None, None)
    if "bonus" in text:
        if bonus := _BONUS.search(text):
            new, old = _positive(bonus.group(1)), _positive(bonus.group(2))
            if new and old:
                return ("bonus", new, old, None)
        return ("other", None, None, None)
    if "dividend" in text:
        if amounts and amounts[0]:
            return ("dividend", None, None, amounts[0])
        return ("other", None, None, None)
    if "demerger" in text or "arrangement" in text:
        return ("demerger", None, None, None)
    if "merger" in text or "amalgamation" in text:
        return ("merger", None, None, None)
    if "capital reduction" in text or "reduction of capital" in text:
        return ("other", None, None, None)
    if _OTHER_HINT.search(text):
        return ("other", None, None, None)
    return None


def _parse_items(text: str) -> list[tuple[PurposeItem, str]]:
    """Each action a purpose string describes, with the segment of it that said so."""
    items: list[tuple[PurposeItem, str]] = []
    for segment in _SEGMENTS.split(text or ""):
        item = _parse_segment(segment.strip())
        if item is not None:
            items.append((item, segment.strip()))
    return items


def parse_purpose(text: str) -> list[PurposeItem]:
    """Every action a purpose string describes; several are separated by "/"."""
    return [item for item, _ in _parse_items(text)]


_DATE_FORMATS = ("%d-%b-%Y", "%d %b %Y", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y")


def _date(value: Any) -> date | None:
    text = str(value or "").strip()
    if not text or text == "-":
        return None
    text = text.split("T")[0]
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _clean(value: Any) -> str | None:
    text = str(value or "").strip()
    return None if text in ("", "-") else text


def _actions(
    symbol: str, isin: str | None, ex: date, rec: date | None, purpose: str, source: str
) -> list[ParsedAction]:
    return [
        ParsedAction(symbol, isin, kind, ex, rec, new, old, amount, purpose, source, segment)
        for (kind, new, old, amount), segment in _parse_items(purpose)
    ]


def parse_nse_actions(payload: Any) -> list[ParsedAction]:
    """NSE's corporate-actions JSON: a list of objects with symbol, isin, subject, exDate."""
    if not isinstance(payload, list):
        return []
    actions: list[ParsedAction] = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        symbol = _clean(row.get("symbol"))
        ex_date = _date(row.get("exDate"))
        purpose = str(row.get("subject") or "").strip()
        if not symbol or ex_date is None or not purpose:
            continue
        actions += _actions(
            symbol.upper(),
            _clean(row.get("isin")),
            ex_date,
            _date(row.get("recDate")),
            purpose,
            "nse",
        )
    return actions


_BSE_ISIN = ("isin", "isin_number", "isin_no", "isinno")
_BSE_EX = ("ex_date", "exdate", "ex_dt")
_BSE_PURPOSE = ("purpose", "purpose_name", "subject")
_BSE_RECORD = ("rd_date", "record_date", "recdate")


def _pick(row: dict[str, Any], candidates: tuple[str, ...]) -> Any:
    lowered = {str(k).lower(): v for k, v in row.items()}
    for name in candidates:
        if name in lowered:
            return lowered[name]
    return None


def parse_bse_actions(payload: Any, isin_to_symbol: dict[str, str]) -> list[ParsedAction]:
    """BSE rows carry a scrip code, so the NSE symbol is found through the row's ISIN.

    Rows with no ISIN, or an ISIN not in ``isin_to_symbol``, are dropped. Field names are
    matched case-insensitively among a few candidates because BSE's names are not stable.
    """
    if isinstance(payload, dict):
        payload = payload["Table"] if "Table" in payload else payload.get("data")
    if not isinstance(payload, list):
        return []
    actions: list[ParsedAction] = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        isin = _clean(_pick(row, _BSE_ISIN))
        symbol = isin_to_symbol.get(isin) if isin else None
        ex_date = _date(_pick(row, _BSE_EX))
        purpose = str(_pick(row, _BSE_PURPOSE) or "").strip()
        if not symbol or ex_date is None or not purpose:
            continue
        actions += _actions(symbol, isin, ex_date, _date(_pick(row, _BSE_RECORD)), purpose, "bse")
    return actions
