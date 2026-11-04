from fastapi import APIRouter, Response, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.db.session import DbSession

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str
    environment: str
    database: str


@router.get("/health", response_model=HealthResponse)
def health(db: DbSession, response: Response) -> HealthResponse:
    environment = get_settings().environment
    try:
        db.execute(text("select 1"))
    except SQLAlchemyError:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return HealthResponse(status="error", environment=environment, database="unreachable")
    return HealthResponse(status="ok", environment=environment, database="ok")
