// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildTagIndex,
  matchesTagQuery,
  normalizeTag,
  normalizeTagDisplay,
  parseTagQuery,
  sortTagsByCountDescThenName,
  updateDocumentTags,
  type SearchableDoc,
  type TagIndex,
  type TagQuery,
} from '../tags'

/**
 * Cross-validates the three-way invariant that `TagIndex` advertises
 * in its docstring:
 *   for every (path, tag) pair, documentTags[path] agrees with
 *   tagDocuments[tag] AND tags[tag].count equals tagDocuments[tag].size.
 * `updateDocumentTags` is supposed to maintain this invariant by
 * construction; this helper exists so any test that produces an
 * index can re-check it cheaply. Caught several subtle drift bugs
 * during Phase 1 review.
 */
function expectTagIndexConsistent(index: TagIndex) {
  // Forward pass: every (path, tag) in documentTags must appear in
  // tagDocuments, and tags.count must reflect tagDocuments.size.
  for (const [path, tagsForPath] of index.documentTags) {
    for (const tag of tagsForPath) {
      expect(index.tagDocuments.get(tag)?.has(path)).toBe(true)
    }
  }
  // Reverse pass: every (tag, path) in tagDocuments must appear in
  // documentTags, and tags.count must equal tagDocuments.size.
  for (const [tag, paths] of index.tagDocuments) {
    for (const path of paths) {
      expect(index.documentTags.get(path)?.has(tag)).toBe(true)
    }
    expect(index.tags.get(tag)?.count).toBe(paths.size)
  }
  // Tags not present in tagDocuments must not be present in
  // documentTags either, and `tags` must agree.
  for (const [tag, rec] of index.tags) {
    if (!index.tagDocuments.has(tag)) {
      expect(rec.count).toBe(0)
    } else {
      expect(rec.count).toBe(index.tagDocuments.get(tag)!.size)
    }
  }
}

// -------- normalizeTag --------

describe('normalizeTag', () => {
  it('strips a leading `#`', () => {
    expect(normalizeTag('#java')).toBe('java')
  })

  it('trims leading and trailing whitespace', () => {
    expect(normalizeTag('  java  ')).toBe('java')
    expect(normalizeTag('\t#java\n')).toBe('java')
  })

  it('re-trims after stripping `#` so `# java` does not leak the inner space', () => {
    // Pre-Phase-1 fix: this used to return `' java'` (with a
    // leading space) because the post-strip trim only ran as part
    // of the empty-string check. Phase 1.1 makes the trim
    // unconditional so the normalized form is always clean.
    expect(normalizeTag('# java')).toBe('java')
    expect(normalizeTag('#  spring  ')).toBe('spring')
  })

  it('lowercases for matching', () => {
    expect(normalizeTag('Java')).toBe('java')
    expect(normalizeTag('JAVA')).toBe('java')
    expect(normalizeTag('#JaVa')).toBe('java')
  })

  it('returns empty string for blank input', () => {
    expect(normalizeTag('')).toBe('')
    expect(normalizeTag('   ')).toBe('')
    expect(normalizeTag('#')).toBe('')
    // `-#` as a raw tag string isn't a "blank" — it's a non-empty
    // string that just doesn't start with `#` and so passes through
    // the normalizer unchanged (the `-#` exclude prefix is the
    // parser's job, not the normalizer's).
    expect(normalizeTag('-#')).toBe('-#')
    expect(normalizeTag(null)).toBe('')
    expect(normalizeTag(undefined)).toBe('')
  })

  it('preserves Chinese (Unicode-safe)', () => {
    expect(normalizeTag('#人工智能')).toBe('人工智能')
    expect(normalizeTag('人工智能')).toBe('人工智能')
  })

  it('preserves slashes, dashes, underscores', () => {
    expect(normalizeTag('#a/b/c')).toBe('a/b/c')
    expect(normalizeTag('#spring-boot')).toBe('spring-boot')
    expect(normalizeTag('#spring_boot')).toBe('spring_boot')
  })

  it('only strips ONE leading `#`', () => {
    // A user who actually names a tag `##java` shouldn't have it
    // silently turned into `java`.
    expect(normalizeTag('##java')).toBe('#java')
  })

  it('does not NFKC-normalize Unicode (preserves user content)', () => {
    // ﬁ (U+FB01) does not collapse to "fi". If a future user reports
    // a real duplicate-from-NFKC case, we can revisit; for now the
    // conservative choice is no silent rename.
    expect(normalizeTag('ﬁre')).toBe('ﬁre')
  })
})

