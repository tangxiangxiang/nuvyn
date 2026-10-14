# Nuvyn Attachment Manager — Phase 3 Implementation

**Date:** 2026-10-14
**Status:** Implemented, with cleanup intentionally read-only

Phase 3 adds safe preview and constrained image reuse while keeping resource
ownership in the existing Note, Board Asset, Board Material, and Vault layers.
It does not introduce a generic attachment store or change Diary security.

## P3.1 — Safe preview and Note picker

- The catalog remains metadata-only. Preview binaries are fetched only after a
  user selects an image.
- Vault images are fetched from the authenticated Markdown Resource API after
  validating the same canonical path and image-extension boundary accepted by
  Markdown resource references; Diary, traversal, hidden, and non-image paths
  are rejected before any read.
- Board Assets use a dedicated authenticated preview endpoint. Raster bytes are
  returned unchanged; SVG is sanitized for preview without changing the
  original immutable Asset bytes or hash.
- Board Materials use their existing authenticated service. The detail read
  sanitizes the SVG returned for preview; the stored material is unchanged.
- Preview requests abort when the resource changes or the component unmounts.
  Request sequence checks prevent stale responses from replacing a newer
  selection, and every created object URL is revoked.
- Note's image action opens a picker. A Vault image is inserted as its direct
  Markdown resource reference. A Board Asset is read through the verified
  Board API, then copied into the Note library through `uploadNoteImage`; the
  captured Monaco Tracked Range is still responsible for insertion, preserving
  cursor tracking and undo boundaries.

## P3.2 — Board insertion and manager upload

- Attachment Manager upload is limited to the existing Note image upload
  endpoint and its format/size/SVG validation.
- Board's editor menu opens the same source-aware picker. Selecting an existing
  Board Asset keeps its Asset ID. It is registered with the active
  `BoardAssetSession`, persisted as a Pending Blob, and passed through the
  existing idempotent integrity-checked upload and scene checkpoint flow.
- Selecting a Vault Note image reads its authenticated sanitized resource,
  creates a new Excalidraw file identity and Board Asset identity, stores the
  Pending Blob, then uploads and saves through the current Board session.
- Board/session/host identity is rechecked after network reads and before scene
  mutation. Excalidraw image decoding checks that the same host is still live
  after asynchronous work.
- Catalog and current reference projections are refreshed after writes. Board
  Materials remain managed by their existing material panel and API.

## P3.3 — Read-only cleanup and bounded audit

- Cleanup preflight stays advisory: no delete or quarantine operation was added,
  and `deletionAllowed` remains false.
- A SQLite audit table records operation type, resource identity, source and
  target workspace identities, result category, and timestamp for the scoped
  Note image upload/import and Board asset import/reuse paths.
- Audit retention is capped at 500 entries; the read endpoint returns at most
  100 entries per request.
- Audit writes reject non-canonical resource IDs and absolute/unrecognized
  source identities. The table contains no binary payload, Diary plaintext,
  credentials, or absolute filesystem paths.
- Audit persistence is best-effort after a validated durable write; an audit
  failure does not turn a successful resource write into a reported failure.

## Boundaries and validation

- No Diary listing, preview, import, or generic upload is introduced.
- A Note import from Board is a copy into the Note image library. Board reuse
  keeps the existing Board Asset identity; a Vault-to-Board insertion creates a
  Board-owned copy.
- Existing storage ownership, API protocols, Board scene Asset references,
  Pending Blob recovery, and Monaco tracked insertion remain authoritative.
- Cleanup is not automatically authorized by a zero-reference result, partial
  index, or unknown historical/draft coverage.

## Verification

Focused unit coverage exercises source-specific reads, SVG preview cleaning,
stale request cancellation, object URL cleanup, audit bounds/privacy, and Board
Asset identity/recovery context. Browser E2E validation is recorded in the
implementation report; local real Safari system-clipboard and physical-device
behavior require manual confirmation where Playwright cannot emulate them.
