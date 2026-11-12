from fastapi import APIRouter

from app.api.routes import (
    accounts,
    auth,
    coins,
    cron,
    crypto_trades,
    dashboard,
    deposits,
    fund_trades,
    funds,
    goals,
    health,
    market,
    policies,
    portfolio,
    recurring,
    setup,
    sips,
    sms,
    stocks,
    streak,
    trades,
    transactions,
)

api_router = APIRouter()
api_router.include_router(auth.public_router)
api_router.include_router(auth.router)
api_router.include_router(accounts.router)
api_router.include_router(deposits.router)
api_router.include_router(dashboard.router)
api_router.include_router(streak.router)
api_router.include_router(setup.router)
api_router.include_router(transactions.router)
api_router.include_router(sms.router)
api_router.include_router(sms.rules_router)
api_router.include_router(funds.router)
api_router.include_router(fund_trades.router)
api_router.include_router(sips.router)
api_router.include_router(recurring.router)
api_router.include_router(policies.router)
api_router.include_router(goals.router)
api_router.include_router(stocks.router)
api_router.include_router(coins.router)
api_router.include_router(market.router)
api_router.include_router(crypto_trades.router)
api_router.include_router(trades.router)
api_router.include_router(portfolio.router)
api_router.include_router(health.router)
api_router.include_router(cron.router)
