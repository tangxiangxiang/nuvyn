CREATE TABLE board_materials (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(trim(name)) <= 80),
  kind TEXT NOT NULL CHECK (kind = 'svg'),
  content TEXT NOT NULL CHECK (length(content) > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);

CREATE INDEX idx_board_materials_archived_updated
  ON board_materials(archived, updated_at DESC, id DESC);
