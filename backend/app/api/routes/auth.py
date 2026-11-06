from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.core.config import get_settings
from app.core.security import create_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    password: str


class LoginResponse(BaseModel):
    token: str


class SessionResponse(BaseModel):
    authenticated: bool


@router.post("/login")
def login(body: LoginRequest) -> LoginResponse:
    settings = get_settings()
    if (
        not settings.app_password_hash
        or not settings.token_secret
        or not verify_password(body.password, settings.app_password_hash)
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect password.")
    return LoginResponse(token=create_token(settings.token_secret))


@router.get("/session")
def session() -> SessionResponse:
    """Lets a client check its credentials; the middleware has already rejected bad ones."""
    return SessionResponse(authenticated=True)
