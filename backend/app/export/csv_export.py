"""The user's data as spreadsheets: one CSV per entity, zipped.

Human headers, names instead of ids, plain numbers (1234.50: no ₹, no Indian grouping), ISO
dates, UTF-8 with a byte order mark so Excel reads ₹ and non-English names.
"""

import csv
import io
import zipfile
from collections.abc import Iterable
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.deposits import deposit_figures
from app.api.goals import load_goal_book, load_goal_tags
from app.api.loans import load_book
from app.api.routes.accounts import list_sort_key, to_response
from app.models.account import Account
from app.models.budget import Budget
from app.models.category import Category
from app.models.insurance import InsurancePolicy
from app.models.investment import Instrument, InvestmentTrade, Sip
from app.models.recurring import RecurringTemplate
from app.models.snapshot import NetWorthSnapshot
from app.models.transaction import Transaction

TYPE_NAMES = {
    "bank": "Bank",
    "credit_card": "Credit card",
    "cash": "Cash",
    "broker": "Broker",
    "wallet": "Wallet",
    "ppf": "PPF",
    "rd": "RD",
    "loan": "Loan",
}


def cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, Decimal):
        return format(value + 0, "f")
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def money(value: Decimal | None) -> str:
    return "" if value is None else f"{value + 0:.2f}"


def amount(value: Decimal | None) -> str:
    """A quantity or price as stored, without trailing zeros past the paise."""
    if value is None:
        return ""
    text = format(value.normalize() + 0, "f")
    whole, _, fraction = text.partition(".")
    return f"{whole}.{fraction.ljust(2, '0')}"


def to_csv(headers: list[str], rows: Iterable[list[Any]]) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(headers)
    for row in rows:
        writer.writerow([v if isinstance(v, str) else cell(v) for v in row])
    return ("﻿" + out.getvalue()).encode("utf-8")


def build_zip(db: Session, user_id: int) -> bytes:
    files = spreadsheets(db, user_id)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return out.getvalue()


def spreadsheets(db: Session, user_id: int) -> dict[str, bytes]:
    accounts = sorted(
        db.scalars(select(Account).where(Account.user_id == user_id)).all(), key=list_sort_key
    )
    names = {a.id: a.name for a in accounts}
    return {
        "accounts.csv": _accounts(db, user_id, accounts, names),
        "transactions.csv": _transactions(db, user_id, names),
        "stock_trades.csv": _trades(db, user_id, names, "stock"),
        "fund_trades.csv": _trades(db, user_id, names, "mutual_fund"),
        "crypto_trades.csv": _trades(db, user_id, names, "crypto"),
        "sips.csv": _sips(db, user_id, names),
        "loans.csv": _loans(db, user_id, accounts, names),
        "deposits.csv": _deposits(db, user_id, accounts, names),
        "goals.csv": _goals(db, user_id),
        "insurance_policies.csv": _policies(db, user_id, names),
        "recurring_templates.csv": _templates(db, user_id, names),
        "budgets.csv": _budgets(db, user_id),
        "categories.csv": _categories(db, user_id),
        "net_worth_history.csv": _net_worth(db, user_id),
    }


def _accounts(db: Session, user_id: int, accounts: list[Account], names: dict[int, str]) -> bytes:
    book = load_book(db, user_id, accounts)
    tags = load_goal_tags(db, user_id)
    headers = [
        "Name", "Type", "Institution", "Bank account kind", "Last 4 digits", "Balance",
        "Credit limit", "Available credit", "Statement day", "Due day", "Interest rate (%)",
        "Set aside for goals", "Archived",
    ]  # fmt: skip
    rows = []
    for a in accounts:
        r = to_response(a, book, tags)
        rows.append(
            [
                a.name, TYPE_NAMES.get(a.type, a.type), a.institution, a.bank_kind, a.last4,
                r.balance, r.credit_limit or "", r.available_credit or "", a.statement_day,
                a.due_day, money(a.interest_rate), r.set_aside, a.archived_at is not None,
            ]
        )  # fmt: skip
    return to_csv(headers, rows)


def _transactions(db: Session, user_id: int, names: dict[int, str]) -> bytes:
    found = db.scalars(
        select(Transaction)
        .where(Transaction.user_id == user_id)
        .order_by(Transaction.date, Transaction.id)
    )
    templates = dict(
        db.execute(
            select(RecurringTemplate.id, RecurringTemplate.name).where(
                RecurringTemplate.user_id == user_id
            )
        ).all()
    )
    headers = [
        "Date", "Type", "Amount", "Account", "To account", "Category", "Interest",
        "Note", "Recurring reminder", "Source",
    ]  # fmt: skip
    rows = [
        [
            t.date,
            t.type,
            money(t.amount),
            names.get(t.account_id, ""),
            names.get(t.to_account_id, "") if t.to_account_id else "",
            t.category,
            money(t.interest),
            t.note,
            templates.get(t.recurring_template_id, "") if t.recurring_template_id else "",
            t.source,
        ]  # fmt: skip
        for t in found
    ]
    return to_csv(headers, rows)


