# Diary architecture

Diary is a standalone workspace at `/diary`. SQLite is the source of truth for
daily mood records, bullet entries, private attachments and life events. The
workspace uses the account's Diary password and capability boundary, along
with shared theme and custom mood-icon settings. Legacy Diary URLs redirect to
the calendar.

## UI and state

`DiaryView.vue` owns the visible month, selected date, Diary/Events view,
calendar data, day and event state, and countdowns. The selected day opens in
`DiaryDayDialog.vue`; `DiaryBulletReader.vue` and `DiaryBulletEditor.vue`
render its entries, while `DiaryAttachmentSection.vue` renders image groups
and PDF cards. `DiaryLifeCalendar.vue` wraps Naive UI Calendar, with
`diaryCalendarAdapter.ts` translating its local date values into validated
Diary dates. `DiaryEventForm.vue` and `DiaryMoodPicker.vue` own their focused
editing surfaces.

The calendar batches mood, entry-presence and attachment-presence markers.
The selected day's encrypted content and attachment metadata load on demand;
image bytes load only for visible previews and PDFs only on explicit download.
`entryIds` and `imageGroups` preserve attachment-to-entry identity across
reordering and edits. Each image group contains at most nine images. Images
without an entry render at the end of the day, and PDF files remain separate
from image groups. Diary edits use an explicit manual save and the date's
`expectedVersion`.

The Diary and Events views share the calendar instance so switching views
preserves its month. Only the view preference is stored in browser storage,
scoped to the signed-in owner. Dialogs are centered on larger screens and use
the existing bottom-sheet layout on phones.

## Search

Global search calls `POST /api/diary/life/search` only while Diary access is
unlocked. It searches daily entry text and exact `YYYY-MM-DD` queries, returns
date-ordered pages, and does not create a plaintext search index. Entry hits
include an entry identity and snippet; exact-date hits identify the date.
Selecting a text hit opens that day and reveals the matching entry. Search
reads are cancellable and do not include events, moods, or attachment
filenames.

## SQLite and privacy

Migration `0043_diary_life.sql` creates the Diary day/event tables and retires
the earlier Plan and Diary content-migration tables. Migration
`0045_diary_attachments.sql` adds the independent attachment relation.

| Table | Key | Storage |
| --- | --- | --- |
| `diary_days` | owner, date | Encrypted mood and entry payload |
| `diary_day_attachments` | random attachment UUID | Encrypted metadata and lifecycle state; bytes are separately authenticated ciphertext |
| `diary_events` | owner, event UUID | Indexed date range and recurrence, plus encrypted event fields |
| `diary_deleted_records` | owner, kind, ID or date | Latest deletion version to reject stale writes |

Older encrypted day payloads that contain `description` remain readable as a
single entry. The next save writes the current `entries` representation.
Attachment metadata and bytes are encrypted independently; attachment bytes
never enter `diary_days` or Bullet Entries.

Owner, dates, event UUIDs, recurrence, version and creation/update timestamps
are visible in an offline database inspection. Attachment UUID, owner, day
date, ordering and lifecycle state are also visible; original filename, MIME
type and byte size are encrypted. Titles, descriptions, mood IDs, event
emojis, categories, times, all-day, primary and countdown flags are
encrypted. Each request checks authentication, owner scope and a valid Diary
capability.

The record key is derived from the existing Diary data key using a separate
HMAC domain. AES-256-GCM uses a fresh nonce per write and authenticates the
vault, owner, record kind, identity and version. Attachment metadata and bytes
use the independent `nuvyn/diary-attachments/v1` HMAC domain; their AAD binds
the vault, owner, date, random attachment ID, format version and payload
purpose. The raw Diary DEK is never returned from the Access Service. The API
enforces optimistic version checks and disables caching. The browser discards
active data and invalidates reads when the session locks.

