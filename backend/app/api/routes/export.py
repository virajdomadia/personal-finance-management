"""Downloads of the signed-in user's own data: a JSON backup and a zip of CSVs. Read-only."""

import json

from fastapi import APIRouter, Depends, Response

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.db.session import DbSession
from app.export.backup import dump
from app.export.csv_export import build_zip

router = APIRouter(prefix="/export", tags=["export"], dependencies=[Depends(get_current_user)])


def _attachment(name: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"}


@router.get("/backup")
def backup(user: CurrentUser, db: DbSession) -> Response:
    body = json.dumps(dump(db, user), ensure_ascii=False, indent=1)
    name = f"pfm-backup-{today_india().isoformat()}.json"
    return Response(body, media_type="application/json", headers=_attachment(name))


@router.get("/csv")
def spreadsheets(user: CurrentUser, db: DbSession) -> Response:
    name = f"pfm-export-{today_india().isoformat()}.zip"
    return Response(build_zip(db, user.id), media_type="application/zip", headers=_attachment(name))
