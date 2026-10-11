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

**Status: Planned**

- Build reliable Note and Board reference coverage without scanning Diary plaintext.
- Distinguish known unused resources from resources with incomplete reference evidence.
- Add a read-only preflight that explains whether a resource can be safely cleaned up; it must not delete resources by itself.
- Add reference details and navigation only where the source identity and target lifecycle can be verified.

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