QUANTITY = {"stock": "Shares", "mutual_fund": "Units", "crypto": "Quantity"}
PRICE = {"stock": "Price", "mutual_fund": "NAV", "crypto": "Price"}


def _trades(db: Session, user_id: int, names: dict[int, str], kind: str) -> bytes:
    found = db.execute(
        select(InvestmentTrade, Instrument)
        .join(Instrument, Instrument.id == InvestmentTrade.instrument_id)
        .where(InvestmentTrade.user_id == user_id, Instrument.kind == kind)
        .order_by(InvestmentTrade.date, InvestmentTrade.id)
    ).all()
    headers = [
        "Date", "Side", "Symbol", "Name", QUANTITY[kind], PRICE[kind], "Charges", "Amount",
        "Account", "Held before using the app", "Estimated", "From SIP", "Note",
    ]  # fmt: skip
    rows = [
        [
            t.date,
            t.side,
            i.symbol,
            i.name,
            amount(t.quantity),
            amount(t.price),
            money(t.charges),
            money(t.amount),
            names.get(t.account_id, ""),
            t.opening,
            t.estimated,
            t.sip_id is not None,
            t.note,
        ]  # fmt: skip
        for t, i in found
    ]
    return to_csv(headers, rows)


def _sips(db: Session, user_id: int, names: dict[int, str]) -> bytes:
    found = db.execute(
        select(Sip, Instrument)
        .join(Instrument, Instrument.id == Sip.instrument_id)
        .where(Sip.user_id == user_id)
        .order_by(Sip.id)
    ).all()
    headers = ["Fund", "Amount", "Day of month", "Start date", "Paid from", "Active"]
    rows = [
        [i.name, money(s.amount), s.day, s.start_date, names.get(s.account_id, ""), s.active]
        for s, i in found
    ]
    return to_csv(headers, rows)


def _loans(db: Session, user_id: int, accounts: list[Account], names: dict[int, str]) -> bytes:
    loans = [a for a in accounts if a.type == "loan"]
    book = load_book(db, user_id, accounts)
    tags = load_goal_tags(db, user_id)
    headers = [
        "Name", "Lender", "Outstanding", "Interest rate (%)", "EMI", "EMIs left",
        "Next EMI interest", "Next EMI principal", "EMI paid from", "Archived",
    ]  # fmt: skip
    rows = []
    for a in loans:
        r = to_response(a, book, tags)
        nxt = r.next_emi
        rows.append(
            [
                a.name, a.institution, r.balance, money(a.interest_rate), money(a.emi_amount),
                r.emis_left, (nxt.interest or "") if nxt else "",
                (nxt.principal or "") if nxt else "",
                names.get(a.pay_from_id, "") if a.pay_from_id else "", a.archived_at is not None,
            ]
        )  # fmt: skip
    return to_csv(headers, rows)


def _deposits(db: Session, user_id: int, accounts: list[Account], names: dict[int, str]) -> bytes:
    deposits = [a for a in accounts if a.type in ("ppf", "rd")]
    book = load_book(db, user_id, accounts)
    tags = load_goal_tags(db, user_id)
    today = today_india()
    headers = [
        "Name", "Type", "Institution", "Balance", "Interest rate (%)", "Opened on",
        "Maturity date", "Monthly instalment", "Tenure (months)", "Paid from", "Archived",
    ]  # fmt: skip
    rows = []
    for a in deposits:
        r = to_response(a, book, tags)
        figures = deposit_figures(a, book, today)
        rows.append(
            [
                a.name, TYPE_NAMES[a.type], a.institution, r.balance, money(a.interest_rate),
                a.opened_on, figures.maturity_date if figures else "", money(a.deposit_amount),
                a.tenure_months, names.get(a.pay_from_id, "") if a.pay_from_id else "",
                a.archived_at is not None,
            ]
        )  # fmt: skip
    return to_csv(headers, rows)


