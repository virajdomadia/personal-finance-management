"""Proves the ledger design's database enforcement on PostgreSQL, before any real migration.

Loads tests/sql/ledger_prototype.sql into a throwaway `ledger_proto` schema, then commits real
transactions against it. Deferred checks only run at COMMIT, so nothing here uses savepoints.
Each rejection test also shows that the matching correct operation is accepted.
"""

import itertools
from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import DBAPIError

pytestmark = pytest.mark.postgres

SCHEMA = "ledger_proto"
DDL = (Path(__file__).parent / "sql" / "ledger_prototype.sql").read_text(encoding="utf-8")
DAY = date(2026, 11, 3)

# Ledger account ids created by `seed`. Accounts 14 and 21 and category 105 are left without one,
# so tests can try to back a ledger account with them.
BANK, CARD, CASH, GROCERIES, SALARY, OPENING = 1000, 1001, 1010, 1002, 1003, 1004
OTHER_USERS_BANK = 2000


@pytest.fixture
def proto(pg_engine: Engine) -> Iterator[Engine]:
    with pg_engine.begin() as conn:
        conn.execute(text(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE"))
        conn.execute(text(f"CREATE SCHEMA {SCHEMA}"))
    engine = create_engine(pg_engine.url, connect_args={"options": f"-c search_path={SCHEMA}"})
    with engine.begin() as conn:
        # Straight to psycopg: with no parameters it leaves the `%` in RAISE messages alone.
        conn.connection.driver_connection.execute(DDL)
        seed(conn)
    yield engine
    engine.dispose()
    with pg_engine.begin() as conn:
        conn.execute(text(f"DROP SCHEMA {SCHEMA} CASCADE"))


def sql(conn: Connection, statement: str, **params: Any) -> Any:
    return conn.execute(text(statement), params)


def seed(conn: Connection) -> None:
    sql(conn, "INSERT INTO users VALUES (1), (2)")
    sql(
        conn,
        "INSERT INTO accounts (id, user_id, type) VALUES"
        " (10, 1, 'bank'), (11, 1, 'credit_card'), (12, 1, 'cash'), (20, 2, 'bank'),"
        " (14, 1, 'cash'), (21, 2, 'bank')",
    )
    sql(
        conn,
        "INSERT INTO categories (id, user_id, kind, name) VALUES"
        " (100, 1, 'expense', 'Groceries'), (101, 1, 'expense', 'Food'),"
        " (102, 1, 'income', 'Salary'), (105, 1, 'income', 'Interest')",
    )
    sql(
        conn,
        "INSERT INTO ledger_accounts (id, user_id, kind, account_id, category_id, system_role)"
        " VALUES (1000, 1, 'asset', 10, NULL, NULL), (1001, 1, 'liability', 11, NULL, NULL),"
        " (1010, 1, 'asset', 12, NULL, NULL), (1002, 1, 'expense', NULL, 100, NULL),"
        " (1003, 1, 'income', NULL, 102, NULL),"
        " (1004, 1, 'equity', NULL, NULL, 'opening_balances'),"
        " (2000, 2, 'asset', 20, NULL, NULL)",
    )


class Ledger:
    """Writes ledger operations the way the service will: one database transaction each."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self.ids = itertools.count(10_000)

    def change(self, conn: Connection, tx: int, version: int, action: str, user: int = 1) -> int:
        id = next(self.ids)
        sql(
            conn,
            "INSERT INTO transaction_changes (id, user_id, transaction_id, version, action,"
            " actor_user_id) VALUES (:id, :u, :tx, :v, :a, :u)",
            id=id,
            u=user,
            tx=tx,
            v=version,
            a=action,
        )
        return id

    def post(
        self,
        conn: Connection,
        tx: int,
        change: int,
        lines: list[tuple[int, int]],
        day: date = DAY,
        user: int = 1,
    ) -> int:
        posting = next(self.ids)
        sql(
            conn,
            "INSERT INTO postings (id, user_id, transaction_id, change_id, kind, effective_date)"
            " VALUES (:id, :u, :tx, :c, 'original', :d)",
            id=posting,
            u=user,
            tx=tx,
            c=change,
            d=day,
        )
        for account, paise in lines:
            self.line(conn, posting, account, paise, user=user)
        return posting

    def line(
        self,
        conn: Connection,
        posting: int,
        account: int,
        paise: int,
        reverses: int | None = None,
        user: int = 1,
    ) -> int:
        id = next(self.ids)
        sql(
            conn,
            "INSERT INTO journal_lines (id, user_id, posting_id, ledger_account_id, amount_paise,"
            " reverses_line_id) VALUES (:id, :u, :p, :a, :x, :r)",
            id=id,
            u=user,
            p=posting,
            a=account,
            x=paise,
            r=reverses,
        )
        return id

    def reverse(
        self, conn: Connection, tx: int, change: int, posting: int, only: int | None = None
    ) -> int:
        """Reverse `posting` line for line, or only its first `only` lines (a broken reversal)."""
        day = sql(conn, "SELECT effective_date FROM postings WHERE id = :p", p=posting).scalar()
        reversal = next(self.ids)
        sql(
            conn,
            "INSERT INTO postings (id, user_id, transaction_id, change_id, kind, reverses_id,"
            " effective_date) VALUES (:id, 1, :tx, :c, 'reversal', :p, :d)",
            id=reversal,
            tx=tx,
            c=change,
            p=posting,
            d=day,
        )
        rows = sql(
            conn,
            "SELECT id, ledger_account_id, amount_paise FROM journal_lines"
            " WHERE posting_id = :p ORDER BY id",
            p=posting,
        ).all()
        for line_id, account, paise in rows[:only]:
            self.line(conn, reversal, account, -paise, reverses=line_id)
        return reversal

    def active_posting(self, conn: Connection, tx: int) -> int:
        return sql(
            conn,
            "SELECT p.id FROM postings p WHERE p.transaction_id = :tx AND p.kind = 'original'"
            " AND NOT EXISTS (SELECT 1 FROM postings r WHERE r.reverses_id = p.id)",
            tx=tx,
        ).scalar_one()

    def expense(self, tx: int, rupees: int, account: int = BANK, day: date = DAY) -> int:
        """Create an expense in one operation; returns its posting id."""
        account_id = {BANK: 10, CARD: 11, CASH: 12}[account]
        with self.engine.begin() as conn:
            sql(
                conn,
                "INSERT INTO transactions (id, user_id, type, date, amount, account_id, category)"
                " VALUES (:tx, 1, 'expense', :d, :amt, :acc, 'Groceries')",
                tx=tx,
                d=day,
                amt=rupees,
                acc=account_id,
            )
            change = self.change(conn, tx, 1, "create")
            return self.post(
                conn, tx, change, [(GROCERIES, rupees * 100), (account, -rupees * 100)], day
            )

    def edit_amount(self, tx: int, rupees: int) -> None:
        with self.engine.begin() as conn:
            version = sql(conn, "SELECT version FROM transactions WHERE id = :tx", tx=tx).scalar()
            change = self.change(conn, tx, version + 1, "edit")
            self.reverse(conn, tx, change, self.active_posting(conn, tx))
            self.post(conn, tx, change, [(GROCERIES, rupees * 100), (BANK, -rupees * 100)])
            sql(
                conn,
                "UPDATE transactions SET amount = :amt, version = version + 1 WHERE id = :tx",
                amt=rupees,
                tx=tx,
            )

    def void(self, tx: int) -> None:
        with self.engine.begin() as conn:
            version = sql(conn, "SELECT version FROM transactions WHERE id = :tx", tx=tx).scalar()
            change = self.change(conn, tx, version + 1, "void")
            self.reverse(conn, tx, change, self.active_posting(conn, tx))
            sql(
                conn,
                "UPDATE transactions SET status = 'voided', version = version + 1 WHERE id = :tx",
                tx=tx,
            )

    def balance(self, account: int, known_at: Any = None) -> int:
        with self.engine.connect() as conn:
            return sql(
                conn,
                "SELECT coalesce(sum(l.amount_paise), 0) FROM journal_lines l"
                " JOIN postings p ON p.id = l.posting_id WHERE l.ledger_account_id = :a"
                " AND (CAST(:t AS timestamptz) IS NULL OR p.recorded_at <= :t)",
                a=account,
                t=known_at,
            ).scalar_one()

    def count(self, table: str) -> int:
        with self.engine.connect() as conn:
            return sql(conn, f"SELECT count(*) FROM {table}").scalar_one()


@pytest.fixture
def ledger(proto: Engine) -> Ledger:
    return Ledger(proto)


def rejects(engine: Engine, match: str, *statements: str) -> None:
    """The statements, run as one operation, are refused and leave nothing behind."""
    with pytest.raises(DBAPIError, match=match):
        with engine.begin() as conn:
            for statement in statements:
                sql(conn, statement)


# Happy path, and that reversals don't block what comes after


def test_expense_posts_and_balances(ledger: Ledger) -> None:
    ledger.expense(1, 2000)
    assert ledger.balance(BANK) == -200_000
    assert ledger.balance(GROCERIES) == 200_000


def test_edit_reverses_then_reposts_and_can_repeat(ledger: Ledger) -> None:
    ledger.expense(1, 2000)
    ledger.edit_amount(1, 1500)
    ledger.edit_amount(1, 1200)
    assert ledger.balance(BANK) == -120_000
    assert ledger.count("postings") == 5  # original, then (reversal + original) twice


def test_void_then_new_transactions_still_work(ledger: Ledger) -> None:
    ledger.expense(1, 2000)
    ledger.void(1)
    ledger.expense(2, 300)
    assert ledger.balance(BANK) == -30_000


def test_balance_as_known_at_an_earlier_time(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    with proto.connect() as conn:
        before_edit = sql(conn, "SELECT clock_timestamp()").scalar()
    ledger.edit_amount(1, 500)
    assert ledger.balance(BANK) == -50_000
    assert ledger.balance(BANK, known_at=before_edit) == -200_000


# Append-only


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE journal_lines SET amount_paise = 1",
        "DELETE FROM journal_lines",
        "UPDATE postings SET effective_date = '2026-01-01'",
        "DELETE FROM postings",
        "UPDATE transaction_changes SET action = 'edit'",
        "DELETE FROM transaction_changes",
    ],
)
def test_posted_records_cannot_change(ledger: Ledger, proto: Engine, statement: str) -> None:
    ledger.expense(1, 2000)
    rejects(proto, "append-only", statement)
    assert ledger.balance(BANK) == -200_000


def test_lines_cannot_be_added_to_an_earlier_posting(ledger: Ledger, proto: Engine) -> None:
    posting = ledger.expense(1, 2000)
    rejects(
        proto,
        "is closed",
        f"INSERT INTO journal_lines (id, user_id, posting_id, ledger_account_id, amount_paise)"
        f" VALUES (1, 1, {posting}, {BANK}, 100), (2, 1, {posting}, {GROCERIES}, -100)",
    )


def test_purge_deletes_only_the_named_user(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    rejects(
        proto,
        "append-only",
        "SELECT set_config('app.purging_user', '2', true)",
        "DELETE FROM journal_lines WHERE user_id = 1",
    )
    with proto.begin() as conn:
        sql(conn, "SELECT set_config('app.purging_user', '1', true)")
        for table in ["journal_lines", "postings", "transaction_changes", "transactions"]:
            sql(conn, f"DELETE FROM {table} WHERE user_id = 1")
    assert ledger.count("journal_lines") == 0


# Balance and completeness, checked at commit


def test_unbalanced_posting_is_refused(ledger: Ledger, proto: Engine) -> None:
    with pytest.raises(DBAPIError, match="does not balance"):
        with proto.begin() as conn:
            sql(
                conn,
                "INSERT INTO transactions (id, user_id, type, date) VALUES (1, 1, 'opening', :d)",
                d=DAY,
            )
            change = ledger.change(conn, 1, 1, "create")
            ledger.post(conn, 1, change, [(BANK, 100), (OPENING, -99)])
    assert ledger.count("transactions") == 0


def test_posting_without_lines_is_refused(ledger: Ledger, proto: Engine) -> None:
    with pytest.raises(DBAPIError, match="has no lines"):
        with proto.begin() as conn:
            sql(
                conn,
                "INSERT INTO transactions (id, user_id, type, date) VALUES (1, 1, 'opening', :d)",
                d=DAY,
            )
            ledger.post(conn, 1, ledger.change(conn, 1, 1, "create"), [])


def test_transaction_without_a_posting_is_refused(ledger: Ledger, proto: Engine) -> None:
    with pytest.raises(DBAPIError, match="0 active postings"):
        with proto.begin() as conn:
            sql(
                conn,
                "INSERT INTO transactions (id, user_id, type, date) VALUES (1, 1, 'opening', :d)",
                d=DAY,
            )
            ledger.change(conn, 1, 1, "create")


def test_posting_needs_a_change_from_the_same_operation(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    with pytest.raises(DBAPIError, match="same operation"):
        with proto.begin() as conn:
            old_change = sql(conn, "SELECT min(id) FROM transaction_changes").scalar()
            ledger.post(conn, 1, old_change, [(BANK, 100), (GROCERIES, -100)])


# Reversals


def test_partial_reversal_is_refused(ledger: Ledger, proto: Engine) -> None:
    posting = ledger.expense(1, 2000)
    with pytest.raises(DBAPIError, match="does not balance|does not exactly reverse"):
        with proto.begin() as conn:
            change = ledger.change(conn, 1, 2, "void")
            ledger.reverse(conn, 1, change, posting, only=1)
            sql(conn, "UPDATE transactions SET status = 'voided', version = 2 WHERE id = 1")
    assert ledger.balance(BANK) == -200_000


def test_reversal_with_the_wrong_amount_is_refused(ledger: Ledger, proto: Engine) -> None:
    posting = ledger.expense(1, 2000)
    with pytest.raises(DBAPIError, match="reverses_line_id"):
        with proto.begin() as conn:
            change = ledger.change(conn, 1, 2, "void")
            reversal = ledger.reverse(conn, 1, change, posting, only=0)
            first = sql(
                conn, "SELECT min(id) FROM journal_lines WHERE posting_id = :p", p=posting
            ).scalar()
            ledger.line(conn, reversal, GROCERIES, -199_999, reverses=first)


def test_reversing_lines_of_another_transaction_is_refused(ledger: Ledger, proto: Engine) -> None:
    mine = ledger.expense(1, 2000)
    other = ledger.expense(2, 2000)  # same accounts and amounts, so line pairing alone can't tell
    with pytest.raises(DBAPIError, match="does not exactly reverse"):
        with proto.begin() as conn:
            change = ledger.change(conn, 1, 2, "void")
            reversal = ledger.reverse(conn, 1, change, mine, only=0)
            for line_id, account, paise in sql(
                conn,
                "SELECT id, ledger_account_id, amount_paise FROM journal_lines"
                " WHERE posting_id = :p",
                p=other,
            ).all():
                ledger.line(conn, reversal, account, -paise, reverses=line_id)
            sql(conn, "UPDATE transactions SET status = 'voided', version = 2 WHERE id = 1")


def test_reversing_twice_is_refused(ledger: Ledger, proto: Engine) -> None:
    posting = ledger.expense(1, 2000)
    ledger.void(1)
    with pytest.raises(DBAPIError, match="reverses_id"):
        with proto.begin() as conn:
            ledger.reverse(conn, 1, ledger.change(conn, 1, 3, "edit"), posting)


def test_void_without_reversing_is_refused(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    rejects(
        proto,
        "still has an active posting",
        "INSERT INTO transaction_changes (id, user_id, transaction_id, version, action,"
        " actor_user_id) VALUES (1, 1, 1, 2, 'void', 1)",
        "UPDATE transactions SET status = 'voided', version = 2 WHERE id = 1",
    )


# The header


def test_header_type_never_changes(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    rejects(proto, "never change", "UPDATE transactions SET type = 'income', version = 2")


def test_header_version_moves_by_one(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    rejects(
        proto, "must move from version 1 to 2", "UPDATE transactions SET note = 'x', version = 3"
    )


def test_header_date_cannot_drift_from_its_posting(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    rejects(
        proto,
        "posting is dated",
        "INSERT INTO transaction_changes (id, user_id, transaction_id, version, action,"
        " actor_user_id) VALUES (1, 1, 1, 2, 'edit', 1)",
        "UPDATE transactions SET date = '2026-11-01', version = 2 WHERE id = 1",
    )


def test_header_amount_cannot_drift_from_its_posting(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    rejects(
        proto,
        "its posting moves",
        "INSERT INTO transaction_changes (id, user_id, transaction_id, version, action,"
        " actor_user_id) VALUES (1, 1, 1, 2, 'edit', 1)",
        "UPDATE transactions SET amount = 10, version = 2 WHERE id = 1",
    )


def test_note_change_needs_a_change_record(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    rejects(proto, "no change record", "UPDATE transactions SET note = 'x', version = 2")
    with proto.begin() as conn:  # the correct way: a change row, no postings
        ledger.change(conn, 1, 2, "redact")
        sql(conn, "UPDATE transactions SET note = NULL, version = 2 WHERE id = 1")


# Ownership


def test_line_on_another_users_ledger_account_is_refused(ledger: Ledger, proto: Engine) -> None:
    with pytest.raises(DBAPIError, match="journal_lines_ledger_account_id_user_id_fkey"):
        with proto.begin() as conn:
            sql(
                conn,
                "INSERT INTO transactions (id, user_id, type, date) VALUES (1, 1, 'opening', :d)",
                d=DAY,
            )
            change = ledger.change(conn, 1, 1, "create")
            ledger.post(conn, 1, change, [(OTHER_USERS_BANK, 100), (OPENING, -100)])


def test_posting_on_another_users_transaction_is_refused(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    with pytest.raises(DBAPIError, match="fkey"):
        with proto.begin() as conn:
            ledger.change(conn, 1, 2, "edit", user=2)


@pytest.mark.parametrize(
    ("values", "match"),
    [
        ("(3000, 1, 'asset', 21, NULL, NULL)", "ledger_accounts_account_id_user_id_kind_fkey"),
        ("(3000, 1, 'expense', NULL, 105, NULL)", "ledger_accounts_category_id_user_id_kind_fkey"),
        ("(3000, 1, 'asset', 14, 101, NULL)", "one_backing"),
        ("(3000, 1, 'expense', NULL, NULL, NULL)", "one_backing"),
    ],
)
def test_ledger_account_backing_rules(proto: Engine, values: str, match: str) -> None:
    rejects(
        proto,
        match,
        "INSERT INTO ledger_accounts (id, user_id, kind, account_id, category_id, system_role)"
        f" VALUES {values}",
    )


def test_a_card_backs_only_a_liability(proto: Engine) -> None:
    with proto.begin() as conn:
        sql(conn, "INSERT INTO accounts (id, user_id, type) VALUES (13, 1, 'credit_card')")
    rejects(
        proto,
        "ledger_accounts_account_id_user_id_kind_fkey",
        "INSERT INTO ledger_accounts (id, user_id, kind, account_id) VALUES (3000, 1, 'asset', 13)",
    )
    with proto.begin() as conn:
        sql(
            conn,
            "INSERT INTO ledger_accounts (id, user_id, kind, account_id)"
            " VALUES (3000, 1, 'liability', 13)",
        )


# Planned CHECKs on today's transaction columns


@pytest.mark.parametrize(
    ("columns", "match"),
    [
        ("'expense', -5, 10, NULL, 'Groceries'", "amount_check"),
        ("'transfer', 5, 10, NULL, NULL", "transfer_has_two_accounts"),
        ("'expense', 5, 10, 11, 'Groceries'", "transfer_has_two_accounts"),
        ("'transfer', 5, 10, 10, NULL", "transfer_accounts_differ"),
        ("'expense', 5, 10, NULL, NULL", "category_when_needed"),
        ("'transfer', 5, 10, 11, 'Groceries'", "transfer_has_no_category"),
        ("'transfer', 5, 10, 20, NULL", "transactions_to_account_id_user_id_fkey"),
    ],
)
def test_transaction_column_checks(proto: Engine, columns: str, match: str) -> None:
    rejects(
        proto,
        match,
        "INSERT INTO transactions (id, user_id, date, type, amount, account_id, to_account_id,"
        f" category) VALUES (1, 1, '2026-11-03', {columns})",
    )


def test_valid_transfer_is_accepted(ledger: Ledger, proto: Engine) -> None:
    with proto.begin() as conn:
        sql(
            conn,
            "INSERT INTO transactions (id, user_id, date, type, amount, account_id, to_account_id)"
            " VALUES (1, 1, :d, 'transfer', 400, 10, 11)",
            d=DAY,
        )
        change = ledger.change(conn, 1, 1, "create")
        ledger.post(conn, 1, change, [(CARD, 40_000), (BANK, -40_000)])
    assert ledger.balance(CARD) == 40_000  # what's owed went down by ₹400


# Categories


def test_category_rules(proto: Engine) -> None:
    rejects(
        proto,
        "categories_active_name",
        "INSERT INTO categories VALUES (103, 1, 'expense', 'groceries')",
    )
    rejects(proto, "merged_into_id", "UPDATE categories SET merged_into_id = 102 WHERE id = 101")
    with proto.begin() as conn:  # a valid merge frees the name for reuse
        sql(conn, "UPDATE categories SET merged_into_id = 100 WHERE id = 101")
        sql(
            conn,
            "INSERT INTO categories (id, user_id, kind, name) VALUES (104, 1, 'expense', 'Food')",
        )


# Atomicity: a failure part-way through an operation leaves nothing behind


def test_error_mid_operation_rolls_everything_back(ledger: Ledger, proto: Engine) -> None:
    with pytest.raises(RuntimeError):
        with proto.begin() as conn:
            sql(
                conn,
                "INSERT INTO transactions (id, user_id, type, date) VALUES (1, 1, 'opening', :d)",
                d=DAY,
            )
            change = ledger.change(conn, 1, 1, "create")
            posting = ledger.post(conn, 1, change, [])
            ledger.line(conn, posting, BANK, 100)
            raise RuntimeError("crash before the second line")
    for table in ["transactions", "transaction_changes", "postings", "journal_lines"]:
        assert ledger.count(table) == 0, table


def test_failed_edit_keeps_the_previous_version(ledger: Ledger, proto: Engine) -> None:
    ledger.expense(1, 2000)
    with pytest.raises(DBAPIError, match="does not balance"):
        with proto.begin() as conn:
            change = ledger.change(conn, 1, 2, "edit")
            ledger.reverse(conn, 1, change, ledger.active_posting(conn, 1))
            ledger.post(conn, 1, change, [(GROCERIES, 150_000), (BANK, -149_000)])
            sql(conn, "UPDATE transactions SET amount = 1500, version = 2 WHERE id = 1")
    assert ledger.balance(BANK) == -200_000
    assert ledger.count("postings") == 1
    assert ledger.count("transaction_changes") == 1
