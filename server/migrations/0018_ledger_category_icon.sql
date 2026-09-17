ALTER TABLE ledger_categories ADD COLUMN icon TEXT NOT NULL DEFAULT 'wallet'
  CHECK (
    icon IN ('wallet', 'credit_card', 'cash', 'building_bank', 'briefcase')
    OR icon LIKE 'custom_%'
  );
