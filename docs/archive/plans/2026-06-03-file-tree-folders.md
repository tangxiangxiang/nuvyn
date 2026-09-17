# File-Tree Folder Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real nested-folder support to the vault's `FileTree`: folders are first-class on disk, rendered as a recursive disclosure tree, drag-and-drop moves files between folders, and the URL/route/breadcrumb/tabs all carry the full `path` (which replaces the old flat `slug`).

**Architecture:** Server is the source of truth for the filesystem. Two read endpoints (`/api/tree` for the file-tree UI, `/api/posts` for everything else) plus per-resource CRUD. The `path` field is relative to `src/content/`, always begins with `posts/`. The FileTree becomes a recursive `TreeRow` component. Drag-and-drop is native HTML5 with the folder row as the drop target. Path validation lives in a dedicated `server/paths.ts` module so it is unit-testable in isolation.

**Tech Stack:** Vue 3 `<script setup>`, vue-router `pathMatch(.*)*` splat, native HTML5 DnD, Hono backend with `fs/promises`, Vitest for new tests, single global `style.css`. No new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-06-03-file-tree-folders-design.md](../specs/2026-06-03-file-tree-folders-design.md)

---

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| [vitest.config.ts](../../../vitest.config.ts) | create | Vitest config (node env for server tests, jsdom for component tests) |
| [package.json](../../../package.json) | modify | Add vitest + jsdom devDeps; add `test` script |
| [server/paths.ts](../../../server/paths.ts) | create | `assertSafePath`, `filePathFor`, `folderPathFor`, regex constants |
| [server/tree.ts](../../../server/tree.ts) | create | `buildTree`, `listPostsFlat` — recursive filesystem walkers |
| [server/index.ts](../../../server/index.ts) | modify | New endpoints; replace `slug` with `path` throughout |
| [server/__tests__/paths.test.ts](../../../server/__tests__/paths.test.ts) | create | Unit tests for path validation |
| [server/__tests__/tree.test.ts](../../../server/__tests__/tree.test.ts) | create | Unit tests for tree + flat builders (uses real temp dirs) |
| [src/lib/api.ts](../../../src/lib/api.ts) | modify | `PostSummary.path`; new `TreeNode`; client helpers for tree + folders |
| [src/components/vault/tabs.ts](../../../src/components/vault/tabs.ts) | modify | `Tab.path` |
| [src/composables/usePrompt.ts](../../../src/composables/usePrompt.ts) | create | Module-singleton prompt dialog (mirrors `useConfirm`) |
| [src/components/PromptHost.vue](../../../src/components/PromptHost.vue) | create | Renders active prompt overlay |
| [src/components/vault/icons.ts](../../../src/components/vault/icons.ts) | create | Inline SVG strings (folder closed/open, file-md) |
| [src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue) | create | Recursive row: renders one node + its children |
| [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue) | modify | Wraps TreeRow list; holds expansion state; wires DnD; renders top-bar |
| `src/components/vault/Breadcrumb.vue` | modify | Dynamic segments from `currentPath` |
| [src/components/vault/CommandPalette.vue](../../../src/components/vault/CommandPalette.vue) | modify | Show path in result rows |
| [src/components/vault/TagPanel.vue](../../../src/components/vault/TagPanel.vue) | modify | Show path in result rows |
| [src/lib/search.ts](../../../src/lib/search.ts) | modify | Index `path` |
| [src/views/VaultView.vue](../../../src/views/VaultView.vue) | modify | Derive `currentPath` from `pathMatch`; replace `slug` with `path`; mount DnD |
| [src/router/index.ts](../../../src/router/index.ts) | modify | Splat route `:pathMatch(.*)*` |
| [src/App.vue](../../../src/App.vue) | modify | Mount `<PromptHost />` |
| [src/style.css](../../../src/style.css) | modify | New tree rules, drop-target states, indent variables |
| [src/components/vault/__tests__/FileTree.test.ts](../../../src/components/vault/__tests__/FileTree.test.ts) | create | Renders 1- and 2-level trees; chevron toggle; drag emits |

Each task is self-contained and ends with the codebase in a buildable, committable state.

---

## Task 1: Add Vitest

**Files:**
- Modify: [package.json](../../../package.json)

- [ ] **Step 1: Install Vitest + jsdom**

Run:
```bash
npm install -D vitest @vitest/ui jsdom @vue/test-utils
```

- [ ] **Step 2: Add a `test` script to package.json**

Edit [package.json](../../../package.json). In the `scripts` block, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create vitest config**

Create [vitest.config.ts](../../../vitest.config.ts):
```ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['src/**/*.test.ts', 'jsdom'],
    ],
  },
})
```

- [ ] **Step 4: Verify Vitest runs**

Create a temporary sanity test at `vitest-sanity.test.ts` (project root):
```ts
import { describe, it, expect } from 'vitest'
describe('vitest', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add package.json vitest.config.ts vitest-sanity.test.ts
git commit -m "chore: add vitest for server and component tests"
```

- [ ] **Step 6: Remove the sanity test (we have real tests coming)**

Delete `vitest-sanity.test.ts`.

```bash
git add -u vitest-sanity.test.ts
git commit -m "chore: remove vitest sanity test (real tests follow)"
```

---

## Task 2: Path validation module (`server/paths.ts`)

**Files:**
- Create: [server/paths.ts](../../../server/paths.ts)
- Create: [server/__tests__/paths.test.ts](../../../server/__tests__/paths.test.ts)

- [ ] **Step 1: Write the failing test**

Create [server/__tests__/paths.test.ts](../../../server/__tests__/paths.test.ts):
```ts
import { describe, it, expect } from 'vitest'
import { assertSafePath, filePathFor, folderPathFor, isValidPathSyntax } from '../paths.js'

describe('isValidPathSyntax', () => {
  it('accepts top-level post', () => {
    expect(isValidPathSyntax('posts/hello-world')).toBe(true)
  })
  it('accepts nested post', () => {
    expect(isValidPathSyntax('posts/notes/draft')).toBe(true)
  })
  it('accepts folder', () => {
    expect(isValidPathSyntax('posts/notes')).toBe(true)
  })
  it('rejects missing posts prefix', () => {
    expect(isValidPathSyntax('notes/draft')).toBe(false)
  })
  it('rejects empty segment', () => {
    expect(isValidPathSyntax('posts//draft')).toBe(false)
  })
  it('rejects ..', () => {
    expect(isValidPathSyntax('posts/../etc')).toBe(false)
  })
  it('rejects uppercase', () => {
    expect(isValidPathSyntax('posts/Hello')).toBe(false)
  })
  it('rejects leading slash', () => {
    expect(isValidPathSyntax('/posts/draft')).toBe(false)
  })
  it('rejects trailing slash', () => {
    expect(isValidPathSyntax('posts/notes/')).toBe(false)
  })
  it('rejects .md extension', () => {
    expect(isValidPathSyntax('posts/draft.md')).toBe(false)
  })
  it('rejects leading hyphen', () => {
    expect(isValidPathSyntax('posts/-draft')).toBe(false)
  })
  it('rejects trailing hyphen', () => {
    expect(isValidPathSyntax('posts/draft-')).toBe(false)
  })
})

describe('assertSafePath', () => {
  const cwd = process.cwd()
  it('resolves a valid path to a disk path inside content/', () => {
    expect(assertSafePath('posts/hello-world')).toBe(
      `${cwd}/src/content/posts/hello-world`,
    )
  })
  it('throws on ..', () => {
    expect(() => assertSafePath('posts/../etc')).toThrow()
  })
  it('throws on absolute injection', () => {
    // regex would already block, but the resolve check is a second line of defense
    expect(() => assertSafePath('posts/..%2Fetc')).toThrow()
  })
})

describe('filePathFor / folderPathFor', () => {
  it('filePathFor adds .md', () => {
    expect(filePathFor('posts/draft')).toMatch(/src[\\/]content[\\/]posts[\\/]draft\.md$/)
  })
  it('folderPathFor does not add .md', () => {
    expect(folderPathFor('posts/notes')).toMatch(/src[\\/]content[\\/]posts[\\/]notes$/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/__tests__/paths.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/paths.ts`**

Create [server/paths.ts](../../../server/paths.ts):
```ts
import path from 'node:path'

export const CONTENT_DIR = path.resolve(process.cwd(), 'src/content')
export const POSTS_DIR = path.join(CONTENT_DIR, 'posts')

const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const PATH_RE = /^posts\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export function isValidPathSyntax(p: string): boolean {
  return PATH_RE.test(p)
}

export function assertSafePath(p: string): string {
  if (!isValidPathSyntax(p)) {
    throw new Error(`invalid path: ${p}`)
  }
  // Defensive: even with a passing regex, make sure resolve can't escape CONTENT_DIR.
  // (e.g. symlink games — out of scope for v1 but cheap to add.)
  const resolved = path.resolve(CONTENT_DIR, p)
  if (!resolved.startsWith(CONTENT_DIR + path.sep) && resolved !== CONTENT_DIR) {
    throw new Error(`path escapes content dir: ${p}`)
  }
  return resolved
}

export function filePathFor(p: string): string {
  return path.join(assertSafePath(p)) + '.md'
}

export function folderPathFor(p: string): string {
  return path.join(assertSafePath(p))
}

export { SEGMENT_RE }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/__tests__/paths.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/paths.ts server/__tests__/paths.test.ts
git commit -m "feat(server): add path validation module (assertSafePath, filePathFor)"
```

