-- Ledger prototype (docs/architecture/ledger-design.md, revision 2).
--
-- TEST-ONLY. Loaded into a throwaway schema by tests/test_pg_ledger_prototype.py so the design's
-- constraints and triggers can be proven before any real migration exists. `users`, `accounts`
-- and `transactions` here are minimal stand-ins for the real tables, carrying only the columns
-- the ledger needs plus the CHECKs the design plans to add to the real ones.

CREATE TABLE users (id bigint PRIMARY KEY);

CREATE TABLE accounts (
  id                  bigint PRIMARY KEY,
  user_id             bigint NOT NULL REFERENCES users,
  type                text NOT NULL CHECK (type IN ('bank', 'credit_card', 'cash', 'broker', 'wallet')),
  ledger_kind         text GENERATED ALWAYS AS
                        (CASE WHEN type IN ('credit_card', 'loan') THEN 'liability' ELSE 'asset' END) STORED,
  opening_date        date,
  opening_date_source text CHECK (opening_date_source IN ('entered', 'migrated')),
  currency            char(3) NOT NULL DEFAULT 'INR',
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, ledger_kind)
);

CREATE TABLE categories (
  id             bigint PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users,
  kind           text NOT NULL CHECK (kind IN ('income', 'expense')),
  name           text NOT NULL,
  parent_id      bigint,
  merged_into_id bigint,
  archived_at    timestamptz,
  UNIQUE (id, user_id, kind),
  FOREIGN KEY (parent_id, user_id, kind)      REFERENCES categories (id, user_id, kind),
  FOREIGN KEY (merged_into_id, user_id, kind) REFERENCES categories (id, user_id, kind),
  CHECK (merged_into_id <> id),
  CHECK (parent_id <> id)
);
CREATE UNIQUE INDEX categories_active_name ON categories (user_id, kind, lower(name))
  WHERE merged_into_id IS NULL;

CREATE TABLE ledger_accounts (
  id          bigint PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users,
  kind        text NOT NULL CHECK (kind IN ('asset', 'liability', 'income', 'expense', 'equity')),
  account_id  bigint UNIQUE,
  category_id bigint UNIQUE,
  system_role text CHECK (system_role IN ('opening_balances', 'adjustments')),
  UNIQUE (id, user_id),
  UNIQUE (user_id, system_role),
  FOREIGN KEY (account_id, user_id, kind)  REFERENCES accounts (id, user_id, ledger_kind),
  FOREIGN KEY (category_id, user_id, kind) REFERENCES categories (id, user_id, kind),
  CONSTRAINT one_backing CHECK (num_nonnulls(account_id, category_id, system_role) = 1),
  CHECK (system_role IS NULL OR kind = 'equity')
);

CREATE TABLE transactions (
  id            bigint PRIMARY KEY,
  user_id       bigint NOT NULL REFERENCES users,
  type          text NOT NULL
                  CHECK (type IN ('opening', 'income', 'expense', 'transfer', 'refund', 'adjustment')),
  date          date NOT NULL,
  note          text,
  status        text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided')),
  version       int NOT NULL DEFAULT 1 CHECK (version >= 1),
  refund_of_id  bigint,
  -- Today's columns, kept during dual-write, with the CHECKs planned for the real table.
  amount        numeric(14, 2) CHECK (amount > 0),
  account_id    bigint,
  to_account_id bigint,
  category      text,
  UNIQUE (id, user_id),
  FOREIGN KEY (refund_of_id, user_id)  REFERENCES transactions (id, user_id),
  FOREIGN KEY (account_id, user_id)    REFERENCES accounts (id, user_id),
  FOREIGN KEY (to_account_id, user_id) REFERENCES accounts (id, user_id),
  CONSTRAINT transfer_has_two_accounts CHECK ((type = 'transfer') = (to_account_id IS NOT NULL)),
  CONSTRAINT transfer_accounts_differ  CHECK (to_account_id <> account_id),
  CONSTRAINT category_when_needed      CHECK (type NOT IN ('income', 'expense') OR category IS NOT NULL),
  CONSTRAINT transfer_has_no_category  CHECK (type <> 'transfer' OR category IS NULL),
  CONSTRAINT only_refunds_link         CHECK (type = 'refund' OR refund_of_id IS NULL)
);

