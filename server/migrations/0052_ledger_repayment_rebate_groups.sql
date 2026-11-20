-- A repayment rebate is stored as a positive income companion so it restores
-- the source asset balance. Its group links it to the repayment, where
-- analytics interpret it as a negative expense adjustment instead of income.
DROP TRIGGER IF EXISTS ledger_transactions_group_fields_insert;
DROP TRIGGER IF EXISTS ledger_transactions_group_fields_update;

CREATE TRIGGER ledger_transactions_group_fields_insert
BEFORE INSERT ON ledger_transactions
WHEN (
  NEW.group_id IS NOT NULL
  AND NEW.type NOT IN ('transfer', 'expense', 'income')
) OR (
  NEW.type = 'income'
  AND NEW.group_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_transactions AS parent
    WHERE parent.group_id = NEW.group_id
      AND parent.type = 'transfer'
      AND parent.transfer_kind = 'repayment'
      AND parent.deleted_at IS NULL
  )
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
  AND NEW.type NOT IN ('transfer', 'expense', 'income')
) OR (
  NEW.type = 'income'
  AND NEW.group_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_transactions AS parent
    WHERE parent.group_id = NEW.group_id
      AND parent.type = 'transfer'
      AND parent.transfer_kind = 'repayment'
      AND parent.deleted_at IS NULL
  )
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