---

## Task 3: Tree and flat-list builders (`server/tree.ts`)

**Files:**
- Create: [server/tree.ts](../../../server/tree.ts)
- Create: [server/__tests__/tree.test.ts](../../../server/__tests__/tree.test.ts)

- [ ] **Step 1: Write the failing test**

Create [server/__tests__/tree.test.ts](../../../server/__tests__/tree.test.ts):
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listPostsFlat, buildTree, listSubtreePaths } from '../tree.js'
import { POSTS_DIR } from '../paths.js'

let sandbox: string

async function makeFixture() {
  // Mirror a real posts layout under a temp dir, then point POSTS_DIR there.
  // Simpler: we just write files inside the real POSTS_DIR and clean up after.
  // For test isolation we create a sandbox dir and override via env-var in a future refactor.
  // For now we use a sibling temp dir to keep tests hermetic.
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
  it('returns all .md files as PostSummary-shaped objects', async () => {
    // Override POSTS_DIR by passing an override (see impl below)
    const posts = await listPostsFlat(sandbox)
    const paths = posts.map((p) => p.path).sort()
    expect(paths).toEqual([
      'posts/hello',
      'posts/notes/archive/old',
      'posts/notes/draft',
    ])
  })
})

describe('buildTree', () => {
  it('nests folders before files, both alphabetically', async () => {
    const tree = await buildTree(sandbox)
    expect(tree).toEqual([
      { kind: 'file', name: 'hello', path: 'posts/hello', title: 'hello', mtime: expect.any(Number) },
      {
        kind: 'folder',
        name: 'notes',
        path: 'posts/notes',
        children: [
          {
            kind: 'folder',
            name: 'archive',
            path: 'posts/notes/archive',
            children: [
              { kind: 'file', name: 'old', path: 'posts/notes/archive/old', title: 'old', mtime: expect.any(Number) },
            ],
          },
          { kind: 'file', name: 'draft', path: 'posts/notes/draft', title: 'draft', mtime: expect.any(Number) },
        ],
      },
    ])
  })

  it('returns an empty array for an empty directory', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-empty-'))
    const tree = await buildTree(empty)
    expect(tree).toEqual([])
    await fs.rm(empty, { recursive: true, force: true })
  })
})

describe('listSubtreePaths', () => {
  it('returns all descendant file paths under a folder', async () => {
    const all = await listSubtreePaths(sandbox, 'posts/notes')
    expect(all.sort()).toEqual(['posts/notes/archive/old', 'posts/notes/draft'])
  })
  it('returns empty for a non-existent folder', async () => {
    const all = await listSubtreePaths(sandbox, 'posts/missing')
    expect(all).toEqual([])
  })
})
```

> Note: `POSTS_DIR` is imported but unused in tests — we use a `sandbox` parameter instead. Drop that import if your linter complains, or keep it for documentation. (Keeping it; remove if it causes a TS unused-import error.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/__tests__/tree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/tree.ts`**

Create [server/tree.ts](../../../server/tree.ts):
```ts
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { POSTS_DIR } from './paths.js'
import type { PostSummary, TreeNode } from '../src/lib/api.js'

async function* walk(dir: string, prefix: string): AsyncGenerator<{ abs: string; rel: string; isDir: boolean }> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield { abs, rel, isDir: true }
      yield* walk(abs, rel)
    } else {
      yield { abs, rel, isDir: false }
    }
  }
}

function relToPath(rel: string): string {
  // rel is e.g. "hello.md" or "notes/draft.md" — strip .md and prepend "posts/"
  const noExt = rel.replace(/\.md$/, '')
  return `posts/${noExt}`
}

function nameFromPath(p: string): string {
  return p.split('/').pop()!
}

function titleFromFile(file: string, fallback: string): string {
  // Cheap title extraction: first H1, or fallback to filename.
  // We avoid pulling in gray-matter here for performance; a fuller parse happens
  // at GET /api/posts/* time. This is best-effort for the tree view.
  try {
    // Synchronous read is fine here — files are small and this only runs in tree-builder paths.
    const fsSync = require('node:fs') as typeof import('node:fs')
    const text = fsSync.readFileSync(file, 'utf8')
    const m = /^#\s+(.+)$/m.exec(text)
    if (m) return m[1].trim()
  } catch { /* ignore */ }
  return fallback
}

async function readMtime(abs: string): Promise<number> {
  const st = await fs.stat(abs)
  return st.mtimeMs
}

export async function listPostsFlat(rootDir: string = POSTS_DIR): Promise<PostSummary[]> {
  const out: PostSummary[] = []
  for await (const entry of walk(rootDir, '')) {
    if (entry.isDir) continue
    if (!entry.rel.endsWith('.md')) continue
    const p = relToPath(entry.rel)
    const name = nameFromPath(p)
    out.push({
      path: p,
      title: titleFromFile(entry.abs, name),
      date: '',
      tags: [],
      size: (await fs.stat(entry.abs)).size,
      mtime: await readMtime(entry.abs),
    })
  }
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

export async function listSubtreePaths(rootDir: string, folderPath: string): Promise<string[]> {
  // folderPath is the `path` field, e.g. "posts/notes". Strip the "posts/" prefix to get
  // the rel dir under rootDir.
  const relDir = folderPath.replace(/^posts\//, '')
  const absDir = path.join(rootDir, relDir)
  try {
    await fs.stat(absDir)
  } catch {
    return []
  }
  const out: string[] = []
  for await (const entry of walk(absDir, relDir)) {
    if (entry.isDir) continue
    if (!entry.rel.endsWith('.md')) continue
    out.push(relToPath(entry.rel))
  }
  return out
}

type MutableNode =
  | { kind: 'file'; name: string; path: string; title: string; mtime: number }
  | { kind: 'folder'; name: string; path: string; children: MutableNode[] }

export async function buildTree(rootDir: string = POSTS_DIR): Promise<TreeNode[]> {
  // Build a tree by sorting and inserting into a path-keyed node map.
  const nodes = new Map<string, MutableNode>()

  // Ensure root folder exists in the tree as a sentinel.
  const rootFolder: MutableNode = { kind: 'folder', name: 'posts', path: 'posts', children: [] }
  nodes.set('posts', rootFolder)

  for await (const entry of walk(rootDir, '')) {
    if (!entry.rel.endsWith('.md') && !entry.isDir) continue
    if (entry.isDir) {
      // Ensure every ancestor folder exists.
      const parts = entry.rel.split('/')
      let acc = 'posts'
      for (const part of parts) {
        acc = acc === 'posts' ? `posts/${part}` : `${acc}/${part}`
        if (!nodes.has(acc)) {
          nodes.set(acc, { kind: 'folder', name: part, path: acc, children: [] })
        }
      }
    } else {
      const p = relToPath(entry.rel)
      const name = nameFromPath(p)
      const parts = p.split('/')
      let parentPath = 'posts'
      for (let i = 1; i < parts.length - 1; i++) {
        parentPath = parentPath === 'posts' ? `posts/${parts[i]}` : `${parentPath}/${parts[i]}`
      }
      const parent = nodes.get(parentPath)!
      parent.children.push({
        kind: 'file',
        name,
        path: p,
        title: titleFromFile(entry.abs, name),
        mtime: await readMtime(entry.abs),
      })
    }
  }

  // Sort each folder's children: folders first, then files, both alphabetically (case-insensitive).
  function sortChildren(n: MutableNode) {
    if (n.kind === 'folder') {
      n.children.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      n.children.forEach(sortChildren)
    }
  }
  sortChildren(rootFolder)

  return rootFolder.children
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/__tests__/tree.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/tree.ts server/__tests__/tree.test.ts
git commit -m "feat(server): add recursive tree and flat-list builders"
```

---

## Task 4: Update `server/index.ts` — base endpoints with `path`

**Files:**
- Modify: [server/index.ts](../../../server/index.ts)

- [ ] **Step 1: Replace `POSTS_DIR` references and slug regex with the new path module**

In [server/index.ts](../../../server/index.ts), replace the top of the file (lines 1-32 area). The new header should be:

```ts
import { Hono } from 'hono'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { assertSafePath, filePathFor, folderPathFor, CONTENT_DIR, POSTS_DIR } from './paths.js'
import { listPostsFlat, buildTree, listSubtreePaths } from './tree.js'
import { slugify } from './slug.js'
import type { PostSummary, TreeNode } from '../src/lib/api.js'

// POSTS_DIR and CONTENT_DIR come from paths.js; we keep these names available
// for any inline code that still references them.
```

