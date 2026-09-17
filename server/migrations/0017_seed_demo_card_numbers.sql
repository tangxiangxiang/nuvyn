UPDATE ledger_accounts
SET card_number = printf('6222%012d', abs(random()) % 1000000000000)
WHERE card_number = ''
  AND type IN ('bank', 'credit_card');
