# Tags Query & Index Refactor — Implementation Record

## 1. Code Baseline

The production code baseline at the time of this documentation repair:

```text
SHA: 8a5b452b9e48c97d52065c30204ff57b898d4a1a
Date: 2026-07-30
Branch: main
```

This is the HEAD of `main` before any documentation commits for the
retrospective process repair. Subsequent documentation commits are
NOT production code baselines.

## 2. Implementation Commits

### 2.1 `7bd502e` — refactor(tags): unify tag query model and tag index

**Author:** txx
**Date:** 2026-07-30 10:49:10 +0800

**Summary:** Phase 1 of the tag-system plan. Created the shared
infrastructure module `src/lib/tags.ts` and wired it into TagPanel
and FileTree.

**Files changed (6 files, additions 1026, deletions 21):**

| File | Additions | Deletions | Notes |
|------|-----------|-----------|-------|
| `src/lib/tags.ts` | 358 | 0 | new module |
| `src/lib/__tests__/tags.test.ts` | 471 | 0 | 57 new test cases |
| `src/components/vault/FileTree.vue` | 46 | 0 | additive `#tag` branch |
| `src/components/vault/TagPanel.vue` | 80 | 21 | TagIndex integration |
| `src/components/vault/__tests__/FileTree.test.ts` | 54 | 0 | 3 new test cases |
| `src/components/vault/__tests__/TagPanel.test.ts` | 17 | 0 | 1 new test case |

> Note: the original Implementation Record reported "+1005" — that was
> the GitHub compare "changes" column (additions + deletions). The
> actual additions total is 1026, deletions 21. This correction matters
> because per-file row totals are additions, not changes.

**Key implementations:**
- `normalizeTag`, `parseTagQuery`, `matchesTagQuery`, `buildTagIndex`,
  `updateDocumentTags`, `sortTagsByCountDescThenName`
- TagPanel: replaced hand-rolled `tagMap` with `buildTagIndex`
- FileTree: added `#`-token branch to `filterByQuery` (additive, kept legacy path)

**Issues discovered post-commit (Phase 1 review):**
1. `updateDocumentTags(index, path, undefined, undefined)` broke the
   three-way invariant (P1.1).
2. TagPanel filter used `parseTagQuery` → only read `query.text`, so
   `#java` input showed every tag (P1.2).
3. FileTree had dual-branch: text-only queries stayed on legacy path,
   queries with `#` tokens used shared matcher; the shared path searched
   summary and used single `includes` instead of AND text tokens (P1.3).
4. `normalizeTag` didn't re-trim after `#` strip: `# java` → ` java`
   (P1.1).
5. Display names preserved leading `#`: `##java` rendering (P2).

### 2.2 `8a5b452` — fix(tags): address Phase 1 review (Phase 1.1)

**Author:** txx
**Date:** 2026-07-30 11:18:51 +0800

**Summary:** Phase 1.1 review fixes for index consistency, file-tree
semantics, and tag-panel filtering.

**Files changed (6 files, additions 611, deletions 196):**

| File | Additions | Deletions | Notes |
|------|-----------|-----------|-------|
| `src/lib/tags.ts` | 198 | 160 | API redesign, textTokens, displayName fix |
| `src/lib/__tests__/tags.test.ts` | 355 | 116 | 19 new test cases, invariant helper |
| `src/components/vault/FileTree.vue` | 120 | 74 | unified query path |
| `src/components/vault/TagPanel.vue` | 40 | 21 | filter and active-state fixes |
| `src/components/vault/__tests__/FileTree.test.ts` | 45 | 0 | 3 new test cases |
| `src/components/vault/__tests__/TagPanel.test.ts` | 49 | 0 | 3 new test cases |

**Key fixes (Phase 1.1 closures):**

