# Tags Query & Index Refactor — Final Closure

This document records the formal closure of the Tags Query & Index
Refactor (Phase 1 + Phase 1.1 review fixes). It is the authoritative
closure record. Future changes must respect the maintenance-mode rules
in §8.

---

## 1. Final Baseline

```text
Repository:  tangxiangxiang/nuvyn
Branch:      main
Final Production Code SHA:  8a5b452b9e48c97d52065c30204ff57b898d4a1a
Closure Date:               2026-07-30

Spec:  docs/superpowers/specs/2026-07-30-tags-query-index-refactor-design.md
Plan:  docs/superpowers/plans/2026-07-30-tags-query-index-refactor-implementation-plan.md
Impl:  docs/tags-query-index-refactor-implementation-record.md
```

> Closure 文档提交不是生产代码 baseline。生产代码 baseline 是
> `8a5b452b9e48c97d52065c30204ff57b898d4a1a` — Phase 1.1 的最后一个提交。

---

## 2. Final Status

```text
TAGS QUERY & INDEX REFACTOR:  CLOSED
PHASE 1:                       CLOSED
PHASE 1.1 REVIEW FIXES:       CLOSED
TAG MANAGEMENT PHASE 2:       NOT STARTED
STATUS:                        MAINTENANCE MODE
```

---

## 3. Delivered Scope

The following capabilities are implemented, tested, and closed:

### 3.1 Tag Identity & Display

- `normalizeTag(raw)` — canonical tag identity (trim, strip one `#`, lowercase)
- `normalizeTagDisplay(raw)` — UI-facing display form (trim, strip one `#`, preserve case)
- CJK, `/`, `-`, `_` preserved; no NFKC normalization
- `null` / `undefined` / blank input → `""`

### 3.2 Query Model

- `TagQuery` — structured query with `text`, `textTokens`, `includeAll`, `includeAny`, `exclude`
- `parseTagQuery(input)` — classifies `#tag`, `-#tag`, bare `#`, and text tokens
- `matchesTagQuery(doc, query)` — exclude-first match predicate with AND text tokens
- Text tokens search path + title only (case-insensitive); summary deliberately excluded
- `includeAny` field reserved for Phase 4 (always `[]`)

### 3.3 Tag Index

- `TagIndex` — `tags`, `documentTags`, `tagDocuments` with three-way invariant
- `buildTagIndex(posts)` — forward + reverse + count index from posts array
- `updateDocumentTags(index, path, newTags)` — immutable single-document update
- `null` / `undefined` newTags → no-op (returns same reference)
- `[]` newTags → explicit clear
- No-op detection → returns same reference
- `sortTagsByCountDescThenName(records)` — stable sort helper
- `DocumentTagsDelta` — `{ added, removed }` for downstream consumers

### 3.4 FileTree Integration

- All search queries flow through `parseTagQuery` → `matchesTagQuery` (unified path)
- `#tag` tokens match document tags (not as literal text)
- `-#tag` tokens exclude tagged documents
- Text tokens preserve legacy AND semantic on path/title only
- Bare `#` → empty query → full tree
- Folder preserved when any descendant matches

### 3.5 TagPanel Integration

- Tag list built from `TagIndex` (displayName + count)
- Tag name filter via `normalizeTag(input)` — strips `#`, case-insensitive
- Bare `#` → zero tags
- Selected tag comparison via `selectedTagKey` (normalized, case-insensitive)
- `#` glyph rendered by template, not embedded in display name

### 3.6 Test Suite

- `src/lib/__tests__/tags.test.ts` — 76 unit tests with invariant helper
- `src/components/vault/__tests__/TagPanel.test.ts` — 16 component tests
- `src/components/vault/__tests__/FileTree.test.ts` — 19 filter tests

---

## 4. Closed Review Findings

