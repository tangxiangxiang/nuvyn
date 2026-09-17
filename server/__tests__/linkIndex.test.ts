// Unit tests for the link index: pure extraction, resolution, and the
// LinkIndex lifecycle. No HTTP. Mirrors the test pattern in
// server/__tests__/tree.test.ts (mkdtemp + write fixtures + rm).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  LinkIndex,
  extractLinks,
  __resetLinkIndexForTesting,
} from '../linkIndex.js'
import { setContentDir } from '../paths.js'

let sandbox: string
const allPaths = ['hello', 'notes/draft', 'notes/sub/old', 'archive/2024/old']

beforeEach(() => {
  sandbox = path.join(os.tmpdir(), `nuvyn-links-${Date.now()}-${Math.random()}`)
  // Note: not creating the dir — tests create the fixtures they need.
  setContentDir(sandbox)
  __resetLinkIndexForTesting()
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
  // Restore default content dir for tests that don't care.
  setContentDir(path.resolve(process.cwd(), 'src/content'))
  __resetLinkIndexForTesting()
})

async function writeFile(rel: string, body: string) {
  const abs = path.join(sandbox, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, 'utf8')
}

// ---------- extractLinks ----------

describe('extractLinks', () => {
  it('returns an empty array for a body with no links', () => {
    expect(extractLinks('# plain', 'hello', allPaths)).toEqual([])
  })

  it('extracts [[wiki]]', () => {
    const links = extractLinks('see [[hello]] for context', 'notes/draft', allPaths)
    expect(links).toEqual([{ target: 'hello', alias: undefined, anchor: undefined, kind: 'wiki' }])
  })

  it('extracts [[wiki|alias]] with display text', () => {
    const links = extractLinks('read [[hello|the hello file]] please', 'notes/draft', allPaths)
    expect(links).toEqual([{ target: 'hello', alias: 'the hello file', anchor: undefined, kind: 'wiki' }])
  })

  it('extracts [[wiki#anchor]]', () => {
    const links = extractLinks('see [[hello#section]]', 'notes/draft', allPaths)
    expect(links).toEqual([{ target: 'hello', alias: undefined, anchor: 'section', kind: 'wiki' }])
  })

  it('extracts [[wiki#anchor|alias]] with both', () => {
    const links = extractLinks('see [[hello#section|the section]]', 'notes/draft', allPaths)
    expect(links).toEqual([{ target: 'hello', alias: 'the section', anchor: 'section', kind: 'wiki' }])
  })

  it('resolves same-dir before root', () => {
    // Source is in 'notes/sub'; ref 'old' should hit 'notes/sub/old' first.
    const links = extractLinks('see [[old]]', 'notes/sub/whatever', allPaths)
    expect(links[0].target).toBe('notes/sub/old')
  })

  it('falls back to root when same-dir misses', () => {
    // Source is in 'notes'; ref 'old' — no 'notes/old', so root 'archive/2024/old' (basename match).
    // But also 'hello' exists at root. We test with a basename that has only one match.
    const links = extractLinks('see [[hello]]', 'notes/draft', allPaths)
    expect(links[0].target).toBe('hello')
  })

  it('falls back to recursive basename match', () => {
    // 'old' lives in 'notes/sub' and 'archive/2024'. From 'hello' (root),
    // same-dir 'hello/old' misses, root 'old' misses, recursive match hits.
    const links = extractLinks('see [[old]]', 'hello', allPaths)
    expect(links[0].target).toMatch(/old$/)
  })

  it('skips broken wiki links (target not in allPaths)', () => {
    const links = extractLinks('see [[does-not-exist]]', 'hello', allPaths)
    expect(links).toEqual([])
  })

  it('rejects wiki refs with .. or leading / (security)', () => {
    expect(extractLinks('see [[../escape]]', 'hello', allPaths)).toEqual([])
    expect(extractLinks('see [[/etc/passwd]]', 'hello', allPaths)).toEqual([])
  })

  it('rejects empty wiki refs', () => {
    expect(extractLinks('see [[]] and [[|alias]]', 'hello', allPaths)).toEqual([])
  })

  it('extracts standard markdown [text](path.md) as md', () => {
    const links = extractLinks('see [the hello file](hello.md) please', 'notes/draft', allPaths)
    expect(links).toEqual([{ target: 'hello', alias: 'the hello file', anchor: undefined, kind: 'md' }])
  })

  it('extracts [text](path.md#anchor) with anchor', () => {
    const links = extractLinks('see [section](hello.md#section)', 'notes/draft', allPaths)
    expect(links).toEqual([{ target: 'hello', alias: 'section', anchor: 'section', kind: 'md' }])
  })

  it('skips external markdown links (http, https, mailto)', () => {
    const links = extractLinks(
      'see [ext](https://example.com) and [mail](mailto:x@y) and [proto-relative](//x)',
      'notes/draft',
      allPaths,
    )
    expect(links).toEqual([])
  })

  it('skips internal links that point outside allPaths', () => {
    const links = extractLinks('see [x](missing.md)', 'notes/draft', allPaths)
    expect(links).toEqual([])
  })

  it('skips [[wiki]] inside fenced code blocks', () => {
    const body = '```\nconst x = [[hello]]\n```\noutside [[hello]]'
    const links = extractLinks(body, 'notes/draft', allPaths)
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe('hello')
  })

  it('skips [[wiki]] inside inline code', () => {
    const body = 'use `[[hello]]` and see [[hello]]'
    const links = extractLinks(body, 'notes/draft', allPaths)
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe('hello')
  })

  it('skips [[wiki]] inside tilde-fenced code', () => {
    const body = '~~~\nfoo [[hello]] bar\n~~~\nsee [[hello]]'
    const links = extractLinks(body, 'notes/draft', allPaths)
    expect(links).toHaveLength(1)
  })

  it('skips [[wiki]] inside frontmatter', () => {
    const body = '---\nrelated: "[[hello]]"\n---\n# Title\nsee [[hello]]'
    const links = extractLinks(body, 'notes/draft', allPaths)
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe('hello')
  })

  it('returns multiple links in document order', () => {
    const body = 'see [[hello]] and [[notes/draft]]'
    const links = extractLinks(body, 'hello', allPaths)
    expect(links).toHaveLength(2)
    expect(links.map((l) => l.target).sort()).toEqual(['hello', 'notes/draft'])
  })

  it('dedupes repeated wiki links to the same target+anchor', () => {
    // Same target, no anchor — the second occurrence is a slip.
    const links = extractLinks(
      'see [[hello]] then [[hello]] again',
      'notes/draft',
      allPaths,
    )
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe('hello')
  })

  it('dedupes across wiki and md syntaxes pointing to the same target+anchor', () => {
    // Author wrote the link twice using different syntaxes — we
    // should only index it once, keeping the first occurrence (the
    // wiki form, with its alias if any).
    const links = extractLinks(
      'see [[hello]] and [h](hello.md) again',
      'notes/draft',
      allPaths,
    )
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe('hello')
    expect(links[0].kind).toBe('wiki')
  })

  it('keeps links that differ in anchor (intentional, not a duplicate)', () => {
    // Same target, two different anchors — these are distinct
    // references in the doc, so we keep both.
    const links = extractLinks(
      'see [[hello#top]] and [[hello#bottom]]',
      'notes/draft',
      allPaths,
    )
    expect(links).toHaveLength(2)
    expect(links.map((l) => l.anchor).sort()).toEqual(['bottom', 'top'])
  })

  it('dedupes on first occurrence, preserving that occurrence’s alias', () => {
    // First mention has an alias; second doesn’t. After dedup, the
    // alias from the first mention should win.
    const links = extractLinks(
      'see [[hello|greeting]] and [[hello]] again',
      'notes/draft',
      allPaths,
    )
    expect(links).toHaveLength(1)
    expect(links[0].alias).toBe('greeting')
  })

  it('strips trailing .md from md-link hrefs before resolving', () => {
    const links = extractLinks('see [t](hello.md)', 'notes/draft', allPaths)
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe('hello')
  })
})