Then add the `POST /api/folders`, `PATCH /api/folders/*`, `DELETE /api/folders/*` endpoints AND update existing endpoints to use `path` instead of `slug`. The full file is included below — replace the entire file with:

```ts
import { Hono } from 'hono'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { assertSafePath, filePathFor, folderPathFor, CONTENT_DIR, POSTS_DIR } from './paths.js'
import { listPostsFlat, buildTree, listSubtreePaths } from './tree.js'
import { slugify } from './slug.js'
import type { PostSummary, TreeNode } from '../src/lib/api.js'

const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

const app = new Hono()

function bad(c: any, msg: string, code = 400) { return c.json({ error: msg }, code) }

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/tree', async (c) => {
  const tree = await buildTree()
  return c.json(tree)
})

app.get('/api/posts', async (c) => {
  const posts = await listPostsFlat()
  return c.json(posts)
})

// Create a new post. Body: { path: string, title?: string }
app.post('/api/posts', async (c) => {
  const body = await c.req.json().catch(() => null) as { path?: string; title?: string } | null
  if (!body || typeof body.path !== 'string') return bad(c, 'path required')
  if (!SEGMENT_RE.test(body.path.replace(/^posts\//, '').split('/').pop() ?? '')) {
    return bad(c, 'invalid final segment')
  }
  let abs: string
  try { abs = filePathFor(body.path) } catch (e: any) { return bad(c, e.message) }
  if (await exists(abs)) return bad(c, 'file exists', 409)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const title = body.title ?? body.path.split('/').pop()!
  const slug = title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const body_text = `---\ntitle: ${title}\ndate: ${new Date().toISOString().slice(0, 10)}\ntags: []\nslug: ${slug}\n---\n\n# ${title}\n`
  await fs.writeFile(abs, body_text, 'utf8')
  const st = await fs.stat(abs)
  return c.json({
    path: body.path,
    title,
    date: body_text.match(/^date:\s*(.+)$/m)![1],
    tags: [],
    size: st.size,
    mtime: st.mtimeMs,
  } satisfies PostSummary, 201)
})

// PATCH a file: rename within folder (name) or move (targetPath). Exactly one.
app.patch('/api/posts/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/posts\//, '')
  const srcPath = `posts/${splat}`
  let src: string
  try { src = filePathFor(srcPath) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(src)) return bad(c, 'not found', 404)

  const body = await c.req.json().catch(() => null) as { name?: string; targetPath?: string } | null
  if (!body || (body.name === undefined && body.targetPath === undefined)) {
    return bad(c, 'name or targetPath required')
  }
  if (body.name !== undefined && body.targetPath !== undefined) {
    return bad(c, 'pass exactly one of name / targetPath')
  }

  let dest: string
  let destPath: string
  if (body.name !== undefined) {
    if (!SEGMENT_RE.test(body.name)) return bad(c, 'invalid name')
    const parent = path.dirname(src)
    dest = path.join(parent, body.name + '.md')
    const parentRel = path.dirname(srcPath)
    destPath = parentRel === 'posts' ? `posts/${body.name}` : `${parentRel}/${body.name}`
  } else {
    try { dest = filePathFor(body.targetPath!) } catch (e: any) { return bad(c, e.message) }
    destPath = body.targetPath!
    // Cycle check: dest must not be inside src's directory
    if (dest.startsWith(path.dirname(src) + path.sep) && dest !== src) {
      // moving a file into a subdirectory of itself? only possible if targetPath is
      // under srcPath. Reject that.
      if (`posts/${splat}` !== body.targetPath && body.targetPath!.startsWith(srcPath + '/')) {
        return bad(c, 'cannot move into descendant', 422)
      }
    }
  }
  if (await exists(dest)) return bad(c, 'destination exists', 409)
  await fs.rename(src, dest)
  const st = await fs.stat(dest)
  return c.json({
    path: destPath,
    title: destPath.split('/').pop()!,
    date: '',
    tags: [],
    size: st.size,
    mtime: st.mtimeMs,
  } satisfies PostSummary)
})

// Delete a file
app.delete('/api/posts/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/posts\//, '')
  let abs: string
  try { abs = filePathFor(`posts/${splat}`) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(abs)) return bad(c, 'not found', 404)
  await fs.unlink(abs)
  return c.json({ ok: true })
})

// Read a single post (raw + frontmatter)
app.get('/api/posts/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/posts\//, '')
  let abs: string
  try { abs = filePathFor(`posts/${splat}`) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(abs)) return bad(c, 'not found', 404)
  const raw = await fs.readFile(abs, 'utf8')
  const parsed = matter(raw)
  const st = await fs.stat(abs)
  return c.json({
    path: `posts/${splat}`,
    raw,
    frontmatter: parsed.data,
    size: st.size,
    mtime: st.mtimeMs,
  })
})

// Create an empty folder. Body: { path: string }
app.post('/api/folders', async (c) => {
  const body = await c.req.json().catch(() => null) as { path?: string } | null
  if (!body || typeof body.path !== 'string') return bad(c, 'path required')
  if (!body.path.split('/').every((seg) => SEGMENT_RE.test(seg))) {
    return bad(c, 'invalid segment')
  }
  let abs: string
  try { abs = folderPathFor(body.path) } catch (e: any) { return bad(c, e.message) }
  if (await exists(abs)) return bad(c, 'folder exists', 409)
  await fs.mkdir(abs, { recursive: true })
  return c.json({ path: body.path }, 201)
})

// Rename a folder (single-segment rename, cascades on disk).
app.patch('/api/folders/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/folders\//, '')
  const srcPath = `posts/${splat}`
  let src: string
  try { src = folderPathFor(srcPath) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(src)) return bad(c, 'not found', 404)

  const body = await c.req.json().catch(() => null) as { newPath?: string } | null
  if (!body || typeof body.newPath !== 'string') return bad(c, 'newPath required')
  // Validate: newPath parent must match srcPath parent, only last segment differs.
  const srcParent = path.dirname(srcPath)
  const newParent = path.dirname(body.newPath)
  if (srcParent !== newParent) return bad(c, 'only single-segment rename allowed', 422)
  let dest: string
  try { dest = folderPathFor(body.newPath) } catch (e: any) { return bad(c, e.message) }
  if (await exists(dest)) return bad(c, 'destination exists', 409)
  await fs.rename(src, dest)
  // Collect affected file paths for client cache refresh.
  const moved = await listSubtreePaths(POSTS_DIR, body.newPath)
  return c.json({ path: body.newPath, moved })
})

// Delete a folder recursively. Requires ?recursive=true if non-empty.
app.delete('/api/folders/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/folders\//, '')
  const folderP = `posts/${splat}`
  let abs: string
  try { abs = folderPathFor(folderP) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(abs)) return bad(c, 'not found', 404)
  const recursive = c.req.query('recursive') === 'true'
  const all = await listSubtreePaths(POSTS_DIR, folderP)
  if (all.length > 0 && !recursive) {
    return bad(c, 'folder is not empty; pass ?recursive=true to delete', 400)
  }
  await fs.rm(abs, { recursive: true, force: true })
  return c.json({ deleted: all })
})

async function exists(p: string) {
  try { await fs.stat(p); return true } catch { return false }
}

export default app
```

- [ ] **Step 2: Create `server/slug.js` shim**

The existing code referenced a `slugify` helper from `server/slug.js`; create it as a thin wrapper so this file compiles:

`server/slug.js`:
```js
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: passes (no TS errors). If a vue-tsc error mentions an unknown type, add `export type { PostSummary, TreeNode } from '../src/lib/api.js'` to a new [src/lib/api.ts](../../../src/lib/api.ts) shim — see Task 7 for the real type definitions; in this task the route handlers only reference fields, so the import may be deferred.

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`

Then in another terminal, exercise the new endpoints:
```bash
# create a folder
curl -s -X POST http://localhost:5173/api/folders -H 'content-type: application/json' -d '{"path":"posts/notes"}'

# list tree
curl -s http://localhost:5173/api/tree

# create a nested file
curl -s -X POST http://localhost:5173/api/posts -H 'content-type: application/json' -d '{"path":"posts/notes/draft","title":"Draft"}'

# rename the folder
curl -s -X PATCH http://localhost:5173/api/folders/notes -H 'content-type: application/json' -d '{"newPath":"posts/archive"}'

# verify the file moved
curl -s http://localhost:5173/api/tree

# delete the folder recursively
curl -s -X DELETE 'http://localhost:5173/api/folders/archive?recursive=true'
```

Expected: each call returns the JSON described in the spec; the tree reflects the changes between calls.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/slug.js
git commit -m "feat(server): path-based endpoints, tree, folder CRUD"
```

---

