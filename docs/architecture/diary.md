# Diary architecture

Diary is an independent workspace at `/diary`. SQLite is the source of truth for daily mood records, private day attachments and life events. The workspace reuses the existing Diary password, capability, theme and custom mood icon settings. Legacy Diary URLs redirect to the calendar.

## UI

`DiaryView.vue` owns the displayed month, view preference, day and event state and countdowns. `DiaryDayDialog.vue` presents one day's mood and bullet entries in reading or editing mode. `DiaryBulletReader.vue` renders entries as text, and `DiaryBulletEditor.vue` handles list input. `DiaryLifeCalendar.vue` wraps Naive UI Calendar and displays a single marker per cell. `DiaryEventForm.vue` handles event creation and editing, and `DiaryMoodPicker.vue` provides shared mood choices. Switching views keeps the calendar mounted, including its month and date selection. Only the view preference is stored in browser storage, scoped to the signed-in owner.

Diary mode batches the month's mood, text-entry and attachment-presence markers, with the selected date's encrypted content and attachment metadata fetched on demand. Attachment bytes are fetched only for visible image previews or explicit PDF downloads. Existing encrypted `description` payloads are presented as one unchanged entry and are rewritten as `entries` only when saved. Events mode reads events in pages, displays a primary event first, then sorts by start time, creation time and ID. A date shows one emoji and a count of any additional events. Preset event emojis use the same Fluent Emoji collection as moods. Custom event emojis use the device's emoji font. The dialogs are centered on larger screens and appear at the bottom on phones.

## SQLite and privacy

Migration `0043_diary_life.sql` creates the Diary day/event tables and removes obsolete Plan and Diary content migration tables. Migration `0045_diary_attachments.sql` adds the independent attachment relation.

| Table | Key | Storage |
| --- | --- | --- |
| `diary_days` | owner, date | Encrypted mood ID and entries (legacy description payloads are read compatibly) |
| `diary_day_attachments` | random attachment UUID | Owner, date, encrypted metadata and lifecycle state; bytes are stored separately as authenticated ciphertext |
| `diary_events` | owner, event UUID | Indexed start and end dates and recurrence, plus encrypted event fields |
| `diary_deleted_records` | owner, kind, ID or date | Latest deletion version to reject a stale write |

Bullet entries reuse `diary_days` and its encrypted payload. Attachment metadata is a separate encrypted payload and attachment bytes never enter `diary_days` or Bullet Entries.

Owner, dates, event UUIDs, recurrence, version and creation/update timestamps are visible in an offline database inspection. Attachment UUID, owner, day date, ordering and lifecycle state are also visible; original filename, MIME type and byte size are encrypted. Titles, descriptions, mood IDs, event emojis, categories, times, all-day, primary and countdown flags are encrypted. There is no public listing of Diary metadata. Each request checks authentication, owner scope and a valid Diary capability.

The record key is derived from the existing Diary data key using a separate HMAC domain. AES-256-GCM uses a fresh nonce per write, and authenticates the vault, owner, record kind, identity and version. Attachment metadata and bytes use the independent `nuvyn/diary-attachments/v1` HMAC domain; their AAD binds the vault, owner, date, random attachment ID, format version and payload purpose. The raw Diary DEK is never returned from the Access Service. The API enforces optimistic version checks and disables caching. The browser discards active data and invalidates reads when the session locks.

Attachment ciphertext lives only under `data/diary-attachments/<random-uuid>` with restrictive file mode. This directory is part of the existing Docker `/app/data` named volume, so container replacement preserves the files. It is separate from Vault attachments, `/api/assets`, Board assets and Attachment Manager enumeration. No plaintext staging file or public/static URL is created. Images are validated against their declared MIME and strict format structure; SVG, HTML, audio, video, archive and executable formats are rejected. PDF is returned only as an authenticated download. Responses use `no-store`, `nosniff`, and safe content disposition.

Uploads first create an encrypted `staged` row and file with a 24-hour expiry. A diary save supplies the desired attachment IDs and the same date-level `expectedVersion`; one SQLite transaction updates the encrypted day record and attachment states. A date containing only attachments is a valid `diary_days` record and appears on the calendar. Removed files are marked `deleting` in the same transaction; physical unlink and row removal are retried on later attachment operations or the next authenticated Diary attachment request after process recovery. A crash between durable file creation and row insertion is reconciled as an encrypted orphan. Cancellation only discards staged items and never removes previously attached files. Deleting the whole day marks both attached and staged files for cleanup in the day deletion transaction.

The browser keeps decrypted attachment data in short-lived Blob URLs only. URLs and in-flight requests are cleared on Diary teardown, lock, close, day switch and component unmount. PDF downloads and image previews are never written to IndexedDB, localStorage or the Service Worker cache.

Back up SQLite (including WAL/SHM) and the complete `data/diary-attachments/` directory at a consistent point. Restore them together; a database-only or file-only restore can leave missing or orphaned attachments. The directory is in the same Docker data volume as SQLite.

## API

All endpoints are relative to `/api/diary/life`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/days?start=&end=` | Batch mood, `hasEntries` and `hasAttachments` markers; requires unlocked Diary access |
| GET | `/days/:date` | Read the day, current version and attached metadata |
| PUT, DELETE | `/days/:date` | Save or delete with `expectedVersion` |
| GET | `/events?start=&end=&offset=` | Paged event range, with optional `date` filter |
| GET | `/events/:id` | Read a single event |
| PUT, DELETE | `/events/:id` | Save or delete with `expectedVersion` |
| GET | `/countdowns?today=&offset=` | Paged events with countdown enabled |

Dates are validated as ISO calendar dates. Times are optional local wall-clock values. UUIDs are generated by the client on event creation. Mutations return a conflict when the supplied version is stale and a locked response when Diary access is missing.

Diary attachment endpoints use the separate `/api/diary/attachments` namespace. `POST /stage` accepts one bounded multipart file and an idempotency key; `GET /:id/content` returns one authenticated attachment; `DELETE /:id` discards an uncommitted staged upload. Only attached metadata is returned with `GET /api/diary/life/days/:date`. `PUT /days/:date` accepts the desired attachment UUID list alongside fields and `expectedVersion`; it commits day content and attachment association atomically. All endpoints require the logged-in owner session plus the current Diary Access Capability. There is no public attachment URL and ordinary asset/attachment routes do not enumerate these rows or files.

## Recurrence and countdowns

Dates and durations use calendar arithmetic with Temporal. Countdown days are calculated against the browser's local date, including across year boundaries and daylight-saving transitions. Annual February 29 events occur on February 28 in non-leap years. A multi-day annual event preserves its original duration. The countdown uses the next start date, and a past one-off event falls off the countdown list. The first three upcoming dates are shown by default.

## Legacy retirement

At startup the server only removes regular, single-link Markdown files with valid date names directly under the Diary directory and an exact document metadata match. The operation is idempotent and skips symlinks, nested directories, unrelated names and unmanaged files. Historic shared Git objects are retained to avoid rewriting Note history. Legacy guards on shared Vault services still protect any retained Diary snapshots.
