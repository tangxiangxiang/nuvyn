# D7.1 — Registry and Metadata Foundation

> **Historical lineage — not current runtime authority.** Current behavior is
> defined by [Diary Architecture](../architecture/diary.md) and [Diary User
> Guide](../user-guide/diary.md). This file is retained for D7 traceability.

Status: **REVIEW-CLOSED**
Independent Review: **PASS**
Self-review: **P0 = 0 / P1 = 0 / P2 = 0**

## 1. Evidence scope

Starting HEAD:

`63f4100b64bdef1e354217bf489c8f45f2ed9879`

Initial implementation HEAD:

`c9e909dbc98bd63175fdfde2eb652603f60f1e1a`

Focused D7.1 remediation commit:

`199fbe4a8de6af151f47f268abb3ff4616db405b`

The initial implementation commit is `feat(diary): add mood registry and metadata foundation`. The remediation preserves trusted pre-Mood History proof, and this evidence document records both commits without reopening any closed D7 design contract.

Review history: the initial D7.1 evidence reached `REVIEW-READY`. The first Independent Review found P1 because `pre-mood-schema` incorrectly downgraded trusted covered provenance to legacy. Remediation commit `199fbe4a8de6af151f47f268abb3ff4616db405b` corrected that boundary; evidence sync commit `b56c2576b6e2111d72be653fa1de1f3f14bb4b4f` recorded the remediation. Independent re-review passed with P0/P1/P2 = 0/0/0.

D7.1 establishes only the registry, live metadata, existing metadata API integration, CAS command, History v1/v2 compatibility, bulk summary seam, and regression evidence. It does not start D7.2 or D7.3.

The closed D7 PRD, Implementation Plan, Plan Amendment, D7.0 evidence, and D7.0A evidence were not rewritten.

## 2. Changed architecture

The single live Mood owner is the existing SQLite `documents` metadata row. The stable Mood ID is a controlled field on that row; it is not a second database, sidecar, Markdown frontmatter owner, History store, Recovery store, or lifecycle.

The shared registry is framework-independent and is the only catalog consumed by current validation and future picker work. D7.1 adds no picker, Calendar marker, Native Mood UI, 4×6 DOM, or presentation state.

## 3. Frozen registry

The product catalog is exactly 24 entries in **4 columns × 6 rows**, in row-major order. The persisted value is the stable ID; the asset path is only a registry presentation mapping.

| Row | Column | Stable ID | 中文 | English | Accessibility name | Canonical asset |
| ---: | ---: | --- | --- | --- | --- | --- |
| 1 | 1 | `kiss` | 亲亲 | Kiss | 亲亲 / Kiss | `public/emoji/亲亲.svg` |
| 1 | 2 | `sad` | 伤心 | Sad | 伤心 / Sad | `public/emoji/伤心.svg` |
| 1 | 3 | `surprised-big` | 吃惊-大 | Big surprise | 大幅吃惊 / Big surprise | `public/emoji/吃惊-大.svg` |
| 1 | 4 | `surprised-small` | 吃惊-小 | Small surprise | 小幅吃惊 / Small surprise | `public/emoji/吃惊-小.svg` |
| 2 | 1 | `watching` | 吃瓜 | Watching the drama | 吃瓜 / Watching the drama | `public/emoji/吃瓜.svg` |
| 2 | 2 | `like` | 喜欢 | Like | 喜欢 / Like | `public/emoji/喜欢.svg` |
| 2 | 3 | `laughing` | 大笑 | Laughing | 大笑 / Laughing | `public/emoji/大笑.svg` |
| 2 | 4 | `disappointed` | 失落 | Disappointed | 失落 / Disappointed | `public/emoji/失落.svg` |
| 3 | 1 | `afraid` | 害怕 | Afraid | 害怕 / Afraid | `public/emoji/害怕.svg` |
| 3 | 2 | `shy` | 害羞 | Shy | 害羞 / Shy | `public/emoji/害羞.svg` |
| 3 | 3 | `happy` | 开心 | Happy | 开心 / Happy | `public/emoji/开心.svg` |
| 3 | 4 | `smiling` | 微笑 | Smiling | 微笑 / Smiling | `public/emoji/微笑.svg` |
| 4 | 1 | `amazed` | 惊讶 | Amazed | 惊讶 / Amazed | `public/emoji/惊讶.svg` |
| 4 | 2 | `angry` | 愤怒 | Angry | 愤怒 / Angry | `public/emoji/愤怒.svg` |
| 4 | 3 | `flirty` | 放电 | Flirty | 放电 / Flirty | `public/emoji/放电.svg` |
| 4 | 4 | `speechless` | 无语 | Speechless | 无语 / Speechless | `public/emoji/无语.svg` |
| 5 | 1 | `dizzy` | 晕 | Dizzy | 晕 / Dizzy | `public/emoji/晕.svg` |
| 5 | 2 | `indignant` | 气愤 | Indignant | 气愤 / Indignant | `public/emoji/气愤.svg` |
| 5 | 3 | `frowning` | 皱眉 | Frowning | 皱眉 / Frowning | `public/emoji/皱眉.svg` |
| 5 | 4 | `mysterious` | 神秘 | Mysterious | 神秘 / Mysterious | `public/emoji/神秘.svg` |
| 6 | 1 | `laughing-tears` | 笑哭 | Laughing with tears | 笑哭 / Laughing with tears | `public/emoji/笑哭.svg` |
| 6 | 2 | `playful` | 调皮 | Playful | 调皮 / Playful | `public/emoji/调皮.svg` |
| 6 | 3 | `unwell` | 难受 | Unwell | 难受 / Unwell | `public/emoji/难受.svg` |
| 6 | 4 | `devilish` | 魔鬼 | Devilish | 魔鬼 / Devilish | `public/emoji/魔鬼.svg` |

