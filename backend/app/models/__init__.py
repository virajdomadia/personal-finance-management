"""Import every model module here so Alembic autogenerate sees it."""

from app.models.account import Account  # noqa: F401
from app.models.goal import Goal, GoalEarmark, GoalHolding  # noqa: F401
from app.models.insurance import InsurancePolicy, PolicyPeriod  # noqa: F401
from app.models.investment import (  # noqa: F401
    Instrument,
    InstrumentPrice,
    InvestmentTrade,
    Sip,
)
from app.models.market import MarketCode  # noqa: F401
from app.models.recurring import RecurringSkip, RecurringTemplate  # noqa: F401
from app.models.sms import AccountIdentifier, PayeeRule, SmsEntry, SmsSample  # noqa: F401
from app.models.transaction import Transaction  # noqa: F401
from app.models.user import User  # noqa: F401
