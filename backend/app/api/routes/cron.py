import hmac
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from app.api.dates import today_india
from app.api.snapshots import snapshot_all, snapshot_date
from app.core.config import get_settings
from app.core.security import bearer_token
from app.db.session import DbSession
from app.prices.fetch import default_fetcher
from app.prices.refresh import run_nightly

# Public to the auth middleware: Vercel Cron cannot hold a user token, so this route checks
# its own secret.
router = APIRouter(tags=["cron"])


class RefreshResponse(BaseModel):
    updated: dict[str, int]
    failed: dict[str, str]
    snapshots: int  # users whose net worth snapshot was written tonight


def utc_now() -> datetime:
    return datetime.now(UTC)


def _is_cron(request: Request) -> bool:
    secret = get_settings().cron_secret
    # An unset secret must never match, not even an empty bearer token.
    return bool(secret) and hmac.compare_digest(bearer_token(request).encode(), secret.encode())


@router.get("/cron/prices", response_model=RefreshResponse)
def refresh_prices(request: Request, db: DbSession) -> RefreshResponse:
    if not _is_cron(request):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    today = today_india()
    with default_fetcher() as fetcher:
        report = run_nightly(db, fetcher, today)
    # After the prices, so tonight's snapshot values holdings at tonight's prices. It is dated by
    # the evening the run was meant for, even when the platform starts it after midnight.
    snapshots = snapshot_all(db, snapshot_date(utc_now()))
    return RefreshResponse(updated=report.updated, failed=report.failed, snapshots=snapshots)
