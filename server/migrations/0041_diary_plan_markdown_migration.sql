-- Keep the original encrypted items as the recoverable source and audit record.
CREATE TABLE diary_plan_markdown_migration (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  document_id TEXT NOT NULL,
  source_versions TEXT NOT NULL,
  base_hash TEXT,
  target_hash TEXT NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (owner_user_id, date)
);
