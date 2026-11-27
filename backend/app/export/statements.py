"""A bank or card statement, from any bank, into transactions for one account.

Reading (`read_statement`): the file becomes a grid (`statement_files`), the header row is found
by the names banks give their columns (Txn Date / Value Date, Narration / Particulars,
Withdrawal / Debit, Deposit / Credit, or one Amount column with Dr/Cr), and each row after it
becomes a line: a date, the narration, an amount and whether money went out or came in. Rows
without a date and an amount (opening balance, page footers) are left out; a row with only text
continues the narration above it, as PDFs wrap long narrations.

Suggesting (`suggest`): the payee is pulled out of the narration (`UPI/…/SWIGGY/…` → Swiggy),
then the owner's payee rules, the built-in merchant list, and their own card and account
numbers suggest a category or a transfer. A line matching a saved transaction of the account
(same direction and amount, dated within a day) is a duplicate.

Saving (`save_lines`): the lines the owner kept, as edited, under the same rules as a
transaction typed in by hand, saved together or not at all. Imported rows have source
"statement"; a category may be left empty, as for an SMS.
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi.exceptions import RequestValidationError
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.balances import (
    HISTORY,
    Movement,
    load_movements,
    move_openings,
    net_flows,
    opening_held,
)
from app.api.categories import current_name, kind_of, resolve
from app.api.dates import today_india
from app.api.routes.transactions import lock_accounts, validate_transaction_values
from app.export.importing import FileProblem, changes_problem, rule_errors
from app.export.statement_files import Grid, cell_text
from app.models.account import Account
from app.models.sms import PayeeRule
from app.models.transaction import Transaction
from app.sms.merchants import builtin_category
from app.sms.payees import display_name, payee_key

SOURCE = "statement"
MAX_LINES = 3000
HEADER_SCAN = 60  # rows looked at for the header: statements open with the account's details
NOTE_LIMIT = 200
DUPLICATE_WINDOW = timedelta(days=1)
NEAR_AMOUNT = Decimal(1)  # a typed amount rounded off still matches the bank's

# Column names as banks write them, after `_norm`. The first name found for a role wins, so
# the transaction date comes before the value date.
ROLES: dict[str, tuple[str, ...]] = {
    "date": (
        "txn date", "transaction date", "tran date", "trans date", "date", "posting date",
        "value date", "value dt", "date of transaction", "txn dt",
    ),
    "narration": (
        "narration", "description", "particulars", "transaction details", "details",
        "transaction remarks", "remarks", "transaction description", "description narration",
        "transaction particulars",
    ),
    "debit": (
        "withdrawal amt", "withdrawal amount", "withdrawal", "withdrawals", "debit amount",
        "debit", "debits", "dr amount", "dr", "paid out", "amount debited", "withdrawal dr",
        "debit amt",
    ),
    "credit": (
        "deposit amt", "deposit amount", "deposit", "deposits", "credit amount", "credit",
        "credits", "cr amount", "cr", "paid in", "amount credited", "deposit cr", "credit amt",
    ),
    "amount": ("amount", "transaction amount", "amt", "txn amount"),
    "drcr": ("dr cr", "cr dr", "debit credit", "type", "transaction type", "dr or cr"),
    "balance": ("balance", "closing balance", "available balance", "running balance"),
}  # fmt: skip
_UNITS = re.compile(r"\((?:inr|rs|₹)\)|\b(?:inr|rs)\b|₹")


def _norm(header: Any) -> str:
    text = _UNITS.sub(" ", cell_text(header).casefold())
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


@dataclass
class Columns:
    header_row: int
    date: int
    narration: int | None
    debit: int | None
    credit: int | None
    amount: int | None
    drcr: int | None
    balance: int | None


def find_columns(grid: Grid) -> Columns:
    for index, row in enumerate(grid[:HEADER_SCAN]):
        names = [_norm(c) for c in row]
        found: dict[str, int] = {}
        for role, options in ROLES.items():
            for option in options:
                if option in names and names.index(option) not in found.values():
                    found[role] = names.index(option)
                    break
        has_money = ("debit" in found and "credit" in found) or "amount" in found
        if "date" in found and has_money:
            return Columns(
                index,
                found["date"],
                found.get("narration"),
                found.get("debit"),
                found.get("credit"),
                found.get("amount"),
                found.get("drcr"),
                found.get("balance"),
            )
    raise FileProblem(
        "Couldn't find the statement's columns. It needs a date column and either withdrawal "
        "and deposit columns or an amount column."
    )


# Cells

_MONTHS = {
    m: i
    for i, names in enumerate(
        [
            ("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"),
            ("may",), ("jun", "june"), ("jul", "july"), ("aug", "august"),
            ("sep", "sept", "september"), ("oct", "october"), ("nov", "november"),
            ("dec", "december"),
        ],
        start=1,
    )
    for m in names
}  # fmt: skip
_NUMERIC_DATE = re.compile(r"(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{4}|\d{2})(?!\d)")
_NAMED_DATE = re.compile(r"(\d{1,2})[/.\- ]?([A-Za-z]{3,9})[/.\-, ]*(\d{4}|\d{2})(?!\d)")
_NAMED_FIRST = re.compile(r"([A-Za-z]{3,9})[ .\-]+(\d{1,2}),?[ \-]+(\d{4})(?!\d)")
_ISO = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


def parse_date(value: Any) -> date | None:
    """A statement date, day first as Indian banks write it. None when the cell isn't one."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = cell_text(value)
    if not text:
        return None
    head = text.split()[0] if _ISO.match(text) else text
    try:
        if m := _ISO.match(head):
            return date(int(m[1]), int(m[2]), int(m[3]))
        if m := _NUMERIC_DATE.match(text):
            day, month, year = int(m[1]), int(m[2]), int(m[3])
        elif (m := _NAMED_DATE.match(text)) and m[2].casefold() in _MONTHS:
            day, month, year = int(m[1]), _MONTHS[m[2].casefold()], int(m[3])
        elif (m := _NAMED_FIRST.match(text)) and m[1].casefold() in _MONTHS:
            day, month, year = int(m[2]), _MONTHS[m[1].casefold()], int(m[3])
        else:
            return None
        return date(year + 2000 if year < 100 else year, month, day)
    except ValueError:
        return None


