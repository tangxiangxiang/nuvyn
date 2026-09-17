ALTER TABLE ledger_transactions
ADD COLUMN transfer_kind TEXT
  CHECK (transfer_kind IS NULL OR transfer_kind IN ('general', 'repayment', 'withdrawal'));

UPDATE ledger_transactions
SET transfer_kind = 'general'
WHERE type = 'transfer';

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