Registry owner: `shared/diaryMood.ts`

It exports `MoodId`, `MOOD_CATALOG`, `isMoodId()`, and `getMoodDefinition()`. Registry tests verify 24 entries, exact order, unique IDs/assets/positions, `R3C3 = happy`, labels, accessibility names, and the existence of all 24 SVG files.

## 4. Live metadata contract

Migration `server/migrations/0010_diary_mood_metadata.sql` is additive:

    ALTER TABLE documents ADD COLUMN mood TEXT NULL;

It uses the existing SQLite database and the existing `documents` owner. There is no enum constraint or foreign key to the catalog, so an older server can preserve a future stored value.

`DocumentMetadata.mood` and the read DTO are `string | null`. A canonical user mutation accepts only `MoodId | null`; this distinction permits known-field/unknown-value preservation.

New rows default to `NULL`. Diary creation remains owned by the existing Diary create route and does not assign a default Mood. Delete removes the live row and its Mood. Recreating the same date creates a new document identity with `mood = NULL`; no tombstone Mood is inherited.

The migration test upgrades an existing v5 `documents` row and verifies that the row remains intact with `mood = NULL`. Existing tags, History tables, and other metadata tables remain in the same database.

## 5. Domain boundary and API

Mood is valid only for a canonical managed Diary path:

    normalizeLogicalContentPath(path)
    → classifyDiaryPath(logicalPath) === "managed"

The boundary rejects ordinary Notes, Inbox, Literature, Archive, Ledger, the Diary root, unmanaged `diary/*`, invalid dates, nested paths, and asset paths. History paths are normalized from their `.md` form before classification.

The existing `PATCH /api/metadata/documents/*` route now accepts `mood`, but no new Mood route exists. It validates the canonical ID or `null` before `ensureMetadata()` can create a row on an invalid path, returns the stable `INVALID_MOOD` error for invalid input, and uses the existing metadata transaction.

Set, change, and clear all require `expectedUpdatedAt`. The CAS comparison occurs before the no-op decision:

    validate token → compare current version → allow equal-value no-op

Therefore a stale same-value request returns `METADATA_VERSION_CONFLICT` / HTTP 409, while an equal-value request with the current version may remain a no-op. No `moodVersion`, `moodUpdatedAt`, or second CAS token was introduced.

`useDiaryMoodCommand` is the client/domain command seam. It validates `DiaryDate`, derives the exact logical path, validates `MoodId | null`, requires the existing metadata version, calls the existing metadata API, and returns authoritative metadata. It does not create a document, navigate, open a tab, change a route, write raw Markdown, or touch Calendar state. Missing today/past/future files do not receive orphan metadata; an already-existing future Diary document can be updated.

## 6. Unknown stored values and raw separation

An opaque stored value such as `future-mood-v3` is returned unchanged and survives unrelated title, summary, tags, body-save, ordinary read, and History capture operations. Only an explicit canonical Mood selection or clear may replace it.

Markdown remains the body source of truth. A raw frontmatter field such as `mood: happy` is not imported into SQLite, does not overwrite SQLite Mood, is not rewritten by a body save, and remains untouched as user raw data. The metadata draft store remains title/summary/tags-only session state; D7.1 adds no Mood draft or persisted Mood draft.

