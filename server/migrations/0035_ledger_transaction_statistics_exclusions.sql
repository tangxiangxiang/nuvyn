CREATE TABLE ledger_transaction_statistics_exclusions (
  transaction_id TEXT PRIMARY KEY NOT NULL
    REFERENCES ledger_transactions(id) ON DELETE CASCADE,
  excluded_at INTEGER NOT NULL
    CHECK (typeof(excluded_at) = 'integer')
);