// -------- normalizeTagDisplay --------

describe('normalizeTagDisplay', () => {
  it('strips one leading `#` but preserves casing', () => {
    expect(normalizeTagDisplay('#Java')).toBe('Java')
    expect(normalizeTagDisplay('#java')).toBe('java')
    expect(normalizeTagDisplay('Java')).toBe('Java')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeTagDisplay('  #java  ')).toBe('java')
    expect(normalizeTagDisplay('\t#Java\n')).toBe('Java')
  })

  it('returns empty string for blank input', () => {
    expect(normalizeTagDisplay('')).toBe('')
    expect(normalizeTagDisplay('   ')).toBe('')
    expect(normalizeTagDisplay('#')).toBe('')
    expect(normalizeTagDisplay(null)).toBe('')
  })

  it('strips the leading `#` even when followed by inner whitespace', () => {
    // `# java` should not display as ` java` (with a leading space)
    // — the trim handles the post-strip whitespace too.
    expect(normalizeTagDisplay('# java')).toBe('java')
  })

  it('only strips ONE leading `#`', () => {
    expect(normalizeTagDisplay('##java')).toBe('#java')
  })
})

// -------- parseTagQuery --------

describe('parseTagQuery', () => {
  it('returns an empty query for empty input', () => {
    expect(parseTagQuery('')).toEqual({
      text: '',
      textTokens: [],
      includeAll: [],
      includeAny: [],
      exclude: [],
    })
  })

  it('returns an empty query for whitespace-only input', () => {
    const q = parseTagQuery('   \t\n  ')
    expect(q.text).toBe('')
    expect(q.textTokens).toEqual([])
  })

  it('parses a single #tag into includeAll', () => {
    const q = parseTagQuery('#java')
    expect(q.includeAll).toEqual(['java'])
    expect(q.exclude).toEqual([])
    expect(q.text).toBe('')
    expect(q.textTokens).toEqual([])
  })

  it('parses multiple #tags as AND (all into includeAll)', () => {
    const q = parseTagQuery('#java #spring')
    expect(q.includeAll).toEqual(['java', 'spring'])
    expect(q.textTokens).toEqual([])
  })

  it('parses -#exclude tokens', () => {
    const q = parseTagQuery('-#archive')
    expect(q.exclude).toEqual(['archive'])
    expect(q.includeAll).toEqual([])
  })

  it('handles a mix of includeAll, exclude, and plain text', () => {
    const q = parseTagQuery('#java #spring -#archive nacos')
    expect(q.includeAll).toEqual(['java', 'spring'])
    expect(q.exclude).toEqual(['archive'])
    expect(q.text).toBe('nacos')
    expect(q.textTokens).toEqual(['nacos'])
  })

  it('tokenizes multi-word plain text into textTokens', () => {
    const q = parseTagQuery('redis cache')
    expect(q.text).toBe('redis cache')
    expect(q.textTokens).toEqual(['redis', 'cache'])
  })

  it('combines tag and text in any order', () => {
    const q1 = parseTagQuery('#java nacos')
    expect(q1.includeAll).toEqual(['java'])
    expect(q1.text).toBe('nacos')
    expect(q1.textTokens).toEqual(['nacos'])

    const q2 = parseTagQuery('nacos #java')
    expect(q2.includeAll).toEqual(['java'])
    expect(q2.textTokens).toEqual(['nacos'])
  })

  it('dedupes repeated #tags in includeAll', () => {
    const q = parseTagQuery('#java #java #JAVA')
    expect(q.includeAll).toEqual(['java'])
  })

  it('dedupes repeated -#tags in exclude', () => {
    const q = parseTagQuery('-#archive -#archive')
    expect(q.exclude).toEqual(['archive'])
  })

  it('records both includeAll and exclude when same tag is in both', () => {
    const q = parseTagQuery('#java -#java')
    expect(q.includeAll).toEqual(['java'])
    expect(q.exclude).toEqual(['java'])
  })

  it('tolerates a bare `#` (no tag name)', () => {
    const q = parseTagQuery('# java')
    expect(q.includeAll).toEqual([])
    expect(q.text).toBe('java')
    expect(q.textTokens).toEqual(['java'])
  })

  it('tolerates multiple spaces between tokens', () => {
    const q = parseTagQuery('#java    #spring')
    expect(q.includeAll).toEqual(['java', 'spring'])
  })

  it('preserves Chinese tag names', () => {
    const q = parseTagQuery('#人工智能 #机器学习')
    expect(q.includeAll).toEqual(['人工智能', '机器学习'])
  })

  it('preserves slash / dash / underscore in tags', () => {
    const q = parseTagQuery('#a/b/c #spring-boot #spring_boot')
    expect(q.includeAll).toEqual(['a/b/c', 'spring-boot', 'spring_boot'])
  })

  it('handles mixed case tag tokens', () => {
    const q = parseTagQuery('#Java #spring -#Archive')
    expect(q.includeAll).toEqual(['java', 'spring'])
    expect(q.exclude).toEqual(['archive'])
  })

  it('lowercases textTokens so the matcher can do simple substring comparison', () => {
    const q = parseTagQuery('Redis CACHE')
    expect(q.textTokens).toEqual(['redis', 'cache'])
  })

  it('handles tag tokens adjacent to text without space', () => {
    // `#javanacos` is one token; the parser puts it in includeAll.
    // The same behavior as the legacy substring search.
    const q = parseTagQuery('#javanacos')
    expect(q.includeAll).toEqual(['javanacos'])
    expect(q.textTokens).toEqual([])
  })
})

