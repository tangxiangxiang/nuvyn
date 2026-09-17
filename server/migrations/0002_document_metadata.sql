CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE tags (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE
);

CREATE TABLE document_tags (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);

CREATE TABLE document_aliases (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  PRIMARY KEY (document_id, alias)
);

CREATE TABLE document_embeddings (
  document_id  TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  model        TEXT NOT NULL,
  embedding    BLOB NOT NULL,
  indexed_at   INTEGER NOT NULL
);

CREATE TABLE metadata_migrations (
  path        TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('legacy', 'imported', 'verified', 'cleaned', 'failed')),
  source_hash TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_documents_updated ON documents(updated_at DESC);
CREATE INDEX idx_document_tags_tag ON document_tags(tag_id, document_id);
CREATE INDEX idx_document_aliases_alias ON document_aliases(alias);