_DR = re.compile(r"\b(dr|debit|d)\.?$", re.I)
_CR = re.compile(r"\b(cr|credit|c)\.?$", re.I)


def parse_amount(value: Any) -> tuple[Decimal, str | None] | None:
    """(amount, "out"/"in" when the cell says so) or None for an empty cell.

    Raises ValueError for a cell that isn't a number."""
    if isinstance(value, bool):
        raise ValueError
    if isinstance(value, int | float):
        number = Decimal(repr(value)) if isinstance(value, float) else Decimal(value)
        return (abs(number), "out" if number < 0 else None) if number else None
    text = cell_text(value)
    if text in ("", "-", "--", "0", "0.00", "nil", "NIL"):
        return None
    side = None
    if _DR.search(text):
        side, text = "out", _DR.sub("", text)
    elif _CR.search(text):
        side, text = "in", _CR.sub("", text)
    text = text.replace(",", "").replace("₹", "").replace("INR", "").replace("Rs.", "").strip()
    if text.startswith("(") and text.endswith(")"):
        side, text = "out", text[1:-1]
    if text.startswith("-"):
        side, text = side or "out", text[1:]
    elif text.startswith("+"):
        side, text = side or "in", text[1:]
    try:
        number = Decimal(text.strip())
    except InvalidOperation:
        raise ValueError from None
    return (number, side) if number else None


