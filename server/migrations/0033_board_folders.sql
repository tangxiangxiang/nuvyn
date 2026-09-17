CREATE TABLE board_folders (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(trim(name)) <= 80),
  parent_id TEXT REFERENCES board_folders(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);

ALTER TABLE boards ADD COLUMN folder_id TEXT REFERENCES board_folders(id) ON DELETE SET NULL;

CREATE INDEX idx_board_folders_parent_id ON board_folders(parent_id);
CREATE INDEX idx_boards_folder_id ON boards(folder_id);