All findings from the Phase 1 review (`7bd502e`) were closed by Phase
1.1 (`8a5b452`):

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| P1.1 | `updateDocumentTags` broke three-way invariant on null newTags | P1 | API redesigned to `(index, path, newTags)`; old tags read from index |
| P1.2 | TagPanel `#tag` filter input silently ignored | P1 | Filter uses `normalizeTag(input)` directly |
| P1.2 | Case-sensitive selectedTag comparison | P1 | Added `selectedTagKey` computed |
| P1.3 | FileTree dual-branch semantic drift | P1 | Unified all queries through shared matcher |
| P1.3 | Text tokens searched summary | P1 | Constrained to path/title only |
| P1.3 | Bare `#` emptied file tree | P1 | `parseTagQuery('#')` → empty query → full tree |
| P2 | `##java` display (double `#`) | P2 | Added `normalizeTagDisplay` helper |

---

## 5. Final Invariants

The closed system preserves the following invariants. Any future change
that weakens any of them must reopen the closure.

1. **Single canonical identity for the client query surface.**
   `normalizeTag(raw)` is the **shared** definition of tag identity for
   the client query surface (TagPanel list/results and FileTree search).
   Two strings that normalize to the same value are the same tag for
   matching and indexing in that surface.
   This is **not** the system-wide tag identity: the SQLite tag-
   persistence layer on the server does not currently run through
   `normalizeTag` (it does its own trim + lowercase, without stripping
   a leading `#`). Persistence-layer normalization is explicitly out of
   scope for this closure — see §7.
2. **Display name rules.** `normalizeTagDisplay(raw)` strips one leading
   `#` and preserves casing. The UI `#` glyph is separate.
3. **FileTree multi-text-token AND.** Every text token must match
   (case-insensitive substring) in path or title. Summary is never
   searched.
4. **TagIndex three-way consistency.** For every `(path, tag)`:
   `documentTags[path]` has `tag` ⇔ `tagDocuments[tag]` has `path`;
   `tags[tag].count === tagDocuments[tag].size`.
5. **Null/undefined resilience.** `updateDocumentTags` with null/undefined
   newTags returns the original index reference unchanged.
6. **Single query entry point.** FileTree's `filterByQuery` has exactly
   one code path through `parseTagQuery` → `matchesTagQuery`. No
   separate legacy branch.

---

## 6. Verification Evidence

Verified locally on the final production code SHA
`8a5b452b9e48c97d52065c30204ff57b898d4a1a` on 2026-07-30:

| Command | Result |
|---------|--------|
| `npm run typecheck` | PASS (client + server) |
| `npm run build` | PASS |
| `npm test -- --run` | PASS |
| `git diff --check` | PASS (clean) |

Test run summary:

```text
Test Files: 154 passed (154)
Tests:      2453 passed | 2 skipped (2455)
Failed:     0
Duration:   80.46s
```

### GitHub CI

```text
GitHub CI: NOT INDEPENDENTLY VERIFIED
```

No workflow run was located for SHA `8a5b452b9e48c97d52065c30204ff57b898d4a1a`
during the documentation repair window. Local verification (typecheck,
test, build) passes cleanly.

---

## 7. Accepted Non-Blocking Risks

The following are verified against the current code and accepted as
non-blocking for closure:

1. **`includeAny` (OR) is modeled but has no parser syntax or UI.**
   The field exists in `TagQuery` as a typed placeholder for a future
   Phase 4 OR-mode toggle. It is always `[]` in Phase 1. No user-facing
   behavior depends on it.

2. **Tag identity is unified only on the client query surface.**
   `normalizeTag` is the shared identity for TagPanel and FileTree —
   both client-side. The SQLite persistence layer does not currently
   route tag values through `normalizeTag`; server-side tag handling
   applies its own trim + lowercase, without stripping a leading `#`.
   This is acceptable for Phase 1 because the Query & Index Refactor
   intentionally scopes itself to the client query surface and because
   server-side tag operations (rename / merge / remove) are NOT
   STARTED. A future server-side refactor that normalizes tags on the
   SQLite side is out of scope here.

