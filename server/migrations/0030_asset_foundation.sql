CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (typeof(byte_size) = 'integer' AND byte_size >= 0),
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer')
);

CREATE TABLE asset_references (
  asset_id TEXT NOT NULL
    REFERENCES assets(id) ON DELETE RESTRICT,
  owner_type TEXT NOT NULL CHECK (length(trim(owner_type)) > 0),
  owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
  PRIMARY KEY (asset_id, owner_type, owner_id, purpose)
);

CREATE INDEX idx_asset_references_owner
  ON asset_references(owner_type, owner_id, purpose, asset_id);