CREATE TABLE transaction_changes (
  id             bigint PRIMARY KEY,
  user_id        bigint NOT NULL,
  transaction_id bigint NOT NULL,
  version        int NOT NULL,
  action         text NOT NULL CHECK (action IN ('create', 'edit', 'void', 'redact', 'migrate')),
  actor_user_id  bigint NOT NULL REFERENCES users,
  at             timestamptz NOT NULL DEFAULT now(),
  fields_changed text[] NOT NULL DEFAULT '{}',
  before         jsonb,
  after          jsonb,
  UNIQUE (transaction_id, version),
  UNIQUE (id, user_id, transaction_id),
  FOREIGN KEY (transaction_id, user_id) REFERENCES transactions (id, user_id)
);

CREATE TABLE postings (
  id             bigint PRIMARY KEY,
  user_id        bigint NOT NULL,
  transaction_id bigint NOT NULL,
  change_id      bigint NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('original', 'reversal')),
  reverses_id    bigint UNIQUE,
  effective_date date NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  reversed_kind  text GENERATED ALWAYS AS
                   (CASE WHEN reverses_id IS NULL THEN NULL ELSE 'original' END) STORED,
  UNIQUE (id, user_id),
  UNIQUE (id, transaction_id, effective_date, kind),
  FOREIGN KEY (transaction_id, user_id) REFERENCES transactions (id, user_id),
  FOREIGN KEY (change_id, user_id, transaction_id)
    REFERENCES transaction_changes (id, user_id, transaction_id),
  FOREIGN KEY (reverses_id, transaction_id, effective_date, reversed_kind)
    REFERENCES postings (id, transaction_id, effective_date, kind),
  CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL))
);

CREATE TABLE journal_lines (
  id                bigint PRIMARY KEY,
  user_id           bigint NOT NULL,
  posting_id        bigint NOT NULL,
  ledger_account_id bigint NOT NULL,
  amount_paise      bigint NOT NULL CHECK (amount_paise <> 0),
  reverses_line_id  bigint UNIQUE,
  negated_paise     bigint GENERATED ALWAYS AS (-amount_paise) STORED,
  UNIQUE (id, ledger_account_id, amount_paise),
  FOREIGN KEY (posting_id, user_id)        REFERENCES postings (id, user_id),
  FOREIGN KEY (ledger_account_id, user_id) REFERENCES ledger_accounts (id, user_id),
  FOREIGN KEY (reverses_line_id, ledger_account_id, negated_paise)
    REFERENCES journal_lines (id, ledger_account_id, amount_paise)
);
CREATE INDEX journal_lines_account ON journal_lines (ledger_account_id);
CREATE INDEX postings_user_date ON postings (user_id, effective_date);


-- Append-only: postings, lines and the audit trail never change. The one exception is deleting a
-- user's whole data, which sets app.purging_user to that user's id for its own transaction.
CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.purging_user', true) = OLD.user_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER transaction_changes_append_only BEFORE UPDATE OR DELETE ON transaction_changes
  FOR EACH ROW EXECUTE FUNCTION append_only();


-- Everything one operation writes shares the database transaction's timestamp, and a posting can
-- only gain lines in the operation that created it.
CREATE FUNCTION stamp_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER transaction_changes_stamp BEFORE INSERT ON transaction_changes
  FOR EACH ROW EXECUTE FUNCTION stamp_change();

CREATE FUNCTION stamp_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.recorded_at := now();
  IF NOT EXISTS (SELECT 1 FROM transaction_changes WHERE id = NEW.change_id AND at = now()) THEN
    RAISE EXCEPTION 'posting % must be written by a change made in the same operation', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postings_stamp BEFORE INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION stamp_posting();

CREATE FUNCTION posting_is_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM postings WHERE id = NEW.posting_id AND recorded_at = now()) THEN
    RAISE EXCEPTION 'posting % is closed; lines can only be added when it is written', NEW.posting_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_open_posting BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION posting_is_open();