// -------- matchesTagQuery --------

function doc(partial: Partial<SearchableDoc> & { path: string; tags: string[] }): SearchableDoc {
  return {
    path: partial.path,
    title: partial.title ?? '',
    tags: partial.tags,
    summary: partial.summary,
  }
}

describe('matchesTagQuery', () => {
  it('empty query matches everything', () => {
    const q = parseTagQuery('')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: [] }), q)).toBe(true)
  })

  it('single #tag matches docs with that tag', () => {
    const q = parseTagQuery('#java')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['java'] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['spring'] }), q)).toBe(false)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: [] }), q)).toBe(false)
  })

  it('AND of two #tags requires both', () => {
    const q = parseTagQuery('#java #spring')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['java', 'spring'] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['java'] }), q)).toBe(false)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['spring'] }), q)).toBe(false)
  })

  it('-#tag excludes a doc that has the tag', () => {
    const q = parseTagQuery('-#archive')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['archive'] }), q)).toBe(false)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: [] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['java'] }), q)).toBe(true)
  })

  it('exclude takes precedence over includeAll', () => {
    const q = parseTagQuery('#a -#a')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['a'] }), q)).toBe(false)
  })

  it('plain text matches path or title (case-insensitive)', () => {
    const q = parseTagQuery('Redis')
    expect(matchesTagQuery(doc({ path: 'notes/redis.md', title: 'A', tags: [] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'Redis notes', tags: [] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: [] }), q)).toBe(false)
  })

  it('multi-text-token requires every token (AND)', () => {
    const q = parseTagQuery('redis cache')
    // Both tokens present in different fields → match
    expect(matchesTagQuery(doc({ path: 'redis.md', title: 'Cache notes', tags: [] }), q)).toBe(true)
    // Only one token present → no match
    expect(matchesTagQuery(doc({ path: 'redis.md', title: 'Notes', tags: [] }), q)).toBe(false)
  })

  it('text + #tag requires both', () => {
    const q = parseTagQuery('#java nacos')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'nacos setup', tags: ['java'] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'other', tags: ['java'] }), q)).toBe(false)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'nacos setup', tags: [] }), q)).toBe(false)
  })

  it('case-insensitive tag matching (Java ≡ java)', () => {
    const q = parseTagQuery('#Java')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['java'] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['JAVA'] }), q)).toBe(true)
  })

  it('case-insensitive text matching', () => {
    const q = parseTagQuery('REDIS')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'redis notes', tags: [] }), q)).toBe(true)
  })

  it('preserves Chinese tags', () => {
    const q = parseTagQuery('#人工智能')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['人工智能'] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['机器学习'] }), q)).toBe(false)
  })

  it('survives tags containing slashes', () => {
    const q = parseTagQuery('#a/b')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['a/b'] }), q)).toBe(true)
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: ['a'] }), q)).toBe(false)
  })

  it('treats `undefined` tags as empty without crashing', () => {
    const q = parseTagQuery('#java')
    const docWithUndefinedTags = { path: 'a.md', title: 'A', tags: undefined } as unknown as SearchableDoc
    expect(matchesTagQuery(docWithUndefinedTags, q)).toBe(false)
  })

  it('treats `null` entries in tags as missing', () => {
    const q = parseTagQuery('#java')
    const docWithNullEntries = { path: 'a.md', title: 'A', tags: [null, 'java', undefined] } as unknown as SearchableDoc
    expect(matchesTagQuery(docWithNullEntries, q)).toBe(true)
  })

  // P1.3 fix: text tokens MUST NOT search the summary. A mixed
  // query like `#java redis cache` keeps the legacy "every text
  // token must match in path or title (AND)" semantic, with the
  // body summary deliberately excluded. Otherwise a `#tag` token
  // would silently widen the search scope.
  it('text tokens do NOT search the body summary (P1.3)', () => {
    const q = parseTagQuery('#java redis cache')
    const docOnlyInSummary = doc({
      path: 'a.md',
      title: 'untitled',
      tags: ['java'],
      summary: 'a deep dive into redis and cache internals',
    })
    // `redis` and `cache` exist only in the summary; without the
    // P1.3 fix the old shared-model branch would match. The
    // matcher must NOT — text tokens only look at path/title.
    expect(matchesTagQuery(docOnlyInSummary, q)).toBe(false)
  })

  it('multi-text-token AND semantics survive a `#tag` prefix', () => {
    // `redis cache` typed alone: both tokens must appear (anywhere
    // in path/title).
    const q1 = parseTagQuery('redis cache')
    expect(
      matchesTagQuery(
        doc({ path: 'redis.md', title: 'Cache notes', tags: [] }),
        q1,
      ),
    ).toBe(true)
    expect(
      matchesTagQuery(
        doc({ path: 'cache.md', title: 'Redis notes', tags: [] }),
        q1,
      ),
    ).toBe(true)
    // `#java redis cache`: still AND across the text tokens, AND
    // the tag must be present. A doc with both tags and one text
    // token in path, the other in title, must match.
    const q2 = parseTagQuery('#java redis cache')
    expect(
      matchesTagQuery(
        doc({ path: 'redis.md', title: 'Cache notes', tags: ['java'] }),
        q2,
      ),
    ).toBe(true)
  })

  it('a bare `#` is treated as no tag at all (no AND-must-have-tag crash)', () => {
    // `parseTagQuery('#')` produces no includeAll entries and no
    // text tokens; the matcher should match everything.
    const q = parseTagQuery('#')
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: [] }), q)).toBe(true)
  })
})

