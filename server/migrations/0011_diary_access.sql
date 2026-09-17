-- D8.1: the secondary Diary access configuration.
--
-- This table deliberately stores only the wrapped in-memory key material and
-- the bounded KDF/wrap parameters needed to unwrap it. Passwords, KEKs and
-- plaintext Diary bodies never belong here.

CREATE TABLE diary_access_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format_version INTEGER NOT NULL,
  kdf_algorithm TEXT NOT NULL,
  kdf_version INTEGER NOT NULL,
  kdf_n INTEGER NOT NULL,
  kdf_r INTEGER NOT NULL,
  kdf_p INTEGER NOT NULL,
  kdf_maxmem INTEGER NOT NULL,
  salt BLOB NOT NULL,
  wrap_algorithm TEXT NOT NULL,
  wrap_version INTEGER NOT NULL,
  wrap_nonce BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  wrap_tag BLOB NOT NULL,
  vault_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