-- The header can change, but never its owner or type, and every change bumps the version by one.
CREATE FUNCTION guard_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'a transaction''s owner and type never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'transaction % must move from version % to %', OLD.id, OLD.version, OLD.version + 1
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transactions_guard BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION guard_header();


-- Checked at commit, once everything an operation writes is in place. Checking each new posting is
-- enough: lines can only join a posting in the operation that wrote it (journal_lines_open_posting),
-- so every line is seen by its posting's check.
CREATE FUNCTION check_posting(p_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p postings;
  n int;
  total bigint;
  wrong int;
BEGIN
  SELECT * INTO p FROM postings WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN;  -- removed by a user purge
  END IF;
  SELECT count(*), coalesce(sum(amount_paise), 0) INTO n, total
    FROM journal_lines WHERE posting_id = p_id;
  IF n = 0 THEN
    RAISE EXCEPTION 'posting % has no lines', p_id USING ERRCODE = 'check_violation';
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'posting % does not balance (off by % paise)', p_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  IF p.kind = 'reversal' THEN
    SELECT count(*) INTO wrong
      FROM journal_lines l LEFT JOIN journal_lines o ON o.id = l.reverses_line_id
      WHERE l.posting_id = p_id AND (o.id IS NULL OR o.posting_id <> p.reverses_id);
    IF wrong > 0 OR n <> (SELECT count(*) FROM journal_lines WHERE posting_id = p.reverses_id) THEN
      RAISE EXCEPTION 'posting % does not exactly reverse posting %', p_id, p.reverses_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM journal_lines WHERE posting_id = p_id AND reverses_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'original posting % contains reversal lines', p_id USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION check_transaction(t_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t transactions;
  active int;
  active_date date;
  debits bigint;
BEGIN
  SELECT * INTO t FROM transactions WHERE id = t_id;
  IF NOT FOUND THEN
    RETURN;  -- removed by a user purge
  END IF;
  SELECT count(*), min(p.effective_date) INTO active, active_date
    FROM postings p
    WHERE p.transaction_id = t_id AND p.kind = 'original'
      AND NOT EXISTS (SELECT 1 FROM postings r WHERE r.reverses_id = p.id);
  IF t.status = 'posted' AND active <> 1 THEN
    RAISE EXCEPTION 'posted transaction % has % active postings, not 1', t_id, active
      USING ERRCODE = 'check_violation';
  END IF;
  IF t.status = 'voided' AND active <> 0 THEN
    RAISE EXCEPTION 'voided transaction % still has an active posting', t_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF t.status = 'posted' THEN
    IF active_date <> t.date THEN
      RAISE EXCEPTION 'transaction % is dated % but its posting is dated %', t_id, t.date, active_date
        USING ERRCODE = 'check_violation';
    END IF;
    IF t.amount IS NOT NULL THEN
      SELECT coalesce(sum(l.amount_paise) FILTER (WHERE l.amount_paise > 0), 0) INTO debits
        FROM journal_lines l JOIN postings p ON p.id = l.posting_id
        WHERE p.transaction_id = t_id AND p.kind = 'original'
          AND NOT EXISTS (SELECT 1 FROM postings r WHERE r.reverses_id = p.id);
      IF debits <> t.amount * 100 THEN
        RAISE EXCEPTION 'transaction % says % but its posting moves % paise', t_id, t.amount, debits
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM transaction_changes WHERE transaction_id = t_id AND version = t.version
  ) THEN
    RAISE EXCEPTION 'transaction % has no change record for version %', t_id, t.version
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION deferred_posting_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_posting(NEW.id);
  PERFORM check_transaction(NEW.transaction_id);
  RETURN NULL;
END $$;
CREATE FUNCTION deferred_transaction_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_transaction(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER postings_complete AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deferred_posting_check();
CREATE CONSTRAINT TRIGGER transactions_consistent AFTER INSERT OR UPDATE ON transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deferred_transaction_check();
