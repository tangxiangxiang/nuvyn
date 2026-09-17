-- Phase 2.1 T2.1-0 foundation.  This migration installs explicit
-- document-tag association provenance and the bounded Undo state schema;
-- recording is intentionally not activated by this migration.

DROP INDEX IF EXISTS idx_document_tags_tag;

CREATE TABLE document_tags_phase21 (
  association_id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE(document_id, tag_id)
);

INSERT INTO document_tags_phase21 (document_id, tag_id)
SELECT document_id, tag_id
FROM document_tags
ORDER BY document_id COLLATE BINARY, tag_id;

DROP TABLE document_tags;
ALTER TABLE document_tags_phase21 RENAME TO document_tags;

CREATE INDEX idx_document_tags_tag ON document_tags(tag_id, document_id);
CREATE INDEX idx_document_tags_document ON document_tags(document_id, tag_id);

CREATE TABLE tag_undo_records (
  record_id TEXT PRIMARY KEY
    CHECK (length(record_id) BETWEEN 1 AND 128),
  original_operation_id TEXT NOT NULL UNIQUE
    CHECK (length(original_operation_id) BETWEEN 1 AND 128),
  original_result_id TEXT NOT NULL
    CHECK (length(original_result_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('rename', 'merge', 'remove')),
  display_only INTEGER NOT NULL CHECK (display_only IN (0, 1)),
  identity_contract_version TEXT NOT NULL
    CHECK (length(identity_contract_version) BETWEEN 1 AND 64),
  record_contract_version TEXT NOT NULL
    CHECK (length(record_contract_version) BETWEEN 1 AND 64),
  database_generation TEXT NOT NULL
    CHECK (length(database_generation) BETWEEN 1 AND 128),
  operation_json TEXT NOT NULL
    CHECK (length(operation_json) BETWEEN 2 AND 32768),
  committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
  source_tag_id INTEGER NOT NULL CHECK (source_tag_id > 0),
  source_before_name TEXT NOT NULL
    CHECK (length(source_before_name) BETWEEN 1 AND 200),
  source_before_normalized_name TEXT NOT NULL
    CHECK (length(source_before_normalized_name) BETWEEN 1 AND 200),
  source_after_exists INTEGER NOT NULL CHECK (source_after_exists IN (0, 1)),
  source_after_name TEXT CHECK (source_after_name IS NULL OR length(source_after_name) BETWEEN 1 AND 200),
  source_after_normalized_name TEXT CHECK (source_after_normalized_name IS NULL OR length(source_after_normalized_name) BETWEEN 1 AND 200),
  destination_tag_id INTEGER CHECK (destination_tag_id IS NULL OR destination_tag_id > 0),
  destination_before_name TEXT CHECK (destination_before_name IS NULL OR length(destination_before_name) BETWEEN 1 AND 200),
  destination_before_normalized_name TEXT CHECK (destination_before_normalized_name IS NULL OR length(destination_before_normalized_name) BETWEEN 1 AND 200),
  destination_after_name TEXT CHECK (destination_after_name IS NULL OR length(destination_after_name) BETWEEN 1 AND 200),
  destination_after_normalized_name TEXT CHECK (destination_after_normalized_name IS NULL OR length(destination_after_normalized_name) BETWEEN 1 AND 200),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('latest', 'consumed', 'terminal')),
  terminal_code TEXT CHECK (terminal_code IS NULL OR length(terminal_code) BETWEEN 1 AND 128),
  undo_operation_id TEXT CHECK (undo_operation_id IS NULL OR length(undo_operation_id) BETWEEN 1 AND 128),
  undo_result_id TEXT CHECK (undo_result_id IS NULL OR length(undo_result_id) BETWEEN 1 AND 128),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),
  association_remove_count INTEGER NOT NULL DEFAULT 0 CHECK (association_remove_count >= 0),
  association_add_count INTEGER NOT NULL DEFAULT 0 CHECK (association_add_count >= 0),
  version_update_count INTEGER NOT NULL DEFAULT 0 CHECK (version_update_count >= 0),
  CHECK (kind = 'rename' OR display_only = 0),
  CHECK (source_after_exists = 1 OR (source_after_name IS NULL AND source_after_normalized_name IS NULL)),
  CHECK (source_after_exists = 0 OR (source_after_name IS NOT NULL AND source_after_normalized_name IS NOT NULL)),
  CHECK (lifecycle = 'consumed' OR (undo_operation_id IS NULL AND undo_result_id IS NULL AND consumed_at IS NULL)),
  CHECK (lifecycle <> 'consumed' OR (undo_operation_id IS NOT NULL AND undo_result_id IS NOT NULL AND consumed_at IS NOT NULL)),
  CHECK (lifecycle = 'consumed' OR terminal_code IS NULL),
  CHECK (lifecycle = 'terminal' OR terminal_code IS NULL),
  CHECK (lifecycle <> 'terminal' OR terminal_code IS NOT NULL)
);

CREATE INDEX idx_tag_undo_records_lifecycle
  ON tag_undo_records(lifecycle, committed_at DESC);

CREATE TABLE tag_undo_association_deltas (
  record_id TEXT NOT NULL REFERENCES tag_undo_records(record_id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('removed-source', 'created-destination')),
  association_id INTEGER NOT NULL CHECK (association_id > 0),
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 512),
  tag_id INTEGER NOT NULL CHECK (tag_id > 0),
  PRIMARY KEY (record_id, effect, association_id)
);

CREATE INDEX idx_tag_undo_deltas_record_document
  ON tag_undo_association_deltas(record_id, document_id);

CREATE INDEX idx_tag_undo_deltas_record_effect_association
  ON tag_undo_association_deltas(record_id, effect, association_id);

CREATE TABLE tag_undo_state (
  state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
  database_generation TEXT NOT NULL UNIQUE
    CHECK (length(database_generation) BETWEEN 1 AND 128),
  current_record_id TEXT REFERENCES tag_undo_records(record_id),
  last_superseded_record_id TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

INSERT INTO tag_undo_state (
  state_id,
  database_generation,
  current_record_id,
  last_superseded_record_id,
  updated_at
)
VALUES (1, lower(hex(randomblob(16))), NULL, NULL, strftime('%s', 'now') * 1000);
