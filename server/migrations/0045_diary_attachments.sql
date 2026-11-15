-- Diary files are encrypted in the private data directory. This table stores
-- only opaque identities, lifecycle state and encrypted private metadata.
CREATE TABLE diary_day_attachments (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_date TEXT NOT NULL CHECK (
    length(day_date) = 10
    AND day_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND day_date >= '0001-01-01'
    AND date(day_date, '+0 days') IS NOT NULL
    AND date(day_date, '+0 days') = day_date
  ),
  encrypted_metadata BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'attached', 'deleting')),
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  request_key TEXT,
  UNIQUE (owner_user_id, request_key)
);

CREATE INDEX idx_diary_day_attachments_date
  ON diary_day_attachments(owner_user_id, day_date, status, display_order, id);
CREATE INDEX idx_diary_day_attachments_expiry
  ON diary_day_attachments(status, expires_at);
