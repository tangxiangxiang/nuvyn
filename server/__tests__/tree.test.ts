import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listPostsFlat, buildTree, listSubtreePaths } from '../tree.js'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db.js'
import { saveDocumentMetadata } from '../documentMetadata.js'

let sandbox: string

async function makeFixture() {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-'))
  await fs.writeFile(path.join(sandbox, 'hello.md'), '# hi')
  await fs.mkdir(path.join(sandbox, 'notes'))
  await fs.writeFile(path.join(sandbox, 'notes', 'draft.md'), '# draft')
  await fs.mkdir(path.join(sandbox, 'notes', 'archive'))
  await fs.writeFile(path.join(sandbox, 'notes', 'archive', 'old.md'), '# old')
}

beforeEach(makeFixture)
afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe('listPostsFlat', () => {
  it('prefers database metadata while retaining file statistics', async () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    saveDocumentMetadata(db, {
      path: 'hello', title: 'Database title', summary: 'Database summary', tags: ['database'],
      createdAt: Date.UTC(2025, 0, 2), updatedAt: Date.UTC(2026, 1, 3),
    })
    const posts = await listPostsFlat(sandbox, db)
    const hello = posts.find((post) => post.path === 'hello')!
    expect(hello).toMatchObject({
      title: 'Database title', summary: 'Database summary', tags: ['database'],
      created: '2025-01-02', updated: '2026-02-03',
    })
    expect(hello.size).toBeGreaterThan(0)
    db.close()
  })

  it('returns all .md files as PostSummary-shaped objects', async () => {
    const posts = await listPostsFlat(sandbox)
    const paths = posts.map((p) => p.path).sort()
    expect(paths).toEqual([
      'hello',
      'notes/archive/old',
      'notes/draft',
    ])
  })

  it('reads `created` from frontmatter and falls back to mtime for `updated`', async () => {
    // File has no `updated` in frontmatter — covers the migration case
    // for notes that were never saved through the API.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-dates-'))
    const file = path.join(dir, 'stub.md')
    await fs.writeFile(
      file,
      '---\ntitle: Dated\ncreated: 2026-01-15\n---\n\nBody\n',
    )
    // Pin mtime so the formatted `updated` is deterministic
    const mtimeMs = Date.UTC(2026, 2, 20, 12, 0, 0)
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000)

    const posts = await listPostsFlat(dir)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.created).toBe('2026-01-15')
    expect(posts[0]!.updated).toBe('2026-03-20')
    expect(posts[0]!.mtime).toBe(mtimeMs)

    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads `updated` from frontmatter when present, ignoring mtime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-fm-updated-'))
    const file = path.join(dir, 'stub.md')
    await fs.writeFile(
      file,
      '---\ntitle: Dated\ncreated: 2026-01-15\nupdated: 2026-02-10\n---\n\nBody\n',
    )
    // mtime set to something completely different from `updated` —
    // the frontmatter value should win.
    const mtimeMs = Date.UTC(2030, 0, 1, 0, 0, 0)
    await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000)

    const posts = await listPostsFlat(dir)
    expect(posts[0]!.created).toBe('2026-01-15')
    expect(posts[0]!.updated).toBe('2026-02-10')
    expect(posts[0]!.mtime).toBe(mtimeMs)

    await fs.rm(dir, { recursive: true, force: true })
  })

  it('falls back to legacy `date` field for back-compat', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-legacy-'))
    await fs.writeFile(
      path.join(dir, 'old.md'),
      '---\ntitle: Old\ndate: 2025-12-01\n---\n\nBody\n',
    )
    const posts = await listPostsFlat(dir)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.created).toBe('2025-12-01')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads `summary` from frontmatter and defaults to "" when missing', async () => {
    // Two files in one dir so we can also verify the per-file shape
    // (one populated, one absent) without coupling to a single fixture.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-summary-'))
    await fs.writeFile(
      path.join(dir, 'a.md'),
      '---\ntitle: A\nsummary: Two-line summary here.\n---\n\nbody\n',
    )
    await fs.writeFile(
      path.join(dir, 'b.md'),
      '---\ntitle: B\n---\n\nbody\n',
    )
    const posts = await listPostsFlat(dir)
    const byPath = Object.fromEntries(posts.map((p) => [p.path, p]))
    expect(byPath['a']!.summary).toBe('Two-line summary here.')
    expect(byPath['b']!.summary).toBe('')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('trims surrounding whitespace from `summary`', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-summary-trim-'))
    await fs.writeFile(
      path.join(dir, 'stub.md'),
      '---\ntitle: T\nsummary:   spacy   \n---\n\nbody\n',
    )
    const posts = await listPostsFlat(dir)
    expect(posts[0]!.summary).toBe('spacy')
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('buildTree', () => {
  it('nests everything under a content root folder with empty path', async () => {
    const tree = await buildTree(sandbox)
    expect(tree).toEqual([
      {
        kind: 'folder',
        name: 'content',
        path: '',
        children: [
          {
            kind: 'folder',
            name: 'notes',
            path: 'notes',
            children: [
              {
                kind: 'folder',
                name: 'archive',
                path: 'notes/archive',
                children: [
                  { kind: 'file', name: 'old', path: 'notes/archive/old', title: 'old', mtime: expect.any(Number) },
                ],
              },
              { kind: 'file', name: 'draft', path: 'notes/draft', title: 'draft', mtime: expect.any(Number) },
            ],
          },
          { kind: 'file', name: 'hello', path: 'hello', title: 'hi', mtime: expect.any(Number) },
        ],
      },
    ])
  })

  it('returns a content folder with empty children for an empty directory', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-empty-'))
    const tree = await buildTree(empty)
    expect(tree).toEqual([
      { kind: 'folder', name: 'content', path: '', children: [] },
    ])
    await fs.rm(empty, { recursive: true, force: true })
  })

  it('returns a content folder with empty children for a missing directory', async () => {
    const tree = await buildTree(path.join(sandbox, 'does-not-exist'))
    expect(tree).toEqual([
      { kind: 'folder', name: 'content', path: '', children: [] },
    ])
  })

  it('sorts numeric and chapter prefixes naturally', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-natural-sort-'))
    await fs.mkdir(path.join(dir, 'book'))
    await fs.writeFile(path.join(dir, 'book', 'ch10-late.md'), '# late')
    await fs.writeFile(path.join(dir, 'book', 'ch2-middle.md'), '# middle')
    await fs.writeFile(path.join(dir, 'book', 'ch1-early.md'), '# early')
    await fs.writeFile(path.join(dir, '002-second.md'), '# second')
    await fs.writeFile(path.join(dir, '001-first.md'), '# first')

    const tree = await buildTree(dir)
    const root = tree[0]!
    expect(root.kind).toBe('folder')
    if (root.kind !== 'folder') return
    expect(root.children.map((n) => n.name)).toEqual(['book', '001-first', '002-second'])
    const book = root.children[0]!
    expect(book.kind).toBe('folder')
    if (book.kind !== 'folder') return
    expect(book.children.map((n) => n.name)).toEqual(['ch1-early', 'ch2-middle', 'ch10-late'])

    await fs.rm(dir, { recursive: true, force: true })
  })

  it('prefers frontmatter.title over the first H1 and the filename', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-fm-'))
    await fs.writeFile(
      path.join(dir, 'stub.md'),
      '---\ntitle: Display Title\n---\n\n# Body Heading\n',
    )
    const posts = await listPostsFlat(dir)
    expect(posts).toHaveLength(1)
    expect(posts[0]!.title).toBe('Display Title')

    const tree = await buildTree(dir)
    const file = tree[0]!.children[0]!
    expect(file.kind).toBe('file')
    if (file.kind === 'file') expect(file.title).toBe('Display Title')

    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('listSubtreePaths', () => {
  it('returns all descendant file paths under a folder', async () => {
    const all = await listSubtreePaths(sandbox, 'notes')
    expect(all.sort()).toEqual(['notes/archive/old', 'notes/draft'])
  })
  it('returns empty for a non-existent folder', async () => {
    const all = await listSubtreePaths(sandbox, 'missing')
    expect(all).toEqual([])
  })
})

// The vault's own .git/ and legacy .nuvyn/ are Nuvyn bookkeeping, not user content.
// They must not surface in the file tree, and the tree builders must not
// recurse through their contents.
describe('vault internal directories are excluded from tree listings', () => {
  let sandboxWithGit: string

  beforeEach(async () => {
    sandboxWithGit = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-tree-with-git-'))
    await fs.writeFile(path.join(sandboxWithGit, 'visible.md'), '# visible')
    // Minimal .git/ shape — enough to prove both the file-listing and
    // folder-listing branches of walk()'s filter.
    await fs.mkdir(path.join(sandboxWithGit, '.git'))
    await fs.writeFile(
      path.join(sandboxWithGit, '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    )
    await fs.mkdir(path.join(sandboxWithGit, '.git', 'objects'), { recursive: true })
    await fs.writeFile(
      path.join(sandboxWithGit, '.git', 'objects', 'abc123'),
      'fake-blob',
    )
    await fs.mkdir(path.join(sandboxWithGit, '.nuvyn', 'nested'), { recursive: true })
    await fs.writeFile(
      path.join(sandboxWithGit, '.nuvyn', 'nested', 'internal.md'),
      '# internal',
    )
    // .gitignore and .gitattributes that initRepo() also creates in real vaults
    await fs.writeFile(path.join(sandboxWithGit, '.gitignore'), '')
    await fs.writeFile(path.join(sandboxWithGit, '.gitattributes'), '')
  })

  afterEach(async () => {
    await fs.rm(sandboxWithGit, { recursive: true, force: true })
  })

  it('listPostsFlat ignores .git/ contents entirely', async () => {
    const posts = await listPostsFlat(sandboxWithGit)
    expect(posts.map((p) => p.path)).toEqual(['visible'])
  })

  it('buildTree does not surface a .git/ folder node', async () => {
    const tree = await buildTree(sandboxWithGit)
    // tree[0] is the implicit root folder; its children must only contain
    // visible.md, not a .git folder.
    const root = tree[0]!
    expect(root.kind).toBe('folder')
    if (root.kind !== 'folder') return
    const childNames = root.children.map((c) => c.name).sort()
    expect(childNames).toEqual(['visible'])
    expect(childNames).not.toContain('.git')
  })

  it('listSubtreePaths("") does not include .git/ descendants', async () => {
    // Walking the root should mirror what /api/tree would render for
    // a brand-new vault with .git/ in place — no .git/ descendants leak.
    const all = await listSubtreePaths(sandboxWithGit, '')
    expect(all).toEqual(['visible'])
  })

  it('does not expose .nuvyn/ or its descendants', async () => {
    const posts = await listPostsFlat(sandboxWithGit)
    const tree = await buildTree(sandboxWithGit)
    const all = await listSubtreePaths(sandboxWithGit, '')
    const root = tree[0]!
    if (root.kind !== 'folder') return

    expect(posts.map((p) => p.path)).toEqual(['visible'])
    expect(root.children.map((child) => child.name)).toEqual(['visible'])
    expect(all).toEqual(['visible'])
  })
})
