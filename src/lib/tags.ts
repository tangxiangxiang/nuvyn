// Tag query model and shared tag index.
//
// Phase 1 of the tag-system plan. Pure module — no Vue, no fetch, no
// DOM. Both TagPanel and FileTree consume the same parse / match /
// normalize / index functions from here so the two sidebars cannot
// drift apart on tag semantics again.
//
// Design notes:
//   * Tag identity is `normalizeTag(raw)` — trim, drop a leading `#`,
//     lowercase. Two tag strings that normalize to the same value are
//     the same tag for matching purposes; the first display form
//     wins. Rationale: users routinely type `#Java` / `#java` /
//     `#JAVA` and expect them to collide. The display name is what
//     they see in the UI; the normalized form is what the index
//     keys on.
//   * `normalizeTagDisplay` is the UI-facing counterpart: trim and
//     strip one leading `#`, but preserve the user's casing. The
//     metadata editor allows typing `#java` verbatim and that should
//     not render as `##java` in the tag list.
//   * The parser is intentionally simple in Phase 1 — `#tag` AND
//     tokens, `-#tag` exclude tokens, plain text for everything
//     else. `textTokens` (always populated, even when `text` is
//     empty) is the AND-tokenized view of the text channel; both
//     TagPanel's tag-list filter and FileTree's file filter use it.
//     `includeAny` (OR) is a typed field but always empty until a
//     Phase 4 UI exposes a mode toggle; this lets Phase 1 ship the
//     predicate shape without committing to the parser's full
//     surface area.
//   * `matchesTagQuery` excludes take precedence over includeAll, so
//     `#a -#a` matches nothing (rather than everything). Text
//     tokens use legacy AND semantics (every token must be a
//     case-insensitive substring of path or title) — and never
//     searches the body summary, so a mixed query like
//     `#java redis cache` keeps the "redis AND cache, anywhere in
//     path/title" semantic the file-tree had before Phase 1.
//   * `buildTagIndex` is defensive about `tags === undefined` — the
//     server's rename and tree-builder paths can theoretically emit
//     `tags: undefined` for documents that exist in YAML but not in
//     the SQLite metadata table. We coerce to `[]` rather than
//     crash; the same guard propagates to Phase 2 batch operations.
//   * `updateDocumentTags` enforces a strict three-way invariant
//     over the index: `documentTags`, `tagDocuments`, and
//     `tags.count` must always agree on which paths carry which
//     normalized tags. The previous signature accepted both
//     `oldTags` and `newTags` separately and could silently break
//     the invariant when both were missing (it would zero out
//     `documentTags` while leaving `tagDocuments` and `tags` alone,
//     so the index could claim "this doc has no java but java's
//     reverse index still points to this doc"). The new signature
//     reads the old tags from the index itself so the invariant
//     holds by construction. `newTags === null | undefined` means
//     "caller has no info" and returns the original index
//     untouched, never zeroing anything.

import {
  normalizeTagDisplay as normalizeSharedTagDisplay,
  normalizeTagIdentity as normalizeSharedTagIdentity,
} from '../../shared/tagNormalization'

/** Phase 1 compatibility exports backed by the shared identity contract. */
export const normalizeTag = normalizeSharedTagIdentity
export const normalizeTagDisplay = normalizeSharedTagDisplay

/**
 * Canonical tag identity. Two tag strings that normalize to the same
 * value are the same tag for matching purposes. The index records the
 * first display form the index saw so the UI doesn't reflow on every
 * casing change.
 */
export interface TagRecord {
  /** Canonical identity key (trimmed, leading `#` stripped, lowercased). */
  normalizedName: string
  /** First-seen display form, with any leading `#` stripped but
   *  original casing preserved. Empty string is invalid; callers
   *  should drop. */
  displayName: string
  /** Number of distinct posts that carry this tag (post count, not occurrences). */
  count: number
}

/** Minimal document shape required for tag matching. Designed so it
 *  can be built from a `PostSummary` (path/title/tags/summary) without
 *  pulling in the full API surface. */
export interface SearchableDoc {
  path: string
  title: string
  tags: ReadonlyArray<string | undefined | null> | undefined | null
  summary?: string
}

