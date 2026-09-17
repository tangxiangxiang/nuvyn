# Tags Query & Index Refactor — Implementation Plan

**Status:** Completed — Retrospective Reconstruction
**Spec:** [2026-07-30-tags-query-index-refactor-design.md](../specs/2026-07-30-tags-query-index-refactor-design.md)

> This plan reconstructs the implementation sequence from repository
> evidence. It is not presented as a pre-existing plan.

---

## Task 1: Establish Pure Tag Model

- [x] Define `TagRecord` interface
- [x] Define `SearchableDoc` interface
- [x] Define `TagQuery` interface with `text`, `textTokens`, `includeAll`, `includeAny`, `exclude`
- [x] Define `TagIndex` interface with `tags`, `documentTags`, `tagDocuments`
- [x] Define `DocumentTagsDelta` interface

**Files modified:** `src/lib/tags.ts`
**Test files:** `src/lib/__tests__/tags.test.ts`
**Implementation commit:** `7bd502e`
**Deviations:** None — interfaces match the intended design.
**Verification:** TypeScript compilation; interfaces are consumed by all downstream code.

---

## Task 2: Implement Tag Normalization

- [x] Implement `normalizeTag(raw)`: trim → strip one `#` → re-trim → lowercase
- [x] Implement `normalizeTagDisplay(raw)`: trim → strip one `#` → re-trim → preserve case
- [x] `null` / `undefined` → `""`
- [x] `# java` → re-trim handles the inner space (Phase 1.1)
- [x] Only ONE leading `#` stripped (`##java` → `#java`)
- [x] No NFKC normalization
- [x] Unit tests: 10 `normalizeTag` cases + 5 `normalizeTagDisplay` cases

**Files modified:** `src/lib/tags.ts`
**Test files:** `src/lib/__tests__/tags.test.ts`
**Implementation commit:** `7bd502e` (initial); `8a5b452` (re-trim fix, displayName helper)
**Deviations:** Initial implementation did not re-trim after `#` strip, causing `# java` → ` java`. Fixed in Phase 1.1 (`8a5b452`). Initial display name extraction used `raw.trim()` directly, causing `##java` display. Fixed by introducing `normalizeTagDisplay` in Phase 1.1.
**Verification:** `tags.test.ts` — `normalizeTag` and `normalizeTagDisplay` describe blocks.

---

## Task 3: Implement Query Parsing and Matching

- [x] Implement `parseTagQuery(input)`: whitespace-split → classify tokens
- [x] `#xxx` → `includeAll` (normalized, deduped)
- [x] `-#xxx` → `exclude` (normalized, deduped)
- [x] Bare `#` / `-#` → dropped
- [x] Plain text → joined into `text`; tokenized into `textTokens` (lowercased)
- [x] Implement `matchesTagQuery(doc, query)`: exclude → includeAll → includeAny → textTokens
- [x] Exclude takes precedence over includeAll
- [x] Text tokens AND on `path` + `title` only — NOT summary (Phase 1.1)
- [x] `textTokens` always populated (Phase 1.1)
- [x] Unit tests: 17 `parseTagQuery` cases + 17 `matchesTagQuery` cases

**Files modified:** `src/lib/tags.ts`
**Test files:** `src/lib/__tests__/tags.test.ts`
**Implementation commit:** `7bd502e` (initial); `8a5b452` (textTokens, summary exclusion, bare `#` handling)
**Deviations:**
- Initial `matchesTagQuery` searched `path + title + summary` when `#` tokens were present. This widened the search scope compared to the legacy FileTree behavior (path/title only). Fixed in Phase 1.1 by constraining text tokens to path/title only and adding explicit `textTokens` AND semantics.
- Initial implementation had a dual-branch in FileTree: text-only queries used the legacy path, queries with `#` tokens used the shared matcher. Phase 1.1 unified both paths through the shared matcher.
**Verification:** `tags.test.ts` — `parseTagQuery` and `matchesTagQuery` describe blocks.

---

## Task 4: Implement TagIndex

- [x] Implement `buildTagIndex(posts)`: iterate posts → build forward + reverse + count maps
- [x] Defensive: `tags: undefined` → `[]`; `null` entries → skipped
- [x] First-seen display form wins (via `normalizeTagDisplay`)
- [x] Count = distinct posts, not occurrences
- [x] Implement `updateDocumentTags(index, path, newTags)`: immutable update with invariant
- [x] `newTags === null | undefined` → no-op (returns same reference)
- [x] `newTags === []` → explicit clear
- [x] No-op detection → returns same reference
- [x] Old tags read from index internally (not caller-supplied) — Phase 1.1
- [x] Implement `sortTagsByCountDescThenName(records)`: stable sort, no mutation
- [x] Three-way invariant helper: `expectTagIndexConsistent` in tests — Phase 1.1
- [x] Unit tests: 9 `buildTagIndex` cases + 14 `updateDocumentTags` cases + 3 sort cases