// -------- buildTagIndex --------

describe('buildTagIndex', () => {
  it('builds a tag record per distinct tag', () => {
    const idx = buildTagIndex([
      { path: 'a.md', tags: ['java', 'spring'] },
      { path: 'b.md', tags: ['java', 'redis'] },
      { path: 'c.md', tags: ['redis'] },
    ])
    expect(idx.tags.size).toBe(3)
    expect(idx.tags.get('java')?.count).toBe(2)
    expect(idx.tags.get('spring')?.count).toBe(1)
    expect(idx.tags.get('redis')?.count).toBe(2)
    expectTagIndexConsistent(idx)
  })

  it('preserves the first-seen display form', () => {
    const idx = buildTagIndex([
      { path: 'a.md', tags: ['Java'] },
      { path: 'b.md', tags: ['java'] },
      { path: 'c.md', tags: ['JAVA'] },
    ])
    expect(idx.tags.size).toBe(1)
    expect(idx.tags.get('java')?.displayName).toBe('Java')
    expect(idx.tags.get('java')?.count).toBe(3)
  })

  it('strips a leading `#` from the display form but preserves the casing (P2)', () => {
    // A metadata field stored as the literal `#java` should
    // render as `#java`, NOT `##java`.
    const idx = buildTagIndex([{ path: 'a.md', tags: ['#java'] }])
    expect(idx.tags.get('java')?.displayName).toBe('java')
    expectTagIndexConsistent(idx)
  })

  it('strips `#` and inner whitespace together in the display form (P2)', () => {
    const idx = buildTagIndex([{ path: 'a.md', tags: ['# java'] }])
    expect(idx.tags.get('java')?.displayName).toBe('java')
  })

  it('records documentTags per path', () => {
    const idx = buildTagIndex([
      { path: 'a.md', tags: ['java', 'spring'] },
      { path: 'b.md', tags: ['java'] },
    ])
    expect(idx.documentTags.get('a.md')).toEqual(new Set(['java', 'spring']))
    expect(idx.documentTags.get('b.md')).toEqual(new Set(['java']))
  })

  it('records tagDocuments as reverse lookup', () => {
    const idx = buildTagIndex([
      { path: 'a.md', tags: ['java'] },
      { path: 'b.md', tags: ['java'] },
      { path: 'c.md', tags: ['redis'] },
    ])
    expect(idx.tagDocuments.get('java')).toEqual(new Set(['a.md', 'b.md']))
    expect(idx.tagDocuments.get('redis')).toEqual(new Set(['c.md']))
  })

  it('treats undefined tags as empty', () => {
    const idx = buildTagIndex([
      { path: 'a.md', tags: undefined },
      { path: 'b.md', tags: ['java'] },
    ] as unknown as Array<{ path: string; tags?: string[] | undefined }>)
    expect(idx.documentTags.get('a.md')?.size ?? 0).toBe(0)
    expect(idx.tags.size).toBe(1)
    expectTagIndexConsistent(idx)
  })

  it('dedupes repeated tags within one document', () => {
    const idx = buildTagIndex([{ path: 'a.md', tags: ['java', 'java', 'JAVA'] }])
    expect(idx.tags.size).toBe(1)
    expect(idx.tags.get('java')?.count).toBe(1)
    expectTagIndexConsistent(idx)
  })

  it('handles an empty posts list', () => {
    const idx = buildTagIndex([])
    expect(idx.tags.size).toBe(0)
    expect(idx.documentTags.size).toBe(0)
    expect(idx.tagDocuments.size).toBe(0)
    expectTagIndexConsistent(idx)
  })

  it('handles a single tag as both the first-seen display name and the document set', () => {
    const idx = buildTagIndex([{ path: 'a.md', tags: ['人工智能'] }])
    expect(idx.tags.get('人工智能')?.displayName).toBe('人工智能')
    expect(idx.tags.get('人工智能')?.count).toBe(1)
    expectTagIndexConsistent(idx)
  })
})

