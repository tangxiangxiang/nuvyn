ALTER TABLE ledger_accounts ADD COLUMN card_number TEXT NOT NULL DEFAULT ''
  CHECK (typeof(card_number) = 'text');
