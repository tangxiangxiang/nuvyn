-- Transfer payees are part of the current Ledger transaction contract.
-- Rebuild the table because the foundation migration's row-shape CHECK still
-- required transfer payees to be empty.

DROP TRIGGER IF EXISTS ledger_transactions_transfer_kind_insert;
DROP TRIGGER IF EXISTS ledger_transactions_transfer_kind_update;
DROP TRIGGER IF EXISTS ledger_transactions_group_fields_insert;
DROP TRIGGER IF EXISTS ledger_transactions_group_fields_update;

ALTER TABLE ledger_transactions RENAME TO ledger_transactions_legacy;

CREATE TABLE ledger_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL
    CHECK (type IN ('income', 'expense', 'transfer', 'adjustment')),
  amount_minor INTEGER NOT NULL
    CHECK (typeof(amount_minor) = 'integer'),
  account_id TEXT
    REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  from_account_id TEXT
    REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  to_account_id TEXT
    REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  category_id TEXT
    REFERENCES ledger_categories(id) ON DELETE RESTRICT,
  occurred_at INTEGER NOT NULL
    CHECK (typeof(occurred_at) = 'integer'),
  payee TEXT NOT NULL DEFAULT ''
    CHECK (typeof(payee) = 'text'),
  note TEXT NOT NULL DEFAULT ''
    CHECK (typeof(note) = 'text'),
  adjustment_calculated_balance_minor INTEGER
    CHECK (
      adjustment_calculated_balance_minor IS NULL
      OR typeof(adjustment_calculated_balance_minor) = 'integer'
    ),
  adjustment_target_balance_minor INTEGER
    CHECK (
      adjustment_target_balance_minor IS NULL
      OR typeof(adjustment_target_balance_minor) = 'integer'
    ),
  deleted_at INTEGER
    CHECK (deleted_at IS NULL OR typeof(deleted_at) = 'integer'),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer'),
  location TEXT NOT NULL DEFAULT ''
    CHECK (typeof(location) = 'text'),
  transfer_kind TEXT
    CHECK (transfer_kind IS NULL OR transfer_kind IN ('general', 'repayment', 'withdrawal')),
  group_id TEXT
    CHECK (group_id IS NULL OR (typeof(group_id) = 'text' AND length(trim(group_id)) > 0)),
  transfer_fee_mode TEXT
    CHECK (transfer_fee_mode IS NULL OR transfer_fee_mode IN ('extra', 'deducted')),
  CHECK (
    (
      type IN ('income', 'expense')
      AND account_id IS NOT NULL
      AND from_account_id IS NULL
      AND to_account_id IS NULL
      AND category_id IS NOT NULL
      AND amount_minor > 0
      AND adjustment_calculated_balance_minor IS NULL
      AND adjustment_target_balance_minor IS NULL
    )
    OR (
      type = 'transfer'
      AND account_id IS NULL
      AND from_account_id IS NOT NULL
      AND to_account_id IS NOT NULL
      AND from_account_id <> to_account_id
      AND category_id IS NULL
      AND amount_minor > 0
      AND adjustment_calculated_balance_minor IS NULL
      AND adjustment_target_balance_minor IS NULL
    )
    OR (
      type = 'adjustment'
      AND account_id IS NOT NULL
      AND from_account_id IS NULL
      AND to_account_id IS NULL
      AND category_id IS NULL
      AND amount_minor <> 0
      AND adjustment_calculated_balance_minor IS NOT NULL
      AND adjustment_target_balance_minor IS NOT NULL
      AND amount_minor = adjustment_target_balance_minor - adjustment_calculated_balance_minor
      AND payee = ''
    )
  )
);