// -------- updateDocumentTags --------

describe('updateDocumentTags', () => {
  const base = buildTagIndex([
    { path: 'a.md', tags: ['java', 'spring'] },
    { path: 'b.md', tags: ['java'] },
  ])

  it('does not mutate the input index', () => {
    const out = updateDocumentTags(base, 'a.md', ['java', 'redis'])
    expect(out.index).not.toBe(base)
    expect(base.documentTags.get('a.md')).toEqual(new Set(['java', 'spring']))
    expectTagIndexConsistent(base)
  })

  it('adds new tags to the index and updates reverse lookups', () => {
    const out = updateDocumentTags(base, 'a.md', ['java', 'spring', 'redis'])
    expect(out.index.tags.has('redis')).toBe(true)
    expect(out.index.tagDocuments.get('redis')).toEqual(new Set(['a.md']))
    expect(out.delta).toEqual({ added: ['redis'], removed: [] })
    expectTagIndexConsistent(out.index)
  })

  it('removes tags from the index when a doc no longer carries them', () => {
    const out = updateDocumentTags(base, 'a.md', ['java'])
    expect(out.index.tags.has('spring')).toBe(false)
    expect(out.index.tagDocuments.has('spring')).toBe(false)
    expect(out.delta).toEqual({ added: [], removed: ['spring'] })
    expectTagIndexConsistent(out.index)
  })

  it('decrements counts when a tag is removed but other docs still have it', () => {
    const seeded = buildTagIndex([
      { path: 'a.md', tags: ['java'] },
      { path: 'b.md', tags: ['java'] },
    ])
    const out = updateDocumentTags(seeded, 'a.md', [])
    expect(out.index.tags.get('java')?.count).toBe(1)
    expect(out.index.tagDocuments.get('java')).toEqual(new Set(['b.md']))
    expectTagIndexConsistent(out.index)
  })

  it('handles a no-op update by returning the SAME index reference (no churn)', () => {
    // Same set in and out — the caller is using the function as a
    // confirmation step. We must not allocate a new index or
    // re-emit a delta; identity comparison matters for downstream
    // computed/effect consumers.
    const out = updateDocumentTags(base, 'a.md', ['java', 'spring'])
    expect(out.index).toBe(base)
    expect(out.delta).toEqual({ added: [], removed: [] })
  })

  it('handles an unknown document path by adding a fresh entry', () => {
    const out = updateDocumentTags(base, 'new.md', ['redis'])
    expect(out.index.documentTags.get('new.md')).toEqual(new Set(['redis']))
    expect(out.index.tags.has('redis')).toBe(true)
    expect(out.index.tagDocuments.get('redis')).toEqual(new Set(['new.md']))
    expect(out.delta).toEqual({ added: ['redis'], removed: [] })
    expectTagIndexConsistent(out.index)
  })

  // P1.1 fix: null / undefined `newTags` means "caller has no
  // info" — the function must NOT zero out the document's entry in
  // `documentTags`, because the previous behavior left
  // `documentTags[path] = []` while `tagDocuments` still pointed
  // back at the path, breaking the three-way invariant.
  it('does not corrupt the index when newTags is null (P1.1)', () => {
    const seeded = buildTagIndex([{ path: 'a.md', tags: ['java'] }])
    const out = updateDocumentTags(seeded, 'a.md', null)
    expect(out.index).toBe(seeded)
    expect(out.delta).toEqual({ added: [], removed: [] })
    // Crucially: documentTags must still reflect `a.md` having java.
    expect(out.index.documentTags.get('a.md')).toEqual(new Set(['java']))
    expect(out.index.tagDocuments.get('java')).toEqual(new Set(['a.md']))
    expectTagIndexConsistent(out.index)
  })

  it('does not corrupt the index when newTags is undefined (P1.1)', () => {
    const seeded = buildTagIndex([{ path: 'a.md', tags: ['java', 'spring'] }])
    const out = updateDocumentTags(seeded, 'a.md', undefined)
    expect(out.index).toBe(seeded)
    expect(out.delta).toEqual({ added: [], removed: [] })
    expect(out.index.documentTags.get('a.md')).toEqual(new Set(['java', 'spring']))
    expectTagIndexConsistent(out.index)
  })

  it('treats null entries inside the newTags array as missing (no crash, no add)', () => {
    const out = updateDocumentTags(base, 'a.md', ['java', null, 'spring', undefined])
    // The null/undefined entries normalize to nothing — no new tag
    // appears in the diff.
    expect(out.delta).toEqual({ added: [], removed: [] })
    expect(out.index.documentTags.get('a.md')).toEqual(new Set(['java', 'spring']))
    expectTagIndexConsistent(out.index)
  })

  it('clears a document when caller passes newTags = []', () => {
    const seeded = buildTagIndex([{ path: 'a.md', tags: ['java'] }])
    const out = updateDocumentTags(seeded, 'a.md', [])
    expect(out.index.documentTags.get('a.md')).toEqual(new Set([]))
    expect(out.index.tags.has('java')).toBe(false)
    expect(out.delta).toEqual({ added: [], removed: ['java'] })
    expectTagIndexConsistent(out.index)
  })

  it('uses the FIRST new raw tag as the display name when introducing a new tag (P2)', () => {
    const seeded = buildTagIndex([])
    const out = updateDocumentTags(seeded, 'a.md', ['#Spring', '#SPRING', '#spring'])
    expect(out.index.tags.get('spring')?.displayName).toBe('Spring')
  })

  // P1.1 + P1.2 round-trip: the function should be usable to model
  // a "rename #Java → #java" operation without ever observing a
  // broken intermediate state.
  it('survives a rename round-trip without breaking the invariant (P1.1)', () => {
    const seeded = buildTagIndex([
      { path: 'a.md', tags: ['Java'] },
      { path: 'b.md', tags: ['Java'] },
    ])
    // Rename Java → java: same normalized key, so this is a
    // no-op as far as the index is concerned. Caller passes the
    // same canonical set.
    const out = updateDocumentTags(seeded, 'a.md', ['java'])
    expect(out.index).toBe(seeded)
    expect(out.delta).toEqual({ added: [], removed: [] })
    expectTagIndexConsistent(out.index)
  })
})

