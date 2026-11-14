CREATE TABLE diary_plan_items (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  encrypted_fields BLOB,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (owner_user_id, id)
);

-- A NULL payload is a deletion receipt. Retain the ID so a delayed create
-- retry cannot recreate a deleted item.
CREATE INDEX idx_diary_plan_owner_date
  ON diary_plan_items(owner_user_id, date)
  WHERE encrypted_fields IS NOT NULL;
