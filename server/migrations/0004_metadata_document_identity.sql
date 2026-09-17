ALTER TABLE metadata_migrations RENAME TO metadata_migrations_legacy;

CREATE TABLE metadata_migrations (
  path               TEXT PRIMARY KEY,
  document_id        TEXT REFERENCES documents(id) ON DELETE SET NULL,
  original_path      TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL CHECK (status IN ('legacy', 'imported', 'verified', 'cleaned', 'failed', 'orphaned')),
  source_hash        TEXT NOT NULL DEFAULT '',
  error              TEXT NOT NULL DEFAULT '',
  updated_at         INTEGER NOT NULL,
  frontmatter_backup TEXT NOT NULL DEFAULT '',
  cleaned_hash       TEXT NOT NULL DEFAULT ''
);

INSERT INTO metadata_migrations (
  path, document_id, original_path, status, source_hash, error,
  updated_at, frontmatter_backup, cleaned_hash
)
SELECT
  m.path, d.id, '',
  CASE WHEN d.id IS NULL THEN 'orphaned' ELSE m.status END,
  m.source_hash, m.error, m.updated_at, m.frontmatter_backup, m.cleaned_hash
FROM metadata_migrations_legacy m
LEFT JOIN documents d ON d.path = m.path;

DROP TABLE metadata_migrations_legacy;

CREATE INDEX idx_metadata_migrations_document ON metadata_migrations(document_id);
CREATE INDEX idx_metadata_migrations_original_path ON metadata_migrations(original_path);
