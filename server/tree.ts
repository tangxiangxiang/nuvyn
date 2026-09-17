import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { CONTENT_DIR } from './paths.js'
import type { PostSummary, TreeNode } from '../src/lib/api.js'
import type { Database as DatabaseT } from 'better-sqlite3'
import { getDocumentMetadata } from './documentMetadata.js'
import { classifyDiaryPath } from '../shared/diaryProtocol.js'
import { NUVYN_VAULT_DIRECTORY } from './technicalNamespace.js'

// `PostSummary` and `TreeNode` are owned by the client (src/lib/api.ts). The
// server is intentionally not in the type-check graph (no tsconfig include),
// but the wire shapes still have to agree — importing the same type that the
// client uses means a future change to either side has a single source of
// truth. Path resolution works because the whole repo is processed by
// Vite/Vitest under `moduleResolution: bundler`.

async function* walk(
  dir: string,
  prefix: string,
): AsyncGenerator<{ abs: string; rel: string; isDir: boolean }> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const name = entry.name.toString()
    // Skip Nuvyn's internal directories. They are operational/history state,
    // not user content — surfacing them in the tree would leak implementation
    // details and make the public file listings depend on internal artifacts.
    // The history endpoint /api/history/* already exposes commit history
    // for the vault; users have no reason to browse .git/ from the file
    // tree. Note: `isValidSegment` in server/paths.ts already rejects any
    // path containing a dot, so user content can never legitimately live
    // inside a dot-prefixed directory — this filter is purely a hygiene
    // boundary for Nuvyn's own bookkeeping, not a security check.
    if (name === '.git' || name === NUVYN_VAULT_DIRECTORY) continue
    const abs = path.join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (entry.isDirectory()) {
      yield { abs, rel, isDir: true }
      yield* walk(abs, rel)
    } else {
      yield { abs, rel, isDir: false }
    }
  }
}

function relToPath(rel: string): string {
  // rel is e.g. "hello.md" or "notes/draft.md" — strip .md, no implicit prefix
  // (the implicit root is `src/content/`, which is handled by the caller).
  return rel.replace(/\.md$/, '')
}

function nameFromPath(p: string): string {
  return p.split('/').pop()!
}

function emptyFrontmatter(): ReturnType<typeof readFrontmatter> {
  return { tags: [], firstHeading: null, title: null, created: null, updated: null, summary: null }
}

const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

export function naturalPathCompare(a: string, b: string): number {
  return naturalCollator.compare(a, b)
}

