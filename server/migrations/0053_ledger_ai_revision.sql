-- Keep only revision metadata. Triggers participate in the originating write,
-- including compound transactions, foreign-key actions and rollbacks.
CREATE TABLE IF NOT EXISTS ledger_ai_changes (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('settings', 'account', 'category', 'transaction')),
  entity_id TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS ledger_ai_changes_retain AFTER INSERT ON ledger_ai_changes
BEGIN
  DELETE FROM ledger_ai_changes WHERE revision <= NEW.revision - 16384;
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_settings_insert AFTER INSERT ON ledger_settings
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('settings', NEW.singleton_id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_settings_update AFTER UPDATE ON ledger_settings
WHEN OLD.base_currency IS NOT NEW.base_currency
  OR OLD.timezone IS NOT NEW.timezone
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('settings', NEW.singleton_id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_settings_delete AFTER DELETE ON ledger_settings
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('settings', OLD.singleton_id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_account_insert AFTER INSERT ON ledger_accounts
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('account', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_account_update AFTER UPDATE ON ledger_accounts
WHEN OLD.name IS NOT NEW.name
  OR OLD.type IS NOT NEW.type
  OR OLD.nature IS NOT NEW.nature
  OR OLD.opening_balance_minor IS NOT NEW.opening_balance_minor
  OR OLD.opening_date IS NOT NEW.opening_date
  OR OLD.currency IS NOT NEW.currency
  OR OLD.note IS NOT NEW.note
  OR OLD.archived_at IS NOT NEW.archived_at
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('account', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_account_delete AFTER DELETE ON ledger_accounts
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('account', OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_category_insert AFTER INSERT ON ledger_categories
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('category', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_category_update AFTER UPDATE ON ledger_categories
WHEN OLD.kind IS NOT NEW.kind
  OR OLD.name IS NOT NEW.name
  OR OLD.archived_at IS NOT NEW.archived_at
  OR OLD.system_key IS NOT NEW.system_key
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('category', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_category_delete AFTER DELETE ON ledger_categories
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('category', OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_transaction_insert AFTER INSERT ON ledger_transactions
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('transaction', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_transaction_update AFTER UPDATE ON ledger_transactions
WHEN OLD.type IS NOT NEW.type
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.account_id IS NOT NEW.account_id
  OR OLD.from_account_id IS NOT NEW.from_account_id
  OR OLD.to_account_id IS NOT NEW.to_account_id
  OR OLD.category_id IS NOT NEW.category_id
  OR OLD.occurred_at IS NOT NEW.occurred_at
  OR OLD.payee IS NOT NEW.payee
  OR OLD.location IS NOT NEW.location
  OR OLD.note IS NOT NEW.note
  OR OLD.adjustment_calculated_balance_minor IS NOT NEW.adjustment_calculated_balance_minor
  OR OLD.adjustment_target_balance_minor IS NOT NEW.adjustment_target_balance_minor
  OR OLD.transfer_kind IS NOT NEW.transfer_kind
  OR OLD.group_id IS NOT NEW.group_id
  OR OLD.transfer_fee_mode IS NOT NEW.transfer_fee_mode
  OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('transaction', NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_transaction_delete AFTER DELETE ON ledger_transactions
WHEN OLD.deleted_at IS NULL
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('transaction', OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_exclusion_insert AFTER INSERT ON ledger_transaction_statistics_exclusions
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('transaction', NEW.transaction_id);
END;

CREATE TRIGGER IF NOT EXISTS ledger_ai_exclusion_delete AFTER DELETE ON ledger_transaction_statistics_exclusions
BEGIN
  INSERT INTO ledger_ai_changes (entity, entity_id)
  VALUES ('transaction', OLD.transaction_id);
END;
