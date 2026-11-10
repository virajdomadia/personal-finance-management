"""Insurance policies: a record of cover, with a yearly reminder for its premium.

A policy holds no money and isn't in net worth. Its premium is reminded by a yearly expense
template that stays in step with it (amount, paying account, renewal day). Each paid period is a
`PolicyPeriod`; renewing records the premium as an ordinary expense linked to the template and
moves the policy to the new period, all in one database transaction.
"""

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deposits import add_months, financial_year, fy_label, rd_maturity, rd_maturity_value
from app.api.deps import CurrentUser, get_current_user
from app.api.policy_periods import payments
from app.api.recurring import card_bill_due
from app.api.routes.accounts import MAX_ID, Money, clean_text, field_error, fmt
from app.api.routes.dashboard import today_india
from app.api.routes.recurring import (
    DEFAULT_REMIND,
    TemplateResponse,
    check_template_values,
    template_responses,
)
from app.api.routes.stocks import Deleted
from app.api.routes.transactions import AccountRef, Day, lock_accounts, save_checks
from app.db.session import DbSession
from app.models.account import Account
from app.models.insurance import InsurancePolicy, PolicyPeriod
from app.models.recurring import RecurringSkip, RecurringTemplate
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/insurance", tags=["insurance"], dependencies=[Depends(get_current_user)]
)

KINDS = ("health",)
CATEGORY = "Insurance"
_NOT_FOUND = "Policy not found."
_BAD_KIND = "Choose health."
_BAD_PERIOD = "The period must end after it starts, within a year."
_FUTURE = "The date can't be in the future."
_CHOOSE_ACCOUNT = "Choose an account."
_CHOOSE_PAYMENT = "Choose a payment."
_TAKEN = "That payment already belongs to a policy."
_OVERLAP = "The new period must start after the current one ends."
# The template's name is "{insurer} premium" and must fit its 60 characters.
_INSURER_LIMIT = 52


def _kind(value: Any) -> Any:
    if value is not None and value not in KINDS:
        raise PydanticCustomError("kind", _BAD_KIND)
    return value


