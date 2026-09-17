-- D7.0A: generic historical metadata snapshots and cross-store journals.
--
-- These tables are deliberately separate from `documents` and
-- `document_tags`: those tables remain the live metadata authority.  The
-- history tables are immutable, revision-bound evidence plus durable
-- operation state; they are never a second live metadata source of truth.

CREATE TABLE history_metadata_operations (
  operation_id       TEXT PRIMARY KEY
    CHECK (length(operation_id) BETWEEN 1 AND 128),
  vault_id           TEXT NOT NULL
    CHECK (length(vault_id) BETWEEN 1 AND 128),
  kind               TEXT NOT NULL CHECK (kind IN ('capture', 'restore')),
  state              TEXT NOT NULL CHECK (state IN (
    'prepared', 'committed', 'compensating', 'recovered', 'aborted',
    'ambiguous', 'failed'
  )),
  expected_parent_sha TEXT,
  commit_sha         TEXT,
  tree_sha           TEXT,
  paths_json         TEXT NOT NULL CHECK (length(paths_json) >= 2),
  expected_hashes_json TEXT NOT NULL CHECK (length(expected_hashes_json) >= 2),
  error_code         TEXT,
  error_message      TEXT,
  created_at         INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at         INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE INDEX idx_history_metadata_operations_state
  ON history_metadata_operations(vault_id, state, updated_at);

CREATE UNIQUE INDEX uq_history_metadata_capture_commit
  ON history_metadata_operations(vault_id, commit_sha)
  WHERE kind = 'capture' AND commit_sha IS NOT NULL;

CREATE TABLE history_metadata_revisions (
  operation_id       TEXT NOT NULL
    REFERENCES history_metadata_operations(operation_id) ON DELETE CASCADE,
  vault_id           TEXT NOT NULL
    CHECK (length(vault_id) BETWEEN 1 AND 128),
  commit_sha         TEXT,
  parent_sha         TEXT,
  tree_sha           TEXT,
  path_at_revision   TEXT NOT NULL
    CHECK (length(path_at_revision) BETWEEN 1 AND 4096),
  document_id        TEXT,
  generation_id      TEXT,
  coverage_kind      TEXT NOT NULL CHECK (coverage_kind IN ('covered', 'legacy')),
  schema_version     INTEGER,
  payload_json       TEXT,
  payload_digest     TEXT,
  body_sha           TEXT,
  captured_at        INTEGER NOT NULL CHECK (captured_at >= 0),
  PRIMARY KEY (operation_id, path_at_revision),
  UNIQUE (vault_id, commit_sha, path_at_revision),
  CHECK (
    (coverage_kind = 'covered'
      AND document_id IS NOT NULL
      AND generation_id IS NOT NULL
      AND schema_version IS NOT NULL
      AND payload_json IS NOT NULL
      AND payload_digest IS NOT NULL)
    OR
    (coverage_kind = 'legacy'
      AND document_id IS NULL
      AND generation_id IS NULL
      AND schema_version IS NULL
      AND payload_json IS NULL
      AND payload_digest IS NULL)
  )
);

CREATE INDEX idx_history_metadata_revisions_lookup
  ON history_metadata_revisions(vault_id, commit_sha, path_at_revision);

CREATE TABLE history_metadata_restore_journal (
  operation_id       TEXT PRIMARY KEY
    REFERENCES history_metadata_operations(operation_id) ON DELETE CASCADE,
  vault_id           TEXT NOT NULL
    CHECK (length(vault_id) BETWEEN 1 AND 128),
  commit_sha         TEXT NOT NULL,
  path_at_revision   TEXT NOT NULL
    CHECK (length(path_at_revision) BETWEEN 1 AND 4096),
  document_id        TEXT NOT NULL,
  generation_id      TEXT NOT NULL,
  before_exists      INTEGER NOT NULL CHECK (before_exists IN (0, 1)),
  before_raw         TEXT,
  target_raw         TEXT NOT NULL,
  before_metadata_json TEXT,
  target_metadata_json TEXT NOT NULL,
  target_digest      TEXT NOT NULL,
  created_at         INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at         INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK ((before_exists = 1 AND before_raw IS NOT NULL) OR before_exists = 0),
  CHECK (before_metadata_json IS NULL OR length(before_metadata_json) >= 2),
  CHECK (length(target_metadata_json) >= 2)
);

CREATE INDEX idx_history_metadata_restore_journal_state
  ON history_metadata_restore_journal(vault_id, updated_at);

-- The existing metadata_migrations tombstone is not guaranteed to exist for
-- every document deletion. Keep a small identity-only provenance record for
-- covered create-only History Restore; it is not a live metadata owner.
CREATE TABLE history_metadata_document_tombstones (
  document_id   TEXT PRIMARY KEY,
  original_path TEXT NOT NULL
    CHECK (length(original_path) BETWEEN 1 AND 4096),
  deleted_at    INTEGER NOT NULL CHECK (deleted_at >= 0)
);

CREATE INDEX idx_history_metadata_tombstones_path
  ON history_metadata_document_tombstones(original_path, deleted_at DESC);