@dataclass
class Line:
    number: int  # 1-based row in the file, for messages
    date: date
    narration: str
    amount: Decimal
    direction: str  # "out" | "in"
    balance: str | None = None
    errors: list[str] = field(default_factory=list)


_FOOTERS = (
    "statement summary", "opening balance", "closing balance", "total", "grand total",
    "page ", "this is a computer", "generated on", "*** end", "end of statement",
)  # fmt: skip


def read_lines(grid: Grid, columns: Columns) -> list[Line]:
    lines: list[Line] = []
    last_row = -1  # the grid row the last line (or its wrapped narration) ended on
    for index in range(columns.header_row + 1, len(grid)):
        row = grid[index]

        def at(column: int | None, row: list[Any] = row) -> Any:
            return row[column] if column is not None and column < len(row) else None

        narration = cell_text(at(columns.narration))
        day = parse_date(at(columns.date))
        try:
            debit = parse_amount(at(columns.debit))
            credit = parse_amount(at(columns.credit))
            single = parse_amount(at(columns.amount))
        except ValueError:
            if day is not None:
                lines.append(Line(index + 1, day, narration, Decimal(0), "out",
                                  errors=["The amount isn't a number."]))  # fmt: skip
            continue
        if day is None:
            # A wrapped narration carries on in the very next row, with no date or amount.
            follows = lines and last_row == index - 1
            if follows and narration and not (debit or credit or single):
                if narration.casefold().startswith(_FOOTERS):
                    last_row = -1
                else:
                    lines[-1].narration = f"{lines[-1].narration} {narration}".strip()
                    last_row = index
            continue
        if debit and credit:
            lines.append(Line(index + 1, day, narration, debit[0], "out",
                              errors=["Both a withdrawal and a deposit on one row."]))  # fmt: skip
            continue
        if debit:
            amount, direction = debit[0], "out"
        elif credit:
            amount, direction = credit[0], "in"
        elif single:
            amount = single[0]
            side = single[1]
            flag = cell_text(at(columns.drcr)).casefold()
            if flag.startswith(("dr", "debit", "d")) and flag not in ("deposit",):
                side = "out"
            elif flag.startswith(("cr", "credit", "c", "deposit")):
                side = "in"
            direction = side or "out"
        else:
            continue  # opening balance, a total, or a blank amount
        balance = cell_text(at(columns.balance)) or None
        lines.append(Line(index + 1, day, narration, amount, direction, balance))
        last_row = index
        if len(lines) > MAX_LINES:
            raise FileProblem(f"The statement has more than {MAX_LINES} transactions. Split it.")
    if not lines:
        raise FileProblem("Found the columns but no transactions under them.")
    return lines


def read_statement(grid: Grid) -> list[Line]:
    return read_lines(grid, find_columns(grid))


# The payee in a narration

_CHANNELS = {
    "upi", "dr", "cr", "neft", "imps", "rtgs", "pos", "ach", "nach", "ecs", "p2a", "p2m", "mb",
    "ib", "tpt", "inb", "mob", "bil", "billpay", "atm", "atw", "nwd", "eaw", "vps", "ips", "net",
    "ft", "trf", "transfer", "to", "by", "from", "payment", "paid", "via", "upiout", "upiin",
    "debit", "credit", "card", "txn", "ref", "inft", "clg", "chq", "cheque", "self", "rev",
    "upi in", "upi out", "collect", "pay", "sent", "received", "bank", "india", "ltd", "pvt",
    "wdl", "withdrawal", "cash",
}  # fmt: skip
_IFSC = re.compile(r"^[A-Za-z]{4}0[A-Za-z0-9]{6}$")
_BANK_CODE = re.compile(r"^[A-Z]{4}$")
_SPLIT = re.compile(r"[/|\\]+|\s+-\s+|-(?=\S)|:")
_MASKED = re.compile(r"[xX*]{3,}\d*")