def _ref(message: str) -> Any:
    def check(value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise PydanticCustomError("ref", message)
        return value

    return check


def _text(message: str, limit: int) -> Any:
    return BeforeValidator(lambda v: clean_text(v, message, limit=limit))


Kind = Annotated[str | None, BeforeValidator(_kind)]
Insurer = Annotated[str | None, _text("Enter the insurer.", _INSURER_LIMIT)]
Plan = Annotated[str | None, _text("Enter the plan.", 100)]
PolicyNumber = Annotated[str | None, _text("Enter the policy number.", 40)]
Insured = Annotated[str | None, _text("Enter who is insured.", 100)]
Details = Annotated[str | None, _text("Enter the details.", 2000)]
FundRef = Annotated[int | None, BeforeValidator(_ref(_CHOOSE_ACCOUNT))]
PaymentRef = Annotated[int | None, BeforeValidator(_ref(_CHOOSE_PAYMENT))]

_REQUIRED = {
    "kind": _BAD_KIND,
    "insurer": "Enter the insurer.",
    "plan": "Enter the plan.",
    "policy_number": "Enter the policy number.",
    "insured": "Enter who is insured.",
    "sum_insured": "Enter the sum insured.",
    "period_start": "Choose the date the period starts.",
    "period_end": "Choose the date the period ends.",
    "premium": "Enter the premium.",
    "paid_on": "Choose the date it was paid.",
}


class PolicyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    kind: Kind = None
    insurer: Insurer = None
    plan: Plan = None
    policy_number: PolicyNumber = None
    insured: Insured = None
    sum_insured: Money = None
    period_start: Day = None
    period_end: Day = None
    premium: Money = None
    account_id: AccountRef = None
    funded_by_id: FundRef = None
    details: Details = None
    paid_on: Day = None
    transaction_id: PaymentRef = None


class PolicyUpdate(BaseModel):
    """The policy's own fields. Its kind is fixed; its history changes only by renewing."""

    model_config = ConfigDict(extra="forbid")

    insurer: Insurer = None
    plan: Plan = None
    policy_number: PolicyNumber = None
    insured: Insured = None
    sum_insured: Money = None
    period_start: Day = None
    period_end: Day = None
    premium: Money = None
    account_id: AccountRef = None
    funded_by_id: FundRef = None
    details: Details = None
    # Only for a period paid before the app; a recorded payment's date is the transaction's.
    paid_on: Day = None


class RenewBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: Day = None
    amount: Money = None
    account_id: AccountRef = None
    period_start: Day = None
    period_end: Day = None
    sum_insured: Money = None


class FundedBy(BaseModel):
    account_id: int
    name: str
    maturity_date: str | None
    maturity_estimate: str | None
    covers: bool | None
    shortfall: str | None


class CardBill(BaseModel):
    due: str
    before_funding: bool


class Period(BaseModel):
    period_start: str
    period_end: str
    premium: str
    sum_insured: str
    paid_on: str
    transaction_id: int | None


class FyPremium(BaseModel):
    fy: str
    amount: str


class PolicyResponse(BaseModel):
    id: int
    kind: str
    insurer: str
    plan: str
    policy_number: str
    insured: str
    sum_insured: str
    period_start: str
    period_end: str
    premium: str
    details: str | None
    active: bool
    template: TemplateResponse
    paying_account_id: int
    paying_account_name: str
    funded_by: FundedBy | None
    card_bill: CardBill | None
    periods: list[Period]
    premium_by_fy: list[FyPremium]
    days_to_renewal: int | None  # None once the policy has lapsed


class PolicyList(BaseModel):
    policies: list[PolicyResponse]


def _funded_by(account: Account | None, premium: Decimal) -> tuple[FundedBy | None, date | None]:
    """The funding line, and the RD's maturity date when it is an RD still open."""
    if account is None:
        return None, None
    opened, amount = account.opened_on, account.deposit_amount
    tenure, rate = account.tenure_months, account.interest_rate
    if (
        account.type != "rd"
        or account.archived_at is not None
        or opened is None
        or amount is None
        or tenure is None
        or rate is None
    ):
        return FundedBy(
            account_id=account.id,
            name=account.name,
            maturity_date=None,
            maturity_estimate=None,
            covers=None,
            shortfall=None,
        ), None
    matures = rd_maturity(opened, tenure)
    estimate = rd_maturity_value(amount, rate, tenure)
    covers = estimate >= premium
    return FundedBy(
        account_id=account.id,
        name=account.name,
        maturity_date=matures.isoformat(),
        maturity_estimate=fmt(estimate),
        covers=covers,
        shortfall=None if covers else fmt(premium - estimate),
    ), matures


def _card_bill(paying: Account, renewal: date, matures: date | None) -> CardBill | None:
    if paying.type != "credit_card" or paying.statement_day is None or paying.due_day is None:
        return None
    due = card_bill_due(renewal, paying.statement_day, paying.due_day)
    return CardBill(due=due.isoformat(), before_funding=matures is not None and due < matures)


def _responses(
    db: Session, user_id: int, today: date, ids: list[int] | None = None
) -> list[PolicyResponse]:
    """The user's policies (or just `ids`): active first, then by renewal date."""
    query = select(InsurancePolicy).where(InsurancePolicy.user_id == user_id)
    if ids is not None:
        query = query.where(InsurancePolicy.id.in_(ids))
    policies = sorted(db.scalars(query), key=lambda p: (not p.active, p.period_end, p.id))
    if not policies:
        return []
    templates = {
        t.id: t for t in template_responses(db, user_id, today, [p.template_id for p in policies])
    }
    accounts = {a.id: a for a in db.scalars(select(Account).where(Account.user_id == user_id))}
    periods: dict[int, list[PolicyPeriod]] = defaultdict(list)
    for period in db.scalars(
        select(PolicyPeriod)
        .where(
            PolicyPeriod.user_id == user_id,
            PolicyPeriod.policy_id.in_([p.id for p in policies]),
        )
        .order_by(PolicyPeriod.period_start, PolicyPeriod.id)
    ):
        periods[period.policy_id].append(period)
    paid = payments(db, user_id, [x for rows in periods.values() for x in rows])

    out = []
    for p in policies:
        template = templates[p.template_id]
        paying = accounts[template.account_id]
        funded, matures = _funded_by(
            None if p.funded_by_id is None else accounts.get(p.funded_by_id), p.premium
        )
        by_fy: dict[int, Decimal] = defaultdict(Decimal)
        for period in periods[p.id]:
            premium, paid_on = paid[period.id]
            by_fy[financial_year(paid_on)] += premium
        out.append(
            PolicyResponse(
                id=p.id,
                kind=p.kind,
                insurer=p.insurer,
                plan=p.plan,
                policy_number=p.policy_number,
                insured=p.insured,
                sum_insured=fmt(p.sum_insured),
                period_start=p.period_start.isoformat(),
                period_end=p.period_end.isoformat(),
                premium=fmt(p.premium),
                details=p.details,
                active=p.active,
                template=template,
                paying_account_id=paying.id,
                paying_account_name=paying.name,
                funded_by=funded,
                # The template's next occurrence is the renewal: it starts on `period_end`.
                # A lapsed policy has no renewal coming.
                card_bill=_card_bill(paying, p.period_end, matures) if p.active else None,
                periods=[
                    Period(
                        period_start=x.period_start.isoformat(),
                        period_end=x.period_end.isoformat(),
                        premium=fmt(paid[x.id][0]),
                        sum_insured=fmt(x.sum_insured),
                        paid_on=paid[x.id][1].isoformat(),
                        transaction_id=x.transaction_id,
                    )
                    for x in periods[p.id]
                ],
                premium_by_fy=[
                    FyPremium(fy=fy_label(fy), amount=fmt(amount))
                    for fy, amount in sorted(by_fy.items())
                ],
                days_to_renewal=(p.period_end - today).days if p.active else None,
            )
        )
    return out


def _owned(db: Session, user_id: int, id: int, lock: bool = False) -> InsurancePolicy:
    policy = None
    if 1 <= id <= MAX_ID:
        query = select(InsurancePolicy).where(
            InsurancePolicy.id == id, InsurancePolicy.user_id == user_id
        )
        if lock:
            query = query.execution_options(populate_existing=True).with_for_update()
        policy = db.scalar(query)
    if policy is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)
    return policy


