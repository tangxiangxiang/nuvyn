# Nuvyn Attachment Manager — Implementation Phases

**Last updated:** 2026-10-12

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

## Phase 3 — Upload and cross-module reuse

**Status: Planned**

- Define a unified attachment intake flow while preserving source-specific storage and ownership.
- Support insertion into Note and Board through their existing write boundaries.
- Add audited cleanup only after Phase 2 reference and safety evidence is sufficient.
- Keep Diary encryption and access controls independent; do not route encrypted Diary resources through a generic plaintext attachment service.

## Verification gates

- Each phase must add focused backend and frontend tests before expanding scope.
- Run `npm run typecheck`, focused unit tests, relevant E2E, and `npm run build` for Phase 1.
- Do not treat an incomplete index as a complete inventory or as permission to mutate a resource.
