# Tags Query & Index Refactor — Design

**Date:** 2026-07-30
**Status:** Approved — Retrospective Reconstruction
**Scope:** Tags Query & Index Refactor only

> This specification was reconstructed after implementation to restore
> the repository's required spec → plan → implementation → closure chain.
> It does not claim that this exact document existed before implementation.

The predecessor document [2026-06-02-vault-tag-filter-design.md](2026-06-02-vault-tag-filter-design.md)
described an earlier design in which clicking a tag in TagPanel would
filter the FileTree (lifting `activeTagFilter` into `VaultView`). That
proposed interaction was **not** the implementation that landed. The
current implementation keeps `selectedTag` purely in `VaultView` for the
in-panel results section; the FileTree is **not** driven by tag clicks.
This specification records the Query & Index Refactor that was actually
shipped. The predecessor design is preserved as historical reference but
must NOT be read as the current contract — its interaction design has
been superseded.

---

## 1. Problem

The vault had two independent, drifting implementations of tag-related
logic in the surfaces that the refactor covers:

1. **TagPanel** hand-rolled a `tagMap` computed that counted raw tag
   strings without normalization — `Java`, `JAVA`, and ` java ` were
   three separate entries in the tag list.
2. **FileTree** had its own legacy substring-based filter that treated
   `#java` as a literal text search of paths and titles, returning zero
   matches for tag-shaped queries.

These two query surfaces (the panel list and the tree search) used
different tag semantics. The refactor unifies them on a shared module
so the two query surfaces cannot drift apart again. It does **not**
change the TagPanel ↔ FileTree interaction: the panel renders its own
selected-tag results region, and the tree is driven by its own search
input — the two are independent surfaces sharing a tag model.

## 2. Goal

Create a single, pure, shared module (`src/lib/tags.ts`) that every
in-scope tag consumer draws from, so the covered surfaces cannot drift
apart again:

- **One definition** of tag identity (`normalizeTag`).
- **One query parser** (`parseTagQuery`) that classifies tokens into
  include, exclude, and text channels.
- **One match predicate** (`matchesTagQuery`) that applies the parsed
  query to a document.
- **One index** (`buildTagIndex` / `updateDocumentTags`) that maintains
  forward, reverse, and count consistency with a verifiable invariant.

The refactor's scope is the **client query surface**: the TagPanel
list/results and the FileTree search input. Out of client scope
(see §4): the SQLite tag-persistence layer (no shared `normalizeTag`
on the server side), the Command Palette (a separate MiniSearch index),
and any persistent tag-management operations.

## 3. Scope

- Tags Query & Index Refactor: **implemented and closed**.
- Phase 1: unified tag model, query parsing, matching, indexing, and
  integration into FileTree and TagPanel.
- Phase 1.1: review fixes for index consistency, query semantics, and
  display correctness.

## 4. Non-Goals

- Tag rename, merge, remove, or any persistent tag-management operations.
- Batch tag operations, server-side tag transactions, or Undo.
- Auto-complete, tag health checks, tag linking, saved filter views, or
  hierarchical tags.
- AI tag suggestions.
- Phase 2 / Phase 3 features of any kind.

## 5. Terminology

| Term | Definition |
|------|-----------|
| **normalized tag** | `normalizeTag(raw)` — trim, strip one leading `#`, lowercase. The canonical identity key. |
| **display name** | `normalizeTagDisplay(raw)` — trim, strip one leading `#`, preserve casing. The UI-facing form. |
| **TagQuery** | Parsed representation of a free-text query: `text`, `textTokens`, `includeAll`, `includeAny`, `exclude`. |
| **TagIndex** | Forward (`documentTags`), reverse (`tagDocuments`), and count (`tags`) maps over a set of documents. |
| **TagRecord** | `{ normalizedName, displayName, count }` — one entry in the tag list. |
| **SearchableDoc** | `{ path, title, tags, summary? }` — minimal document shape for matching. |

## 6. Tag Identity Rules

`normalizeTag(raw: string | undefined | null): string`

1. If `raw` is `null` or `undefined`, return `""`.
2. Trim leading and trailing whitespace.
3. If the result is empty, return `""`.
4. If the result starts with `#`, strip exactly one leading `#`.
5. Re-trim (handles `# java` → `java`, not ` java`).
6. Lowercase the result.
7. Preserve CJK characters, `/`, `-`, `_`.
8. Do NOT perform NFKC normalization.
9. Empty result (`""`) means "no tag" — callers must drop.

## 7. Display-Name Rules

`normalizeTagDisplay(raw: string | undefined | null): string`

1. If `raw` is `null` or `undefined`, return `""`.
2. Trim leading and trailing whitespace.
3. If the result is empty, return `""`.
4. If the result starts with `#`, strip exactly one leading `#`.
5. Re-trim.
6. Preserve original casing — do NOT lowercase.

The `#` glyph in the UI is the component's responsibility (TagPanel
renders `<span class="tag-hash">#</span>` separately). The display name
must NOT carry its own `#` prefix; a metadata field stored as the
literal `#java` must render as `#java`, not `##java`.