def _template(db: Session, policy: InsurancePolicy) -> RecurringTemplate:
    """The policy's template, locked so no transaction can link to it meanwhile."""
    template = db.scalar(
        select(RecurringTemplate)
        .where(RecurringTemplate.id == policy.template_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    assert template is not None  # the foreign key keeps it
    return template


def _period_errors(start: date | None, end: date | None, errors: list[dict[str, Any]]) -> None:
    if start is not None and end is not None and not start < end <= add_months(start, 12):
        errors.append(field_error("period_end", _BAD_PERIOD))


def _positive(values: dict[str, Any], field: str, label: str, errors: list[dict[str, Any]]) -> None:
    value = values.get(field)
    if value is not None and value <= 0:
        errors.append(field_error(field, f"{label} must be greater than 0."))


def _funding_errors(
    values: dict[str, Any], accounts: dict[int, Account], errors: list[dict[str, Any]]
) -> None:
    fund_id = values.get("funded_by_id")
    if fund_id is None:
        return
    fund = accounts.get(fund_id)
    if fund is None:  # someone else's account is reported the same as one that doesn't exist
        errors.append(field_error("funded_by_id", _CHOOSE_ACCOUNT))
    elif fund.archived_at is not None:
        errors.append(
            field_error("funded_by_id", f"{fund.name} is archived. Restore it to use it.")
        )


def _template_values(values: dict[str, Any]) -> dict[str, Any]:
    end: date | None = values["period_end"]
    return {
        "name": None if values["insurer"] is None else f"{values['insurer']} premium",
        "type": "expense",
        "amount": values["premium"],
        "account_id": values["account_id"],
        "to_account_id": None,
        "category": CATEGORY,
        "note": None,
        "frequency": "yearly",
        "day": None if end is None else end.day,
        "month": None if end is None else end.month,
        # The current period is paid, so the next premium is due when it ends.
        "start_date": end,
        "end_date": None,
        "remind_days": DEFAULT_REMIND["yearly"],
        "active": True,
    }


_KEPT_IN_STEP = ("name", "amount", "account_id", "day", "month", "start_date")
_TEMPLATE_FIELDS = {"amount": "premium", "start_date": "period_end"}


def _template_errors(
    values: dict[str, Any],
    accounts: dict[int, Account],
    today: date,
    errors: list[dict[str, Any]],
    money: bool = True,
) -> None:
    """The template must be recordable: its rules are a transaction's, in the policy's words."""
    try:
        check_template_values(_template_values(values), accounts, today, money=money)
    except RequestValidationError as error:
        reported = {e["loc"][-1] for e in errors}
        for e in error.errors():
            field = _TEMPLATE_FIELDS.get(e["loc"][-1], e["loc"][-1])
            if field in ("name", "day", "month") or field in reported:
                continue  # a missing insurer or end date is already reported
            errors.append(field_error(field, e["msg"]))


@router.get("")
def list_policies(user: CurrentUser, db: DbSession) -> PolicyList:
    return PolicyList(policies=_responses(db, user.id, today_india()))


@router.post("", status_code=status.HTTP_201_CREATED)
def create_policy(body: PolicyCreate, user: CurrentUser, db: DbSession) -> PolicyResponse:
    values = body.model_dump()
    today = today_india()
    accounts = lock_accounts(db, user.id, [values["account_id"], values["funded_by_id"]])
    errors: list[dict[str, Any]] = []
    for field, message in _REQUIRED.items():
        if values[field] is None:
            errors.append(field_error(field, message))
    _positive(values, "sum_insured", "Sum insured", errors)
    _positive(values, "premium", "Premium", errors)
    _period_errors(values["period_start"], values["period_end"], errors)
    if values["paid_on"] is not None and values["paid_on"] > today:
        errors.append(field_error("paid_on", _FUTURE))
    _funding_errors(values, accounts, errors)
    payment_id = values["transaction_id"]
    payment = None
    if payment_id is not None:
        if 1 <= payment_id <= MAX_ID:
            # Locked, so it can't be linked elsewhere or deleted while the policy is saved.
            payment = db.scalar(
                select(Transaction)
                .where(
                    Transaction.id == payment_id,
                    Transaction.user_id == user.id,
                    Transaction.type == "expense",
                )
                .with_for_update()
            )
        if payment is None:
            errors.append(field_error("transaction_id", _CHOOSE_PAYMENT))
        elif db.scalar(select(PolicyPeriod.id).where(PolicyPeriod.transaction_id == payment_id)):
            errors.append(field_error("transaction_id", _TAKEN))
        elif payment.recurring_template_id is not None:
            errors.append(
                field_error("transaction_id", "That payment belongs to another reminder.")
            )
    _template_errors(values, accounts, today, errors)
    if errors:
        raise RequestValidationError(errors)

    template = RecurringTemplate(user_id=user.id, **_template_values(values))
    db.add(template)
    db.flush()
    if payment is not None:  # it becomes the reminder's first recorded payment
        payment.recurring_template_id = template.id
    policy = InsurancePolicy(
        user_id=user.id,
        template_id=template.id,
        active=True,
        **{
            k: values[k]
            for k in (
                "kind",
                "insurer",
                "plan",
                "policy_number",
                "insured",
                "sum_insured",
                "period_start",
                "period_end",
                "premium",
                "funded_by_id",
                "details",
            )
        },
    )
    db.add(policy)
    db.flush()
    db.add(
        PolicyPeriod(
            user_id=user.id,
            policy_id=policy.id,
            period_start=values["period_start"],
            period_end=values["period_end"],
            premium=values["premium"],
            sum_insured=values["sum_insured"],
            paid_on=values["paid_on"],
            transaction_id=payment_id,
        )
    )
    try:
        db.commit()
    except IntegrityError:  # the payment was linked to another policy meanwhile
        db.rollback()
        raise RequestValidationError([field_error("transaction_id", _TAKEN)]) from None
    return _responses(db, user.id, today, [policy.id])[0]


@router.patch("/{id}")
def update_policy(id: int, body: PolicyUpdate, user: CurrentUser, db: DbSession) -> PolicyResponse:
    changes = body.model_dump(exclude_unset=True)
    first = _owned(db, user.id, id)
    template = db.get(RecurringTemplate, first.template_id)
    assert template is not None
    seen = template.account_id
    accounts = lock_accounts(
        db, user.id, [seen, changes.get("account_id"), changes.get("funded_by_id")]
    )
    policy = _owned(db, user.id, id, lock=True)
    template = _template(db, policy)
    if template.account_id != seen:  # moved meanwhile, so the wrong account is locked
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This policy changed while saving. Try again."
        )
    values = {
        "insurer": policy.insurer,
        "plan": policy.plan,
        "policy_number": policy.policy_number,
        "insured": policy.insured,
        "sum_insured": policy.sum_insured,
        "period_start": policy.period_start,
        "period_end": policy.period_end,
        "premium": policy.premium,
        "account_id": template.account_id,
        "funded_by_id": policy.funded_by_id,
        "details": policy.details,
        **changes,
    }
    errors: list[dict[str, Any]] = []
    for field in ("insurer", "plan", "policy_number", "insured", "sum_insured", "premium"):
        if values[field] is None:
            errors.append(field_error(field, _REQUIRED[field]))
    for field in ("period_start", "period_end"):
        if values[field] is None:
            errors.append(field_error(field, _REQUIRED[field]))
    _positive(values, "sum_insured", "Sum insured", errors)
    _positive(values, "premium", "Premium", errors)
    _period_errors(values["period_start"], values["period_end"], errors)
    if "funded_by_id" in changes:
        _funding_errors(values, accounts, errors)
    today = today_india()
    periods = list(
        db.scalars(
            select(PolicyPeriod)
            .where(PolicyPeriod.policy_id == policy.id)
            .order_by(PolicyPeriod.period_start, PolicyPeriod.id)
        )
    )
    latest = periods[-1] if periods else None
    previous = periods[-2] if len(periods) > 1 else None
    start = values["period_start"]
    if previous is not None and start is not None and start <= previous.period_end:
        errors.append(field_error("period_start", _OVERLAP))
    if "paid_on" in changes:
        paid_on = changes["paid_on"]
        if paid_on is None:
            errors.append(field_error("paid_on", _REQUIRED["paid_on"]))
        elif latest is None or latest.transaction_id is not None:
            errors.append(
                field_error("paid_on", "This premium is a recorded payment. Change it there.")
            )
        elif paid_on > today:
            errors.append(field_error("paid_on", _FUTURE))
    # A lapsed policy's details stay editable whatever has happened to its card.
    _template_errors(values, accounts, today, errors, money=policy.active)
    if errors:
        raise RequestValidationError(errors)

    for field in (
        "insurer",
        "plan",
        "policy_number",
        "insured",
        "sum_insured",
        "period_start",
        "period_end",
        "premium",
        "funded_by_id",
        "details",
    ):
        setattr(policy, field, values[field])
    if latest is not None:
        # The current period is the policy's; a recorded payment keeps its own amount and date.
        latest.period_start = values["period_start"]
        latest.period_end = values["period_end"]
        latest.sum_insured = values["sum_insured"]
        if latest.transaction_id is None:
            latest.premium = values["premium"]
            latest.paid_on = values.get("paid_on") or latest.paid_on
    # Only what the policy decides; the reminder's own settings (remind days, note) stay.
    template_values = _template_values(values)
    for field in _KEPT_IN_STEP:
        setattr(template, field, template_values[field])
    db.commit()
    return _responses(db, user.id, today, [policy.id])[0]


@router.post("/{id}/renew")
def renew_policy(id: int, body: RenewBody, user: CurrentUser, db: DbSession) -> PolicyResponse:
    values = body.model_dump()
    _owned(db, user.id, id)
    accounts = lock_accounts(db, user.id, [values["account_id"]])
    policy = _owned(db, user.id, id, lock=True)
    template = _template(db, policy)
    if not policy.active:
        raise HTTPException(status.HTTP_409_CONFLICT, "This policy has lapsed.")

    errors: list[dict[str, Any]] = []
    start, end = values["period_start"], values["period_end"]
    if start is None:
        errors.append(field_error("period_start", _REQUIRED["period_start"]))
    elif start <= policy.period_end:
        errors.append(field_error("period_start", _OVERLAP))
    if end is None:
        errors.append(field_error("period_end", _REQUIRED["period_end"]))
    _period_errors(start, end, errors)
    if values["sum_insured"] is None:
        errors.append(field_error("sum_insured", _REQUIRED["sum_insured"]))
    _positive(values, "sum_insured", "Sum insured", errors)
    payment = {
        "type": "expense",
        "amount": values["amount"],
        "date": values["date"],
        "account_id": values["account_id"],
        "to_account_id": None,
        "category": CATEGORY,
        "interest": None,
        "note": None,
        "recurring_template_id": template.id,
    }
    try:
        # The link is this policy's own template, so the "Renew the policy instead" rule is off.
        save_checks(db, user.id, accounts, payment, existing_id=None, link_changed=False)
    except RequestValidationError as error:
        errors.extend(field_error(e["loc"][-1], e["msg"]) for e in error.errors())
    if errors:
        raise RequestValidationError(errors)

    tx = Transaction(user_id=user.id, **payment)
    db.add(tx)
    db.flush()
    db.add(
        PolicyPeriod(
            user_id=user.id,
            policy_id=policy.id,
            period_start=start,
            period_end=end,
            premium=values["amount"],
            sum_insured=values["sum_insured"],
            paid_on=values["date"],
            transaction_id=tx.id,
        )
    )
    policy.period_start = start
    policy.period_end = end
    policy.premium = values["amount"]
    policy.sum_insured = values["sum_insured"]
    # The premium now comes from the account it was just paid from, at the new amount.
    template_values = _template_values(
        {
            "insurer": policy.insurer,
            "premium": values["amount"],
            "account_id": values["account_id"],
            "period_end": end,
        }
    )
    for field in _KEPT_IN_STEP:
        setattr(template, field, template_values[field])
    db.commit()
    return _responses(db, user.id, today_india(), [policy.id])[0]


@router.post("/{id}/lapse")
def lapse_policy(id: int, user: CurrentUser, db: DbSession) -> PolicyResponse:
    _owned(db, user.id, id)
    policy = _owned(db, user.id, id, lock=True)
    template = _template(db, policy)
    policy.active = False
    template.active = False
    db.commit()
    return _responses(db, user.id, today_india(), [policy.id])[0]


@router.delete("/{id}")
def delete_policy(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    _owned(db, user.id, id)
    policy = _owned(db, user.id, id, lock=True)
    # Locking the template makes a transaction linking to it wait, so the checks below stay true.
    template = _template(db, policy)
    periods = list(db.scalars(select(PolicyPeriod).where(PolicyPeriod.policy_id == policy.id)))
    linked = db.scalar(
        select(Transaction.id)
        .where(Transaction.user_id == user.id, Transaction.recurring_template_id == template.id)
        .limit(1)
    )
    if linked is not None or any(p.transaction_id is not None for p in periods):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This policy has recorded premiums. Lapse it instead."
        )
    for period in periods:
        db.delete(period)
    for skip in db.scalars(select(RecurringSkip).where(RecurringSkip.template_id == template.id)):
        db.delete(skip)
    db.flush()
    db.delete(policy)
    db.flush()
    db.delete(template)
    db.commit()
    return Deleted(id=id)
