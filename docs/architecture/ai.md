# AI Architecture

The browser streams conversations through server routes. The server owns provider credentials, builds live workspace context, calls Anthropic or OpenAI, executes tools, and persists sessions and messages.

## Role in the Personal OS

AI is not a separate first-level Workspace. It is part of the `Personal OS Intelligence Layer`: a system capability that can eventually understand the same owner's context across Note, Diary, Ledger, and Board. The current runtime is deliberately narrower and operates on protected live workspace context, validated files, and metadata tools.

The long-term product direction includes questions such as “Why did I decide not to use File Tree on the Board homepage?”, “How much did the Nuvyn project cost this month?”, and “What was I mainly working on this month?”. These may require Note, Diary, Board, Ledger, and history context together, but this document does not claim that cross-Workspace synthesis is implemented.

## Request path

```mermaid
flowchart LR
  UI["AI panel"] --> Context["Live workspace context"]
  Context --> API["/api/ai"]
  API --> Provider["Anthropic or OpenAI"]
  Provider --> Tools["Server tool loop"]
  Tools --> Vault["Validated vault operations"]
  API --> DB["SQLite sessions and messages"]
```

Context may represent the current document, a comparison, or a recovery view. For an edited document it can include the unsaved browser buffer rather than only the disk copy. Attachments are identified by validated workspace paths.

## Tool execution

Nuvyn currently exposes eight model tools:

- `read_file`
- `update_metadata`
- `list_files`
- `create_file`
- `write_file`
- `patch_file`
- `delete_file`
- `rename_file`

Tool calls execute automatically. They reuse path validation, archive policy, and document mutation safeguards where applicable. A multi-step AI run is not an all-or-nothing database transaction: successful earlier calls remain applied if a later call fails.

## Credentials

Named AI profiles store protocol, model, base URL and encrypted API key in SQLite `ai_profiles` (migration `0039_ai_profiles.sql`). IDs are stable and independent of editable names/models. Multiple profiles can use either Anthropic or OpenAI; these are protocol names, not service brands. The KV key `ai.active.profileId` selects at most one default; an empty value disables AI. New profiles never become default automatically. API keys are encrypted with AES-256-GCM using a 32-byte master key resolved in this order:

1. `NUVYN_MASTER_KEY`
2. `NUVYN_MASTER_KEY_FILE`
3. auto-created `data/.nuvyn-master-key` when a key is first saved

The canonical key sources are listed above; no compatibility aliases are read.

The master key is not stored in SQLite. Losing it makes stored provider keys unreadable; exposing it together with the database exposes those keys.

## Profile import and compatibility

Schema migration 0039 creates the table without touching credential material.
`getDb()` explicitly imports the old provider slots once at database initialization.
The import is one SQLite transaction, recorded by `ai.profiles.imported.v1`:

- A slot with any saved key, Base URL or model becomes one deterministic legacy profile.
- Modern AES-GCM ciphertext is copied verbatim; importing metadata does not require its master key.
- Plaintext or `ai.encryption.key` formats use the existing read-only legacy decoder first. Every encrypted slot must be recoverable before a fallback key may be created. Only the profile copy is re-encrypted with the current master key.
- The old active protocol selects its imported profile. An absent active slot does not silently activate the other protocol.
- Original KV rows are retained as upgrade recovery data. Once imported, they are not the runtime authority and receive no normal dual writes. Re-running/restarting never re-imports stale slots.
- A failed historical conversion rolls back all Profile rows/default/import marker. The application stays available, and Profile listing exposes only metadata and safe error codes. Ordinary GETs do not repeatedly retry that conversion. After restoring the original key, explicitly retry through Settings or `POST /api/ai/profiles/retry-migration`; targeted explicit key removal is also available.

Profile API: `GET/POST /api/ai/profiles`, `PATCH/DELETE /api/ai/profiles/:id`,
`PUT /api/ai/profiles/:id/activate`, and `POST /api/ai/profiles/:id/test-connection`.
A new unsaved form uses `POST /api/ai/profiles/test-connection`.
Unspecified/blank keys preserve the credential; `clearKey: true` explicitly removes it.
Changing protocol while retaining a saved credential requires explicit consent.
Deleting a default requires first selecting a replacement or explicitly consenting
to disable AI; it never chooses the first remaining profile.

Legacy `GET /api/ai/settings` returns only the default profile view;
`GET /api/ai/settings/credential-status` remains a non-decrypting metadata view.
The older write and probe APIs operate only when their protocol-slot semantics
are unambiguous, otherwise return `409 ai-profile-ambiguous` without mutation.
Legacy PUT preserves its historical explicit-provider selection semantics and
empty-key removal; the new UI uses only the Profile APIs.

## Request configuration snapshot

`getAiRuntimeConfig()` resolves only the default Profile. The chat route captures
one immutable-by-ownership configuration value before streaming. Every tool round
and compaction call receives that value. Text generation helpers (Title, Summary,
Tags, Slug and commit subject) likewise pass their resolved snapshot to
`generateText()`. Changing or deleting the default during a request affects only
future requests. Backend cache entries contain protocol adapters, never credentials,
endpoints or models; SDK clients receive the request snapshot. Existing sessions,
message envelopes, tools and abort behavior retain their current formats.

## Settings connection probe

The Settings connection test validates the exact provider, credential, Base URL,
and model currently displayed by the user without turning those values into a
saved configuration:

```mermaid
flowchart LR
  Form["Settings form"] --> Route["POST /api/ai/profiles/:id/test-connection"]
  Route --> Config["Transient provider config + read-only saved credential fallback"]
  Config --> Probe["Minimal provider probe"]
  Probe --> Result["Safe result"]
  Result --> NoWrite["No settings persistence"]
```

An unsaved API key, Base URL, or model is passed only to this request. If the
API Key field is empty, the route reads only the selected profile's saved credential
without triggering credential migration or writing any `ai.*` settings rows.
The probe bypasses the normal chat session, streaming, and persistence flow and
does not execute workspace mutation tools. Its harmless tool definition exists
only to verify the tool/function-calling capability required by normal Nuvyn
workspace actions.

OpenAI uses a non-streaming Chat Completions-compatible request at the configured
API root; Nuvyn appends `/chat/completions`. Anthropic uses a non-streaming
Messages API request. Neither provider is tested by merely calling a Models API.
The probe disables SDK retries and has an approximately 10-second bound. OpenAI
starts with `max_tokens` and makes at most one compatibility retry with
`max_completion_tokens` when the provider explicitly rejects the former; other
provider failures are not retried by this compatibility path.
Provider errors are classified and sanitized before returning to the browser;
secrets in upstream messages are replaced with `[redacted]`.

## Trust boundary

AI output is untrusted input. Tool safety policy blocks unsupported or unsafe mutations, but users should still review results and keep backups. The AI Markdown renderer disables raw HTML. See [AI Assistant](../user-guide/ai.md) and [Security Model](security.md).
