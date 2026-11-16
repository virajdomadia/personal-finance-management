"""Importing holdings you already have (stocks, mutual funds, crypto) from an Excel workbook: the
template, a preview, and the import.

The file is the request body itself (the raw .xlsx bytes), not a form upload.
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, get_current_user
from app.api.routes.imports import _body
from app.db.session import DbSession
from app.export.holdings_import import Row, run_import, template
from app.export.importing import FileProblem, Report
from app.export.xlsx import XLSX_TYPE

router = APIRouter(prefix="/import", tags=["import"], dependencies=[Depends(get_current_user)])


class HoldingRow(BaseModel):
    row: int  # the spreadsheet row number
    type: str | None
    name: str | None
    symbol: str | None
    account: str | None
    quantity: str | None
    invested: str | None  # the amount that will be stored, once it can be worked out
    date: str | None
    status: Literal["ok", "duplicate", "error"]
    errors: list[str]


class HoldingsReport(BaseModel):
    rows: list[HoldingRow]
    ok: int  # rows that will be (or were) added
    duplicates: int  # rows matching a saved existing holding, skipped
    problems: int  # rows in error; nothing is added while there are any
    imported: int  # rows added by this request (0 for a preview)


def _row(r: Row) -> HoldingRow:
    return HoldingRow(
        row=r.number,
        type=r.type,
        name=r.name,
        symbol=r.symbol,
        account=r.account,
        quantity=r.quantity,
        invested=r.invested,
        date=r.date,
        status=r.status,  # type: ignore[arg-type]
        errors=r.errors,
    )


def _report(report: Report) -> HoldingsReport:
    return HoldingsReport(
        rows=[_row(r) for r in report.rows],  # type: ignore[arg-type]
        ok=report.ok,
        duplicates=report.duplicates,
        problems=report.problems,
        imported=report.imported,
    )


@router.get("/holdings/template")
def holdings_template(user: CurrentUser, db: DbSession) -> Response:
    headers = {
        "Content-Disposition": 'attachment; filename="pfm-holdings-template.xlsx"',
        "Cache-Control": "no-store",
    }
    return Response(template(db, user.id), media_type=XLSX_TYPE, headers=headers)


@router.post("/holdings/preview")
async def preview_holdings(request: Request, user: CurrentUser, db: DbSession) -> HoldingsReport:
    """Every row checked as the import would check it. Saves nothing."""
    return _run(db, user.id, await _body(request), save=False)


@router.post("/holdings")
async def import_holdings(request: Request, user: CurrentUser, db: DbSession) -> HoldingsReport:
    """Adds every row that isn't a duplicate, or nothing at all if any row has a problem
    (the report says which, with `imported` 0)."""
    return _run(db, user.id, await _body(request), save=True)


def _run(db: DbSession, user_id: int, data: bytes, save: bool) -> HoldingsReport:
    try:
        return _report(run_import(db, user_id, data, save))
    except FileProblem as problem:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(problem)) from None
