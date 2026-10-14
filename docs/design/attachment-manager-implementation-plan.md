# Nuvyn Attachment Manager — Implementation Phases

**Last updated:** 2026-10-14

This plan separates the unified catalog foundation from later reference analysis and write capabilities. Existing resource identities, physical storage, and lifecycle remain owned by their current modules.

## Phase 1 — Unified resource catalog and basic UI

**Status: Implemented**

- Add metadata-only adapters for Board Assets, Vault attachment files, and Board Materials.
- Expose authenticated list, summary, index-status, and explicit refresh endpoints.
- Provide server-side search, source/type/reference filters, deterministic pagination, and partial-source status.
- Cache a rebuildable catalog snapshot in process memory. Ordinary page/search requests reuse it; explicit refresh supersedes an older scan. No database index or new resource table is introduced.
- Bound Vault traversal by depth, directory count, entry count, and elapsed time. Do not read file content or attachment binaries, follow symlinks, include Markdown documents, or enter `diary/`.
- Add a wide Settings → Storage & attachments manager with real list data, summary, filters, paging, metadata detail, and copyable ID/path.
- Keep reference status conservative: existing positive Board reference counts are known; zero counts, Vault files, and Board Materials remain unknown.
- No upload, deletion, rename, move, full preview, or reference-navigation actions.

## Phase 2 — Reference tracing and safety checks

**Status: Implemented (read-only; conservative coverage)**

- Build a bounded, rebuildable in-memory projection for current non-Diary Note references and live Board Asset scene/thumbnail relations. The scan reuses the existing Markdown resource expansion and token semantics, honors nested Include rules, and does not retain document bodies.
- Report direct and indirect Markdown image, snippet, Include-chain, Board Embed, Board Scene, and Board Thumbnail relationships with counts, source identity, and bounded pagination.
- Resolve Note → Board → Asset as a derived relationship only; keep `asset_references` authoritative for Board scene and thumbnail ownership.
- Expose authenticated reference status, refresh, query, and read-only cleanup-preview APIs. No deletion authorization or mutation is returned.
- Add reference detail and navigation via the existing Note and Board lifecycle. The primary row opens its displayed owner; an indirect Note reference may separately open its actual source Note. Keep catalog list/search non-blocking while the reference projection is pending.
- A failed reference refresh returns an API error and preserves the last successful snapshot only as explicitly stale evidence. Stale or unavailable reference data projects as unknown and cleanup preflight remains unverified; a successful retry replaces the snapshot.
- Coverage is intentionally partial: Diary is restricted; Git history, browser drafts, unsaved editor buffers, Board checkpoints, and external changes after scanning are not checked. Board Material usage remains unknown. A zero current-reference result never authorizes deletion.

## Phase 3 — Safe previews, insertion, and audited operations

**Status: Implemented (P3.1–P3.3; cleanup remains read-only)**

- Add on-demand previews for Note/Vault images, Board Assets, and Board Materials. Reads use each source's authenticated API; Vault image paths are constrained to generated Note-image identities, SVG content is sanitized for previews, and object URLs/requests are cancelled and released when selection changes or the component unmounts.
- Add a searchable, source-filtered, paginated, keyboard-operable image picker to Note and Board flows. Note can directly reference an existing Vault image; a Board Asset selected for Note is verified and copied through the existing Note image upload and Monaco tracked-range insertion path.
- Add a constrained Attachment Manager upload entry that writes only through the existing Note image upload service; it is not a generic file upload surface.
- Add Board insertion through the existing Board Asset Session. An existing Board Asset keeps its Asset ID and is revalidated through the session's durable Pending Blob/recovery flow; a Vault image becomes a new Board Asset. Board Material storage and insertion remain under their existing API.
- Refresh catalog/reference snapshots after supported writes and insertions. Authentication, SVG validation, Board integrity checks, editor identity checks, and Diary exclusions remain owned by the existing modules.
- Add a bounded SQLite operation audit for Note image uploads/imports and Board image imports/reuse. It retains at most 500 metadata-only events; source identities are constrained and no binary payload, Diary plaintext, credentials, or absolute paths are recorded.
- Keep cleanup preview read-only: `deletionAllowed` remains false. No delete, quarantine, or garbage-collection action is added by Phase 3.
- Keep Diary encryption and access controls independent; no Diary attachment is listed, previewed, uploaded, or routed through a generic plaintext attachment service.

## Phase 4 — Recoverable Note image trash

- See [Phase 4 lifecycle and safety design](attachment-manager-phase4.md).
- Persist verified upload provenance and independent recovery journals; keep
  trash binaries in the Vault's protected `.nuvyn/attachment-trash/` directory.
- Allow confirmed recycling only for proven Note uploads with no current
  references and reliable indexes. Recheck under the Vault mutation lock.
- Preserve authenticated historical Markdown reads; restore exclusively to
  the original path. No permanent deletion or automatic expiration.
- Add Settings trash search, paging, preview, restore and separate storage totals.
- Old images without upload provenance remain ineligible. NAS power-loss
  durability requires manual verification; process crashes are tested.

## Verification gates (all phases)

- Each phase must add focused backend and frontend tests before expanding scope.
- Run `npm run typecheck`, focused unit tests, relevant E2E, and `npm run build` for each phase.
- Do not treat an incomplete index as a complete inventory or as permission to mutate a resource.
