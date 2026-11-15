-- Early Diary builds recorded version 43 before including deletion receipts.
CREATE TABLE IF NOT EXISTS diary_deleted_records (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('day', 'event')),
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  PRIMARY KEY (owner_user_id, kind, id)
);
