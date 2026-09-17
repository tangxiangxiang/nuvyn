# Changelog

All notable changes to Nuvyn are documented in this file. Entries dated before
the Nuvyn brand baseline may refer to Nuvyn as the historical product name.

## Ledger archived category management — 2026-09-12

- Added a collapsed settings section for restoring archived categories or permanently deleting categories without history; server-side history protection remains authoritative.

## Ledger current-state documentation sync — 2026-09-12

- Documented the shipped Ledger workspace, account and account-detail lifecycle, category and icon management, and dashboard projections.
- Documented the transaction table with income, expense, transfer, repayment, and withdrawal flows, including interest/fee handling and period navigation.
- Added current user-guide, architecture, and UI-language authorities; retained earlier Ledger PRDs and implementation plans as historical planning lineage.

## Diary Calendar MVP — 2026-08-25

- Added a Calendar-first `diary/` scope with one managed Markdown entry per local calendar date.
- Today and past missing dates can be created through the date command; missing future dates remain unopened, while existing future entries can still be edited.
- Diary entries reuse the existing editor, History, Recovery, and delete lifecycle; managed date identities and the reserved `diary` root remain protected from rename/move operations.
- Completed responsive, keyboard/focus, mobile, compatibility, and release regression validation without changing the approved VCalendar candidate or core Nuvyn stack.

## Archive workflow — 2026-08-24

- Relaxed `archive/` from a protected content subtree to a recommended organizational area.
- Archive descendants now follow ordinary Nuvyn file/folder lifecycle rules instead of archive-specific restrictions: files can be created, renamed, moved, and deleted normally, while folders retain the existing Nuvyn CRUD capabilities. General folder re-parenting remains unsupported.
- The top-level `archive` root remains reserved so the built-in Archive action keeps a stable destination.

## Markdown Rendering Maintenance — 2026-08-24

### Compatibility

- Switched callouts to strict GitHub-style Alert markers: only uppercase
  `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, and `CAUTION` are recognized.
- Legacy, lowercase, titled, folded, and unknown Obsidian-style callout forms
  now remain ordinary blockquotes.
- Removed the inline `[[toc]]` extension; `[[toc]]`, `[[TOC]]`, and `[[Toc]]`
  now follow normal WikiLink semantics.

### Rendering

- Completed the Shiki syntax-highlighting migration and the VitePress-style
  Markdown Extensions program.
- Refined reader code blocks, line highlighting, diff/focus/error/warning
  surfaces, and language labels.
- Unified Alert and Markdown-container reader/PDF surfaces.

### Hardening

- Bounded Markdown include/snippet resource selection by UTF-8 byte limits
  before output materialization.

### Migration

- See the [post-MD-EXT Markdown compatibility note](docs/migrations/markdown-post-md-ext-compatibility.md).

## Authentication v1 — 2026-08-11

### Product capability

- Added single-owner Authentication v1 for the existing Nuvyn instance.
- Added first-run owner setup, login, logout, and protected application APIs.
- Kept the existing vault, metadata, AI, History, Git, and recovery data instance-scoped; no public registration or multi-user model was introduced.

### Security

- Added opaque server-side sessions in `HttpOnly` cookies with fixed 30-day expiry, revocation, disabled-owner checks, and optional startup session invalidation.
- Added versioned scrypt password hashing, bounded KDF concurrency/queue work, failure-based login throttling, generic credential failures, and malformed/abnormally sized password handling before expensive KDF work.
- Added layered `SameSite`, Origin, Fetch Metadata, and JSON content-type protections for mutations.
- Added a dedicated 16 KiB request-body limit for owner setup/login credential payloads without limiting Markdown document bodies.

### Architecture and deployment

- Made `GET /api/health` liveness-only and moved stable instance identity to protected `GET /api/vault/identity`.
- Made authentication hydration and protected identity resolution precede Vault workspace, tab persistence, and Draft Store recovery initialization.
- Integrated active logout and session-expiry handling with existing editor save barriers and browser Draft Store preservation.
- Documented loopback/HTTPS cookie profiles, browser-facing `NUVYN_PUBLIC_ORIGIN`, Docker setup, backup/restore session implications, and the real authentication test lanes.

## AI Provider & Settings Hardening — 2026-08-09

- Added separate Anthropic and OpenAI provider settings with encrypted saved credentials.
- Hardened OpenAI-compatible streaming Chat Completions support, API-root Base URL validation, streamed-response persistence, and the bounded `max_tokens` → `max_completion_tokens` compatibility fallback.
- Added explicit diagnostics for OpenAI-compatible tool/function-calling incompatibility.
- Added a real manual Settings connection probe for the current transient provider configuration. Probes are read-only, bounded, non-persistent, and redact API keys.
- Improved connection failure classification for authentication, explicit model errors, timeouts, tool incompatibility, and generic endpoint failures.
- Tightened the Settings UI controls and simplified Base URL guidance.
- Standardized History and Crash Recovery integration lanes for cross-platform CI, including Windows-specific serialization where needed.

## Tags Query & Index Refactor — Process Closure — 2026-07-30

- Completed retrospective process repair for the Tags Query & Index Refactor.
- Closed Phase 1 (unified tag model, query parsing, matching, TagIndex,
  FileTree integration, TagPanel integration).
- Closed Phase 1.1 review fixes (index consistency, FileTree semantics,
  TagPanel filter, display form).
- Created formal Spec, Plan, Implementation Record, and Closure documents.
- This is a documentation-only change — no production code was modified.
- Tag Management Phase 2 (Rename / Merge / Remove) remains NOT STARTED.

Production code baseline for the Tags Query & Index Refactor:

`8a5b452b9e48c97d52065c30204ff57b898d4a1a`

See [`docs/archive/closures/tags-query-index-refactor-final-closure.md`](docs/archive/closures/tags-query-index-refactor-final-closure.md)
for the complete closure record.

## Edit Feature Closure — 2026-07-30

- Completed the Edit feature development program.
- Closed the Round-17 folder move and crash-recovery audit.
- Added durable cross-artifact owner handoff.
- Made metadata recovery CAS idempotent.
- Enforced strict durable snapshot graph validation.
- Added source and destination directory ownership proofs.
- Closed inode-reuse ABA with birthtime-based directory identity.
- Quarantined weak legacy recovery journals.
- Stabilized Windows integration tests by waiting for in-flight requests.
- Entered maintenance mode.

Final production code baseline:

`83abbf336785290a667321a8817ff6898176a678`

See [`docs/archive/closures/edit-feature-final-closure.md`](docs/archive/closures/edit-feature-final-closure.md)
for the complete closure record.