/** Parsed tag query. `text` is the raw text-channel string and
 *  `textTokens` is its whitespace-tokenized, lowercased, AND view
 *  (every token must match somewhere). `includeAll` is AND (every
 *  tag must be present). `exclude` is NOT (any matching tag drops
 *  the doc). `includeAny` is OR (at least one tag must be present);
 *  reserved for a future Phase 4 UI toggle — currently always `[]`.
 *
 *  Text tokens are searched only against `path` + `title` (case-
 *  insensitive substring) and never against the body summary, so
 *  the legacy FileTree AND-text semantic is preserved when the
 *  query is a mix of text and tag tokens. */
export interface TagQuery {
  text: string
  textTokens: string[]
  includeAll: string[]
  includeAny: string[]
  exclude: string[]
}

/**
 * Reverse-lookup index over a `posts`-shaped list. Pure data — no
 * reactivity, no caching of the source. Callers re-build on `posts`
 * change and re-build cheaply because the index is O(n) over tag
 * count.
 *
 * Invariant: for every `(path, tag)` pair, the three fields agree —
 * `documentTags.get(path)?.has(tag) === tagDocuments.get(tag)?.has(path)`
 * and `tags.get(tag)?.count === tagDocuments.get(tag)?.size`.
 * `updateDocumentTags` maintains this invariant by construction.
 */
export interface TagIndex {
  /** normalizedName → TagRecord */
  tags: Map<string, TagRecord>
  /** path → Set<normalizedTag> */
  documentTags: Map<string, Set<string>>
  /** normalizedTag → Set<path> */
  tagDocuments: Map<string, Set<string>>
}

/** Result of diffing a single document's tags against the index. Used
 *  by `updateDocumentTags` so callers can know exactly what changed
 *  without re-walking the index. */
export interface DocumentTagsDelta {
  added: string[]
  removed: string[]
}

/**
 * Canonical tag identity. Whitespace is trimmed and a single leading
 * `#` is stripped (the result is then re-trimmed so `'# java'`
 * normalizes to `'java'` cleanly, not `' java'`). The result is
 * lowercased so `Java` / `java` / `JAVA` collapse to the same key.
 * Slashes, dashes, underscores and Unicode (including CJK) are
 * preserved. Empty results (input was blank or `#`-only) return `""`
 * — callers should drop these.
 *
 * We do NOT do NFKC normalization here — that would rewrite `ﬁ` →
 * `fi` etc. and silently change user-authored tag names.
 */
/**
 * Parse a free-text query into a structured `TagQuery`. Whitespace
 * separates tokens. Recognized token shapes:
 *   - `#xxx`     → push `xxx` into `includeAll`
 *   - `-#xxx`    → push `xxx` into `exclude`
 *   - anything else → accumulated into `text` and `textTokens`
 *
 * Empty input and input consisting only of `#` / `-#` tokens
 * degenerate to `text === ''` / `textTokens === []` plus whatever
 * include/exclude tokens were extracted.
 */
export function parseTagQuery(input: string): TagQuery {
  const includeAll: string[] = []
  const includeAny: string[] = []
  const exclude: string[] = []
  const textParts: string[] = []
  const seenAll = new Set<string>()
  const seenExclude = new Set<string>()

  // Split on whitespace; tolerate CRLF/LF/tabs. We intentionally do
  // NOT split on `|` — OR-mode is reserved for a future Phase 4 UI
  // toggle so the parser can stay stable across Phase 1.
  const tokens = input.split(/\s+/).filter(Boolean)
  for (const token of tokens) {
    if (token === '#' || token === '-#') continue
    if (token.startsWith('-#')) {
      const name = normalizeTag(token.slice(2))
      if (!name) continue
      if (!seenExclude.has(name)) {
        seenExclude.add(name)
        exclude.push(name)
      }
      continue
    }
    if (token.startsWith('#')) {
      const name = normalizeTag(token.slice(1))
      if (!name) continue
      if (!seenAll.has(name)) {
        seenAll.add(name)
        includeAll.push(name)
      }
      continue
    }
    textParts.push(token)
  }
  // Collapse multiple whitespace into single spaces in the text
  // channel so downstream substring checks are predictable.
  const text = textParts.join(' ').trim()
  // `textTokens` is the AND-tokenized view: lowercased, empty-token
  // filtered. The matcher uses this directly so the FileTree's
  // legacy "every token must match somewhere" semantic is preserved
  // when the user types a mix of `#tags` and plain text.
  const textTokens = text === '' ? [] : text.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return { text, textTokens, includeAll, includeAny, exclude }
}

