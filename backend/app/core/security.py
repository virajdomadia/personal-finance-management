import hashlib
import hmac
import time
from base64 import urlsafe_b64encode
from collections.abc import Awaitable, Callable
from secrets import compare_digest

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from app.core.config import get_settings

API_SECRET_HEADER = "X-API-Secret"
BEARER_PREFIX = "Bearer "
TOKEN_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

_KEY_LENGTH = 64


def verify_password(password: str, stored: str) -> bool:
    """Checks a "salt:key" hex hash, as made by frontend/scripts/hash-password.mjs."""
    salt_hex, _, key_hex = stored.partition(":")
    try:
        salt = bytes.fromhex(salt_hex)
        key = bytes.fromhex(key_hex)
    except ValueError:
        return False
    if not salt or len(key) != _KEY_LENGTH:
        return False
    # These parameters are Node's scrypt defaults, which the hash script uses.
    derived = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=_KEY_LENGTH)
    return compare_digest(derived, key)


def _sign(expiry: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), expiry.encode(), hashlib.sha256).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode()


def create_token(secret: str, now: float | None = None) -> str:
    """A token is "expirySeconds.signature"; holding a valid one means the password was entered."""
    expiry = str(int(time.time() if now is None else now) + TOKEN_MAX_AGE_SECONDS)
    return f"{expiry}.{_sign(expiry, secret)}"


def is_valid_token(token: str, secret: str, now: float | None = None) -> bool:
    if not secret:
        return False
    expiry, _, signature = token.partition(".")
    if not compare_digest(signature.encode(), _sign(expiry, secret).encode()):
        return False
    # The signature matched, so we issued this expiry and it is safe to parse.
    return (time.time() if now is None else now) < int(expiry)


def _is_authorized(request: Request) -> bool:
    settings = get_settings()
    public_paths = {f"{settings.api_prefix}/health", f"{settings.api_prefix}/auth/login"}
    if request.url.path in public_paths:
        return True

    authorization = request.headers.get("Authorization", "")
    if authorization.startswith(BEARER_PREFIX) and is_valid_token(
        authorization.removeprefix(BEARER_PREFIX), settings.token_secret
    ):
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
