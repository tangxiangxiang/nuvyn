ALTER TABLE ledger_transactions
ADD COLUMN group_id TEXT
  CHECK (group_id IS NULL OR (typeof(group_id) = 'text' AND length(trim(group_id)) > 0));

ALTER TABLE ledger_transactions
ADD COLUMN transfer_fee_mode TEXT
  CHECK (transfer_fee_mode IS NULL OR transfer_fee_mode IN ('extra', 'deducted'));

CREATE INDEX idx_ledger_transactions_group
  ON ledger_transactions(group_id, deleted_at, occurred_at DESC, created_at DESC, id DESC);

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