Attachment ciphertext lives only under `data/diary-attachments/<random-uuid>`
with restrictive file mode. This directory is part of the existing Docker
`/app/data` named volume, so container replacement preserves the files. It is
separate from Vault attachments, `/api/assets`, Board assets and Attachment
Manager enumeration. No plaintext staging file or public/static URL is
created. Images are validated against their declared MIME and strict format
structure; SVG, HTML, audio, video, archive and executable formats are
rejected. PDF is returned only as an authenticated download. Responses use
`no-store`, `nosniff`, and safe content disposition.

Uploads first create an encrypted `staged` row and file with a 24-hour expiry.
A diary save supplies the desired attachment IDs and the same date-level
`expectedVersion`; one SQLite transaction updates the encrypted day record
and attachment states. A date containing only attachments is a valid
`diary_days` record and appears on the calendar. Removed files are marked
`deleting` in the same transaction; physical unlink and row removal are
retried on later attachment operations or the next authenticated Diary
attachment request after process recovery. A crash between durable file
creation and row insertion is reconciled as an encrypted orphan. Cancellation
only discards staged items and never removes previously attached files.
Deleting the whole day marks attached and staged files for cleanup in the day
deletion transaction.

The browser keeps decrypted attachment data in short-lived Blob URLs only.
URLs and in-flight requests are cleared on Diary teardown, lock, close, day
switch and component unmount. PDF downloads and image previews are never
written to IndexedDB, localStorage or the Service Worker cache.

Back up SQLite (including WAL/SHM) and the complete
`data/diary-attachments/` directory at a consistent point. Restore them
together; a database-only or file-only restore can leave missing or orphaned
attachments. Both are in the same Docker data volume.

## API

All day and event endpoints are relative to `/api/diary/life` and require an
authenticated owner session plus the current Diary Access Capability.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/day-policy` | Current server-local date and editability boundary |
| POST | `/search` | Paginated search of entry text or an exact date |
| GET | `/days?start=&end=` | Batch mood, `hasEntries` and `hasAttachments` markers |
| GET | `/days/:date` | Read the day, current version and attached metadata |
| PUT, DELETE | `/days/:date` | Save or delete with `expectedVersion` |
| GET | `/events?start=&end=&offset=` | Paged event range, with optional `date` filter |
| GET | `/events/:id` | Read a single event |
| PUT, DELETE | `/events/:id` | Save or delete with `expectedVersion` |
| GET | `/countdowns?today=&offset=` | Paged events with countdown enabled |

Search accepts a non-empty query of at most 120 characters, a page size from
1 to 20 and an optional date cursor. Day and event dates are validated as ISO
calendar dates. Event times are optional local wall-clock values. Event UUIDs
are generated by the client. Mutations return a conflict when the supplied
version is stale and a locked response when Diary access is missing.

Diary attachment endpoints use the separate `/api/diary/attachments`
namespace. `POST /stage` accepts one bounded multipart file and an idempotency
key; `GET /:id/content` returns one authenticated attachment; `DELETE /:id`
discards an uncommitted staged upload. Only attached metadata is returned
with `GET /api/diary/life/days/:date`. `PUT /days/:date` accepts the desired
attachment UUID list alongside fields and `expectedVersion`; it commits day
content and attachment association atomically. There is no public attachment
URL and ordinary asset/attachment routes do not enumerate these rows or
files.

## Recurrence and countdowns

Dates and durations use calendar arithmetic with Temporal. Countdown days are
calculated against the browser's local date, including across year boundaries
and daylight-saving transitions. Annual February 29 events occur on February
28 in non-leap years. A multi-day annual event preserves its original
duration. The countdown uses the next start date, and a past one-off event
falls off the countdown list. The first three upcoming dates are shown by
default.

## Legacy boundaries

The runtime no longer performs startup cleanup of Markdown files left by the
former Vault-backed Diary. Managed Diary paths remain guarded from generic
plaintext Vault mutations. Completed D0–D8 proposals, implementation plans
and review evidence are archived under
[`docs/archive/diary/`](../archive/diary/README.md); this architecture page
and the [user guide](../user-guide/diary.md) define current behavior.