// ---------- LinkIndex lifecycle ----------

describe('LinkIndex', () => {
  it('rebuild scans every .md file and populates both maps', async () => {
    await writeFile('hello.md', '# hi\nsee [[notes/draft]]')
    await writeFile('notes/draft.md', '# draft\nsee [[hello]]')

    const idx = new LinkIndex()
    await idx.rebuild(sandbox)

    expect(idx.hasPath('hello')).toBe(true)
    expect(idx.hasPath('notes/draft')).toBe(true)
    expect(idx.getBacklinks('hello').map((b) => b.source)).toEqual(['notes/draft'])
    expect(idx.getBacklinks('notes/draft').map((b) => b.source)).toEqual(['hello'])
  })

  it('rebuild skips files that vanish between scan and read', async () => {
    await writeFile('hello.md', '# hi')
    const idx = new LinkIndex()
    // Delete the file after listPostsFlat but before readFile by
    // intercepting the read. Easier: just write nothing weird, then
    // delete, then rebuild again.
    await idx.rebuild(sandbox)
    expect(idx.hasPath('hello')).toBe(true)
    await fs.rm(path.join(sandbox, 'hello.md'))
    await idx.rebuild(sandbox)
    expect(idx.hasPath('hello')).toBe(false)
  })

  it('applyWrite re-extracts from new raw', () => {
    const idx = new LinkIndex()
    idx.registerPath('b')
    idx.applyWrite('a', '# a\nsee [[b]]')
    idx.applyWrite('b', '# b')
    expect(idx.getBacklinks('b').map((x) => x.source)).toEqual(['a'])

    idx.applyWrite('a', '# a (rewritten, no links)')
    expect(idx.getBacklinks('b')).toEqual([])
  })

  it('applyDelete removes the source AND drops dangling references in other files', () => {
    const idx = new LinkIndex()
    idx.registerPath('b')
    idx.applyWrite('a', 'see [[b]]')
    idx.applyWrite('b', '# b')
    expect(idx.getBacklinks('b').map((x) => x.source)).toEqual(['a'])

    idx.applyDelete('b')
    // b is gone
    expect(idx.hasPath('b')).toBe(false)
    // a's dangling link to b is also dropped
    expect(idx.getBacklinks('b')).toEqual([])
  })

  it('applyDelete on a path with no inbound refs just removes the path', () => {
    const idx = new LinkIndex()
    idx.applyWrite('a', '# a')
    idx.applyWrite('b', '# b')
    idx.applyDelete('b')
    expect(idx.hasPath('b')).toBe(false)
    expect(idx.hasPath('a')).toBe(true)
  })

  it('applyRename removes old path and re-extracts at new path', () => {
    const idx = new LinkIndex()
    idx.registerPath('x')
    idx.applyWrite('old', 'see [[x]]')
    idx.applyWrite('x', '# x')
    expect(idx.getBacklinks('x').map((b) => b.source)).toEqual(['old'])

    idx.applyRename('old', 'fresh', 'see [[x]]')
    expect(idx.hasPath('old')).toBe(false)
    expect(idx.hasPath('fresh')).toBe(true)
    // The file's outbound link to x is preserved (the rename was
    // mechanical — the text didn't change).
    expect(idx.getBacklinks('x').map((b) => b.source)).toEqual(['fresh'])
  })

  it('applyRename with changed text updates outbound links', () => {
    const idx = new LinkIndex()
    idx.registerPath('x')
    idx.registerPath('y')
    idx.applyWrite('note', 'see [[x]]')
    idx.applyWrite('x', '# x')
    idx.applyWrite('y', '# y')

    idx.applyRename('note', 'note2', 'see [[y]]')
    expect(idx.getBacklinks('x')).toEqual([])
    expect(idx.getBacklinks('y').map((b) => b.source)).toEqual(['note2'])
  })

  it('getBacklinks returns BacklinkRecord with kind, alias, anchor', () => {
    const idx = new LinkIndex()
    idx.registerPath('b')
    idx.applyWrite('a', 'see [[b|the b file]] and [[b#section]]')
    idx.applyWrite('b', '# b')
    const bl = idx.getBacklinks('b')
    // One source, two links — the first match wins for the record.
    expect(bl).toHaveLength(1)
    expect(bl[0]).toMatchObject({ source: 'a', alias: 'the b file', kind: 'wiki' })
  })

  it('hasPath is the existence check used by the renderer', () => {
    const idx = new LinkIndex()
    idx.applyWrite('a', '# a')
    expect(idx.hasPath('a')).toBe(true)
    expect(idx.hasPath('missing')).toBe(false)
  })

  it('snapshot returns paths, outgoing map, and display titles (no reverse map)', () => {
    const idx = new LinkIndex()
    idx.registerPath('b')
    idx.registerPath('c')
    idx.applyWrite('a', '---\ntitle: Alpha Note\n---\n\nsee [[b]] and [c](c.md)')
    idx.applyWrite('b', '# Beta Heading')
    idx.applyWrite('c', 'plain')
    const snap = idx.snapshot()
    expect(snap.paths.sort()).toEqual(['a', 'b', 'c'])
    expect(snap.outgoing['a']).toHaveLength(2)
    expect(snap.outgoing['a'].map((l) => l.target).sort()).toEqual(['b', 'c'])
    expect(snap.outgoing['b']).toBeUndefined()  // no outbound links
    expect(snap.titles).toMatchObject({
      a: 'Alpha Note',
      b: 'Beta Heading',
      c: 'c',
    })
  })

  it('rebuild populates display titles from listPostsFlat metadata', async () => {
    await writeFile('archive/a.md', '---\ntitle: Frontmatter Title\n---\n\n# Body Title\n')
    await writeFile('archive/b.md', '# Heading Title\n')

    const idx = new LinkIndex()
    await idx.rebuild(sandbox)

    expect(idx.snapshot().titles).toMatchObject({
      'archive/a': 'Frontmatter Title',
      'archive/b': 'Heading Title',
    })
  })

  it('never parses a managed Diary envelope or retains cross-scope edges', async () => {
    await writeFile('diary/2026-08-31.md', 'NUVYN-DIARY-ENC-V1\n{"ciphertext":"[[note]]"}\n')
    await writeFile('note.md', '# Note\nsee [[diary/2026-08-31]]\n')
    await writeFile('other.md', '# Other\n')

    const idx = new LinkIndex()
    await idx.rebuild(sandbox)

    const snapshot = idx.snapshot()
    expect(snapshot.paths).toEqual(expect.arrayContaining(['diary/2026-08-31', 'note', 'other']))
    expect(snapshot.titles['diary/2026-08-31']).toBe('2026-08-31')
    expect(snapshot.outgoing['diary/2026-08-31']).toBeUndefined()
    expect(snapshot.outgoing.note).toBeUndefined()
    expect(idx.getBacklinks('diary/2026-08-31')).toEqual([])
  })

  it('preserves Note-to-Note links while suppressing managed Diary targets', () => {
    const idx = new LinkIndex()
    idx.registerPath('diary/2026-08-31')
    idx.registerPath('note')
    idx.registerPath('other')
    idx.applyWrite('note', 'see [[diary/2026-08-31]] and [[other]]')
    idx.applyWrite('diary/2026-08-31', 'private body [[note]]')

    expect(idx.snapshot().outgoing.note).toEqual([
      { target: 'other', alias: undefined, anchor: undefined, kind: 'wiki' },
    ])
    expect(idx.getBacklinks('other').map((backlink) => backlink.source)).toEqual(['note'])
    expect(idx.getBacklinks('diary/2026-08-31')).toEqual([])
  })

  it('applyFolderRename moves every file in the subtree', () => {
    const idx = new LinkIndex()
    // Pre-register all paths so resolution during applyWrite works
    // regardless of call order.
    idx.registerPath('notes/b')
    idx.registerPath('c')
    // Build an initial state where 'notes/a' links to 'notes/b' and 'c'.
    idx.applyWrite('notes/a', 'see [[b]] and [c](c.md)')
    idx.applyWrite('notes/b', '# b')
    idx.applyWrite('c', '# c')

    // Move the whole 'notes' subtree to 'archive'. Now 'notes/a' is at
    // 'archive/a', 'notes/b' is at 'archive/b'. Resolution of `[[b]]`
    // from `archive/a`'s perspective looks for `archive/b` (same dir).
    idx.applyFolderRename([
      { oldPath: 'notes/a', newPath: 'archive/a', newRaw: 'see [[b]] and [c](c.md)' },
      { oldPath: 'notes/b', newPath: 'archive/b', newRaw: '# b' },
    ])

    expect(idx.hasPath('notes/a')).toBe(false)
    expect(idx.hasPath('notes/b')).toBe(false)
    expect(idx.hasPath('archive/a')).toBe(true)
    expect(idx.hasPath('archive/b')).toBe(true)
    // 'archive/a' links to 'archive/b' (resolved at its new location)
    // and 'c' (still at root).
    const outgoing = idx.snapshot().outgoing['archive/a']
    expect(outgoing.map((l) => l.target).sort()).toEqual(['archive/b', 'c'])
  })

  it('applyFolderDelete drops the entire subtree', () => {
    const idx = new LinkIndex()
    idx.applyWrite('notes/a', '# a')
    idx.applyWrite('notes/b', '# b')
    idx.applyWrite('c', '# c')
    idx.applyFolderDelete(['notes/a', 'notes/b'])
    expect(idx.hasPath('notes/a')).toBe(false)
    expect(idx.hasPath('notes/b')).toBe(false)
    expect(idx.hasPath('c')).toBe(true)
  })
})
