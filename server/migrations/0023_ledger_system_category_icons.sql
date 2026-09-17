UPDATE ledger_categories
SET icon = CASE system_key
  WHEN 'interest' THEN 'custom_builtin_category_expense_interest'
  WHEN 'fee' THEN 'custom_builtin_category_expense_fee'
  ELSE icon
END
WHERE system_key IN ('interest', 'fee');
