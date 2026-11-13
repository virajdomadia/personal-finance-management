"""Downloads of the signed-in user's own data: a gzipped JSON backup and a zip of CSVs.
Read-only."""

import logging

from fastapi import APIRouter, Depends, Response

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.db.session import DbSession
from app.export.backup import dump, encode
from app.export.csv_export import build_zip

log = logging.getLogger(__name__)

router = APIRouter(prefix="/export", tags=["export"], dependencies=[Depends(get_current_user)])


def _attachment(name: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"}


@router.get("/backup")
def backup(user: CurrentUser, db: DbSession) -> Response:
    body, raw_size = encode(dump(db, user))
    # Vercel refuses responses over 4.5 MB; these sizes show how close a backup is getting.
    log.info("backup for user %s: %d bytes of JSON, %d gzipped", user.id, raw_size, len(body))
    name = f"pfm-backup-{today_india().isoformat()}.json.gz"
    return Response(body, media_type="application/gzip", headers=_attachment(name))


@router.get("/csv")
def spreadsheets(user: CurrentUser, db: DbSession) -> Response:
    name = f"pfm-export-{today_india().isoformat()}.zip"
    return Response(build_zip(db, user.id), media_type="application/zip", headers=_attachment(name))
