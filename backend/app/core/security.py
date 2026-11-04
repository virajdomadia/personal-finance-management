from collections.abc import Awaitable, Callable
from secrets import compare_digest

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from app.core.config import get_settings

API_SECRET_HEADER = "X-API-Secret"


def _is_authorized(request: Request) -> bool:
    settings = get_settings()
    if request.url.path == f"{settings.api_prefix}/health":
        return True
    if not settings.api_secret:
        # Local dev runs without a secret; production must never fall open.
        return settings.environment != "production"
    provided = request.headers.get(API_SECRET_HEADER, "")
    return compare_digest(provided.encode(), settings.api_secret.encode())


async def require_api_secret(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Deny by default, so every route is protected without having to opt in."""
    if not _is_authorized(request):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    return await call_next(request)