## 8. TagQuery Contract

```ts
interface TagQuery {
  text: string           // raw text-channel string
  textTokens: string[]   // lowercased, whitespace-tokenized AND projection of text
  includeAll: string[]   // AND — every listed tag must be present
  includeAny: string[]   // OR — at least one listed tag must be present (reserved, always [])
  exclude: string[]      // NOT — any listed tag drops the document
}
```

### Parser Semantics (`parseTagQuery(input: string): TagQuery`)

| Input token | Classification | Notes |
|------------|---------------|-------|
| `#xxx` | `includeAll` | Normalized; deduped |
| `-#xxx` | `exclude` | Normalized; deduped |
| bare `#` or `-#` | Dropped | No tag name present |
| Anything else | `text` + `textTokens` | Joined into `text`; tokenized into `textTokens` |

- `textTokens` is always the lowercased whitespace-split of `text`.
- `includeAny` is always `[]` in Phase 1 — no user-visible OR syntax.
- Repeated **include and exclude tag tokens** are deduplicated. Plain
  text tokens preserve their input occurrences — duplicate text tokens
  do not collapse, but the AND semantics make their effect
  indistinguishable in practice.
- Mixed case `#Tag` → normalized to lowercase for matching.

### Match Semantics (`matchesTagQuery(doc, query): boolean`)

1. **Exclude** (evaluated first): any excluded tag present → `false`.
2. **IncludeAll** (AND): not every required tag present → `false`.
3. **IncludeAny** (OR, reserved): no listed tag present → `false`.
4. **Text tokens**: every token must be a case-insensitive substring of
   `path` or `title`. Summary is NOT searched.
5. Exclude takes precedence over includeAll: `#a -#a` → `false` even
   when the doc carries `a`.
6. An empty query (no text tokens, no includes, no excludes) matches
   everything.

## 9. FileTree Behavior

- Every search query flows through `parseTagQuery` → `matchesTagQuery`.
  There is no separate legacy branch.
- Text tokens search `path` + `title` only (case-insensitive substring).
  Body summary is deliberately excluded.
- Multiple text tokens compose with AND.
- Adding `#tag` tokens does not change the text-token AND semantic.
- Folder matching: a folder is kept if any descendant file matches
  (preserved subtree behavior).
- Bare `#` → `parseTagQuery('#')` → empty query → matches everything →
  full tree visible.
- `#tag` token matches against document tags (normalized comparison),
  not as literal text in path/title.

## 10. TagPanel Behavior

- Tag list is built via `buildTagIndex(props.posts)` and displayed as
  `TagRecord[]` (displayName + count).
- Tag name filter uses `normalizeTag(input)` directly (not
  `parseTagQuery`): strips `#`, lowercases, then substring-matches
  against `tag.normalizedName`.
- Typing `#java` → filter matches `Java` (the `#` is stripped).
- Bare `#` → `normalizeTag('#')` → `""` → zero tags shown ("no match"
  empty state).
- Selected tag comparison uses `normalizeTag(selectedTag)` as the key,
  so `selectedTag='math'` lights up the row for `displayName='Math'`.
- The `#` glyph is rendered by the template (`<span class="tag-hash">#
  </span>`), not included in the display name.

## 11. TagIndex Structure

```ts
interface TagIndex {
  tags: Map<string, TagRecord>          // normalizedName → record
  documentTags: Map<string, Set<string>> // path → Set<normalizedTag>
  tagDocuments: Map<string, Set<string>> // normalizedTag → Set<path>
}

interface TagRecord {
  normalizedName: string  // canonical identity
  displayName: string     // first-seen casing
  count: number           // distinct post count
}

interface DocumentTagsDelta {
  added: string[]
  removed: string[]
}
```

## 12. TagIndex Invariants

For every `(path, tag)` pair the three fields agree:

```text
1. documentTags.get(path)?.has(tag) === true
   ⇔
   tagDocuments.get(tag)?.has(path) === true

2. tags.get(tag)?.count === tagDocuments.get(tag)?.size
```

`updateDocumentTags(index, path, newTags)` maintains this by
construction:

- Old tags are read from `index.documentTags.get(path)` internally —
  the caller does not pass them. This prevents the "zero documentTags
  while tagDocuments still points back" drift.
- `newTags === null | undefined` → no-op; returns the **same** index
  reference with an empty delta.
- `newTags === []` → explicit clear (removes all tags for the path).
- No-op (same tags in, same tags out) → returns the **same** index
  reference.
- The input index is never mutated; a new index is returned on change.

## 13. Component and Module Responsibilities

