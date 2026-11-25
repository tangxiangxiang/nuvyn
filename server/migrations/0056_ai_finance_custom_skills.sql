CREATE TABLE ai_finance_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 8 AND 64),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 80),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 240),
  content TEXT NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 3000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_user_id, name)
);

CREATE INDEX idx_ai_finance_skills_owner
  ON ai_finance_skills(owner_user_id, name);

CREATE TABLE ai_finance_skill_tombstones (
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 8 AND 64),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 80),
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, name)
);
