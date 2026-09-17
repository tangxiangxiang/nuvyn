-- Persist the historical labels of grouped repayment and withdrawal charges.
--
-- Companion expenses are not independently editable. Their payee is a
-- transaction-time snapshot derived from the accounts involved in the
-- grouped transfer, so the read path can treat the stored value as the
-- source of truth. Only fill the known legacy representations: blank rows
-- and repayment rows that stored only the destination account name. Any
-- other non-empty value is an existing historical snapshot and must stay
-- untouched.
UPDATE ledger_transactions AS expense
SET payee = (
  SELECT CASE transfer.transfer_kind
    WHEN 'repayment' THEN destination.name || '还款利息'
    WHEN 'withdrawal' THEN source.name || '提现手续费'
  END
  FROM ledger_transactions AS transfer
  JOIN ledger_accounts AS source
    ON source.id = transfer.from_account_id
  JOIN ledger_accounts AS destination
    ON destination.id = transfer.to_account_id
  WHERE transfer.type = 'transfer'
    AND transfer.transfer_kind IN ('repayment', 'withdrawal')
    AND transfer.group_id = expense.group_id
    AND transfer.from_account_id = expense.account_id
  LIMIT 1
),
    version = version + 1
WHERE expense.type = 'expense'
  AND expense.group_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM ledger_transactions AS transfer
    JOIN ledger_accounts AS source
      ON source.id = transfer.from_account_id
    JOIN ledger_accounts AS destination
      ON destination.id = transfer.to_account_id
    WHERE transfer.type = 'transfer'
      AND transfer.transfer_kind IN ('repayment', 'withdrawal')
      AND transfer.group_id = expense.group_id
      AND transfer.from_account_id = expense.account_id
      AND (
        expense.payee IS NULL
        OR TRIM(expense.payee) = ''
        OR (
          transfer.transfer_kind = 'repayment'
          AND expense.payee = destination.name
        )
      )
  );