## Task 5: Update `src/lib/api.ts` — `path` field, `TreeNode`, client helpers

**Files:**
- Modify: [src/lib/api.ts](../../../src/lib/api.ts)

- [ ] **Step 1: Replace the file content**

[src/lib/api.ts](../../../src/lib/api.ts):
```ts
export interface PostSummary {
  path: string            // replaces slug; e.g. "posts/hello-world"
  title: string
  date: string
  tags: string[]
  summary?: string
  size: number
  mtime: number
}

export type TreeNode =
  | { kind: 'file';   name: string; path: string; title: string; mtime: number }
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }

export interface PostDetail {
  path: string
  raw: string
  frontmatter: Record<string, unknown>
  size: number
  mtime: number
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText }))
    throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status, body })
  }
  return r.json() as Promise<T>
}

export async function getTree(): Promise<TreeNode[]> {
  return jsonOrThrow<TreeNode[]>(await fetch('/api/tree'))
}

export async function listPosts(): Promise<PostSummary[]> {
  return jsonOrThrow<PostSummary[]>(await fetch('/api/posts'))
}

export async function getPost(path: string): Promise<PostDetail> {
  return jsonOrThrow<PostDetail>(await fetch('/api/posts/' + encodeURI(path).replace(/^posts%2F/, 'posts/')))
}

export async function createPost(input: { path: string; title?: string }): Promise<PostSummary> {
  return jsonOrThrow<PostSummary>(await fetch('/api/posts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

export async function patchPost(srcPath: string, body: { name?: string; targetPath?: string }): Promise<PostSummary> {
  return jsonOrThrow<PostSummary>(await fetch('/api/posts/' + encodeURI(srcPath).replace(/^posts%2F/, 'posts/'), {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

export async function deletePost(path: string): Promise<{ ok: true }> {
  return jsonOrThrow<{ ok: true }>(await fetch('/api/posts/' + encodeURI(path).replace(/^posts%2F/, 'posts/'), { method: 'DELETE' }))
}

export async function createFolder(path: string): Promise<{ path: string }> {
  return jsonOrThrow<{ path: string }>(await fetch('/api/folders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  }))
}

export async function renameFolder(srcPath: string, newPath: string): Promise<{ path: string; moved: string[] }> {
  return jsonOrThrow<{ path: string; moved: string[] }>(await fetch('/api/folders/' + encodeURI(srcPath).replace(/^posts%2F/, 'posts/'), {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newPath }),
  }))
}

export async function deleteFolder(path: string, recursive: boolean): Promise<{ deleted: string[] }> {
  const url = '/api/folders/' + encodeURI(path).replace(/^posts%2F/, 'posts/') + (recursive ? '?recursive=true' : '')
  return jsonOrThrow<{ deleted: string[] }>(await fetch(url, { method: 'DELETE' }))
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: passes (this will surface callers still using `slug` — they will be fixed in subsequent tasks; if vue-tsc is strict, fix them in this task by replacing `slug` with `path` in tabs.ts, VaultView.vue, etc., or temporarily silence the unused-import error in the API file by removing the `import type` line. **Preferred:** proceed to Task 6 immediately and let subsequent tasks fix the dependents — vue-tsc only fails on real type errors, not on call-site mismatches that are about to be resolved.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api): replace slug with path, add tree + folder helpers"
```

---

## Task 6: Update `src/components/vault/tabs.ts` — `Tab.path`

**Files:**
- Modify: [src/components/vault/tabs.ts](../../../src/components/vault/tabs.ts)

- [ ] **Step 1: Replace `slug` with `path` throughout**

[src/components/vault/tabs.ts](../../../src/components/vault/tabs.ts):
```ts
export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface Tab {
  path: string
  title: string
  raw: string
  originalRaw: string
  saveStatus: SaveStatus
  error: string | null
  loadError: string | null
  loading: boolean
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/vault/tabs.ts
git commit -m "refactor(tabs): rename Tab.slug to Tab.path"
```

---

## Task 7: Router splat + VaultView `currentPath` derivation

**Files:**
- Modify: [src/router/index.ts](../../../src/router/index.ts)
- Modify: [src/views/VaultView.vue](../../../src/views/VaultView.vue)

- [ ] **Step 1: Update the router**

In [src/router/index.ts](../../../src/router/index.ts), find the route block for `/vault` and replace it. The new shape:

```ts
{
  path: '/vault',
  component: () => import('../views/VaultView.vue'),
  children: [
    { path: '', name: 'vault', component: () => import('../views/VaultView.vue') },
    { path: ':pathMatch(.*)*', name: 'vault-doc', component: () => import('../views/VaultView.vue') },
  ],
},
```

- [ ] **Step 2: Update VaultView to derive `currentPath` and use `path`**

In [src/views/VaultView.vue](../../../src/views/VaultView.vue), make the following edits in order.

In `<script setup>`, **add** the import and computed:
```ts
import { useRoute, useRouter } from 'vue-router'
const route = useRoute()
const router = useRouter()

const routePath = computed<string | null>(() => {
  const m = (route.params.pathMatch as string[] | undefined) ?? []
  return m.length ? 'posts/' + m.join('/') : null
})
```

Then **rename** every `currentSlug` to `currentPath`, every `slug` (in API calls, tab keys, rename handlers) to `path`. Concretely:

- `activeSlug` → `activePath`
- All references to `p.slug` → `p.path`
- `openPost(slug)` → `openPost(path)`: change signature; body becomes `router.replace('/vault/' + path.replace(/^posts\//, ''))`
- `tabs.value.find(t => t.slug === ...)` → `tabs.value.find(t => t.path === ...)`
- `onRename(newSlug)` → `onRename(newPath)`: body uses `patchPost(oldPath, { name: newPath })` (single-segment rename); on success, update local state and the URL.
- `onNewFromTree`: prompt for filename, compose `path` from current folder, call `createPost`.

Replace the entire `<script setup>` of `VaultView.vue` with this — it carries the full updated state shape:

```ts
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { listPosts, getPost, createPost, patchPost, deletePost, getTree } from '../lib/api'
import type { PostSummary, TreeNode } from '../lib/api'
import type { Tab } from '../components/vault/tabs'
import FileTree from '../components/vault/FileTree.vue'
import EditorPane from '../components/vault/EditorPane.vue'
import PreviewPane from '../components/vault/PreviewPane.vue'
import EditorTabs from '../components/vault/EditorTabs.vue'
import Breadcrumb from '../components/vault/Breadcrumb.vue'
import StatusBar from '../components/vault/StatusBar.vue'
import ActivityBar from '../components/vault/ActivityBar.vue'
import TagPanel from '../components/vault/TagPanel.vue'
import CommandPalette from '../components/vault/CommandPalette.vue'
import { useToast } from '../composables/useToast'
import { useConfirm } from '../composables/useConfirm'
import { usePrompt } from '../composables/usePrompt'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const confirm = useConfirm()
const prompt = usePrompt()

const tree  = ref<TreeNode[]>([])
const posts = ref<PostSummary[]>([])
const tabs  = ref<Tab[]>([])
const activePath = ref<string | null>(null)
const activePanel = ref<'files' | 'tags'>('files')

const routePath = computed<string | null>(() => {
  const m = (route.params.pathMatch as string[] | undefined) ?? []
  return m.length ? 'posts/' + m.join('/') : null
})

const filteredPosts = computed(() => posts.value)

async function refresh() {
  [tree.value, posts.value] = await Promise.all([getTree(), listPosts()])
}

function findTab(p: string) { return tabs.value.find((t) => t.path === p) }

async function openPost(p: string) {
  activePath.value = p
  // Update URL
  const urlPart = p.replace(/^posts\//, '')
  router.replace('/vault/' + urlPart)
  // Open or focus tab
  let tab = findTab(p)
  if (!tab) {
    tab = { path: p, title: p.split('/').pop()!, raw: '', originalRaw: '', saveStatus: 'idle', error: null, loadError: null, loading: true }
    tabs.value.push(tab)
  }
  if (tab.loading) {
    try {
      const detail = await getPost(p)
      tab.raw = detail.raw
      tab.originalRaw = detail.raw
      tab.title = (detail.frontmatter.title as string) ?? tab.title
    } catch (e: any) {
      tab.loadError = e.message
      toast.show('Failed to load: ' + e.message)
    } finally {
      tab.loading = false
    }
  }
}

function closeTab(p: string) {
  const idx = tabs.value.findIndex((t) => t.path === p)
  if (idx < 0) return
  tabs.value.splice(idx, 1)
  if (activePath.value === p) {
    const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null
    if (next) openPost(next.path)
    else router.replace('/vault')
  }
}

async function onNewFromTree() {
  const title = await prompt({ title: 'New post', placeholder: 'filename' })
  if (!title) return
  const filename = title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const parent = activePath.value ? activePath.value.replace(/\/[^/]+$/, '') : 'posts'
  const path = parent === 'posts' ? `posts/${filename}` : `${parent}/${filename}`
  try {
    await createPost({ path, title })
    await refresh()
    openPost(path)
  } catch (e: any) {
    toast.show('Create failed: ' + e.message)
  }
}

async function onRename(newName: string) {
  if (!activePath.value) return
  try {
    const updated = await patchPost(activePath.value, { name: newName })
    await refresh()
    const oldPath = activePath.value
    activePath.value = updated.path
    const tab = findTab(oldPath); if (tab) tab.path = updated.path
    router.replace('/vault/' + updated.path.replace(/^posts\//, ''))
  } catch (e: any) {
    toast.show('Rename failed: ' + e.message)
  }
}

async function onDelete(path: string) {
  const ok = await confirm({ message: `Delete "${path}"?`, danger: true })
  if (!ok) return
  try {
    await deletePost(path)
    await refresh()
    if (activePath.value === path) closeTab(path)
  } catch (e: any) {
    toast.show('Delete failed: ' + e.message)
  }
}

onMounted(refresh)
</script>
```

