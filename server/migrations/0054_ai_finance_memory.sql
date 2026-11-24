CREATE TABLE IF NOT EXISTS ai_finance_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'agent')),
  content TEXT NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 300),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_user_id, kind, content)
);

CREATE INDEX IF NOT EXISTS idx_ai_finance_memory_owner_kind
  ON ai_finance_memory(owner_user_id, kind, id);

-- Keep only hashes of forgotten entries. This prevents stale chat summaries
-- from silently recreating the exact same memory without retaining its text.
CREATE TABLE IF NOT EXISTS ai_finance_memory_tombstones (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'agent')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, kind, content_hash)
);
