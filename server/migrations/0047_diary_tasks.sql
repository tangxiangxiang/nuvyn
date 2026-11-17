-- Todo records are independent from recurring life events. All task content,
-- including completion time, remains in the authenticated encrypted payload.
CREATE TABLE diary_tasks (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  due_date TEXT CHECK (
    due_date IS NULL OR (
      length(due_date) = 10
      AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND due_date >= '0001-01-01'
      AND date(due_date, '+0 days') IS NOT NULL
      AND date(due_date, '+0 days') = due_date
    )
  ),
  encrypted_fields BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (owner_user_id, id)
);
CREATE INDEX idx_diary_tasks_due_date ON diary_tasks(owner_user_id, due_date, id);

-- Content-free deletion receipts stop stale clients from reviving old tasks.
CREATE TABLE diary_task_deleted_records (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  PRIMARY KEY (owner_user_id, id)
);
