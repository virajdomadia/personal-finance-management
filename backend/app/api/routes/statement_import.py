"""Importing a bank or card statement from any bank into one account.

1. `POST /import/statement/preview?account_id=…` with the statement file as the request body
   (CSV, .xlsx, .xls or PDF; a locked PDF's password in the `X-File-Password` header). Saves
   nothing; returns each transaction with suggestions to edit.
2. `POST /import/statement` with the lines the owner kept, as edited (JSON). Saves all of them
   or none.
"""

from datetime import date
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import MAX_ID
from app.api.routes.imports import _body
from app.db.session import DbSession
from app.export.importing import FileProblem
from app.export.statement_files import PasswordNeeded, read_grid
from app.export.statements import Kept, added_on, read_statement, save_lines, suggest
from app.models.account import Account

router = APIRouter(prefix="/import", tags=["import"], dependencies=[Depends(get_current_user)])

STATEMENT_TYPES = ("bank", "credit_card", "cash", "wallet", "broker")


class StatementLine(BaseModel):
    line: int  # the row in the file
    date: str
    narration: str
    amount: str
    direction: Literal["out", "in"]
    balance: str | None
    payee: str | None
    type: Literal["expense", "income", "transfer"]
    category: str | None
    other_account_id: int | None
    duplicate: bool  # already saved in this account: left out unless the owner keeps it
    errors: list[str]  # a row that couldn't be read; it can't be kept


class StatementPreview(BaseModel):
    account_id: int
    lines: list[StatementLine]
    new: int  # lines that will be added as they are
    duplicates: int
    problems: int
    added_on: str  # the day the account was added; its opening balance is from then
    # Lines to add dated on or before `added_on`: saving them moves the opening balance instead,
    # so today's balance stays the same.
    before_start: int


class KeptLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line: int
    date: date
    narration: str = Field(default="", max_length=2000)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    direction: Literal["out", "in"]
    type: Literal["expense", "income", "transfer"]
    category: str | None = Field(default=None, max_length=40)
    other_account_id: int | None = None
    payee: str | None = Field(default=None, max_length=120)
    remember: bool = False  # make this line's category or transfer the payee's rule


class StatementSave(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: int
    lines: Annotated[list[KeptLine], Field(min_length=1, max_length=3000)]


class LineErrors(BaseModel):
    line: int
    errors: list[str]


class StatementSaved(BaseModel):
    imported: int  # 0 when any line had a problem: nothing was saved
    rules_saved: int
    errors: list[LineErrors]


def _account(db: DbSession, user_id: int, account_id: int) -> Account:
    account = None
    if 1 <= account_id <= MAX_ID:
        account = db.get(Account, account_id)
    if account is None or account.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    if account.type not in STATEMENT_TYPES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Statements go into a bank, card, cash, wallet or broker account.",
        )
    if account.archived_at is not None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"{account.name} is archived. Restore it first."
        )
    return account


@router.post("/statement/preview", response_model=StatementPreview)
async def preview_statement(
    request: Request,
    user: CurrentUser,
    db: DbSession,
    account_id: Annotated[int, Query()],
    x_file_password: Annotated[str | None, Header(max_length=200)] = None,
) -> StatementPreview | JSONResponse:
    account = _account(db, user.id, account_id)
    data = await _body(request)
    try:
        lines = read_statement(read_grid(data, x_file_password))
    except PasswordNeeded as locked:
        # Its own shape, so the screen can ask for the password instead of showing an error.
        return JSONResponse(
            {"detail": str(locked), "needs_password": True, "wrong_password": locked.wrong},
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        )
    except FileProblem as problem:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(problem)) from None
    suggestions = suggest(db, user.id, account, lines)
    start = added_on(account)
    rows = [
        StatementLine(
            line=line.number,
            date=line.date.isoformat(),
            narration=line.narration,
            amount=f"{line.amount:.2f}",
            direction=line.direction,  # type: ignore[arg-type]
            balance=line.balance,
            payee=s.payee,
            type=s.type,  # type: ignore[arg-type]
            category=s.category,
            other_account_id=s.other_account_id,
            duplicate=s.duplicate,
            errors=line.errors,
        )
        for line, s in zip(lines, suggestions, strict=True)
    ]
    return StatementPreview(
        account_id=account.id,
        lines=rows,
        new=sum(not r.duplicate and not r.errors for r in rows),
        duplicates=sum(r.duplicate and not r.errors for r in rows),
        problems=sum(bool(r.errors) for r in rows),
        added_on=start.isoformat(),
        before_start=sum(
            not r.duplicate and not r.errors and date.fromisoformat(r.date) <= start for r in rows
        ),
    )


@router.post("/statement")
def save_statement(body: StatementSave, user: CurrentUser, db: DbSession) -> StatementSaved:
    _account(db, user.id, body.account_id)
    kept = [
        Kept(
            number=k.line,
            date=k.date,
            narration=k.narration,
            amount=k.amount,
            direction=k.direction,
            type=k.type,
            category=k.category.strip() or None if k.category else None,
            other_account_id=k.other_account_id,
            payee=k.payee,
            remember=k.remember,
        )
        for k in body.lines
    ]
    result = save_lines(db, user.id, body.account_id, kept)
    return StatementSaved(
        imported=result.imported,
        rules_saved=result.rules_saved,
        errors=[LineErrors(line=n, errors=e) for n, e in sorted(result.errors.items())],
    )