INSERT INTO ledger_transactions (
  id, type, amount_minor, account_id, from_account_id, to_account_id,
  category_id, occurred_at, payee, note,
  adjustment_calculated_balance_minor, adjustment_target_balance_minor,
  deleted_at, version, created_at, updated_at, location, transfer_kind,
  group_id, transfer_fee_mode
)
SELECT
  id, type, amount_minor, account_id, from_account_id, to_account_id,
  category_id, occurred_at, payee, note,
  adjustment_calculated_balance_minor, adjustment_target_balance_minor,
  deleted_at, version, created_at, updated_at, location, transfer_kind,
  group_id, transfer_fee_mode
FROM ledger_transactions_legacy;

DROP TABLE ledger_transactions_legacy;

CREATE INDEX idx_ledger_transactions_active_order
  ON ledger_transactions(deleted_at, occurred_at DESC, created_at DESC, id DESC);

CREATE INDEX idx_ledger_transactions_account
  ON ledger_transactions(account_id, deleted_at, occurred_at DESC, created_at DESC, id DESC);

CREATE INDEX idx_ledger_transactions_from_account
  ON ledger_transactions(from_account_id, deleted_at, occurred_at DESC, created_at DESC, id DESC);

CREATE INDEX idx_ledger_transactions_to_account
  ON ledger_transactions(to_account_id, deleted_at, occurred_at DESC, created_at DESC, id DESC);

CREATE INDEX idx_ledger_transactions_category
  ON ledger_transactions(category_id, deleted_at, occurred_at DESC, created_at DESC, id DESC);

CREATE INDEX idx_ledger_transactions_group
  ON ledger_transactions(group_id, deleted_at, occurred_at DESC, created_at DESC, id DESC);

CREATE TRIGGER ledger_transactions_transfer_kind_insert
BEFORE INSERT ON ledger_transactions
WHEN (
  NEW.type = 'transfer'
  AND (NEW.transfer_kind IS NULL OR NEW.transfer_kind NOT IN ('general', 'repayment', 'withdrawal'))
) OR (
  NEW.type <> 'transfer'
  AND NEW.transfer_kind IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid ledger transfer kind');
END;

CREATE TRIGGER ledger_transactions_transfer_kind_update
BEFORE UPDATE OF type, transfer_kind ON ledger_transactions
WHEN (
  NEW.type = 'transfer'
  AND (NEW.transfer_kind IS NULL OR NEW.transfer_kind NOT IN ('general', 'repayment', 'withdrawal'))
) OR (
  NEW.type <> 'transfer'
  AND NEW.transfer_kind IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid ledger transfer kind');
END;

CREATE TRIGGER ledger_transactions_group_fields_insert
BEFORE INSERT ON ledger_transactions
WHEN (
  NEW.group_id IS NOT NULL
  AND NEW.type NOT IN ('transfer', 'expense')
) OR (
  NEW.type = 'transfer'
  AND NEW.transfer_kind = 'general'
  AND NEW.group_id IS NOT NULL
) OR (
  NEW.transfer_fee_mode IS NOT NULL
  AND (
    NEW.type IS NOT 'transfer'
    OR NEW.transfer_kind IS NOT 'withdrawal'
    OR NEW.group_id IS NULL
    OR NEW.transfer_fee_mode NOT IN ('extra', 'deducted')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid ledger transaction group fields');
END;

CREATE TRIGGER ledger_transactions_group_fields_update
BEFORE UPDATE OF type, transfer_kind, group_id, transfer_fee_mode ON ledger_transactions
WHEN (
  NEW.group_id IS NOT NULL
  AND NEW.type NOT IN ('transfer', 'expense')
) OR (
  NEW.type = 'transfer'
  AND NEW.transfer_kind = 'general'
  AND NEW.group_id IS NOT NULL
) OR (
  NEW.transfer_fee_mode IS NOT NULL
  AND (
    NEW.type IS NOT 'transfer'
    OR NEW.transfer_kind IS NOT 'withdrawal'
    OR NEW.group_id IS NULL
    OR NEW.transfer_fee_mode NOT IN ('extra', 'deducted')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid ledger transaction group fields');
END;
