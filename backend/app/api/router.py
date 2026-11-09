from fastapi import APIRouter

from app.api.routes import (
    accounts,
    auth,
    coins,
    crypto_trades,
    dashboard,
    deposits,
    fund_trades,
    funds,
    health,
    portfolio,
    sips,
    stocks,
    trades,
    transactions,
)

api_router = APIRouter()
api_router.include_router(auth.public_router)
api_router.include_router(auth.router)
api_router.include_router(accounts.router)
api_router.include_router(deposits.router)
api_router.include_router(dashboard.router)
api_router.include_router(transactions.router)
api_router.include_router(funds.router)
api_router.include_router(fund_trades.router)
api_router.include_router(sips.router)
api_router.include_router(stocks.router)
api_router.include_router(coins.router)
api_router.include_router(crypto_trades.router)
api_router.include_router(trades.router)
api_router.include_router(portfolio.router)
api_router.include_router(health.router)
