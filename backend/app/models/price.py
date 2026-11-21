"""The column type of a price or NAV: 10 decimals, so a coin priced at a fraction of a paisa
(₹0.00084) keeps its value.

PostgreSQL stores it exactly as NUMERIC(20, 10). SQLite (the test database) would store a float,
which can't hold 17 significant digits (₹9123456.78 at 10 decimals reads back as
9123456.7799999993), so there it is kept as the decimal's text instead. Nothing compares or sums
prices in SQL, so text loses nothing.
"""

from decimal import Decimal
from typing import Any

from sqlalchemy import Numeric, String
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator, TypeEngine

PRICE_SCALE = Decimal("1e-10")


class _ExactText(TypeDecorator[Decimal]):
    impl = String(32)
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Dialect) -> str | None:
        if value is None:
            return None
        return format(Decimal(value).quantize(PRICE_SCALE), "f")

    def process_result_value(self, value: Any, dialect: Dialect) -> Decimal | None:
        return None if value is None else Decimal(str(value))


def price_type() -> TypeEngine[Decimal]:
    return Numeric(20, 10).with_variant(_ExactText(), "sqlite")
