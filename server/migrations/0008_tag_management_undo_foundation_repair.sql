-- Forward repair for the published 0007 foundation.
--
-- 0007 is already migration history and must not be edited in place: a
-- database that recorded schema_version = 7 will never execute a changed
-- 0007.  SQLite cannot alter a CHECK constraint in place, so rebuild the
-- three related foundation tables as one transactional unit.  Copying is
-- deliberately strict; an existing durable row that cannot satisfy the
-- repaired contract aborts this migration and leaves schema_version = 7.

CREATE TABLE tag_undo_records_repair (
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
  CHECK (
    (lifecycle = 'latest'
      AND terminal_code IS NULL
      AND undo_operation_id IS NULL
      AND undo_result_id IS NULL
      AND consumed_at IS NULL)
    OR
    (lifecycle = 'consumed'
      AND terminal_code IS NULL
      AND undo_operation_id IS NOT NULL
      AND undo_result_id IS NOT NULL
      AND consumed_at IS NOT NULL)
    OR
    (lifecycle = 'terminal'
      AND terminal_code IS NOT NULL
      AND undo_operation_id IS NULL
      AND undo_result_id IS NULL
      AND consumed_at IS NULL)
  )
);

CREATE TABLE tag_undo_association_deltas_repair (
  record_id TEXT NOT NULL REFERENCES tag_undo_records_repair(record_id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('removed-source', 'created-destination')),
  association_id INTEGER NOT NULL CHECK (association_id > 0),
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 512),
  tag_id INTEGER NOT NULL CHECK (tag_id > 0),
  PRIMARY KEY (record_id, effect, association_id)
);

CREATE TABLE tag_undo_state_repair (
  state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
  database_generation TEXT NOT NULL UNIQUE
    CHECK (length(database_generation) BETWEEN 1 AND 128),
  current_record_id TEXT REFERENCES tag_undo_records_repair(record_id),
  last_superseded_record_id TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

INSERT INTO tag_undo_records_repair (
  record_id, original_operation_id, original_result_id, kind, display_only,
  identity_contract_version, record_contract_version, database_generation,
  operation_json, committed_at, source_tag_id, source_before_name,
  source_before_normalized_name, source_after_exists, source_after_name,
  source_after_normalized_name, destination_tag_id, destination_before_name,
  destination_before_normalized_name, destination_after_name,
  destination_after_normalized_name, lifecycle, terminal_code,
  undo_operation_id, undo_result_id, consumed_at, association_remove_count,
  association_add_count, version_update_count
)
SELECT
  record_id, original_operation_id, original_result_id, kind, display_only,
  identity_contract_version, record_contract_version, database_generation,
  operation_json, committed_at, source_tag_id, source_before_name,
  source_before_normalized_name, source_after_exists, source_after_name,
  source_after_normalized_name, destination_tag_id, destination_before_name,
  destination_before_normalized_name, destination_after_name,
  destination_after_normalized_name, lifecycle, terminal_code,
  undo_operation_id, undo_result_id, consumed_at, association_remove_count,
  association_add_count, version_update_count
FROM tag_undo_records;

INSERT INTO tag_undo_association_deltas_repair (
  record_id, effect, association_id, document_id, tag_id
)
SELECT record_id, effect, association_id, document_id, tag_id
FROM tag_undo_association_deltas;

INSERT INTO tag_undo_state_repair (
  state_id, database_generation, current_record_id,
  last_superseded_record_id, updated_at
)
SELECT state_id, database_generation, current_record_id,
  last_superseded_record_id, updated_at
FROM tag_undo_state;

DROP TABLE tag_undo_association_deltas;
DROP TABLE tag_undo_state;
DROP TABLE tag_undo_records;

ALTER TABLE tag_undo_records_repair RENAME TO tag_undo_records;
ALTER TABLE tag_undo_association_deltas_repair RENAME TO tag_undo_association_deltas;
ALTER TABLE tag_undo_state_repair RENAME TO tag_undo_state;

CREATE INDEX idx_tag_undo_records_lifecycle
  ON tag_undo_records(lifecycle, committed_at DESC);

CREATE INDEX idx_tag_undo_deltas_record_document
  ON tag_undo_association_deltas(record_id, document_id);

CREATE INDEX idx_tag_undo_deltas_record_effect_association
  ON tag_undo_association_deltas(record_id, effect, association_id);
