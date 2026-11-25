ALTER TABLE ai_finance_memory
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
