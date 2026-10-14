-- Upload provenance is independent of bounded operation audit retention.
CREATE TABLE note_image_identity (
  vault_key TEXT NOT NULL,
  path TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  mtime TEXT NOT NULL,
  PRIMARY KEY (vault_key, path)
);

CREATE TABLE attachment_trash (
  id TEXT PRIMARY KEY,
  vault_key TEXT NOT NULL,
  path TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  mtime TEXT NOT NULL,
  recycled_at INTEGER NOT NULL,
  restored_at INTEGER,
  state TEXT NOT NULL CHECK(state IN ('recycling', 'trashed', 'restoring', 'restored', 'blocked'))
);
CREATE UNIQUE INDEX attachment_trash_live_path ON attachment_trash(vault_key, path) WHERE state != 'restored';
CREATE INDEX attachment_trash_page ON attachment_trash(vault_key, recycled_at DESC, id);

-- Preserve old audit rows while expanding its operation constraint.
ALTER TABLE attachment_operation_audit RENAME TO attachment_operation_audit_old;
CREATE TABLE attachment_operation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL CHECK(operation IN ('attachment-manager-upload', 'note-import-from-board-asset', 'board-import-from-vault-image', 'board-reuse-asset', 'attachment-quarantine', 'attachment-restore')),
  resource_type TEXT NOT NULL CHECK(resource_type IN ('vault-image', 'board-asset')),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 128),
  source_workspace TEXT NOT NULL CHECK(source_workspace IN ('local-file', 'vault-image', 'board-asset')),
  source_resource_id TEXT CHECK(source_resource_id IS NULL OR length(source_resource_id) <= 128),
  target_workspace TEXT NOT NULL CHECK(target_workspace IN ('note-library', 'board')),
  target_workspace_id TEXT CHECK(target_workspace_id IS NULL OR length(target_workspace_id) <= 128),
  result TEXT NOT NULL CHECK(result IN ('success', 'failure')),
  failure_category TEXT CHECK(failure_category IS NULL OR failure_category IN ('validation', 'authorization', 'storage', 'stale-target', 'unknown')),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
);
INSERT INTO attachment_operation_audit SELECT * FROM attachment_operation_audit_old;
DROP TABLE attachment_operation_audit_old;
CREATE INDEX idx_attachment_operation_audit_recent ON attachment_operation_audit(id DESC);
