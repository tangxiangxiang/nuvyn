// GET /api/posts/* must return the markdown body with the frontmatter
// stripped, under the `content` field. The client-side full-text search
// primes its body cache from this field; if it is missing, body-only
// queries (e.g. "H3" inside a doc whose title is the first H1) silently
// return zero hits because the cache ends up as empty strings.
//
// We seed a fixture note in a temp dir and vi.mock filePathFor to point
// at it — same pattern split.test.ts uses. The test is self-contained
// and doesn't depend on any real file under src/content/.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import app, { __setMetadataDbForTesting } from '../index'
import { applyMigrations } from '../db'
import { deleteDocumentMetadata, saveDocumentMetadata } from '../documentMetadata'
import { closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth'

// `tmpRoot` is referenced inside the mock factory, which vitest hoists
// above this assignment — but the factory is a function that runs
// per-import, so it reads `tmpRoot` lazily. As long as beforeEach
// assigns it before any test runs, this is safe.
let tmpRoot: string

vi.mock('../paths.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../paths.js')>()
  return {
    ...mod,
    filePathFor: (p: string) => path.join(tmpRoot, p + '.md'),
  }
})

const FIXTURE_PATH = 'inbox/markdown-syntax'
const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
applyMigrations(db)
let auth: AuthenticatedTestContext
const FIXTURE_BODY = [
  '---',
  'title: Markdown syntax quick reference',
  'created: 2026-03-10',
  'updated: 2026-03-10',
  'tags: [markdown, reference]',
  'summary: Headings, lists, code, links — the essentials.',
  '---',
  '',
  '# H1',
  '## H2',
  '### H3',
  '',
  'body content here.',
  '',
].join('\n')

beforeAll(() => {
  __setMetadataDbForTesting(db)
  auth = createAuthenticatedTestContext({ db })
})
afterAll(() => {
  closeAuthTestContext(auth)
  __setMetadataDbForTesting(null)
  db.close()
})

beforeEach(async () => {
  deleteDocumentMetadata(db, FIXTURE_PATH)
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-get-post-test-'))
  await fs.mkdir(path.join(tmpRoot, 'inbox'), { recursive: true })
  await fs.writeFile(path.join(tmpRoot, 'inbox', 'markdown-syntax.md'), FIXTURE_BODY, 'utf8')
})

afterEach(async () => {
  deleteDocumentMetadata(db, FIXTURE_PATH)
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function get(urlPath: string) {
  const req = new Request(`http://localhost${urlPath}`, { headers: { Cookie: auth.cookie } })
  return app.fetch(req)
}

describe('GET /api/posts/*', () => {
  it('returns database metadata ahead of legacy Frontmatter', async () => {
    saveDocumentMetadata(db, {
      id: 'metadata-test', path: FIXTURE_PATH, title: 'Database title',
      summary: 'Database summary', tags: ['database'],
      createdAt: Date.UTC(2025, 0, 2), updatedAt: Date.UTC(2026, 1, 3),
    })
    const r = await get('/api/posts/' + FIXTURE_PATH)
    const body = await r.json() as {
      metadata: { id: string; title: string }
      frontmatter: Record<string, unknown>
      raw: string
    }
    expect(body.metadata).toMatchObject({ id: 'metadata-test', title: 'Database title' })
    expect(body.frontmatter).toMatchObject({
      title: 'Database title', summary: 'Database summary', tags: ['database'],
      created: '2025-01-02', updated: '2026-02-03',
    })
    expect(body.raw).toContain('title: Markdown syntax quick reference')
  })

  it('returns the markdown body with frontmatter stripped under `content`', async () => {
    const r = await get('/api/posts/' + FIXTURE_PATH)
    expect(r.status).toBe(200)
    const body = await r.json() as { raw: string; content: string; frontmatter: unknown }
    // raw is the on-disk file (frontmatter + body, intact). Windows
    // git config core.autocrlf=true writes CRLF, so the on-disk raw
    // may have \r\n line endings — accept either.
    expect(body.raw).toMatch(/^---\r?\n[\s\S]*\r?\n---\r?\n/)
    // content is the body only — the frontmatter block is gone, and
    // markdown headings are present.
    expect(body.content.startsWith('---')).toBe(false)
    expect(body.content).toMatch(/^# H1/m)
    expect(body.content).toMatch(/^### H3/m)
    // frontmatter is parsed and exposed separately.
    expect(body.frontmatter).toMatchObject({ title: 'Markdown syntax quick reference' })
  })
})
