# Changelog

All notable changes to Nuvyn are documented in this file. Entries dated before
the Nuvyn brand baseline may refer to Nuvyn as the historical product name.

## Nuvyn v0.1.0-alpha.10 — 2026-10-28

Changes since `v0.1.0-alpha.9`.

### Note Editing & Markdown

- Recognize two or more trailing ASCII spaces after Markdown text as a valid hard break, while retaining diagnostics for a single space, whitespace-only lines, tabs and mixed trailing whitespace.
- Added lightweight, bounded syntax hints for Markdown extensions and resource-reference formats without changing source text or resolving resources during editing.
- Extended Slash Commands with Flex, Code Group, Details, Include and code-file snippet templates using Monaco's existing snippet navigation.
- Added Markdown source folding and heading-based Reader section folding, with nested state, TOC/anchor auto-expansion and complete HTML/PDF exports. Refined Reader spacing and folding controls, and isolated folding styles and controller cleanup from author HTML and failed renders.
- Made rendered task checkboxes read-only while retaining editable Markdown source, and expanded the Markdown user guide.

### Note Workspace

- Added temporary Preview and retained Pinned Note tabs. Opening another preview reuses the temporary slot; double-click, explicit Pin and the first real edit retain a document.
- Kept save errors, conflicts, drafts and in-flight requests behind the existing preview-replacement and close protections. Document navigation and delayed editor updates retain their source-document identity.
- Persist only retained documents in the existing Tab Persistence v1 format; temporary previews are not restored as retained tabs merely because they were visited.

### Note Tablet

- Added a responsive Note reading layout for 601–1199px viewports, with single-column content and temporary left/right navigation drawers that preserve desktop layout preferences.
- Replaced the tablet tab strip with a single-document presentation and a collapsed Open documents list for selecting, pinning and closing documents, including Diff and Recovery surfaces.
- Adapted the existing Monaco editor to measured Visual Viewport changes, preserving the editor and Model during layout changes and revealing an obscured focused caret only when the editor shrinks.
- Added Chinese IME synchronization safeguards, early retention of edited previews and source-path-aware updates across document navigation, without introducing a second editor or draft store.
- Added a touch-accessible image button in the existing tablet Note editing navbar, reusing the attachment picker, tracked insertion ranges, upload validation and cross-document fallback.
- Chromium touch simulation and Playwright WebKit regressions cover the tablet flows. Real iPad Safari and Android tablet acceptance is still pending, including system keyboards, Chinese candidate selection, native selection/clipboard, photo/file cancellation, split-screen, external keyboards and Apple Pencil. Browser automation is not real-device verification.

### Reliability

- Restored Diary's existing hidden-but-mounted Tab lifecycle while keeping the Note tablet tab strip unmounted, and aligned Note/Diary navigation, Preview/Pin and image-insertion E2E tests with the current interaction contracts.
- Verified Attachment Manager at desktop, tablet and short phone sizes using settled workspace geometry; opening settings does not add horizontal overflow beyond the existing closed-workspace baseline.
- Increased the per-file AI commit-message diff allowance from 8,000 to 16,000 characters while retaining the total prompt and other resource limits.

### Migration & Deployment

- No new SQLite migration or server-side persistence schema/protocol change was added since `v0.1.0-alpha.9`. Tab Persistence remains v1 and existing v1 records remain readable; the retained-tab behavior is described above.
- Back up the complete Vault, including `.git` and hidden `.nuvyn` state, together with the SQLite data volume at one consistent point before upgrading. Include WAL/SHM files as applicable and preserve any external master key separately.
- The release image is selected by Git Tag; the package version remains `0.0.0`. NAS rollout and real-device acceptance remain manual operations.

## Nuvyn v0.1.0-alpha.9 — 2026-10-19

Changes since `v0.1.0-alpha.8`.

### Document Export

- Added Markdown export for a single ordinary Note, preserving its original Markdown and preferring the current unsaved editor buffer. Markdown remains the editable/source-oriented format and does not bundle referenced assets.
- Added self-contained HTML export for offline reading, with supported local images and fonts embedded and Markdown presentation rendered as static content. PDF remains available for fixed-page printing and layout.
- HTML export does not include other Notes, a full Vault backup, or interactive diagram runtimes. Managed Diary retains its existing PDF-only export; bulk export, ZIP bundles, and Vault backup are not included.

