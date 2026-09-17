ALTER TABLE ledger_categories
ADD COLUMN system_key TEXT
  CHECK (system_key IS NULL OR system_key IN ('interest', 'fee'));

UPDATE ledger_categories
SET system_key = CASE normalized_name
  WHEN '利息' THEN 'interest'
  WHEN '手续费' THEN 'fee'
  ELSE system_key
END,
    archived_at = NULL
WHERE kind = 'expense'
  AND normalized_name IN ('利息', '手续费');

INSERT OR IGNORE INTO ledger_categories (
  id, kind, name, normalized_name, system_key, icon, archived_at, version, created_at, updated_at
)
SELECT 'custom_builtin_category_expense_interest', 'expense', '利息', '利息', 'interest', 'wallet', NULL, 1, 0, 0
WHERE EXISTS (SELECT 1 FROM ledger_settings WHERE singleton_id = 1);

INSERT OR IGNORE INTO ledger_categories (
  id, kind, name, normalized_name, system_key, icon, archived_at, version, created_at, updated_at
)
SELECT 'custom_builtin_category_expense_fee', 'expense', '手续费', '手续费', 'fee', 'wallet', NULL, 1, 0, 0
WHERE EXISTS (SELECT 1 FROM ledger_settings WHERE singleton_id = 1);

CREATE UNIQUE INDEX idx_ledger_categories_system_key
  ON ledger_categories(system_key)
  WHERE system_key IS NOT NULL;

CREATE TRIGGER ledger_categories_system_key_insert
BEFORE INSERT ON ledger_categories
WHEN (
  NEW.system_key IS NOT NULL
  AND (NEW.kind <> 'expense' OR NEW.system_key NOT IN ('interest', 'fee'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid ledger category system key');
END;

CREATE TRIGGER ledger_categories_system_key_update
BEFORE UPDATE OF kind, system_key ON ledger_categories
WHEN (
  NEW.system_key IS NOT NULL
  AND (NEW.kind <> 'expense' OR NEW.system_key NOT IN ('interest', 'fee'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid ledger category system key');
END;