| Component / Module | Responsibility |
|-------------------|---------------|
| `src/lib/tags.ts` | All tag identity, query, match, and index logic. Pure module — no Vue, no DOM, no fetch. |
| `TagPanel.vue` | Renders the tag list from `TagIndex`. Filters the list by tag name. Renders its own selected-tag results region (note list) from the same `TagIndex`. Emits `select`. |
| `FileTree.vue` | Filters the tree via `parseTagQuery` + `matchesTagQuery`. Drives its own search input independently — does NOT respond to TagPanel's selection. |
| `VaultView.vue` | Owns the `selectedTag` ref passed to TagPanel. Does NOT forward TagPanel selection to FileTree, and does NOT filter the FileTree by tag. The original `2026-06-02` design that lifted `activeTagFilter` into VaultView and used it to drive FileTree was not the implementation that shipped. |

## 14. Compatibility Requirements

- No change to existing non-`#` FileTree search behavior.
- Text-token AND semantic preserved from legacy substring branch.
- Tag count and list ordering preserved (count desc, then name asc).
- No new dependencies, no API changes, no Markdown format changes.

## 15. Accessibility Requirements

The following accessibility properties are implemented in the current
codebase and the spec must match the code:

- TagPanel tag list: `role="listbox"` with `role="option"` entries.
- `aria-selected` on the active tag row.
- `aria-label` on the tag filter input, the tag list (`tags.list_label`),
  and the panel root (`tags.panel_label`).
- FileTree search: `aria-label` on the search input.
- `aria-live="polite"` on the TagPanel results region.

### Known non-blocking accessibility gap

The TagPanel results region (`<div class="results" aria-live="polite">`)
is announced on change by `aria-live="polite"` but does **not** carry an
`aria-label` or `aria-labelledby`. The selected tag chip inside the
results header carries the visible label, but a screen reader that
exposes the live region will hear it without a leading label. This
gap is recorded for a future maintenance change; it is not a regression
introduced by the Query & Index Refactor (the refactor did not add or
remove this attribute — it was already absent in the pre-Phase-1 code).

## 16. Performance Constraints

- `buildTagIndex` is O(n) over total tag occurrences across all posts.
- `updateDocumentTags` clones only the maps that change; no full-index
  rebuild.
- `parseTagQuery` is O(n) over input tokens (trivial string split).
- `matchesTagQuery` is O(t + n) where t = unique doc tags, n = text
  tokens.
- All functions are synchronous — no async work, no I/O.

## 17. Error and Edge Cases

| Case | Behavior |
|------|----------|
| `tags: undefined` on a document | Treated as `[]` — no crash, no false match |
| `null` entry in a tags array | Skipped — no crash, no false match |
| `#` (bare `#` in FileTree) | Empty query → full tree |
| `#` (bare `#` in TagPanel filter) | Zero tags shown |
| `#java -#java` in query | Exclude wins → `false` |
| `##java` as a tag name | Preserved as `#java` (only ONE leading `#` stripped) |
| `# java` (space after `#`) | Normalizes to `java` (post-strip re-trim) |
| Chinese tag names | Fully supported — no ASCII-only assumption |
| Slashes in tag names (`a/b/c`) | Preserved — treated as one atomic tag |
| Empty posts list | `buildTagIndex([])` → empty index (no crash) |
| Unknown path + non-empty tags in `updateDocumentTags` | Added as a new entry (`documentTags`, `tagDocuments`, and `tags` all updated) |
| Unknown path + empty tags (`[]`) in `updateDocumentTags` | No-op — returns the same index reference. `documentTags` is **not** updated with an empty set, because the function's no-op short-circuit runs before any write. |

## 18. Acceptance Criteria

1. `normalizeTag` and `normalizeTagDisplay` behave as specified in §6–7.
2. `parseTagQuery` correctly classifies `#tag`, `-#tag`, bare `#`, and
   text tokens; deduplicates `includeAll` and `exclude` only.
3. `matchesTagQuery` applies AND for text tokens and includeAll, NOT
   for exclude, and exclude overrides includeAll.
4. Text tokens search only `path` + `title`, never `summary`.
5. `buildTagIndex` produces a consistent three-way index.
6. `updateDocumentTags` preserves the invariant for all input shapes,
   including the unknown-path + `[]` no-op short-circuit.
7. FileTree uses the unified query path for every search (no dual
   branch).
8. TagPanel filter normalizes input and uses case-insensitive selected
   tag comparison.
9. Bare `#` in either surface behaves correctly.
10. All existing tests pass; new tests cover the behaviors above.

## 19. Verification Requirements

- `npm run typecheck` — clean (client + server).
- `npm test -- --run` — all tests pass.
- `npm run build` — succeeds.
- Manual smoke: TagPanel renders tag list and selected-tag results
  region; `#tag` in FileTree search finds tagged documents; TagPanel
  filter handles `#`-prefixed input.

## 20. Future Work Boundary

**Rename / Merge / Remove and all persistent tag-management operations
are separate features and are NOT STARTED.**

Tag Management (Phase 2) must:

1. Start from a new, independent Spec.
2. Receive Owner Approval before any implementation.
3. Produce its own Plan, Implementation Record, and Closure.
4. Not treat this specification or its Closure as implementation
   authorization.

The `includeAny` (OR) field in `TagQuery` is reserved for a future
Phase 4 UI toggle. The parser does not expose OR syntax; the field
exists so the predicate shape is stable across phases.