3. **`VaultView` tag deselect uses raw string equality, not
   `normalizeTag`.**
   `VaultView.vue` toggles selection with `selectedTag === $event ? null
   : $event`. Two tags that normalize to the same identity but differ
   in casing (e.g. `Math` vs `math`) are not recognized as equal by this
   raw compare. The visible TagPanel row's active state does correctly
   key off `normalizeTag` (so the row lights up), but the toggle itself
   uses raw equality. This is recorded here, not as a violation of the
   closed invariant (the TagPanel inner state is normalized correctly),
   but as a documented boundary of where the refactor's unification
   reaches. Closing this gap requires a small follow-up change to
   `VaultView` and is intentionally out of scope for this closure.

4. **Rename / Merge / Remove are NOT STARTED.**
   The current system provides no persistent tag-management operations.
   Users cannot rename a tag across all documents, merge two tags into
   one, or remove a tag site-wide. This is explicitly out of scope for
   the Query & Index Refactor.

5. **No server-side transactions or Undo.**
   Tag mutations are not atomic across documents, and there is no Undo
   mechanism. These are Phase 2 concerns.

6. **`useTagFilter` composable is un-referenced historical code.**
   `src/composables/vault/useTagFilter.ts` has no production callers
   (it is imported only by its own test file) and is therefore not
   active behavior. It implements **multi-select OR semantics** plus an
   auto-switch to the Files panel — UI surface and state shape that
   this refactor does **not** provide an equivalent for. It is
   **incorrect** to describe it as "superseded by `TagQuery.includeAll`":
   `includeAll` is an AND query field used by the FileTree's shared
   matcher, not the OR-driven panel→tree state machine that
   `useTagFilter` modeled. The composable remains in the codebase as
   unused; a future Phase 2 may revisit it or delete it.

7. **Command Palette has its own tag handling — but does not share
   the unified identity.**
   `src/lib/search.ts` builds its own MiniSearch index over
   `{ title, path, tags, summary }` (with `tags` boosted at 2 and a
   `'tag'` match category). So the palette **does** index and return
   hits on the `tags` field — it is not "not tag-aware". What it does
   **not** share with the Query & Index Refactor is:
     - it does not apply `normalizeTag` to indexed tag values (raw,
       case-preserved strings joined into a single haystack), and
     - it does not implement the `parseTagQuery` `#tag` / `-#tag`
       structured-query semantics; users type free text only.
   This is recorded as a documented boundary: future work could route
   the palette through `normalizeTag` and add a `#`-prefixed structured
   query syntax; both are out of scope for this closure.

8. **TagPanel results region lacks a top-level `aria-label`.**
   The `<div class="results" aria-live="polite">` announces via
   `aria-live` but does not carry its own `aria-label`. This is a
   pre-existing gap; the refactor did not add or remove it. Closing
   the gap is a follow-up maintenance change, not a Phase 1.1
   regression.

---

## 8. Maintenance-Mode Rules

After closure, any future change touching `normalizeTag`,
`normalizeTagDisplay`, `parseTagQuery`, `matchesTagQuery`,
`buildTagIndex`, `updateDocumentTags`, FileTree tag search, or
TagPanel tag identity must:

1. **Update or create a Spec** before implementation.
2. **Create a Plan** documenting the change sequence.
3. **Preserve the TagIndex invariant** — `documentTags`, `tagDocuments`,
   and `tags.count` must remain mutually consistent.
4. **Preserve FileTree text-token AND semantics** — multi-token text
   queries must continue to use AND, and summary must not be searched.
5. **Add tests** for any behavioral change.
6. **Run `typecheck`, `test`, and `build`** before commit.
7. **Do not silently expand scope** under this closure. Any feature
   beyond what §3 lists requires a new Spec and a reopened or new
   closure.

---

## 9. Follow-Up Feature Boundary

```text
Tag Management（Rename / Merge / Remove）是新的独立功能。
当前状态：NOT STARTED。
开始前必须创建新的 Spec，并获得 Owner Approval。
不得把本 Closure 当作 Phase 2 的实现授权。
```

Phase 2 must follow the full chain:

```text
new Spec → new Plan → implementation → new Implementation Record → new Closure
```

It must NOT use this Closure as evidence of prior approval or design
agreement for rename, merge, remove, batch operations, or Undo.
