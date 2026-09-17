ALTER TABLE ledger_transactions
  ADD COLUMN location TEXT NOT NULL DEFAULT ''
  CHECK (typeof(location) = 'text');