def _is_noise(token: str) -> bool:
    t = token.strip(" .,*#")
    if len(t) < 3:
        return True
    letters = sum(c.isalpha() for c in t)
    digits = sum(c.isdigit() for c in t)
    return (
        t.casefold() in _CHANNELS
        or digits >= 5
        or digits > letters
        or bool(_IFSC.match(t))
        or bool(_BANK_CODE.match(t))
        or bool(_MASKED.search(t))
    )


_NOISE_WORDS = {"pvt", "ltd", "limited", "private", "india", "pay", "the", "and", "co"}


def _word_noise(word: str) -> bool:
    w = word.strip(" .,*#()")
    digits = sum(c.isdigit() for c in w)
    return (
        not w
        or w.casefold() in _CHANNELS
        or w.casefold() in _NOISE_WORDS
        or digits > len(w) / 2
        or (digits >= 2 and w.isalnum() and w.upper() == w)  # a terminal or reference code
        or bool(_MASKED.search(w))
        or bool(_IFSC.match(w))
    )


def narration_payee(narration: str) -> str | None:
    """The payee named in a narration, e.g. `UPI/DR/412345678901/SWIGGY/YESB/swiggy@yesb/Pay`
    → `SWIGGY`, `POS 5123XXXXXX1234 AMAZON PAY INDIA` → `AMAZON`; a UPI id when nothing else
    names them."""
    vpa = None
    for token in _SPLIT.split(narration):
        token = token.strip()
        if "@" in token:
            vpa = vpa or token
            continue
        if not token or token.casefold() in _CHANNELS or _IFSC.match(token):
            continue
        if _BANK_CODE.match(token) or (sum(c.isdigit() for c in token) >= 5 and " " not in token):
            continue
        words = [w for w in token.split() if not _word_noise(w)]
        name = " ".join(words)
        if sum(c.isalpha() for c in name) >= 3:
            return name
    return vpa


@dataclass
class Suggestion:
    payee: str | None
    type: str  # expense | income | transfer
    category: str | None
    other_account_id: int | None
    duplicate: bool


# Money in, by words in the narration: income categories every user has (the defaults).
_INCOME_WORDS = [
    (re.compile(r"\bsal(ary)?\b|\bpayroll\b", re.I), "Salary"),
    (re.compile(r"\bint(erest)?\.? ?(pd|paid|cr|credit)\b|\binterest\b", re.I), "Interest"),
    (re.compile(r"\bdiv(idend)?\b", re.I), "Dividends"),
    (re.compile(r"\brefund\b|\brev(ersal)?\b|\bcashback\b", re.I), "Refund"),
]


def income_category(narration: str) -> str | None:
    for pattern, category in _INCOME_WORDS:
        if pattern.search(narration):
            return category
    return None


# Cash taken out at an ATM: a transfer to the owner's cash account, not spending.
_ATM = re.compile(r"\b(atm|atw|nwd|eaw|cash ?wdl|wdl)\b", re.I)

_TRANSFER_WORDS = re.compile(
    r"credit ?card|cc ?payment|card ?payment|autopay|bill ?desk.*card|payment received|thank you",
    re.I,
)


def _own_account(narration: str, account: Account, others: list[Account]) -> Account | None:
    """Another of the owner's accounts named by its last 4 digits, as a masked number."""
    for other in others:
        if other.id == account.id or not other.last4 or other.archived_at is not None:
            continue
        if re.search(rf"(?:[xX*]+|\b){re.escape(other.last4)}\b", narration):
            return other
    return None


