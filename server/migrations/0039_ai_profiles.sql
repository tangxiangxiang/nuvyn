-- Credential conversion is performed separately by initializeAiProfiles().
-- Never copy plaintext or discard the original provider settings in SQL.
CREATE TABLE ai_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
  encrypted_api_key TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
