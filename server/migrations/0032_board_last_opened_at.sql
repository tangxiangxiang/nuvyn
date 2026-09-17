ALTER TABLE boards ADD COLUMN last_opened_at INTEGER
  CHECK (last_opened_at IS NULL OR typeof(last_opened_at) = 'integer');
