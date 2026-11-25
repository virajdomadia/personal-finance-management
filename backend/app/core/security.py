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
    # The sign-in (`sessions` row) the token belongs to. None for a token issued before sessions.
    session_id: int | None = None


def _sign(payload: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode()


def create_token(
    user_id: int,
    session_version: int,
    secret: str,
    now: float | None = None,
    session_id: int | None = None,
) -> str:
    """A token is "userId.sessionVersion.sessionId.expirySeconds.signature", signed over what
    precedes it. Without a session id it is the older "userId.sessionVersion.expirySeconds.
    signature", which is still accepted until it expires."""
    expiry = int(time.time() if now is None else now) + TOKEN_MAX_AGE_SECONDS
    fields = [user_id, session_version, *([] if session_id is None else [session_id]), expiry]
    payload = ".".join(str(field) for field in fields)
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
    if len(parts) not in (4, 5):
        return None
    numbers = [_number(part) for part in parts[:-1]]
    if any(n is None for n in numbers):
        return None
    payload = ".".join(parts[:-1])
    if not compare_digest(parts[-1].encode(), _sign(payload, secret).encode()):
        return None
    user_id, session_version, *session, expires_at = (n for n in numbers if n is not None)
    if (time.time() if now is None else now) >= expires_at:
        return None
    return TokenClaims(user_id, session_version, expires_at, session[0] if session else None)


def bearer_token(request: Request) -> str:
    authorization = request.headers.get("Authorization", "")
    return (
        authorization.removeprefix(BEARER_PREFIX) if authorization.startswith(BEARER_PREFIX) else ""
    )


def _is_authorized(request: Request) -> bool:
    settings = get_settings()
    public_paths = {
        f"{settings.api_prefix}/health",
        f"{settings.api_prefix}/auth/google",
        f"{settings.api_prefix}/cron/prices",  # checks its own secret
    }
    if request.url.path in public_paths:
        return True

    if not settings.token_secret:
        # Local dev runs without a secret; production must never fall open.
        return settings.environment == "development"
    return parse_token(bearer_token(request), settings.token_secret) is not None


async def require_token(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Deny by default, so every route is protected without having to opt in."""
    if not _is_authorized(request):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)
    return await call_next(request)