Mood mutation changes only the existing SQLite metadata row. Focused tests verify that Markdown bytes remain identical before and after a Mood mutation and that body saves preserve both the SQLite value and unrelated raw frontmatter.

## 7. Existing summary seam

The existing bulk `GET /api/posts` / `listPostsFlat()` seam exposes, for canonical managed Diary summaries only:

    mood: string | null
    documentId: string
    metadataUpdatedAt: number

Ordinary summaries do not expose Mood semantics. Detail responses continue to use the existing `DocumentMetadata` DTO. Save, recover, rename, Diary create, and local summary replacement paths carry the managed Diary Mood and metadata identity/version fields so a replacement cannot transiently erase the value. Workspace state remains owned by the existing tab/workspace summary store; no Calendar or Native Mood cache was created.

## 8. History v1/v2 compatibility

The History metadata bridge supports both schemas without changing v1 digest semantics:

| Document/revision | Capture schema | Restore behavior |
| --- | --- | --- |
| Ordinary/non-Diary | v1: title/summary/tags | Body + title/summary/tags; `metadataMode = restored` |
| Canonical managed Diary before Mood coverage | v1 | Body-only; preserve current title/summary/tags/**mood**; `metadataMode = unavailable`, reason `pre-mood-schema` |
| Canonical managed Diary from D7.1 onward | v2: title/summary/tags/mood | Body + all four metadata fields; `metadataMode = restored` |
| Unsupported/newer schema or unknown controlled field | unsupported | Fail closed before body mutation |

New managed Diary captures always use v2, including explicit `mood = null`. Ordinary documents continue to use v1, so a multi-file commit may legally contain ordinary v1 and Diary v2 rows. The v2 payload uses deterministic field ordering and preserves unknown Mood strings opaquely; it does not require the current registry to recognize the historical value.

A managed Diary v1 revision resolves as `kind = covered` with `metadataCompatibility = pre-mood-schema`, not as `kind = legacy`. It retains its commit/tree binding, payload digest, `bodySha`, stable `documentId`, and `generationId`; those proofs run before any body mutation. The restore applies body only, preserves the complete current durable metadata image including Mood, and reports `metadataMode = unavailable` with reason `pre-mood-schema`. A missing current metadata generation or a delete/recreate identity mismatch fails closed rather than creating a path-only generation. It never applies historical title/tags while retaining current Mood, which would create a mixed revision. A v2 managed Diary restore applies title, summary, tags, and Mood through the existing metadata owner transaction, keeps the stable document ID, and mints a fresh metadata version. Explicit null and unknown Mood values are both covered.

`HistoricalMetadataImage`, restore-journal before/target images, parsing, equality, reconciliation, and rollback application all include Mood. If a later body step fails, rollback therefore restores the previous Mood as part of the existing metadata image. No Mood-specific History database or second restore pipeline exists.

## 9. Recovery and lifecycle boundaries

Recovery remains the existing body-only draft/recovery lifecycle. D7.1 does not extend the draft schema, add a Mood snapshot, or create a Mood-specific Recovery owner. The durable SQLite Mood field is not reconstructed from draft content. Existing metadata mutation snapshots and rollback paths include the new nullable column, so generic lifecycle rollback does not drop a live Mood.

Document create, save, rename, move, delete, route synchronization, tabs, active path, dirty state, draft persistence, and document identity continue to use their existing owners. D7.1 does not alter the D1/D2 contracts, Diary create authority, D6 Calendar/Vault ownership, or the existing History/Recovery architecture.

## 10. Files changed by the implementation commit

The implementation commit changed only the following 26 files:

    server/__tests__/auth.migration.test.ts
    server/__tests__/crashRecovery.test.ts
    server/__tests__/history-metadata-revisions.test.ts
    server/__tests__/tagManagement.scale.test.ts
    server/__tests__/tagUndoFoundation.test.ts
    server/__tests__/diary-mood-metadata.test.ts
    server/migrations/0010_diary_mood_metadata.sql
    server/documentMetadata.ts
    server/folderMoveTransaction.ts
    server/history/metadataRevisions.ts
    server/history/restore.ts
    server/routes/diary.ts
    server/routes/metadata.ts
    server/routes/posts.ts
    server/tree.ts
    shared/diaryMood.ts
    shared/__tests__/diaryMood.test.ts
    src/composables/diary/useDiaryMoodCommand.ts
    src/composables/diary/__tests__/useDiaryMoodCommand.test.ts
    src/composables/vault/draft-recovery/__tests__/useDraftRecoveryManagement.test.ts
    src/composables/vault/draft-recovery/__tests__/useUnsavedDraftRecovery.test.ts
    src/composables/vault/editor-tabs/__tests__/workspacePostSummary.test.ts
    src/lib/api.ts
    src/lib/history-api.ts
    src/views/__tests__/VaultView.test.ts
    src/views/metadataPostSummary.ts

No `DiaryCalendar.vue`, `DiaryCalendarSurface.vue`, `ReadingPane.vue`, `EditorPane.vue`, Picker, Calendar marker, route, server Diary API, second database, sidecar, frontmatter writer, or dependency was added.

## 11. Validation evidence

The relevant validations below were run after the focused remediation commit `199fbe4`:

| Validation | Result |
| --- | --- |
| D7.1 focused registry/command/metadata/History/workspace suite | **PASS — 5 files, 63 tests** |
| `npm run test:history-integration` | **PASS — 5 files, 174 tests** |
| `npm run test:recovery-integration` | **PASS — 5 files, 193 tests** |
| `npm run test:unit` | **PASS — 232 files, 3485 passed, 2 skipped** |
| `npm run typecheck:client` | **PASS** |
| `npm run typecheck:server` | **PASS** |
| `npm run typecheck` | **PASS** |
| `npm run build` | **PASS** |
| `git diff --check` before commit | **PASS** |

The full unit run emitted existing jsdom/browser-environment notices (scrollTo, CSS parsing, and canvas context); it still completed with all 232 files passing. No browser E2E was required because D7.1 adds no UI.

## 12. D7.1 exit checklist

- [x] One shared registry with exactly 24 canonical entries, exact order, 4×6 coordinates, labels, accessibility names, and real SVG mappings
- [x] Stable IDs only in persisted Mood metadata
- [x] Additive `0010` migration in the existing SQLite database
- [x] Nullable `documents.mood` with opaque read/storage type
- [x] Canonical write validation limited to managed Diary + 24 IDs/null
- [x] Existing metadata owner and CAS reused for set/change/clear
- [x] Stale same-value CAS conflict covered
- [x] Unknown stored value, raw bytes, Frontmatter, draft, delete/recreate, and rollback boundaries covered
- [x] History v1 remains supported; managed Diary capture is v2 from D7.1 onward
- [x] Managed Diary v1 remains a trusted covered revision with `metadataCompatibility = pre-mood-schema`
- [x] Pre-Mood body SHA corruption, delete/recreate generation mismatch, and missing-live-generation fail-closed behavior are covered
- [x] Managed Diary v2 restores Mood through the generic metadata owner
- [x] Unknown Mood values are preserved; unknown fields/newer schemas fail closed before body mutation
- [x] Existing body-only Recovery architecture remains unchanged
- [x] Existing bulk PostSummary seam carries managed Diary Mood/version/identity
- [x] No per-cell Mood endpoint, second cache, second lifecycle, or second CAS token
- [x] No D7.2/D7.3 UI or Calendar marker was started
- [x] Focused, integration, unit, typecheck, build, and diff validation passed

## 13. Lifecycle and remaining risk

    D7 PRD                  = REVIEW-CLOSED
    D7 Implementation Plan  = REVIEW-CLOSED
    D7 Plan Amendment       = REVIEW-CLOSED
    D7.0A                   = REVIEW-CLOSED
    D7.0                    = REVIEW-CLOSED

    D7.1                   = REVIEW-CLOSED
    D7.1 Independent Review = PASS (0/0/0)
    D7.1 Self-review        = P0/P1/P2 0/0/0

    D7.2                   = NOT STARTED
    D7.3                   = NOT STARTED
    D7 Mood UI             = NOT STARTED

The focused D7.1 remediation addressed the independent-review finding that trusted Pre-Mood v1 provenance must not be downgraded to legacy. Independent re-review passed with P0/P1/P2 = 0/0/0; no new self-review finding is recorded. D7.1 is now closed. Remaining risk is intentionally deferred to later implementation phases: the 24-entry registry has no UI yet, and any future History/Recovery behavior must continue to honor the v1/v2 domain policy recorded here. No D7.1 STOP condition was triggered.

GitHub status: **not queried**.

Conclusion: D7.1 is **REVIEW-CLOSED** after Independent Review PASS. Stop here; do not start D7.2.