/**
 * Predicate: does `doc` satisfy `query`?
 *
 * Order of evaluation (short-circuits on first failure):
 *   1. Exclude: any excluded tag is present → false.
 *   2. Include-all: not every required tag is present → false.
 *   3. Include-any (currently unused): no listed tag is present → false.
 *   4. Text tokens: every token (lowercased) must be a substring of
 *      `path` or `title` (case-insensitive). The body summary is
 *      intentionally NOT searched here — the FileTree's legacy
 *      behavior was a substring of path/title only, and this
 *      function preserves that semantic exactly.
 *   5. Otherwise → true.
 *
 * An empty query (no text tokens, no includes, no excludes) matches
 * everything.
 */
export function matchesTagQuery(doc: SearchableDoc, query: TagQuery): boolean {
  // Defensive: server-side producers can theoretically emit
  // `tags: undefined`; normalize to [] so the Set membership checks
  // never throw. The interface contract still requires `tags` to be
  // present, but a runtime-typed shape from JSON.parse may not honor
  // the contract.
  const docTags = (doc.tags ?? []) as ReadonlyArray<string>
  const docTagSet = new Set<string>()
  for (const t of docTags) {
    if (t == null) continue
    const n = normalizeTag(t)
    if (n) docTagSet.add(n)
  }

  if (query.exclude.length > 0) {
    for (const ex of query.exclude) {
      if (docTagSet.has(ex)) return false
    }
  }

  if (query.includeAll.length > 0) {
    for (const inc of query.includeAll) {
      if (!docTagSet.has(inc)) return false
    }
  }

  if (query.includeAny.length > 0) {
    let any = false
    for (const inc of query.includeAny) {
      if (docTagSet.has(inc)) {
        any = true
        break
      }
    }
    if (!any) return false
  }

  if (query.textTokens.length > 0) {
    // Search ONLY path + title (no summary). Matches the FileTree's
    // pre-Phase-1 behavior byte-for-byte, so the legacy
    // `"redis cache"` AND-text semantic is preserved when the user
    // adds a tag token alongside it.
    const hay = `${doc.path}\n${doc.title}`.toLocaleLowerCase()
    for (const token of query.textTokens) {
      if (!hay.includes(token)) return false
    }
  }

  return true
}

/** Build a `TagIndex` from a posts-shaped array. Defensive about
 *  `tags === undefined`. Order of insertion determines which
 *  display form wins for a given normalized name (first-seen wins). */
export function buildTagIndex(
  posts: ReadonlyArray<{ path: string; tags?: ReadonlyArray<string | undefined | null> | undefined | null }>,
): TagIndex {
  const tags = new Map<string, TagRecord>()
  const documentTags = new Map<string, Set<string>>()
  const tagDocuments = new Map<string, Set<string>>()

  for (const post of posts) {
    const set = new Set<string>()
    const rawTags = post.tags ?? []
    for (const raw of rawTags) {
      if (raw == null) continue
      const n = normalizeTag(raw)
      if (!n) continue
      set.add(n)
      if (!tags.has(n)) {
        tags.set(n, {
          normalizedName: n,
          // Display form strips a single leading `#` but preserves
          // the user's casing. A metadata field stored as the
          // literal `#java` renders as `#java`, not `##java`.
          displayName: normalizeTagDisplay(raw),
          count: 0,
        })
      }
    }
    documentTags.set(post.path, set)
    for (const n of set) {
      let paths = tagDocuments.get(n)
      if (!paths) {
        paths = new Set<string>()
        tagDocuments.set(n, paths)
      }
      paths.add(post.path)
    }
  }
  // Count distinct posts per tag (not occurrences; if the same tag
  // appears twice in one document it's still one post).
  for (const tag of tags.values()) {
    const paths = tagDocuments.get(tag.normalizedName)
    tag.count = paths ? paths.size : 0
  }
  return { tags, documentTags, tagDocuments }
}