### Note & Markdown

- Refined Markdown quote, Alert, and container presentation, and added quick copying from code-block language labels.
- Improved Flex content pagination in PDF export while keeping the existing Flex authoring syntax.

### Reliability & Security

- Hardened HTML export so supported SVG resources are embedded from the existing sanitizer's normalized bytes, and element-count limits are checked after asynchronous widgets and final DOM construction.
- HTML export fails rather than silently dropping unsupported or unavailable resources. Remote images and some complex diagram resources are not supported; Safari's native system-download behavior still needs manual verification.

### Migration & Deployment

- No database migration or persistent schema change was added since `v0.1.0-alpha.8`.
- HTML is a static, self-contained document, not a complete Vault backup. Back up the Vault and SQLite data volume consistently before upgrading; an image-only rollback is not safe after a database migration.

## Nuvyn v0.1.0-alpha.8 — 2026-10-15

Changes since `v0.1.0-alpha.7`.

### Attachment Manager

- Added Settings → Storage & attachments with a unified catalog, source/type/reference filters, search, statistics, pagination and mobile layouts.
- Added current Note and Board reference tracing, Include/Board-mediated relationships, reference navigation and conservative cleanup-risk preflight. History, browser drafts, unsaved buffers, protected Diary and Board checkpoints are not treated as verified unused sources.
- Added authenticated on-demand previews, image pickers and controlled Note-library uploads. Existing Vault images are referenced directly by Note; Board-to-Note and Vault-to-Board imports create validated copies, while Board Asset reuse preserves its ID and existing Asset Session lifecycle.
- Added a recoverable trash for verified Nuvyn-uploaded Note images, with upload-generation/hash checks, independent persistent journals, startup crash reconciliation, search, preview and original-path restore without overwriting conflicts. Only completed `trashed` records can be restored from the UI.
- Original authenticated Markdown image paths remain readable from trash, including historical and later references. Recycling does not free physical storage; permanent deletion and automatic expiration remain disabled. Board resources and Diary files are outside this cleanup scope.

### Note & Markdown

- Added Note image insertion through Monaco's **Insert image** context menu, clipboard image paste and local drag-and-drop, retaining tracked insertion, undo/redo and cross-document safeguards. Removed the persistent image button from the Note tab bar.
- Added server-validated static SVG upload/read support, including bounded Excalidraw font/raster embeds and safer format/CSS handling. SVGs with active or unsupported features are rejected rather than converted silently.
- Added one formal `flex` Markdown layout container: direct blocks are automatic items; nesting and validated parameters support images, text and richer layouts. Narrow containers stack by default; PDF layout is constrained separately. Existing `image-row` syntax retains compatibility.
- Added image-only Board embeds in Notes, authenticated previews, click-to-open Board navigation, asynchronous refresh cancellation and temporary-resource cleanup.
- Added temporary Zen Mode for Note and unlocked Diary on desktop, tablet and phone, with `Ctrl/Cmd+K → Z`, three-second Logo hover/long-press and the bilingual Nine Virtues → Oneness entry. Editor instances, saves and recovery remain intact; refresh returns to the regular layout.
- Refined full-width Zen editing, the existing focus-width shortcut `Ctrl/Cmd+K → F`, auto-hiding Monaco scrollbars and compact document-property/tag controls.

### Reliability

- Added AI title/tag generation as reviewable metadata drafts, slash prompt templates, internal Note-link navigation and a unified composer. Successful read/list calls collapse into an activity summary; pending/error calls and mutations remain visible, including successful empty results and restored history.
- Added History file-revision context actions and refined compact sidebar, link, outline and diff presentation.
- Fixed ordinary Note/folder renames being blocked by unrelated locked Diary content; encrypted Diary bodies remain excluded from generic reference rewrites.
- Aligned Draft Store, Markdown/PDF callout, History and Diary export tests with current UI and routing contracts; synchronized schema-version scale checks.
- Included server-side Markdown scanner helpers in the Docker runtime and improved packaged-smoke diagnostics.

### Security