| Issue | Fix |
|-------|-----|
| P1.1: Index invariant break on null newTags | `updateDocumentTags` redesigned to `(index, path, newTags)`; old tags read from index; null → no-op |
| P1.2: TagPanel `#java` filter ignored | Filter now uses `normalizeTag(input)` directly, not `parseTagQuery.text` |
| P1.2: Case-sensitive active state | Added `selectedTagKey` computed for normalized comparison |
| P1.3: FileTree dual-branch semantic drift | Unified all queries through `parseTagQuery` → `matchesTagQuery` |
| P1.3: Summary search scope widened | Text tokens constrained to path/title only |
| P1.3: Bare `#` emptied file tree | `parseTagQuery('#')` → empty query → matches everything |
| P2: `##java` display | Added `normalizeTagDisplay` helper; `buildTagIndex` and `updateDocumentTags` both use it |

**Tests added in Phase 1.1:**
- `tags.test.ts`: +19 cases (normalizeTagDisplay × 5, textTokens × 8, summary exclusion, bare `#`, invariant helper on every index test, null/undefined guard, rename round-trip)
- `TagPanel.test.ts`: +3 cases (`#tag` filter, bare `#`, case-insensitive active state)
- `FileTree.test.ts`: +3 cases (multi-text-token AND under `#tag`, summary exclusion, bare `#`)

## 3. Files Implemented

### 3.1 `src/lib/tags.ts` — Pure Tag Module

**Role:** Single source of truth for all tag identity, query, match, and
index logic. No Vue, no DOM, no fetch.

**Exports:**
- `TagRecord`, `SearchableDoc`, `TagQuery`, `TagIndex`, `DocumentTagsDelta` (interfaces)
- `normalizeTag(raw)` — canonical identity
- `normalizeTagDisplay(raw)` — UI-facing display form
- `parseTagQuery(input)` — token classifier
- `matchesTagQuery(doc, query)` — match predicate
- `buildTagIndex(posts)` — forward + reverse + count index
- `updateDocumentTags(index, path, newTags)` — immutable single-doc update
- `sortTagsByCountDescThenName(records)` — stable sort helper

**Lines:** 448 (including docstrings)

### 3.2 `src/lib/__tests__/tags.test.ts` — Unit Tests

**Cases:** 76 (57 from Phase 1 + 19 from Phase 1.1)

**Coverage:**
- `normalizeTag` (9 cases)
- `normalizeTagDisplay` (5 cases)
- `parseTagQuery` (17 cases)
- `matchesTagQuery` (17 cases)
- `buildTagIndex` (9 cases)
- `updateDocumentTags` (14 cases)
- `sortTagsByCountDescThenName` (3 cases)
- `TagQuery` contract (2 cases)
- **Total: 76**

> The original Implementation Record reported `normalizeTag` as 10 cases
> (sum 77). The actual count in the file is 9, summing to 76. This
> matches the test runner's reported 76 cases in `tags.test.ts`.

**Key test infrastructure:** `expectTagIndexConsistent` helper validates
the three-way invariant on every index-producing test.

### 3.3 `src/components/vault/TagPanel.vue` — Tag Panel Component

**Role:** Renders the filterable tag list and selected-tag results.

**Consumes:** `buildTagIndex`, `normalizeTag`, `sortTagsByCountDescThenName` from `../lib/tags`.

**Key behaviors:**
- Tag list: `TagRecord[]` sorted by count desc then displayName asc
- Tag name filter: `normalizeTag(input)` → substring match on `normalizedName`
- Bare `#` → zero tags shown
- Selected tag comparison: `normalizeTag(selectedTag)` → key match on `normalizedName`
- Results: `tagDocuments.get(target)` lookup → filtered posts

### 3.4 `src/components/vault/FileTree.vue` — File Tree Component

**Role:** Renders the filtered file tree.

**Consumes:** `parseTagQuery`, `matchesTagQuery` from `../lib/tags`.

**Key behaviors:**
- All queries via `parseTagQuery` → `matchesTagQuery` (no legacy branch)
- Text tokens search path + title only (case-insensitive AND)
- `#tag` tokens match against document tags
- Bare `#` → empty query → full tree
- Folder preserved if any descendant matches
- Search-time folder auto-expansion

