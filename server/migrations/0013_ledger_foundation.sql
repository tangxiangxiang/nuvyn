-- Ledger L0.1: schema-only foundation.
--
-- This migration deliberately does not insert settings, categories, accounts,
-- transactions, or any other owner data. Runtime initialization belongs to a
-- later Ledger slice.

CREATE TABLE ledger_settings (
  singleton_id INTEGER PRIMARY KEY
    CHECK (typeof(singleton_id) = 'integer' AND singleton_id = 1),
  base_currency TEXT NOT NULL
    CHECK (typeof(base_currency) = 'text'),
  timezone TEXT NOT NULL
    CHECK (typeof(timezone) = 'text'),
  has_created_account INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(has_created_account) = 'integer' AND has_created_account IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer')
);

CREATE TABLE ledger_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
    CHECK (typeof(name) = 'text'),
  type TEXT NOT NULL
    CHECK (type IN ('cash', 'bank', 'wallet', 'credit_card', 'loan', 'other')),
  nature TEXT NOT NULL
    CHECK (nature IN ('asset', 'liability')),
  opening_balance_minor INTEGER NOT NULL
    CHECK (typeof(opening_balance_minor) = 'integer'),
  opening_date TEXT NOT NULL
    CHECK (typeof(opening_date) = 'text'),
  currency TEXT NOT NULL
    CHECK (typeof(currency) = 'text'),
  note TEXT NOT NULL DEFAULT ''
    CHECK (typeof(note) = 'text'),
  archived_at INTEGER
    CHECK (archived_at IS NULL OR typeof(archived_at) = 'integer'),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer')
);

CREATE TABLE ledger_categories (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('income', 'expense')),
  name TEXT NOT NULL
    CHECK (typeof(name) = 'text'),
  normalized_name TEXT NOT NULL
    CHECK (typeof(normalized_name) = 'text'),
  archived_at INTEGER
    CHECK (archived_at IS NULL OR typeof(archived_at) = 'integer'),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL
    CHECK (typeof(updated_at) = 'integer'),
  UNIQUE (kind, normalized_name)
);

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
      AND payee = ''
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

CREATE TABLE ledger_idempotency (
  operation_scope TEXT NOT NULL
    CHECK (typeof(operation_scope) = 'text'),
  idempotency_key TEXT NOT NULL
    CHECK (typeof(idempotency_key) = 'text'),
  request_fingerprint TEXT NOT NULL
    CHECK (typeof(request_fingerprint) = 'text' AND length(request_fingerprint) = 64),
  response_status INTEGER NOT NULL
    CHECK (typeof(response_status) = 'integer' AND response_status BETWEEN 100 AND 599),
  response_body_json TEXT NOT NULL
    CHECK (typeof(response_body_json) = 'text'),
  result_status TEXT NOT NULL
    CHECK (result_status IN ('committed', 'no-op')),
  result_type TEXT,
  result_id TEXT,
  created_at INTEGER NOT NULL
    CHECK (typeof(created_at) = 'integer'),
  PRIMARY KEY (operation_scope, idempotency_key)
);

CREATE INDEX idx_ledger_accounts_archived_updated
  ON ledger_accounts(archived_at, updated_at DESC, id DESC);

CREATE INDEX idx_ledger_categories_kind_archived_name
  ON ledger_categories(kind, archived_at, normalized_name, id);

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