def _goals(db: Session, user_id: int) -> bytes:
    book = load_goal_book(db, user_id, today_india())
    headers = [
        "Name", "Kind", "Target", "Target date", "Saved", "Set aside from accounts",
        "Monthly amount", "Reminder day", "Note", "Archived",
    ]  # fmt: skip
    rows = [
        [
            g.name,
            "Emergency fund" if g.kind == "emergency" else "Goal",
            g.target or "",
            g.target_date,
            g.saved,
            g.earmarked,
            g.monthly_amount or "",
            g.reminder_day,
            g.note,
            g.archived,
        ]  # fmt: skip
        for g in book.responses.values()
    ]
    return to_csv(headers, rows)


def _policies(db: Session, user_id: int, names: dict[int, str]) -> bytes:
    found = db.execute(
        select(InsurancePolicy, RecurringTemplate)
        .join(RecurringTemplate, RecurringTemplate.id == InsurancePolicy.template_id)
        .where(InsurancePolicy.user_id == user_id)
        .order_by(InsurancePolicy.id)
    ).all()
    headers = [
        "Kind", "Insurer", "Plan", "Policy number", "Insured", "Sum insured", "Premium",
        "Cover from", "Cover to", "Premium paid from", "Funded by", "Active", "Details",
    ]  # fmt: skip
    rows = [
        [
            p.kind,
            p.insurer,
            p.plan,
            p.policy_number,
            p.insured,
            money(p.sum_insured),
            money(p.premium),
            p.period_start,
            p.period_end,
            names.get(t.account_id, ""),
            names.get(p.funded_by_id, "") if p.funded_by_id else "",
            p.active,
            p.details,
        ]  # fmt: skip
        for p, t in found
    ]
    return to_csv(headers, rows)


def _templates(db: Session, user_id: int, names: dict[int, str]) -> bytes:
    found = db.scalars(
        select(RecurringTemplate)
        .where(RecurringTemplate.user_id == user_id)
        .order_by(RecurringTemplate.name, RecurringTemplate.id)
    )
    headers = [
        "Name", "Type", "Amount", "Account", "To account", "Category", "Frequency",
        "Day of month", "Month", "Start date", "End date", "Remind days before", "Active", "Note",
    ]  # fmt: skip
    rows = [
        [
            t.name,
            t.type,
            money(t.amount),
            names.get(t.account_id, ""),
            names.get(t.to_account_id, "") if t.to_account_id else "",
            t.category,
            t.frequency,
            t.day,
            t.month,
            t.start_date,
            t.end_date,
            t.remind_days,
            t.active,
            t.note,
        ]  # fmt: skip
        for t in found
    ]
    return to_csv(headers, rows)


def _category_names(db: Session, user_id: int) -> dict[int, Category]:
    rows = db.scalars(select(Category).where(Category.user_id == user_id).order_by(Category.id))
    return {c.id: c for c in rows}


def _budgets(db: Session, user_id: int) -> bytes:
    categories = _category_names(db, user_id)
    found = db.scalars(
        select(Budget).where(Budget.user_id == user_id).order_by(Budget.effective_from, Budget.id)
    )
    headers = ["Category", "From month", "Monthly budget"]
    rows = [
        [
            categories[b.category_id].name if b.category_id in categories else "",
            b.effective_from.strftime("%Y-%m"),
            "No budget" if b.amount is None else money(b.amount),
        ]
        for b in found
    ]
    return to_csv(headers, rows)


def _categories(db: Session, user_id: int) -> bytes:
    categories = _category_names(db, user_id)

    def name(id_: int | None) -> str:
        return categories[id_].name if id_ in categories else ""

    headers = ["Kind", "Name", "Parent", "Merged into", "Icon", "Colour", "Archived"]
    rows = [
        [
            c.kind,
            c.name,
            name(c.parent_id),
            name(c.merged_into_id),
            c.icon,
            c.colour,
            c.archived_at is not None,
        ]
        for c in sorted(categories.values(), key=lambda c: (c.kind, c.name.casefold(), c.id))
    ]
    return to_csv(headers, rows)


def _net_worth(db: Session, user_id: int) -> bytes:
    found = db.scalars(
        select(NetWorthSnapshot)
        .where(NetWorthSnapshot.user_id == user_id)
        .order_by(NetWorthSnapshot.date)
    )
    headers = [
        "Date", "Net worth", "Have", "Owe", "Bank and cash", "Deposits", "Stocks",
        "Mutual funds", "Crypto", "Estimated",
    ]  # fmt: skip
    rows = [
        [
            n.date, money(n.net_worth), money(n.total_have), money(n.total_owe),
            money(n.bank_cash), money(n.deposits), money(n.stocks), money(n.funds),
            money(n.crypto), n.estimated,
        ]  # fmt: skip
        for n in found
    ]
    return to_csv(headers, rows)
