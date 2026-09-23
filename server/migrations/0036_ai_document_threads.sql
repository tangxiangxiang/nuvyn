ALTER TABLE sessions ADD COLUMN thread_key TEXT;
ALTER TABLE sessions ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE sessions ADD COLUMN vault_id TEXT;
ALTER TABLE sessions ADD COLUMN document_id TEXT;
ALTER TABLE sessions ADD COLUMN context_path TEXT;
ALTER TABLE sessions ADD COLUMN context_title TEXT;
ALTER TABLE sessions ADD COLUMN compact_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN compacted_through_message_id INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX idx_sessions_thread_key
  ON sessions(thread_key)
  WHERE thread_key IS NOT NULL;
