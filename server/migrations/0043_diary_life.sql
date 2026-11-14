-- Diary Reborn: private bodies live only in authenticated encrypted blobs.
CREATE TABLE diary_days (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL CHECK (length(date) = 10 AND date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date >= '0001-01-01' AND date(date, '+0 days') IS NOT NULL AND date(date, '+0 days') = date),
  encrypted_fields BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (owner_user_id, date)
);
CREATE TABLE diary_events (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  start_date TEXT NOT NULL CHECK (length(start_date) = 10 AND start_date >= '0001-01-01' AND date(start_date, '+0 days') IS NOT NULL AND date(start_date, '+0 days') = start_date),
  end_date TEXT NOT NULL CHECK (length(end_date) = 10 AND date(end_date, '+0 days') IS NOT NULL AND date(end_date, '+0 days') = end_date AND end_date >= start_date),
  recurrence TEXT NOT NULL CHECK (recurrence IN ('none', 'yearly')),
  encrypted_fields BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (owner_user_id, id)
);
CREATE INDEX idx_diary_events_range ON diary_events(owner_user_id, start_date, end_date);
-- Content-free deletion receipts prevent stale writes from recreating records.
CREATE TABLE diary_deleted_records (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('day', 'event')),
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  PRIMARY KEY (owner_user_id, kind, id)
);

-- Legacy Diary data was explicitly retired. Historical migrations are immutable.
DROP TABLE diary_plan_migration_failures;
DROP TABLE diary_plan_markdown_migration;
DROP TABLE diary_plan_items;
DROP TABLE diary_migration_consents;
DROP TABLE diary_migration_items;
DROP TABLE diary_migration_runs;