def suggest(db: Session, user_id: int, account: Account, lines: list[Line]) -> list[Suggestion]:
    accounts = list(db.scalars(select(Account).where(Account.user_id == user_id)))
    rules = {
        r.payee_key: r for r in db.scalars(select(PayeeRule).where(PayeeRule.user_id == user_id))
    }
    unmatched = _saved(db, user_id, account.id, lines)
    # Exact repeats first across the whole file, so a line a few paise off can't claim the
    # saved movement another line repeats exactly.
    exact = [_take(unmatched, line, exact=True) for line in lines]
    repeats = [e or _take(unmatched, line) for e, line in zip(exact, lines, strict=True)]

    found = []
    for line in lines:
        payee = narration_payee(line.narration) if line.narration else None
        key = payee_key(payee) if payee else None
        rule = rules.get(key) if key else None
        kind = "expense" if line.direction == "out" else "income"
        category, other = None, None
        if rule is not None and rule.to_account_id is not None:
            kind, other = "transfer", rule.to_account_id
        elif rule is not None and rule.category is not None:
            category = rule.category
        else:
            own = _own_account(line.narration, account, accounts)
            if own is None and line.direction == "out" and _ATM.search(line.narration):
                own = next(
                    (a for a in accounts if a.type == "cash" and a.archived_at is None), None
                )
            card_bill = account.type == "credit_card" and line.direction == "in"
            if own is not None or (card_bill and _TRANSFER_WORDS.search(line.narration)):
                kind, other = "transfer", own.id if own is not None else None
            elif line.direction == "out":
                category = builtin_category(key or "") or builtin_category(
                    line.narration.casefold()
                )
            else:
                category = income_category(line.narration)
                if category is not None:
                    # "Refund" is no longer a default; a user without it gets no suggestion.
                    category = current_name(db, user_id, "income", category)
        duplicate = repeats[len(found)]
        found.append(
            Suggestion(display_name(payee) if payee else None, kind, category, other, duplicate)
        )
    return found


def _saved(
    db: Session, user_id: int, account_id: int, lines: list[Line]
) -> list[tuple[date, Decimal, str]]:
    """The account's saved movements in the statement's dates (±1 day), as
    (date, amount, out/in), each to be matched at most once."""
    if not lines:
        return []
    start = min(line.date for line in lines) - DUPLICATE_WINDOW
    end = max(line.date for line in lines) + DUPLICATE_WINDOW
    found = []
    for t in db.scalars(
        select(Transaction).where(
            Transaction.user_id == user_id,
            or_(Transaction.account_id == account_id, Transaction.to_account_id == account_id),
            Transaction.date >= start,
            Transaction.date <= end,
        )
    ):
        if t.account_id == account_id:
            money_in = t.type in ("income", "refund")
            found.append((t.date, t.amount, "in" if money_in else "out"))
        if t.to_account_id == account_id:
            found.append((t.date, t.amount - (t.interest or 0), "in"))
    return found


def _take(saved: list[tuple[date, Decimal, str]], line: Line, exact: bool = False) -> bool:
    """Removes and reports the saved movement this line repeats: the same amount, or else one
    within ₹1 (₹227 typed for a ₹227.05 payment), in the same direction within a day."""
    near = [
        i
        for i, (day, amount, direction) in enumerate(saved)
        if direction == line.direction
        and abs(amount - line.amount) < (Decimal("0.005") if exact else NEAR_AMOUNT)
        and abs((day - line.date).days) <= DUPLICATE_WINDOW.days
    ]
    if not near:
        return False
    exact = [i for i in near if saved[i][1] == line.amount]
    del saved[(exact or near)[0]]
    return True


# Saving


@dataclass
class Kept:
    """One line the owner kept, as they left it."""

    number: int
    date: date
    narration: str
    amount: Decimal
    direction: str
    type: str
    category: str | None
    other_account_id: int | None
    payee: str | None
    remember: bool


@dataclass
class SaveResult:
    errors: dict[int, list[str]]  # line number -> messages
    imported: int = 0
    rules_saved: int = 0


def _values(account_id: int, kept: Kept) -> dict[str, Any]:
    out = kept.direction == "out"
    transfer = kept.type == "transfer"
    note = " ".join(kept.narration.split())[:NOTE_LIMIT] or None
    return {
        "type": kept.type,
        "account_id": (account_id if out else kept.other_account_id) if transfer else account_id,
        "to_account_id": (kept.other_account_id if out else account_id) if transfer else None,
        "amount": kept.amount,
        "date": kept.date,
        "category": None if transfer else kept.category,
        "interest": None,
        "note": note,
        "recurring_template_id": None,
    }