export function readFrontmatter(file: string): {
  tags: string[]
  firstHeading: string | null
  title: string | null
  created: string | null
  updated: string | null
  summary: string | null
} {
  // Sync read is fine here — files are small and this only runs in tree-builder paths.
  // We use this for the cheap frontmatter fields (tags, title, created, updated) and the
  // first H1 — the full gray-matter parse is reserved for the single-file GET
  // where we have the content anyway. Returning defaults on any parse error
  // keeps the list endpoint resilient to a single corrupt file.
  try {
    const text = fsSync.readFileSync(file, 'utf8')
    const parsed = matter(text)
    const tags = Array.isArray(parsed.data.tags)
      ? (parsed.data.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : []
    const rawTitle = parsed.data.title
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : null
    // `created` is the new name; fall back to legacy `date` for older notes
    // that haven't been migrated. Both are optional. YAML parses unquoted
    // `YYYY-MM-DD` as a Date, so we handle that case too — round-trip
    // via toISOString gives us a stable `YYYY-MM-DD` string.
    const rawCreated = parsed.data.created ?? parsed.data.date
    let created: string | null = null
    if (typeof rawCreated === 'string' && rawCreated.trim()) {
      created = rawCreated.trim()
    } else if (rawCreated instanceof Date && !isNaN(rawCreated.getTime())) {
      created = rawCreated.toISOString().slice(0, 10)
    }
    // Legacy files may still carry `updated` in Frontmatter. Database-backed
    // callers prefer documents.updated_at and use this only as fallback.
    const rawUpdated = parsed.data.updated
    let updated: string | null = null
    if (typeof rawUpdated === 'string' && rawUpdated.trim()) {
      updated = rawUpdated.trim()
    } else if (rawUpdated instanceof Date && !isNaN(rawUpdated.getTime())) {
      updated = rawUpdated.toISOString().slice(0, 10)
    }
    const m = /^#\s+(.+)$/m.exec(text)
    // `summary` is a free-form blurb (usually 1-2 sentences) the author writes
    // for the search index and result list. The client's minisearch ranks
    // summary hits at boost=1, so empty/missing frontmatter means the note
    // never surfaces on a body-free search — see src/lib/search.ts. Keep this
    // field symmetric with title/created/updated: null when absent, trimmed
    // string when present, so callers can `?? ''` once at the API boundary.
    const rawSummary = parsed.data.summary
    const summary = typeof rawSummary === 'string' && rawSummary.trim() ? rawSummary.trim() : null
    return { tags, firstHeading: m ? m[1].trim() : null, title, created, updated, summary }
  } catch {
    return { tags: [], firstHeading: null, title: null, created: null, updated: null, summary: null }
  }
}

function titleFromFile(
  _file: string,
  fallback: string,
  firstHeading: string | null,
  fmTitle: string | null,
): string {
  // Resolution order: frontmatter.title → body's first H1 → filename.
  // Keeps the file tree in sync with the editor tab title (see
  // useEditorTabs.ts) and the H1 fallback in useMarkdownRender.ts.
  if (fmTitle) return fmTitle
  if (firstHeading) return firstHeading
  return fallback
}

export async function listPostsFlat(
  rootDir: string = CONTENT_DIR,
  metadataDb: DatabaseT | null = null,
): Promise<PostSummary[]> {
  const out: PostSummary[] = []
  for await (const entry of walk(rootDir, '')) {
    if (entry.isDir) continue
    if (!entry.rel.endsWith('.md')) continue
    const p = relToPath(entry.rel)
    const name = nameFromPath(p)
    const stat = await fs.stat(entry.abs)
    const metadata = metadataDb ? getDocumentMetadata(metadataDb, p) : null
    const isManagedDiary = classifyDiaryPath(p) === 'managed'
    // A locked Diary still exposes its SQLite-owned structural projection,
    // but generic tree/list building must not read the legacy plaintext body
    // merely to derive a heading or frontmatter fallback. If metadata has not
    // been imported yet, the filename is the safe title fallback until an
    // authorized body operation can establish the row.
    const fm = isManagedDiary ? emptyFrontmatter() : readFrontmatter(entry.abs)
    out.push({
      path: p,
      title: isManagedDiary
        ? name
        : metadata?.title ?? titleFromFile(entry.abs, name, fm.firstHeading, fm.title),
      created: metadata ? new Date(metadata.createdAt).toISOString().slice(0, 10) : fm.created ?? '',
      // SQLite is authoritative after import; legacy Frontmatter and then
      // filesystem mtime remain compatibility fallbacks.
      updated: metadata
        ? new Date(metadata.updatedAt).toISOString().slice(0, 10)
        : fm.updated ?? new Date(stat.mtimeMs).toISOString().slice(0, 10),
      tags: isManagedDiary ? [] : metadata?.tags ?? fm.tags,
      // Keep an explicit empty string for the client search index when neither
      // database metadata nor legacy Frontmatter provides a summary.
      summary: isManagedDiary ? '' : metadata?.summary ?? fm.summary ?? '',
      size: stat.size,
      mtime: stat.mtimeMs,
      ...(isManagedDiary
        ? {
            mood: metadata?.mood ?? null,
            ...(metadata
              ? { documentId: metadata.id, metadataUpdatedAt: metadata.updatedAt }
              : {}),
          }
        : {}),
    })
  }
  out.sort((a, b) => naturalPathCompare(a.path, b.path))
  return out
}

export async function listSubtreePaths(
  rootDir: string,
  folderPath: string,
): Promise<string[]> {
  // folderPath is the `path` field, e.g. "notes" or "notes/draft" — used as
  // the rel dir under rootDir.
  const absDir = path.join(rootDir, folderPath)
  try {
    await fs.stat(absDir)
  } catch {
    return []
  }
  const out: string[] = []
  for await (const entry of walk(absDir, folderPath)) {
    if (entry.isDir) continue
    if (!entry.rel.endsWith('.md')) continue
    out.push(relToPath(entry.rel))
  }
  return out
}

type MutableNode =
  | { kind: 'file'; name: string; path: string; title: string; mtime: number }
  | { kind: 'folder'; name: string; path: string; children: MutableNode[] }

export async function buildTree(
  rootDir: string = CONTENT_DIR,
  metadataDb: DatabaseT | null = null,
): Promise<TreeNode[]> {
  // Build a tree by sorting and inserting into a path-keyed node map.
  // The implicit root is `src/content/`, named "content" with `path: ''`
  // (empty, since there is no prefix segment for it).
  const nodes = new Map<string, MutableNode>()
  const rootFolder: MutableNode = {
    kind: 'folder',
    name: 'content',
    path: '',
    children: [],
  }
  nodes.set('', rootFolder)

  for await (const entry of walk(rootDir, '')) {
    if (entry.isDir) {
      // Ensure every ancestor folder exists.
      const parts = entry.rel.split('/')
      let acc = ''
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part
        if (!nodes.has(acc)) {
          nodes.set(acc, { kind: 'folder', name: part, path: acc, children: [] })
        }
      }
    } else {
      if (!entry.rel.endsWith('.md')) continue
      const p = relToPath(entry.rel)
      const name = nameFromPath(p)
      const parts = p.split('/')
      // Parent path is everything up to the file's own name, joined back together.
      const parentPath = parts.slice(0, -1).join('/')
      const parent = nodes.get(parentPath)
      if (!parent || parent.kind !== 'folder') continue
      const stat = await fs.stat(entry.abs)
      const metadata = metadataDb ? getDocumentMetadata(metadataDb, p) : null
      const isManagedDiary = classifyDiaryPath(p) === 'managed'
      const fm = isManagedDiary ? emptyFrontmatter() : readFrontmatter(entry.abs)
      parent.children.push({
        kind: 'file',
        name,
        path: p,
        title: isManagedDiary
          ? name
          : metadata?.title ?? titleFromFile(entry.abs, name, fm.firstHeading, fm.title),
        mtime: stat.mtimeMs,
      })
    }
  }

  // Wire each ancestor folder into its parent (skipping the sentinel root itself).
  for (const [nodePath, node] of nodes) {
    if (nodePath === '') continue
    if (node.kind !== 'folder') continue
    const parts = nodePath.split('/')
    const parentPath = parts.slice(0, -1).join('/')
    const parent = nodes.get(parentPath)
    if (parent && parent.kind === 'folder' && !parent.children.includes(node)) {
      parent.children.push(node)
    }
  }

  // Sort each folder's children: folders first, then files, both naturally.
  // This keeps numbered prefixes useful: ch2-* sorts before ch10-*.
  function sortChildren(n: MutableNode) {
    if (n.kind === 'folder') {
      n.children.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
        return naturalPathCompare(a.name, b.name)
      })
      n.children.forEach(sortChildren)
    }
  }
  sortChildren(rootFolder)

  return [rootFolder]
}
