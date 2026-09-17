CREATE TABLE boards (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer')
);

CREATE TABLE board_scenes (
  board_id TEXT PRIMARY KEY NOT NULL
    REFERENCES boards(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  scene_version INTEGER NOT NULL CHECK (typeof(scene_version) = 'integer' AND scene_version >= 1),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0),
  engine_data_json TEXT NOT NULL,
  persistent_app_state_json TEXT NOT NULL
);
