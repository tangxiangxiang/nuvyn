-- Categories with history cannot be deleted into the recycle bin. Restore any
-- legacy rows that were archived by the previous delete fallback.
UPDATE ledger_categories
SET archived_at = NULL,
    version = version + 1,
    updated_at = archived_at
WHERE archived_at IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM ledger_transactions
    WHERE ledger_transactions.category_id = ledger_categories.id
  );