**Files modified:** `src/lib/tags.ts`
**Test files:** `src/lib/__tests__/tags.test.ts`
**Implementation commit:** `7bd502e` (initial); `8a5b452` (API redesign — old tags from index, null/undefined guard)
**Deviations:**
- Initial `updateDocumentTags(index, path, oldTags, newTags)` accepted both old and new tags from the caller. Passing `undefined` for both silently zeroed `documentTags[path]` while leaving `tagDocuments` and `tags` alone, breaking the three-way invariant. Phase 1.1 redesigned the API to `(index, path, newTags)` where old tags are read from the index internally. This makes the invariant hold by construction.
- Initial `buildTagIndex` used `raw.trim()` for displayName, causing `#java` → `##java` rendering. Fixed by using `normalizeTagDisplay` in Phase 1.1.
**Verification:** `tags.test.ts` — `buildTagIndex`, `updateDocumentTags`, and `sortTagsByCountDescThenName` describe blocks. Every index-building test calls `expectTagIndexConsistent`.

---

## Task 5: Integrate FileTree

- [x] Import `matchesTagQuery`, `parseTagQuery` from `../lib/tags`
- [x] Compute `parsedQuery` and `postsByPath` as computeds
- [x] `filterByQuery` uses `matchesTagQuery` for every file node
- [x] Folder matching preserves complete subtree when any descendant matches
- [x] Drop the legacy dual-branch (Phase 1.1) — all queries through the shared path
- [x] Bare `#` → empty query → tree intact (Phase 1.1)
- [x] Text tokens never search summary (Phase 1.1)
- [x] `#tag` + text AND preserved (Phase 1.1)
- [x] Component tests: 19 filter cases including `#tag`, `-#tag`, text+tag AND, summary exclusion, bare `#`

**Files modified:** `src/components/vault/FileTree.vue`
**Test files:** `src/components/vault/__tests__/FileTree.test.ts`
**Implementation commit:** `7bd502e` (initial additive branch); `8a5b452` (unified path, Phase 1.1 fixes)
**Deviations:**
- Initial implementation had a dual branch: text-only queries stayed on the legacy substring path, queries with `#` tokens went through the shared matcher. This caused semantic drift: adding `#java` to `redis cache` changed BOTH the text semantic (single `includes` vs AND tokenization) AND widened the search scope to summary. Phase 1.1 unified both paths through `parseTagQuery` → `matchesTagQuery`.
**Verification:** `FileTree.test.ts` — `Files filter` describe block. `npm run typecheck` and `npm run build` confirm template/type integration.

---

## Task 6: Integrate TagPanel

- [x] Replace hand-rolled `tagMap` computed with `buildTagIndex(props.posts)`
- [x] Tag list renders `TagRecord[]` (displayName + count)
- [x] `selectedTag` resolution through `normalizeTag` for lookup
- [x] Tag name filter uses `normalizeTag(input)` directly (Phase 1.1)
- [x] `#tag`-prefixed input → normalized filter (Phase 1.1)
- [x] Bare `#` → zero tags (Phase 1.1)
- [x] `selectedTagKey` computed for case-insensitive active state (Phase 1.1)
- [x] Component tests: 16 cases including normalization, `#tag` filter, bare `#`, case-insensitive active state

**Files modified:** `src/components/vault/TagPanel.vue`
**Test files:** `src/components/vault/__tests__/TagPanel.test.ts`
**Implementation commit:** `7bd502e` (initial TagIndex integration); `8a5b452` (Phase 1.1 filter and active-state fixes)
**Deviations:**
- Initial tag-list filter parsed input through `parseTagQuery` and only read `query.text`. Typing `#java` made `text === ''` and the panel showed every tag. Phase 1.1 changed to `normalizeTag(input)` directly — strips `#`, lowercases, then substring-matches `normalizedName`.
- Initial `selectedTag` comparison was case-sensitive against `displayName`. Selecting `math` against a tag stored as `Math` rendered results without lighting any row. Phase 1.1 added `selectedTagKey` computed for case-insensitive comparison.
**Verification:** `TagPanel.test.ts` — `Tags filter` describe block.

---

## Task 7: Supplementary Tests and Phase 1.1 Fixes

- [x] `expectTagIndexConsistent` helper — called from every index-building test (Phase 1.1)
- [x] `normalizeTagDisplay` tests (5 new cases)
- [x] `parseTagQuery.textTokens` tests (8 new shapes)
- [x] `matchesTagQuery` summary exclusion and bare `#` tests (3 new cases)
- [x] `buildTagIndex` `#java` display form tests (2 new cases)
- [x] `updateDocumentTags` null/undefined guard and rename round-trip tests (5 new cases)
- [x] TagPanel: `#tag` filter, bare `#`, case-insensitive active state (3 new cases)
- [x] FileTree: multi-text-token AND under `#tag`, summary exclusion, bare `#` (3 new cases)

**Files modified:** `src/lib/tags.ts`, `src/components/vault/FileTree.vue`, `src/components/vault/TagPanel.vue`
**Test files:** `src/lib/__tests__/tags.test.ts`, `src/components/vault/__tests__/FileTree.test.ts`, `src/components/vault/__tests__/TagPanel.test.ts`
**Implementation commit:** `8a5b452` (all Phase 1.1 fixes + new tests)
**Deviations:** Phase 1.1 was the review-and-fix phase — all deviations discovered in Phase 1 review are documented under Tasks 2–6.
**Verification:** Test suite: 154 files, 2453 passed, 2 skipped, 0 failed.