// -------- sortTagsByCountDescThenName --------

describe('sortTagsByCountDescThenName', () => {
  it('sorts by count desc, then display name asc (using displayName, not normalizedName)', () => {
    const sorted = sortTagsByCountDescThenName([
      { normalizedName: 'b', displayName: 'b', count: 3 },
      { normalizedName: 'a', displayName: 'a', count: 5 },
      { normalizedName: 'c', displayName: 'c', count: 3 },
      { normalizedName: 'a2', displayName: 'A2', count: 3 },
    ])
    expect(sorted.map((r) => r.displayName)).toEqual(['a', 'A2', 'b', 'c'])
    // normalizedName keys are lowercase: A2 normalizes to a2, but
    // the sort uses the original display form for the tiebreak.
    expect(sorted.map((r) => r.normalizedName)).toEqual(['a', 'a2', 'b', 'c'])
  })

  it('is stable: equal counts fall back to name localeCompare', () => {
    const sorted = sortTagsByCountDescThenName([
      { normalizedName: 'zebra', displayName: 'zebra', count: 1 },
      { normalizedName: 'apple', displayName: 'apple', count: 1 },
      { normalizedName: 'mango', displayName: 'mango', count: 1 },
    ])
    expect(sorted.map((r) => r.displayName)).toEqual(['apple', 'mango', 'zebra'])
  })

  it('does not mutate the input array', () => {
    const input = [
      { normalizedName: 'b', displayName: 'b', count: 1 },
      { normalizedName: 'a', displayName: 'a', count: 1 },
    ]
    const sorted = sortTagsByCountDescThenName(input)
    expect(input[0]?.normalizedName).toBe('b')
    expect(sorted[0]?.normalizedName).toBe('a')
  })
})

// -------- Re-exposing invariants for downstream callers --------
//
// `TagQuery` is constructed by `parseTagQuery` in production code,
// but third-party callers (Phase 2 batch ops, AI providers, future
// saved-views persistence) might assemble one by hand. Make sure
// the contract is what we documented.
describe('TagQuery contract', () => {
  it('an empty query built by hand still matches everything', () => {
    const empty: TagQuery = { text: '', textTokens: [], includeAll: [], includeAny: [], exclude: [] }
    expect(matchesTagQuery(doc({ path: 'a.md', title: 'A', tags: [] }), empty)).toBe(true)
  })

  it('textTokens and text are consistent: same set, same order, lowercased', () => {
    // The matcher relies on textTokens being the lowercased,
    // AND-tokenized projection of text. If a hand-built query
    // violates that, matchesTagQuery's contract is undefined.
    const q = parseTagQuery('Redis CACHE')
    expect(q.textTokens).toEqual(q.text.toLocaleLowerCase().split(/\s+/).filter(Boolean))
  })
})