### 3.5 `src/components/vault/__tests__/TagPanel.test.ts` — TagPanel Tests

**Cases:** 16 (13 from Phase 1 + 3 from Phase 1.1)

### 3.6 `src/components/vault/__tests__/FileTree.test.ts` — FileTree Tests

**Cases:** 19 filter cases (16 from Phase 1 + 3 from Phase 1.1)

## 4. Design-to-Code Mapping

| Spec requirement | Code location | Test evidence | Commit |
|-----------------|--------------|---------------|--------|
| `normalizeTag` identity | `tags.ts:141-154` | `tags.test.ts` — `normalizeTag` describe (10 cases) | `7bd502e`, `8a5b452` |
| `normalizeTagDisplay` | `tags.ts:162-168` | `tags.test.ts` — `normalizeTagDisplay` describe (5 cases) | `8a5b452` |
| `TagQuery` interface | `tags.ts:93-99` | `tags.test.ts` — `TagQuery contract` describe | `7bd502e`, `8a5b452` |
| `parseTagQuery` — `#tag` → includeAll | `tags.ts:181-224` | `tags.test.ts` — `parseTagQuery` describe (17 cases) | `7bd502e` |
| `parseTagQuery` — `textTokens` | `tags.ts:222` | `tags.test.ts` — textTokens shapes | `8a5b452` |
| `matchesTagQuery` — exclude > includeAll | `tags.ts:257-260` | `tags.test.ts` — `#a -#a` → false | `7bd502e` |
| `matchesTagQuery` — text AND on path/title | `tags.ts:280-289` | `tags.test.ts` — multi-text-token AND | `7bd502e`, `8a5b452` |
| Text tokens NOT search summary | `tags.ts:280-289` | `tags.test.ts:377-389` — P1.3 test | `8a5b452` |
| `buildTagIndex` — three-way maps | `tags.ts:297-340` | `tags.test.ts` — `buildTagIndex` describe (9 cases) | `7bd502e` |
| `buildTagIndex` — `#java` display fix | `tags.ts:318` | `tags.test.ts:454-465` — P2 test | `8a5b452` |
| `updateDocumentTags` — null → no-op | `tags.ts:369-371` | `tags.test.ts:585-602` — P1.1 tests | `8a5b452` |
| `updateDocumentTags` — invariant | `tags.ts:360-435` | `tags.test.ts` — `expectTagIndexConsistent` | `7bd502e`, `8a5b452` |
| FileTree — unified query path | `FileTree.vue:139` | `FileTree.test.ts` — all filter tests | `8a5b452` |
| FileTree — `#tag` match | `FileTree.vue:146-157` | `FileTree.test.ts:202-213` | `7bd502e` |
| FileTree — bare `#` → full tree | `FileTree.vue:139` | `FileTree.test.ts:287-294` | `8a5b452` |
| FileTree — summary exclusion | `FileTree.vue:150` | `FileTree.test.ts:276-280` | `8a5b452` |
| TagPanel — TagIndex-driven list | `TagPanel.vue:38-42` | `TagPanel.test.ts:182-192` | `7bd502e` |
| TagPanel — `#tag` filter | `TagPanel.vue:55-63` | `TagPanel.test.ts:199-206` | `8a5b452` |
| TagPanel — bare `#` → no tags | `TagPanel.vue:59` | `TagPanel.test.ts:216-221` | `8a5b452` |
| TagPanel — case-insensitive active | `TagPanel.vue:73` | `TagPanel.test.ts:228-241` | `8a5b452` |
| sort tags by count desc then name | `tags.ts:442-448` | `tags.test.ts` — sort describe (3 cases) | `7bd502e` |

## 5. Deviations and Discoveries

### 5.1 Index Consistency — P1.1

**Discovery:** The initial `updateDocumentTags(index, path, oldTags, newTags)` signature accepted both old and new tags from the caller. Passing `undefined` for both arguments silently zeroed `documentTags[path]` while leaving `tagDocuments` and `tags` alone, breaking the three-way invariant.

