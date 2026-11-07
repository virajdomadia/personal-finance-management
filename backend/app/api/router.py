from fastapi import APIRouter

from app.api.routes import accounts, auth, health

api_router = APIRouter()
api_router.include_router(auth.public_router)
api_router.include_router(auth.router)
api_router.include_router(accounts.router)
api_router.include_router(health.router)