/**
 * Apply a new tag set to a single document and return a NEW
 * `TagIndex` reflecting the change. The input index is NOT
 * mutated.
 *
 * Signature: `(index, path, newTags)`. The OLD tags are read from
 * `index.documentTags.get(path)` internally — the caller does not
 * pass them. This is what makes the three-way invariant
 * (`documentTags` / `tagDocuments` / `tags.count` agree on every
 * `(path, tag)` pair) hold by construction: the function is the
 * only writer of these three fields for a given path, and it
 * computes them from the same source.
 *
 * `newTags == null` means "caller has no data" — the original
 * index is returned untouched with an empty delta. The function
 * does NOT treat null as "clear the document's tags"; clearing
 * must be explicit (`newTags: []`).
 */
export function updateDocumentTags(
  index: TagIndex,
  path: string,
  newTags: ReadonlyArray<string | undefined | null> | null | undefined,
): { index: TagIndex; delta: DocumentTagsDelta } {
  // null / undefined means "no info from the caller" — refuse to
  // touch the index. Returning the original reference is important
  // so downstream computed/effects that compare by identity don't
  // spuriously rerun.
  if (newTags == null) {
    return { index, delta: { added: [], removed: [] } }
  }

  const oldNorm = new Set(index.documentTags.get(path) ?? [])
  const newNorm = new Set<string>()
  for (const t of newTags) {
    if (t == null) continue
    const n = normalizeTag(t)
    if (n) newNorm.add(n)
  }
  const added: string[] = []
  const removed: string[] = []
  for (const n of newNorm) if (!oldNorm.has(n)) added.push(n)
  for (const n of oldNorm) if (!newNorm.has(n)) removed.push(n)

  // No-op: same tag set, return the input index untouched.
  if (added.length === 0 && removed.length === 0) {
    return { index, delta: { added, removed } }
  }

  // Build new maps. We clone only the structures that change; every
  // other document's entry is reused by reference so the common case
  // (one document changing) is cheap.
  const tags = new Map(index.tags)
  const documentTags = new Map(index.documentTags)
  const tagDocuments = new Map(index.tagDocuments)

  documentTags.set(path, newNorm)

  for (const n of removed) {
    const paths = tagDocuments.get(n)
    if (!paths) continue
    const nextPaths = new Set(paths)
    nextPaths.delete(path)
    if (nextPaths.size === 0) {
      // Last document carrying this tag — drop the tag entirely.
      tagDocuments.delete(n)
      tags.delete(n)
    } else {
      tagDocuments.set(n, nextPaths)
      const rec = tags.get(n)
      if (rec) tags.set(n, { ...rec, count: nextPaths.size })
    }
  }
  for (const n of added) {
    const existing = tagDocuments.get(n)
    const nextPaths = existing ? new Set(existing) : new Set<string>()
    nextPaths.add(path)
    tagDocuments.set(n, nextPaths)
    if (!tags.has(n)) {
      // First time we see this tag — pick a display form. Prefer the
      // first-seen raw tag string from `newTags`.
      const firstRaw = newTags.find((t) => t != null && normalizeTag(t) === n)
      tags.set(n, {
        normalizedName: n,
        displayName: normalizeTagDisplay(firstRaw ?? n),
        count: nextPaths.size,
      })
    } else {
      const rec = tags.get(n)
      if (rec) tags.set(n, { ...rec, count: nextPaths.size })
    }
  }

  return { index: { tags, documentTags, tagDocuments }, delta: { added, removed } }
}

/**
 * Stable sort: posts first by descending tag count, then by display
 * name ascending. Pure function — no index mutation, safe to call
 * inside a `computed`.
 */
export function sortTagsByCountDescThenName(
  records: ReadonlyArray<TagRecord>,
): TagRecord[] {
  return [...records].sort(
    (a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName),
  )
}