In the `<template>`, replace every `current-slug` with `current-path`, every `currentSlug` with `activePath`, every `p.slug` with `p.path`. Concretely update:

- `<FileTree :current-slug="activeSlug" ... />` → `<FileTree :current-path="activePath" ... />`
- `<Breadcrumb :current-slug="activeSlug" />` → `<Breadcrumb :current-path="activePath" />`
- `<TagPanel :posts="filteredPosts" />` stays the same shape (filteredPosts is now an array of `PostSummary` with `path`); TagPanel itself is updated in Task 13.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: passes. If `usePrompt` is not yet defined (Task 9), leave `const prompt = usePrompt()` but the composable file is created in Task 9 — order: **build now will fail**. **Fix:** swap the order — do Task 9 before this build, or stub `usePrompt` with `() => ({ prompt: async () => null })` and remove the stub in Task 9.

- [ ] **Step 4: Commit**

```bash
git add src/router/index.ts src/views/VaultView.vue
git commit -m "feat(vault): path-based router + VaultView path derivation"
```

---

## Task 8: `usePrompt` composable + `PromptHost` component

**Files:**
- Create: [src/composables/usePrompt.ts](../../../src/composables/usePrompt.ts)
- Create: [src/components/PromptHost.vue](../../../src/components/PromptHost.vue)
- Modify: [src/App.vue](../../../src/App.vue) to mount `PromptHost`

- [ ] **Step 1: Read the existing `useConfirm` pattern for reference**

Read [src/composables/useConfirm.ts](../../../src/composables/useConfirm.ts) and [src/components/ConfirmHost.vue](../../../src/components/ConfirmHost.vue) to mirror the shape exactly.

- [ ] **Step 2: Write `usePrompt.ts`**

[src/composables/usePrompt.ts](../../../src/composables/usePrompt.ts):
```ts
import { ref, readonly } from 'vue'

interface PromptState {
  id: number
  title: string
  placeholder?: string
  resolve: (value: string | null) => void
}

const state = ref<PromptState | null>(null)
let nextId = 1

export function usePrompt() {
  function prompt(input: { title: string; placeholder?: string }): Promise<string | null> {
    return new Promise((resolve) => {
      state.value = { id: nextId++, ...input, resolve }
    })
  }
  function submit(value: string) {
    const cur = state.value
    if (!cur) return
    cur.resolve(value.trim() || null)
    state.value = null
  }
  function cancel() {
    const cur = state.value
    if (!cur) return
    cur.resolve(null)
    state.value = null
  }
  return {
    state: readonly(state),
    prompt,
    submit,
    cancel,
  }
}
```

- [ ] **Step 3: Write `PromptHost.vue`**

[src/components/PromptHost.vue](../../../src/components/PromptHost.vue) — mirror the styling of [ConfirmHost.vue](../../../src/components/ConfirmHost.vue):
```vue
<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { usePrompt } from '../composables/usePrompt'

const { state, submit, cancel } = usePrompt()
const input = ref('')

watch(state, async (s) => {
  if (s) {
    input.value = ''
    await nextTick()
    const el = document.getElementById('nuvyn-prompt-input') as HTMLInputElement | null
    el?.focus()
  }
})

function onEnter() { submit(input.value) }
function onEscape(e: KeyboardEvent) { e.preventDefault(); cancel() }
</script>

<template>
  <Teleport to="body">
    <div v-if="state" class="prompt-backdrop" @click.self="cancel" @keydown.esc="onEscape">
      <div class="prompt-card" role="dialog" aria-modal="true">
        <h3 class="prompt-title">{{ state.title }}</h3>
        <input
          id="nuvyn-prompt-input"
          v-model="input"
          class="prompt-input"
          :placeholder="state.placeholder"
          @keydown.enter="onEnter"
        />
        <div class="prompt-actions">
          <button class="prompt-cancel" @click="cancel">Cancel</button>
          <button class="prompt-ok" @click="onEnter">OK</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.prompt-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center;
}
.prompt-card {
  background: var(--bg-elev, #1e1e1e); color: var(--text, #ddd);
  border: 1px solid var(--border, #333);
  border-radius: 6px; padding: 16px; min-width: 320px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.prompt-title { margin: 0 0 12px; font-size: 0.95rem; font-weight: 600; }
.prompt-input {
  width: 100%; padding: 6px 8px; font: inherit;
  background: var(--bg-input, #252526); color: var(--text, #ddd);
  border: 1px solid var(--border, #333); border-radius: 3px;
}
.prompt-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.prompt-cancel, .prompt-ok { padding: 4px 12px; border: 1px solid var(--border, #333); background: transparent; color: inherit; border-radius: 3px; cursor: pointer; }
.prompt-ok { background: var(--accent, #007acc); color: white; border-color: var(--accent, #007acc); }
</style>
```

- [ ] **Step 4: Mount `PromptHost` in `App.vue`**

In [src/App.vue](../../../src/App.vue), import and render it once near the existing `ConfirmHost`/`ToastHost`:
```vue
<PromptHost />
```

Add to the imports at the top of `<script setup>`:
```ts
import PromptHost from './components/PromptHost.vue'
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 6: Manual smoke test**

Run: `npm run dev`. Click the `+ New` button in the file tree. The styled prompt should appear; pressing Enter should call `onNewFromTree`; pressing Escape or clicking the backdrop should cancel.

- [ ] **Step 7: Commit**

```bash
git add src/composables/usePrompt.ts src/components/PromptHost.vue src/App.vue
git commit -m "feat(ui): add prompt dialog (usePrompt + PromptHost)"
```

---

## Task 9: Icons module

**Files:**
- Create: [src/components/vault/icons.ts](../../../src/components/vault/icons.ts)

- [ ] **Step 1: Create the icon strings**

[src/components/vault/icons.ts](../../../src/components/vault/icons.ts):
```ts
export const ICON_FOLDER = `
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 4.5C2 3.67 2.67 3 3.5 3h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5v6.5c0 .83-.67 1.5-1.5 1.5h-9C2.67 13.5 2 12.83 2 12V4.5z"/>
</svg>`

export const ICON_FOLDER_OPEN = `
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 4.5C2 3.67 2.67 3 3.5 3h3l1.5 1.5h4.5c.83 0 1.5.67 1.5 1.5H2V4.5z"/>
  <path d="M2 5h12.5l-1.5 7c-.1.5-.55.85-1.05.85H3.05c-.5 0-.95-.35-1.05-.85L2 5z" fill="currentColor" fill-opacity="0.15"/>
</svg>`

export const ICON_FILE_MD = `
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3.5 2h6L13 5.5V13c0 .83-.67 1.5-1.5 1.5h-8C2.67 14.5 2 13.83 2 13V3.5C2 2.67 2.67 2 3.5 2z"/>
  <path d="M9.5 2v3.5H13"/>
  <text x="5" y="11.5" font-size="3.5" fill="currentColor" stroke="none" font-family="ui-monospace, monospace">M</text>
  <text x="9" y="11.5" font-size="3.5" fill="currentColor" stroke="none" font-family="ui-monospace, monospace">↓</text>
</svg>`

export const ICON_CHEVRON = `
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3.5 2l3 3-3 3"/>
</svg>`
```

- [ ] **Step 2: Commit**

```bash
git add src/components/vault/icons.ts
git commit -m "feat(vault): add file-tree icon strings (folder, file-md, chevron)"
```

---

## Task 10: `TreeRow` recursive component

**Files:**
- Create: [src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue)

- [ ] **Step 1: Create the component**

[src/components/vault/TreeRow.vue](../../../src/components/vault/TreeRow.vue):
```vue
<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import type { TreeNode } from '../../lib/api'
import { ICON_FOLDER, ICON_FOLDER_OPEN, ICON_FILE_MD, ICON_CHEVRON } from './icons'