**Fix:** Redesigned to `(index, path, newTags)` — old tags are read from `index.documentTags.get(path)` internally. The invariant holds by construction because the function is the sole writer of all three maps for a given path.

### 5.2 TagPanel `#tag` Filter — P1.2

**Discovery:** TagPanel's tag-list filter parsed input through `parseTagQuery` and only consulted `query.text`. Typing `#java` made `text === ''` (the parser routes `#xxx` to `includeAll`), so the panel showed every tag — the user's intent was silently ignored.

**Fix:** Filter now uses `normalizeTag(input)` directly. A leading `#` is stripped, the result is lowercased, then substring-matched against `tag.normalizedName`.

### 5.3 Case-Sensitive Active State — P1.2

**Discovery:** `selectedTag` was compared case-sensitively to `displayName`. Selecting `math` against a tag stored as `Math` rendered results without any row lighting up.

**Fix:** Added `selectedTagKey` computed (`normalizeTag(props.selectedTag)`) and compared against `tagRecord.normalizedName`.

### 5.4 FileTree Dual-Branch Semantic Drift — P1.3

**Discovery:** Queries without `#` tokens used the legacy substring branch (AND on path/title, no summary). Queries with `#` tokens used the shared matcher (single `includes(query.text)` on path/title/summary). Adding `#java` to `redis cache` changed BOTH the text semantic AND widened the search scope.

**Fix:** Unified both paths through `parseTagQuery` → `matchesTagQuery`. Text tokens always use AND semantics on path/title only, regardless of `#` token presence.

### 5.5 Display Form — P2

**Discovery:** `buildTagIndex` used `displayName = raw.trim()` which preserved a user-typed `#java` verbatim. The panel then added its own `#` glyph, rendering `##java`.

**Fix:** Introduced `normalizeTagDisplay(raw)` which trims and strips one leading `#` but preserves casing. Both `buildTagIndex` and `updateDocumentTags` use it for display names.

### 5.6 Re-Trim After `#` Strip

**Discovery:** `normalizeTag('# java')` returned `' java'` (with a leading space) because the post-strip trim was only done inside the empty-string check, not unconditionally.

**Fix:** Made the re-trim unconditional — the function always calls `.trim()` on the stripped value.

### 5.7 `textTokens` Field

**Discovery:** The initial `TagQuery` didn't have `textTokens`. The matcher used `query.text` directly with a single `includes`, making `redis cache` a single literal-substring search rather than AND of tokens.

**Fix:** Added `textTokens: string[]` field — always the lowercased whitespace-split of `text`. The matcher iterates over textTokens with AND semantics.

## 6. Excluded Implementation

The following capabilities are explicitly NOT implemented by this
refactor:

- **Rename** — changing a tag's name across all documents
- **Merge** — combining two tags into one
- **Remove** — deleting a tag from all documents
- **Persistent batch transactions** — atomic multi-document tag mutations
- **Undo** — rollback of tag operations
- **Phase 2 UI** — rename/merge/remove buttons, dialogs, confirmation flows
- **Auto-complete** — tag name suggestions during input
- **Tag health checks** — detecting orphaned or inconsistent tags
- **Tag linking** — hyperlinks between related tags
- **Saved filter views** — persisting query state across sessions
- **Hierarchical tags** — parent/child tag relationships
- **AI tag suggestions** — LLM-driven tag proposals

The `useTagFilter` composable (`src/composables/vault/useTagFilter.ts`)
remains in the codebase as un-referenced historical code — it has no
production callers (only its own test file imports it). It implements
multi-select OR semantics plus auto-switch to the Files panel, which
this refactor does **not** provide an equivalent for: `TagQuery.includeAll`
is an AND query field used by FileTree's shared matcher, not the
OR-driven panel→tree state machine `useTagFilter` modeled. Removal
(or proper integration) is deferred to a future Phase 2 change.
