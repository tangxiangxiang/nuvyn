-- D8.4: structural Diary migration inventory, state and action consent.
--
-- These tables are deliberately limited to migration provenance.  They must
-- never become a body store: no plaintext, body size, plaintext digest,
-- password, key, capability or AI message content is accepted here.

CREATE TABLE diary_migration_runs (
  run_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  inventory_revision INTEGER NOT NULL,
  reviewed_revision INTEGER,
  state TEXT NOT NULL CHECK (state IN (
    'NOT_STARTED','INVENTORIED','NEEDS_UNLOCK','RUNNING','ATTENTION_REQUIRED',
    'COMPLETE','FAILED'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE diary_migration_items (
  item_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES diary_migration_runs(run_id),
  vault_id TEXT NOT NULL,
  document_id TEXT,
  canonical_path TEXT NOT NULL,
  inventory_revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  classification TEXT NOT NULL CHECK (classification IN (
    'ALREADY_ENCRYPTED_VALID','LEGACY_PLAINTEXT',
    'ENCRYPTED_MALFORMED','ENCRYPTED_UNKNOWN_VERSION',
    'ENCRYPTED_IDENTITY_MISMATCH','METADATA_MISSING',
    'METADATA_AMBIGUOUS','PRIMARY_MISSING','EXTERNAL_PATH_CONFLICT',
    'MIGRATION_IN_PROGRESS','CLEANUP_PENDING','RECOVERY_AUTH_REQUIRED',
    'DURABILITY_PENDING','CONSENT_REQUIRED','USER_FINALIZE_REQUIRED',
    'UNSUPPORTED','LEGACY_DIARY_AI_HISTORY','FRONTMATTER_IDENTITY_UNRESOLVED',
    'NEEDS_ATTENTION'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'DISCOVERED','NEEDS_UNLOCK','READY','PREPARING',
    'ENCRYPTED_VERIFIED','PUBLISHING','USER_FINALIZE_REQUIRED',
    'RECOVERY_AUTH_REQUIRED','DURABILITY_PENDING','CONSENT_REQUIRED','PUBLISHED',
    'CLEANUP_PENDING','COMPLETE','NEEDS_ATTENTION'
  )),
  finalize_capability TEXT NOT NULL CHECK (finalize_capability IN (
    'AUTOMATIC_HANDLE_BOUND','USER_FINALIZE_REQUIRED','UNSUPPORTED'
  )),
  source_generation_json TEXT,
  source_parent_generation_json TEXT,
  reviewed_source_generation_json TEXT,
  candidate_name TEXT,
  candidate_generation_json TEXT,
  candidate_parent_generation_json TEXT,
  candidate_durability TEXT CHECK (candidate_durability IN (
    'NOT_STARTED','UNKNOWN','DURABLE','FAILED'
  )),
  quarantine_name TEXT,
  quarantine_generation_json TEXT,
  quarantine_parent_generation_json TEXT,
  quarantine_durability TEXT CHECK (quarantine_durability IN (
    'NOT_STARTED','UNKNOWN','DURABLE','FAILED'
  )),
  target_generation_json TEXT,
  transaction_id TEXT,
  ciphertext_fingerprint TEXT,
  ai_session_id INTEGER,
  ai_message_ids_json TEXT,
  frontmatter_row_cas_json TEXT,
  envelope_version INTEGER,
  attention_code TEXT,
  user_residual_state TEXT CHECK (user_residual_state IN (
    'NONE','USER_CONTROLLED_PLAINTEXT_RESIDUAL'
  )),
  last_action_scope TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, inventory_revision, item_key)
);

CREATE TABLE diary_migration_consents (
  consent_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES diary_migration_runs(run_id),
  vault_id TEXT NOT NULL,
  inventory_revision INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  action_scope TEXT NOT NULL CHECK (action_scope IN (
    'MIGRATE_PRIMARY','REMOVE_VERIFIED_LEGACY_PRIMARY','CLEAN_PRIVATE_SQLITE',
    'IMPORT_DRAFT','DISCARD_DRAFT','DISCARD_AI_SESSION','RETAIN_AI_HISTORY',
    'BIND_FRONTMATTER_IDENTITY','ACKNOWLEDGE_GIT_RETENTION'
  )),
  reviewed_generation_json TEXT,
  reviewed_item_set_fingerprint TEXT NOT NULL,
  consented_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('GRANTED','INVALIDATED','CONSUMED')),
  FOREIGN KEY (run_id, inventory_revision, item_key)
    REFERENCES diary_migration_items(run_id, inventory_revision, item_key)
);

CREATE INDEX idx_diary_migration_items_run_state
  ON diary_migration_items(run_id, state);
CREATE INDEX idx_diary_migration_items_identity
  ON diary_migration_items(vault_id, document_id, canonical_path, schema_version);
CREATE INDEX idx_diary_migration_consents_scope
  ON diary_migration_consents(run_id, inventory_revision, action_scope, item_key);