const props = defineProps<{
  node: TreeNode
  depth: number
  currentPath: string | null
  expandedSet: Set<string>   // shared expansion state from parent
}>()

const emit = defineEmits<{
  select: [path: string]
  toggle: [path: string]
  rename: [oldPath: string, newName: string]
  delete: [path: string]
  move: [srcPath: string, targetFolder: string]
  'create-in': [folder: string, kind: 'file' | 'folder']
}>()

const isFolder = computed(() => props.node.kind === 'folder')
const isActive = computed(() => !isFolder.value && props.node.path === props.currentPath)
const isExpanded = computed(() => isFolder.value && props.expandedSet.has(props.node.path))

// --- drag state ---
const isDragging = ref(false)
const isDropTarget = ref(false)
const dragDepth = ref(0)

function onDragStart(e: DragEvent) {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('text/x-nuvyn-path', props.node.path)
  e.dataTransfer.effectAllowed = 'move'
  isDragging.value = true
}
function onDragEnd() { isDragging.value = false; isDropTarget.value = false; dragDepth.value = 0 }

function onDragEnter(e: DragEvent) {
  if (!isFolder.value) return
  e.preventDefault()
  dragDepth.value++
  isDropTarget.value = true
}
function onDragLeave() {
  if (!isFolder.value) return
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) isDropTarget.value = false
}
function onDragOver(e: DragEvent) {
  if (!isFolder.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}
function onDrop(e: DragEvent) {
  if (!isFolder.value) return
  e.preventDefault()
  e.stopPropagation()
  const src = e.dataTransfer?.getData('text/x-nuvyn-path') ?? ''
  if (!src) return
  isDropTarget.value = false
  dragDepth.value = 0
  emit('move', src, props.node.path)
}

// --- rename / delete inline state ---
const renaming = ref(false)
const renameValue = ref('')

function startRename() {
  renaming.value = true
  renameValue.value = props.node.name
  nextTick(() => {
    const el = document.getElementById('nuvyn-rename-input-' + props.node.path) as HTMLInputElement | null
    el?.focus(); el?.select()
  })
}
function commitRename() {
  const name = renameValue.value.trim()
  renaming.value = false
  if (!name || name === props.node.name) return
  emit('rename', props.node.path, name)
}
function cancelRename() { renaming.value = false }
</script>

<template>
  <li
    class="tree-row"
    :class="{ active: isActive, expanded: isExpanded, folder: isFolder, dragging: isDragging, 'drop-target': isDropTarget }"
    :style="{ '--depth': depth }"
    :draggable="!renaming"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragenter="onDragEnter"
    @dragleave="onDragLeave"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <span
      v-if="isFolder"
      class="chevron"
      :class="{ expanded: isExpanded }"
      @click.stop="emit('toggle', node.path)"
      v-html="ICON_CHEVRON"
    />
    <span v-else class="chevron-spacer" />

    <span class="row-icon" v-if="isFolder" v-html="isExpanded ? ICON_FOLDER_OPEN : ICON_FOLDER" />
    <span class="row-icon" v-else v-html="ICON_FILE_MD" />

    <template v-if="renaming">
      <input
        :id="'nuvyn-rename-input-' + node.path"
        v-model="renameValue"
        class="rename-input"
        @keydown.enter="commitRename"
        @keydown.escape="cancelRename"
        @blur="commitRename"
        @click.stop
      />
    </template>
    <template v-else>
      <a
        class="row-name"
        href="#"
        @click.prevent="isFolder ? emit('toggle', node.path) : emit('select', node.path)"
      >{{ node.name }}</a>
      <span v-if="!isFolder" class="row-date" />
    </template>

    <div v-if="!renaming" class="row-actions" @click.stop>
      <button v-if="isFolder" @click="emit('create-in', node.path, 'file')"     title="New file in here">+F</button>
      <button v-if="isFolder" @click="emit('create-in', node.path, 'folder')"   title="New folder in here">+D</button>
      <button @click="startRename" title="Rename">✎</button>
      <button @click="emit('delete', node.path)" title="Delete">×</button>
    </div>

    <ul v-if="isFolder && isExpanded" class="tree-children">
      <TreeRow
        v-for="child in (node as any).children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :current-path="currentPath"
        :expanded-set="expandedSet"
        @select="(p) => emit('select', p)"
        @toggle="(p) => emit('toggle', p)"
        @rename="(oldP, n) => emit('rename', oldP, n)"
        @delete="(p) => emit('delete', p)"
        @move="(src, folder) => emit('move', src, folder)"
        @create-in="(folder, kind) => emit('create-in', folder, kind)"
      />
    </ul>
  </li>
</template>
```

> Note: self-recursion (`<TreeRow>` referencing itself) works in Vue 3 SFC because the component name is derived from the filename. No explicit `name` export is required when using `<script setup>`.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/vault/TreeRow.vue
git commit -m "feat(vault): add recursive TreeRow component"
```

---

## Task 11: New `FileTree.vue` — expansion state, top bar, drop-on-root

**Files:**
- Modify: [src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue)

- [ ] **Step 1: Replace the file content**

[src/components/vault/FileTree.vue](../../../src/components/vault/FileTree.vue):
```vue
<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { TreeNode } from '../../lib/api'
import TreeRow from './TreeRow.vue'
import { useConfirm } from '../../composables/useConfirm'
import { usePrompt } from '../../composables/usePrompt'
import { useToast } from '../../composables/useToast'
import { createPost, createFolder, patchPost, deletePost, renameFolder, deleteFolder } from '../../lib/api'

const props = defineProps<{
  tree: TreeNode[]
  currentPath: string | null
}>()
const emit = defineEmits<{
  select: [path: string]
  refresh: []
}>()

const STORAGE_KEY = 'nuvyn.vault.expandedPaths'
const expanded = ref<Set<string>>(new Set(loadExpanded()))

const confirm = useConfirm()
const prompt = usePrompt()
const toast = useToast()

function loadExpanded(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}
function saveExpanded() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...expanded.value])) } catch { /* ignore */ }
}

function toggle(path: string) {
  if (expanded.value.has(path)) expanded.value.delete(path)
  else expanded.value.add(path)
  expanded.value = new Set(expanded.value)   // trigger reactivity
  saveExpanded()
}

// Default-expand ancestors of currentPath
watch(() => props.currentPath, (p) => {
  if (!p) return
  const segs = p.split('/')
  let acc = 'posts'
  const ancestors: string[] = []
  for (let i = 1; i < segs.length; i++) {
    acc = i === 1 ? `posts/${segs[i]}` : `${acc}/${segs[i]}`
    if (i < segs.length - 1) ancestors.push(acc)
  }
  let changed = false
  for (const a of ancestors) if (!expanded.value.has(a)) { expanded.value.add(a); changed = true }
  if (changed) { expanded.value = new Set(expanded.value); saveExpanded() }
}, { immediate: true })

// --- drag on root (move to root) ---
const isRootDropTarget = ref(false)
const rootDragDepth = ref(0)
function onRootDragEnter(e: DragEvent) { e.preventDefault(); rootDragDepth.value++; isRootDropTarget.value = true }
function onRootDragLeave() { rootDragDepth.value = Math.max(0, rootDragDepth.value - 1); if (rootDragDepth.value === 0) isRootDropTarget.value = false }
function onRootDragOver(e: DragEvent) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move' }
async function onRootDrop(e: DragEvent) {
  e.preventDefault()
  const src = e.dataTransfer?.getData('text/x-nuvyn-path') ?? ''
  isRootDropTarget.value = false
  rootDragDepth.value = 0
  if (!src) return
  const filename = src.split('/').pop()!
  const targetPath = `posts/${filename}`
  if (targetPath === src) return
  try {
    await patchPost(src, { targetPath })
    emit('refresh')
    if (props.currentPath === src) emit('select', targetPath)
    toast.show('Moved to root')
  } catch (err: any) {
    toast.show('Move failed: ' + (err.message ?? 'unknown'))
  }
}

// --- row events ---
async function onSelect(p: string) { emit('select', p) }
async function onToggle(p: string) { toggle(p) }

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.path === path) return n
    if (n.kind === 'folder') {
      const found = findNode(n.children, path)
      if (found) return found
    }
  }
  return null
}

async function onRename(oldPath: string, newName: string) {
  const node = findNode(props.tree, oldPath)
  if (!node) return
  try {
    if (node.kind === 'folder') {
      const parent = oldPath.split('/').slice(0, -1).join('/') || 'posts'
      const newPath = parent === 'posts' ? `posts/${newName}` : `${parent}/${newName}`
      const res = await renameFolder(oldPath, newPath)
      toast.show(`Renamed (${res.moved.length} item${res.moved.length === 1 ? '' : 's'})`)
    } else {
      await patchPost(oldPath, { name: newName })
    }
    emit('refresh')
  } catch (e: any) {
    toast.show('Rename failed: ' + e.message)
  }
}

async function onDelete(p: string) {
  const node = findNode(props.tree, p)
  if (!node) return
  let count = 1
  if (node.kind === 'folder') count = countDescendants(node) + 1
  const ok = await confirm({
    message: node.kind === 'folder'
      ? `Delete folder "${node.name}" and ${count - 1} item${count - 1 === 1 ? '' : 's'} inside?`
      : `Delete "${node.name}"?`,
    danger: true,
  })
  if (!ok) return
  try {
    if (node.kind === 'folder') await deleteFolder(p, true)
    else await deletePost(p)
    emit('refresh')
  } catch (e: any) { toast.show('Delete failed: ' + e.message) }
}
function countDescendants(n: TreeNode): number {
  if (n.kind !== 'folder') return 0
  return n.children.reduce((acc, c) => acc + 1 + countDescendants(c), 0)
}

async function onMove(srcPath: string, targetFolder: string) {
  // targetFolder is the folder path; new file path = targetFolder/filename
  const filename = srcPath.split('/').pop()!
  const newPath = targetFolder === 'posts' ? `posts/${filename}` : `${targetFolder}/${filename}`
  if (newPath === srcPath) return
  // Cycle check: cannot move folder into itself or descendant.
  const srcNode = findNode(props.tree, srcPath)
  if (srcNode?.kind === 'folder' && (newPath === srcPath || newPath.startsWith(srcPath + '/'))) {
    toast.show('Cannot move a folder into itself')
    return
  }
  try {
    await patchPost(srcPath, { targetPath: newPath })
    emit('refresh')
    if (props.currentPath === srcPath) emit('select', newPath)
  } catch (e: any) {
    toast.show('Move failed: ' + (e.message ?? 'unknown'))
  }
}

async function onCreateIn(folder: string, kind: 'file' | 'folder') {
  const title = await prompt({ title: kind === 'file' ? `New file in ${folder}` : `New folder in ${folder}`, placeholder: 'name' })
  if (!title) return
  const name = title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!name) { toast.show('Invalid name'); return }
  const path = folder === 'posts' ? `posts/${name}` : `${folder}/${name}`
  try {
    if (kind === 'file') await createPost({ path, title: name })
    else await createFolder(path)
    expanded.value.add(folder)
    expanded.value = new Set(expanded.value)
    saveExpanded()
    emit('refresh')
  } catch (e: any) { toast.show('Create failed: ' + e.message) }
}
</script>

<template>
  <aside
    class="file-tree"
    :class="{ 'drop-target-root': isRootDropTarget }"
    @dragenter="onRootDragEnter"
    @dragleave="onRootDragLeave"
    @dragover="onRootDragOver"
    @drop="onRootDrop"
  >
    <header>
      <span class="title">Files</span>
      <div class="header-actions">
        <button class="new-btn" @click="onCreateIn('posts', 'file')"   title="New post">+ Post</button>
        <button class="new-btn" @click="onCreateIn('posts', 'folder')" title="New folder">+ Folder</button>
      </div>
    </header>
    <ul v-if="tree.length" class="tree" role="tree">
      <TreeRow
        v-for="node in tree"
        :key="node.path"
        :node="node"
        :depth="0"
        :current-path="currentPath"
        :expanded-set="expanded"
        @select="onSelect"
        @toggle="onToggle"
        @rename="onRename"
        @delete="onDelete"
        @move="onMove"
        @create-in="onCreateIn"
      />
    </ul>
    <p v-else class="empty">No posts yet.</p>
  </aside>
</template>
```

- [ ] **Step 2: Wire up `refresh` from VaultView**

In [src/views/VaultView.vue](../../../src/views/VaultView.vue) (from Task 7), update the `<FileTree>` usage to pass `:tree="tree"` and listen for `@refresh="refresh"`. The current usage:
```vue
<FileTree
  v-if="activePanel === 'files'"
  :posts="filteredPosts"
  :current-slug="activeSlug"
  ...
/>
```

Replace with:
```vue
<FileTree
  v-if="activePanel === 'files'"
  :tree="tree"
  :current-path="activePath"
  @select="openPost"
  @refresh="refresh"
  @new="onNewFromTree"
  @rename="onRename"
  @delete="onDelete"
/>
```

The `@new` event is no longer used (the buttons are now inside FileTree); remove or ignore. Drop the `posts` prop entirely.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`. Verify:
- The four existing files appear at the root.
- Click `+ Folder`, enter `notes`, folder appears.
- Click `+ Post`, enter `draft`, file appears.
- Right side of each row shows hover actions.
- Click the folder chevron to expand.

- [ ] **Step 5: Commit**

```bash
git add src/components/vault/FileTree.vue src/views/VaultView.vue
git commit -m "feat(vault): recursive FileTree with create-in, drag-on-root, expansion state"
```

---

## Task 12: `Breadcrumb.vue` — dynamic segments

**Files:**
- Modify: `src/components/vault/Breadcrumb.vue`

- [ ] **Step 1: Replace the file**

`src/components/vault/Breadcrumb.vue`:
```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'

const props = defineProps<{ currentPath: string | null }>()
const router = useRouter()

const segments = computed(() => {
  if (!props.currentPath) return []
  // strip "posts/" prefix, then split
  return props.currentPath.replace(/^posts\//, '').split('/')
})

function goTo(index: number) {
  const segs = segments.value.slice(0, index + 1)
  router.push('/vault/' + segs.join('/'))
}
function goRoot() { router.push('/vault') }
</script>

<template>
  <nav class="breadcrumb" aria-label="Path">
    <template v-if="!currentPath">
      <span class="seg current">posts</span>
    </template>
    <template v-else>
      <a class="seg" @click="goRoot">posts</a>
      <template v-for="(seg, i) in segments" :key="i">
        <span class="sep">/</span>
        <a v-if="i < segments.length - 1" class="seg" @click="goTo(i)">{{ seg }}</a>
        <span v-else class="seg current">{{ seg }}</span>
      </template>
      <span class="ext">.md</span>
    </template>
  </nav>
</template>

<style scoped>
.breadcrumb { display: flex; align-items: center; gap: 4px; font-size: 0.85rem; color: var(--text-mute, #888); }
.seg { color: inherit; text-decoration: none; cursor: pointer; }
.seg:hover { color: var(--text, #ddd); text-decoration: underline; }
.seg.current { color: var(--text, #ddd); cursor: default; }
.seg.current:hover { text-decoration: none; }
.sep { color: var(--text-mute, #666); }
.ext { color: var(--text-mute, #666); }
</style>
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/vault/Breadcrumb.vue
git commit -m "feat(vault): dynamic breadcrumb from currentPath"
```

---

## Task 13: `TagPanel`, `CommandPalette`, `search.ts` — show `path`

**Files:**
- Modify: [src/components/vault/TagPanel.vue](../../../src/components/vault/TagPanel.vue)
- Modify: [src/components/vault/CommandPalette.vue](../../../src/components/vault/CommandPalette.vue)
- Modify: [src/lib/search.ts](../../../src/lib/search.ts)

- [ ] **Step 1: Update `TagPanel.vue` to show `path`**

Read [src/components/vault/TagPanel.vue](../../../src/components/vault/TagPanel.vue) to find the result-rendering block. In the `<a>` (or however each result is rendered), under the title add a small path line. Find the row that displays `p.title` and append:

```vue
<span v-if="p.path.includes('/')" class="result-path">
  {{ p.path.replace(/^posts\//, '').replace(/\/[^/]+$/, '') }}
</span>
```

CSS (add to the component's `<style scoped>`):
```css
.result-path { display: block; font-size: 0.7rem; color: var(--text-mute, #888); }
```

- [ ] **Step 2: Update `CommandPalette.vue` similarly**

In the result list, for each `<li>` or row showing a result, add a path line. Use the same `.result-path` styling. The simplest insertion is alongside the existing title — find the markup that renders `p.title` and add right after it:

```vue
<span class="result-path">{{ p.path.replace(/^posts\//, '') }}</span>
```

- [ ] **Step 3: Update `lib/search.ts` to index `path`**

In [src/lib/search.ts](../../../src/lib/search.ts), find the `SearchDoc` interface and the documents constructor. Add `path: string` to `SearchDoc`. In the document building loop (where each `PostSummary` becomes a `SearchDoc`), add `path: p.path`. Add `path` to the `fields` array passed to `new MiniSearch(...)`.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/components/vault/TagPanel.vue src/components/vault/CommandPalette.vue src/lib/search.ts
git commit -m "feat(vault): show path in TagPanel, CommandPalette, search index"
```

---

## Task 14: Style the new tree (drop targets, indent, icons)

**Files:**
- Modify: [src/style.css](../../../src/style.css)

- [ ] **Step 1: Replace the file-tree rule block (vault-scoped)**

Find the existing `.vault .file-tree ...` block (around lines 447-521) and replace it with:

```css
/* File tree — vault-scoped */
.vault .file-tree {
  display: flex; flex-direction: column;
  background: var(--vs-bg-2);
  height: 100%; min-width: 0;
  position: relative;
}
.vault .file-tree header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px 6px;
  border-bottom: 1px solid var(--vs-border, rgba(255,255,255,0.06));
  text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.04em;
  color: var(--vs-text-mute, #999);
}
.vault .file-tree .header-actions { display: flex; gap: 4px; }
.vault .file-tree .new-btn {
  background: transparent; border: 1px solid var(--vs-border, rgba(255,255,255,0.1));
  color: var(--vs-text, #ccc); padding: 2px 8px; border-radius: 3px;
  font-size: 0.72rem; cursor: pointer;
}
.vault .file-tree .new-btn:hover { background: var(--vs-row-hover, rgba(255,255,255,0.04)); }

.vault .file-tree .tree {
  list-style: none; padding: 4px 0; margin: 0;
  overflow-y: auto; flex: 1;
}
.vault .file-tree .tree-children { list-style: none; padding: 0; margin: 0; }

.vault .file-tree .tree-row {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 12px 3px calc(12px + var(--depth, 0) * 12px);
  cursor: default; user-select: none;
  position: relative; color: var(--vs-text, #ccc);
  font-size: 0.85rem; line-height: 1.4;
}
.vault .file-tree .tree-row:hover { background: var(--vs-row-hover, rgba(255,255,255,0.04)); }
.vault .file-tree .tree-row.active { background: var(--vs-row-active, rgba(0,122,204,0.18)); }
.vault .file-tree .tree-row.active::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--vs-accent, #007acc);
}
.vault .file-tree .tree-row[draggable] { cursor: grab; }
.vault .file-tree .tree-row.dragging { opacity: 0.4; }
.vault .file-tree .tree-row.drop-target {
  outline: 1px dashed var(--vs-accent, #007acc);
  outline-offset: -1px;
  background: var(--vs-row-drop, rgba(0,122,204,0.08));
}
.vault .file-tree.drop-target-root { box-shadow: inset 0 2px 0 0 var(--vs-accent, #007acc); }

.vault .file-tree .chevron, .vault .file-tree .chevron-spacer {
  width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center;
  color: var(--vs-text-mute, #888); flex-shrink: 0;
}
.vault .file-tree .chevron { cursor: pointer; transition: transform 120ms; }
.vault .file-tree .chevron.expanded { transform: rotate(90deg); }

.vault .file-tree .row-icon { display: inline-flex; width: 14px; height: 14px; flex-shrink: 0; color: var(--vs-text-mute, #888); }
.vault .file-tree .tree-row.folder .row-icon { color: var(--vs-folder, #c8a96a); }

.vault .file-tree .row-name {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-decoration: none; color: inherit;
}
.vault .file-tree .row-date { font-size: 0.7rem; color: var(--vs-text-mute, #888); }

.vault .file-tree .row-actions { opacity: 0; display: flex; gap: 2px; }
.vault .file-tree .tree-row:hover .row-actions { opacity: 1; }
.vault .file-tree .row-actions button {
  background: transparent; border: none; color: var(--vs-text-mute, #888);
  padding: 1px 5px; border-radius: 2px; cursor: pointer; font-size: 0.75rem;
}
.vault .file-tree .row-actions button:hover { background: var(--vs-row-hover, rgba(255,255,255,0.08)); color: var(--vs-text, #ccc); }

.vault .file-tree .rename-input {
  flex: 1; background: var(--vs-input-bg, #252526); color: var(--vs-text, #ccc);
  border: 1px solid var(--vs-accent, #007acc); border-radius: 2px;
  padding: 1px 4px; font: inherit; outline: none;
}

.vault .file-tree .empty { padding: 12px; color: var(--vs-text-mute, #888); font-size: 0.85rem; }
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/style.css
git commit -m "style(vault): file-tree folder support (indent, chevrons, drop targets)"
```

---

## Task 15: Component test for `FileTree` (Vitest + @vue/test-utils)

**Files:**
- Create: [src/components/vault/__tests__/FileTree.test.ts](../../../src/components/vault/__tests__/FileTree.test.ts)

- [ ] **Step 1: Write the test**

[src/components/vault/__tests__/FileTree.test.ts](../../../src/components/vault/__tests__/FileTree.test.ts):
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import FileTree from '../FileTree.vue'
import type { TreeNode } from '../../../lib/api'

const TREE: TreeNode[] = [
  { kind: 'file', name: 'hello', path: 'posts/hello', title: 'Hello', mtime: 0 },
  {
    kind: 'folder', name: 'notes', path: 'posts/notes', children: [
      { kind: 'file', name: 'draft', path: 'posts/notes/draft', title: 'Draft', mtime: 0 },
    ],
  },
]

describe('FileTree', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders top-level files and folders', () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    expect(w.text()).toContain('hello')
    expect(w.text()).toContain('notes')
    expect(w.text()).not.toContain('draft')  // nested, not expanded
  })

  it('expands a folder on click and shows nested files', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    await w.find('.chevron').trigger('click')
    expect(w.text()).toContain('draft')
  })

  it('emits select when a file is clicked', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    const fileRow = w.findAll('.tree-row').find((r) => r.text().includes('hello'))!
    await fileRow.find('.row-name').trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['posts/hello'])
  })

  it('highlights the active row', () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: 'posts/hello' } })
    const active = w.findAll('.tree-row').find((r) => r.classes('active'))
    expect(active).toBeTruthy()
    expect(active!.text()).toContain('hello')
  })

  it('persists expansion to localStorage', async () => {
    const w = mount(FileTree, { props: { tree: TREE, currentPath: null } })
    await w.find('.chevron').trigger('click')
    expect(JSON.parse(localStorage.getItem('nuvyn.vault.expandedPaths')!)).toContain('posts/notes')
  })

  it('default-expands ancestors of the current path', () => {
    mount(FileTree, { props: { tree: TREE, currentPath: 'posts/notes/draft' } })
    // After mount, posts/notes should be in localStorage
    expect(JSON.parse(localStorage.getItem('nuvyn.vault.expandedPaths') ?? '[]')).toContain('posts/notes')
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/components/vault/__tests__/FileTree.test.ts`
Expected: all pass. If a test fails because `currentPath` watcher fires before `localStorage` is hydrated, ensure `STORAGE_KEY` is read in the setup of the ref (synchronous), and that the watcher has `immediate: true`. The component already does both.

- [ ] **Step 3: Commit**

```bash
git add src/components/vault/__tests__/FileTree.test.ts
git commit -m "test(vault): FileTree rendering, expand/collapse, active row, persistence"
```

---

## Task 16: Manual verification checklist

- [ ] **Step 1: Walk through the checklist**

Run `npm run dev` and verify, in order:

1. **Existing flat files still work** — `hello-world.md`, etc. appear at the root. Clicking each opens the editor and the URL is `/vault/<name>`.
2. **Create a root folder** — click `+ Folder`, type `notes`, press Enter. Folder appears.
3. **Create a file in root** — click `+ Post`, type `draft`, press Enter. File appears at root.
4. **Create a file in a folder** — hover the `notes` folder, click `+F`, type `nested`, press Enter. The folder auto-expands; the new file appears inside.
5. **Open the nested file** — click it. Editor opens. URL is `/vault/notes/nested`. Breadcrumb shows `posts › notes › nested`.
6. **Rename a file** — hover the file, click ✎, type `better-name`, press Enter. Tab content preserved, URL updates to `/vault/notes/better-name`.
7. **Rename a folder** — hover the folder, click ✎, type `archive`, press Enter. All children stay functional; breadcrumb reflects new name; URL is `/vault/archive/better-name` after re-clicking the file.
8. **Drag a file into a folder** — drag a top-level file onto the `notes` folder. File moves under `notes`. URL of the open file updates. Disk shows the file at `src/content/posts/notes/<filename>.md`.
9. **Drag a file out to root** — drag a file from inside `notes` onto the file-tree header (root drop zone). File moves to top level.
10. **Recursive delete** — hover the `notes` folder, click ×. Confirm dialog shows item count. Confirm. Folder and all contents removed from disk.
11. **Refresh mid-session** — open a nested file, hit F5. Expansion state restored from `localStorage`; current file opens at the right URL.
12. **Light + dark themes** — toggle the theme button. New tree renders correctly in both palettes.
13. **Build** — `npm run build` passes.

If any item fails, fix the underlying issue and re-run the checklist. Each fix gets its own commit.

- [ ] **Step 2: Commit any final fixes**

```bash
git add -A
git commit -m "fix(vault): manual verification fixes (if any)"
```

If no fixes were needed, this commit is empty — skip it.

---

## Out of scope (verified absent in the final tree)

- No folder drag-and-drop (only files can be moved via DnD).
- No multi-select.
- No undo / soft delete.
- No SSR story.
- No file-watcher / external change detection.

If any of these appear during implementation, stop and confirm with the user.
