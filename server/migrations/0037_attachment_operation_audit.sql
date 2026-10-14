CREATE TABLE attachment_operation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL CHECK (operation IN (
    'attachment-manager-upload',
    'note-import-from-board-asset',
    'board-import-from-vault-image',
    'board-reuse-asset'
  )),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('vault-image', 'board-asset')),
  resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 128),
  source_workspace TEXT NOT NULL CHECK (source_workspace IN ('local-file', 'vault-image', 'board-asset')),
  source_resource_id TEXT CHECK (source_resource_id IS NULL OR length(source_resource_id) <= 128),
  target_workspace TEXT NOT NULL CHECK (target_workspace IN ('note-library', 'board')),
  target_workspace_id TEXT CHECK (target_workspace_id IS NULL OR length(target_workspace_id) <= 128),
  result TEXT NOT NULL CHECK (result IN ('success', 'failure')),
  failure_category TEXT CHECK (failure_category IS NULL OR failure_category IN ('validation', 'authorization', 'storage', 'stale-target', 'unknown')),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
);

CREATE INDEX idx_attachment_operation_audit_recent
  ON attachment_operation_audit(id DESC);