def save_lines(db: Session, user_id: int, account_id: int, kept: list[Kept]) -> SaveResult:
    """Saves every kept line, or none if any breaks a rule. With `remember`, a line's category
    or transfer becomes the payee's rule, as To review does for an SMS."""
    all_ids = {account_id} | {k.other_account_id for k in kept if k.other_account_id}
    accounts = lock_accounts(db, user_id, all_ids)
    account = accounts.get(account_id)
    if account is None or account.archived_at is not None:
        raise RequestValidationError(
            [
                {
                    "loc": ("body", "account_id"),
                    "msg": "Choose an active account.",
                    "type": "value_error",
                }
            ]
        )
    flows = net_flows(load_movements(db, user_id))
    shifts: dict[int, Decimal] = {}  # account id -> money of lines its opening already holds
    result = SaveResult({})
    rows: list[Transaction] = []
    for line in kept:
        problems: list[str] = []
        if line.type not in ("expense", "income", "transfer"):
            problems.append("Type: use expense, income or transfer.")
        elif line.type == "expense" and line.direction == "in":
            problems.append("Type: money came in, so it's income or a transfer.")
        elif line.type == "income" and line.direction == "out":
            problems.append("Type: money went out, so it's an expense or a transfer.")
        elif line.type == "transfer" and line.other_account_id is None:
            problems.append("Choose the other account of this transfer.")
        if line.date > today_india():
            problems.append("Date: The date can't be in the future.")
        if problems:
            result.errors[line.number] = problems
            continue
        values = _values(account_id, line)
        try:
            validate_transaction_values(values, accounts, allow_uncategorised=True)
            if values["category"] is not None:
                kind = kind_of(values["type"]) or "expense"
                values["category"] = resolve(db, user_id, kind, values["category"])
        except RequestValidationError as error:
            result.errors[line.number] = rule_errors(error)
            continue
        movement = Movement(
            0, values["type"], values["amount"], values["account_id"], values["to_account_id"]
        )
        # A line from on or before an account's added day is already in its opening balance.
        before = opening_held(line.date, movement, accounts)
        moving = {a: c for a, c in net_flows([movement]).items() if a not in before}
        problem = changes_problem(accounts, flows, moving)
        if problem:
            result.errors[line.number] = [f"Amount: {problem}"]
            continue
        for changed, change in moving.items():
            flows[changed] = flows.get(changed, Decimal(0)) + change
        for changed, change in before.items():
            shifts[changed] = shifts.get(changed, Decimal(0)) + change
        source = HISTORY if before else SOURCE
        rows.append(Transaction(user_id=user_id, source=source, **values))
        if line.remember and line.payee:
            result.rules_saved += _remember(db, user_id, line, values)

    if result.errors or not rows:
        db.rollback()
        result.rules_saved = 0
        return result
    move_openings(accounts, shifts, 1)
    db.add_all(rows)
    db.commit()
    result.imported = len(rows)
    return result


def _remember(db: Session, user_id: int, line: Kept, values: dict[str, Any]) -> int:
    assert line.payee is not None
    key = payee_key(line.payee)[:120]
    rule = db.scalar(
        select(PayeeRule).where(PayeeRule.user_id == user_id, PayeeRule.payee_key == key)
    )
    if rule is None:
        rule = PayeeRule(user_id=user_id, payee_key=key, display=line.payee[:120])
        db.add(rule)
    if line.type == "transfer":
        rule.category, rule.to_account_id = None, line.other_account_id
    elif values["category"] is not None:
        rule.category, rule.to_account_id = values["category"], None
    else:
        return 0
    db.flush()
    return 1
