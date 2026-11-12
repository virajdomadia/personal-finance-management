"""Bank SMS from the phone: parsed fields and a hash only, never the message text."""

from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import Money
from app.api.routes.transactions import Day
from app.db.session import DbSession
from app.sms.ingest import decide

router = APIRouter(prefix="/sms", tags=["sms"], dependencies=[Depends(get_current_user)])

SmsKind = Literal["debit", "credit", "card_spend", "card_payment", "card_statement", "demat"]


class ParsedSms(BaseModel):
    """One message as the phone's parser read it."""

    model_config = ConfigDict(extra="forbid")

    # SHA-256 of the message, so the same SMS sent twice is recognised.
    hash: Annotated[str, Field(pattern=r"^[0-9a-fA-F]{64}$")]
    sender: Annotated[str, Field(min_length=1, max_length=20)]
    # The parser key, such as "hdfc".
    bank: Annotated[str, Field(min_length=1, max_length=30)]
    kind: SmsKind
    amount: Money = None
    date: Day
    last4: Annotated[str | None, Field(pattern=r"^[0-9]{4}$")] = None
    payee: Annotated[str | None, Field(max_length=120)] = None
    ref: Annotated[str | None, Field(max_length=40)] = None
    balance: Money = None
    isin: Annotated[str | None, Field(pattern=r"^[A-Za-z0-9]{12}$")] = None
    quantity: Annotated[Decimal | None, Field(gt=0, max_digits=24, decimal_places=8)] = None
    due_date: Day = None

    @model_validator(mode="after")
    def _rules(self) -> "ParsedSms":
        self.hash = self.hash.lower()
        if self.date is None:
            raise PydanticCustomError("date", "Choose a date.")
        if self.date > today_india():
            raise PydanticCustomError("date", "The date can't be in the future.")
        if self.amount is None and self.kind != "demat":
            raise PydanticCustomError("amount", "Enter an amount.")
        if self.amount is not None and self.amount <= 0:
            raise PydanticCustomError("amount", "Amount must be greater than 0.")
        if self.payee is not None:
            self.payee = " ".join(self.payee.split()) or None
        if self.ref is not None:
            self.ref = self.ref.strip() or None
        return self


class SmsBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: Annotated[list[ParsedSms], Field(min_length=1, max_length=100)]


class SmsResult(BaseModel):
    hash: str
    # What became of the message: "recorded", "review", "draft", "ignored" or "duplicate".
    status: str
    reason: str | None


class SmsResults(BaseModel):
    results: list[SmsResult]


@router.post("/entries")
def post_entries(body: SmsBatch, user: CurrentUser, db: DbSession) -> SmsResults:
    """Decides each message in order and commits it on its own, so one can't undo another."""
    results = []
    for sms in body.entries:
        entry, repeat = decide(db, user.id, sms)
        db.commit()
        if repeat:
            results.append(SmsResult(hash=sms.hash, status="duplicate", reason=None))
        else:
            results.append(SmsResult(hash=sms.hash, status=entry.status, reason=entry.reason))
    return SmsResults(results=results)
