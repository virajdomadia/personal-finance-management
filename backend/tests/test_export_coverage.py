"""Every table is either in a user's backup or excluded with a reason, and restore can remap
every id in the exported ones. A new table fails here until someone decides."""

from sqlalchemy import JSON, Column, ForeignKey, Integer, MetaData, String, Table

import app.models  # noqa: F401
from app.db.base import Base
from app.export.tables import EXCLUDED, plan


def test_every_table_is_exported_or_excluded_with_a_reason() -> None:
    found = plan(Base.metadata)
    assert found.problems == []
    exported = {t.name for t in found.exported}
    assert exported | set(found.excluded) == set(Base.metadata.tables)
    assert not exported & set(EXCLUDED)
    assert all(reason.strip() for reason in EXCLUDED.values())


def test_the_decisions_so_far() -> None:
    found = plan(Base.metadata)
    assert set(found.excluded) == {"users", "market_codes"}
    assert {"accounts", "transactions", "sms_entries", "instrument_prices"} <= {
        t.name for t in found.exported
    }


def _users(metadata: MetaData) -> None:
    Table("users", metadata, Column("id", Integer, primary_key=True))
    Table(
        "accounts",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("user_id", ForeignKey("users.id")),
    )


def test_a_new_user_table_is_backed_up_without_a_change() -> None:
    metadata = MetaData()
    _users(metadata)
    Table(
        "net_worth_snapshots",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("user_id", ForeignKey("users.id")),
        Column("total", String),
    )
    found = plan(metadata)
    assert found.problems == []
    assert "net_worth_snapshots" in {t.name for t in found.exported}


def test_a_child_table_is_owned_through_its_parent() -> None:
    metadata = MetaData()
    _users(metadata)
    Table(
        "account_notes",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("account_id", ForeignKey("accounts.id"), nullable=False),
    )
    found = plan(metadata)
    assert found.problems == []
    assert found.owned_through["account_notes"].name == "account_id"


def test_a_table_nobody_owns_fails_until_it_is_classified() -> None:
    metadata = MetaData()
    _users(metadata)
    Table("exchange_rates", metadata, Column("id", Integer, primary_key=True))
    assert any(p.startswith("exchange_rates:") for p in plan(metadata).problems)


def test_ids_restore_could_not_remap_fail() -> None:
    metadata = MetaData()
    _users(metadata)
    Table("shared", metadata, Column("id", Integer, primary_key=True))
    Table(
        "things",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("user_id", ForeignKey("users.id")),
        Column("shared_id", ForeignKey("shared.id")),
        Column("loose_id", Integer),
        Column("extra", JSON),
    )
    problems = "\n".join(plan(metadata).problems)
    assert "things.shared_id points at shared" in problems
    assert "things.loose_id looks like an id" in problems
    assert "things.extra is JSON" in problems


def test_a_key_that_is_not_a_primary_key_must_be_allowed() -> None:
    metadata = MetaData()
    _users(metadata)
    Table(
        "codes",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("user_id", ForeignKey("users.id")),
        Column("code", String, unique=True),
    )
    Table(
        "uses",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("user_id", ForeignKey("users.id")),
        Column("code", ForeignKey("codes.code")),
    )
    problems = "\n".join(plan(metadata).problems)
    assert "uses.code points at codes.code, not a primary key" in problems
