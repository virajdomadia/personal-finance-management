"""Importing transactions from an Excel workbook: the template, a preview, and the import.

The file is the request body itself (the raw .xlsx bytes), not a form upload.
"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from app.api.deps import CurrentUser, get_current_user
from app.db.session import DbSession
from app.export.importing import MAX_BYTES, FileProblem, Report, run_import, template
from app.export.xlsx import XLSX_TYPE

router = APIRouter(prefix="/import", tags=["import"], dependencies=[Depends(get_current_user)])


class ImportRow(BaseModel):
    row: int  # the spreadsheet row number
    date: str | None
    type: str | None
    amount: str | None
    account: str | None
    to_account: str | None
    category: str | None
    note: str | None
    status: Literal["ok", "duplicate", "error"]
    errors: list[str]


class ImportReport(BaseModel):
    rows: list[ImportRow]
    ok: int  # rows that will be (or were) added
    duplicates: int  # rows matching a saved transaction, skipped
    problems: int  # rows in error; nothing is added while there are any
    imported: int  # rows added by this request (0 for a preview)


def _report(report: Report) -> ImportReport:
    return ImportReport(
        rows=[
            ImportRow(
                row=r.number,
                date=r.date,
                type=r.type,
                amount=r.amount,
                account=r.account,
                to_account=r.to_account,
                category=r.category,
                note=r.note,
                status=r.status,  # type: ignore[arg-type]
                errors=r.errors,
            )
            for r in report.rows
        ],
        ok=report.ok,
        duplicates=report.duplicates,
        problems=report.problems,
        imported=report.imported,
    )


async def _body(request: Request) -> bytes:
    data = b""
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_BYTES:
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE,
                "The file is over 4 MB. Split it into smaller files.",
            )
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose an Excel file (.xlsx).")
    return data


@router.get("/transactions/template")
def transactions_template(user: CurrentUser, db: DbSession) -> Response:
    headers = {
        "Content-Disposition": 'attachment; filename="pfm-transactions-template.xlsx"',
        "Cache-Control": "no-store",
    }
    return Response(template(db, user.id), media_type=XLSX_TYPE, headers=headers)


@router.post("/transactions/preview")
async def preview_transactions(request: Request, user: CurrentUser, db: DbSession) -> ImportReport:
    """Every row checked as the import would check it. Saves nothing."""
    return _run(db, user.id, await _body(request), save=False)


@router.post("/transactions")
async def import_transactions(request: Request, user: CurrentUser, db: DbSession) -> ImportReport:
    """Adds every row that isn't a duplicate, or nothing at all if any row has a problem
    (the report says which, with `imported` 0)."""
    return _run(db, user.id, await _body(request), save=True)


def _run(db: DbSession, user_id: int, data: bytes, save: bool) -> ImportReport:
    try:
        return _report(run_import(db, user_id, data, save))
    except FileProblem as problem:
        db.rollback()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(problem)) from None