- Kept existing owner-session, Origin/CSRF and Diary encryption boundaries on attachment operations and image reads. No public trash/static image endpoint is introduced.
- Added bounded metadata-only attachment audit events independent of long-lived upload identities and recovery records. The audit contains no file bytes or absolute NAS paths.
- Kept strict SVG sanitization, safe resource paths, no-symlink checks, controlled parser-generated Flex layout classes and DOMPurify restrictions.

### Migration & Deployment

- Adds SQLite migration **0037** for bounded attachment audit and **0038** for `note_image_identity`, `attachment_trash` and expanded audit operations. Migration 0038 and startup recovery are included in the runtime image.
- Only uploads with a verified original identity record are eligible for trash. Old images without that record remain readable but cannot be recycled merely because their filename is a UUID.
- Trash binaries persist at `VAULT_DIR/.nuvyn/attachment-trash/`; SQLite remains in the existing data volume. Production Compose mounts need no change. Activity and trash storage are reported separately.
- Back up the complete SQLite data volume and Vault at one consistent stopped/snapshot point, including WAL/SHM as applicable, hidden `.nuvyn` state, Git History and any external master key.
- NAS deployment remains subject to manual hard-link/directory-fsync, restart and paired-backup restore acceptance. Independent external writers are not coordinated by Nuvyn's process-local lock; copied backups or remounts that change file identities may require administrator review.
- After migration 0038, changing the image back to an older tag alone is not a guaranteed safe rollback. Prepare matching pre-upgrade database and Vault backups. See [Phase 4 safety notes](docs/design/attachment-manager-phase4.md) and [Docker release deployment](docs/deployment/docker-release.md).

## Nuvyn v0.1.0-alpha.4 — 2026-09-20

This release closes out a substantial Ledger increment with stronger financial
presentation, responsive workspace behavior, transaction navigation, and
browser E2E stability.

### Ledger

- Promoted repayment principal to a first-class financial presentation metric across the Dashboard overview, period summaries, cashflow trend, and transaction summaries. Repayment principal remains a `transfer`, is excluded from `expense`, interest remains an Expense, and displayed balance is `income - expense - repayment`.
- Unified transaction detail access from Dashboard recent transactions, the transaction list, and account detail through the shared Transaction Detail Sheet, including shared edit, delete, archive/restore, composite-transaction, and refresh behavior.
- Completed account lifecycle behavior: active accounts can be edited and archived, archived accounts can be restored, zero-balance archived accounts without any transaction history can be permanently deleted, and server-side `hasHistory` remains authoritative across soft-deleted transactions.
- Expanded transaction search to include transaction object, location, note, linked account name, and category name. Income, expense, and repayment summaries continue to use the complete server result set rather than the current page.
- Added category drill-down from Dashboard income and expense analysis into filtered transactions while preserving the authoritative day, week, month, year, or historical date range from the Ledger projection and timezone. All-time category navigation carries only the category condition.
- Made Transactions and Accounts workspaces responsive on desktop. Transaction tables and Account Lists consume available workspace height, short desktop windows avoid bottom clipping, tall windows show more content, and mobile retains its constrained/single-column behavior.
- Defaulted first-use Ledger onboarding to CNY and changed the Accounts list to show all asset and liability accounts by default with clearer visual distinction.

### Diary

- Replaced the Diary return shortcut `D → C` with `G → B` for the shared Go / Back navigation convention while preserving workspace-tab close and unsaved-content protection.

### Reliability

- Expanded Ledger browser regression coverage for fresh onboarding, idempotent create recovery, transaction detail geometry, mobile and desktop responsive layouts, Accounts workspace geometry, historical period navigation, and category drill-down date preservation.
- Rebalanced application E2E coverage and isolated the Ledger responsive fixture from fresh onboarding state when sharing the application E2E SQLite database.

### Compatibility

- Validated across Linux, Windows, macOS, Node.js 22/24, Chromium application E2E, Docker production smoke, authentication smoke, and Vault writer lifecycle smoke.

### Migration

- No new Ledger database migration is required when upgrading from `v0.1.0-alpha.3`.

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

- Added opaque server-side sessions in `HttpOnly` cookies with fixed 7-day expiry, revocation, disabled-owner checks, and optional startup session invalidation.
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
