import hashlib
import hmac
import time
from base64 import urlsafe_b64encode
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from secrets import compare_digest

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from app.core.config import get_settings

BEARER_PREFIX = "Bearer "
TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

# Longer than any real id, expiry or version, and under Python's int-parsing digit limit.
_MAX_NUMBER_DIGITS = 20


@dataclass(frozen=True)
class TokenClaims:
    user_id: int
    session_version: int
    expires_at: int


def _sign(payload: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode()


def create_token(user_id: int, session_version: int, secret: str, now: float | None = None) -> str:
    """A token is "userId.sessionVersion.expirySeconds.signature", signed over what precedes it."""
    expiry = int(time.time() if now is None else now) + TOKEN_MAX_AGE_SECONDS
    payload = f"{user_id}.{session_version}.{expiry}"
    return f"{payload}.{_sign(payload, secret)}"


def _number(text: str) -> int | None:
    if not text.isascii() or not text.isdecimal() or len(text) > _MAX_NUMBER_DIGITS:
        return None
    return int(text)


def parse_token(token: str, secret: str, now: float | None = None) -> TokenClaims | None:
    """Returns the claims of a genuine, unexpired token, or None for anything else."""
    if not secret:
        return None
    parts = token.split(".")
    if len(parts) != 4:
        return None
    user_id, session_version, expires_at = (_number(part) for part in parts[:3])
    if user_id is None or session_version is None or expires_at is None:
        return None
    payload = ".".join(parts[:3])
    if not compare_digest(parts[3].encode(), _sign(payload, secret).encode()):
        return None
    if (time.time() if now is None else now) >= expires_at:
        return None
    return TokenClaims(user_id, session_version, expires_at)


def bearer_token(request: Request) -> str:
    authorization = request.headers.get("Authorization", "")
    return (
        authorization.removeprefix(BEARER_PREFIX) if authorization.startswith(BEARER_PREFIX) else ""
    )


def _is_authorized(request: Request) -> bool:
    settings = get_settings()
    public_paths = {f"{settings.api_prefix}/health", f"{settings.api_prefix}/auth/google"}
    if request.url.path in public_paths:
        return True

    if not settings.token_secret:
        # Local dev runs without a secret; production must never fall open.
        return settings.environment != "production"
    return parse_token(bearer_token(request), settings.token_secret) is not None


async def require_token(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Deny by default, so every route is protected without having to opt in."""
    if not _is_authorized(request):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    return await call_next(request)
