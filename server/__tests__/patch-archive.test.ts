// PATCH /api/posts/* Archive Soft-Policy regression coverage.
//
// The built-in Archive action remains a convenience workflow, while ordinary
// archive descendants use the same rename/move/delete lifecycle as all other
// user documents.
//
// We mock filePathFor into a per-test tmp dir (same pattern as
// get-post.test.ts and split.test.ts) so the test never touches the
// real src/content/ vault.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import app, { __setMetadataDbForTesting } from '../index'
import { applyMigrations } from '../db'
import { getDocumentMetadata, saveDocumentMetadata } from '../documentMetadata'
import { closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth'

let tmpRoot: string
const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
applyMigrations(db)
let auth: AuthenticatedTestContext
vi.mock('../paths.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../paths.js')>()
  return {
    ...mod,
    filePathFor: (p: string) => path.join(tmpRoot, p + '.md'),
  }
})

async function patch(urlPath: string, body: unknown) {
  const req = new Request(`http://localhost${urlPath}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Cookie: auth.cookie },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

async function del(urlPath: string) {
  const req = new Request(`http://localhost${urlPath}`, { method: 'DELETE', headers: { Cookie: auth.cookie } })
  return app.fetch(req)
}

beforeEach(async () => {
  db.exec('DELETE FROM documents; DELETE FROM tags; DELETE FROM auth_sessions; DELETE FROM auth_instance; DELETE FROM users;')
  auth = createAuthenticatedTestContext({ db })
  __setMetadataDbForTesting(db)
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-patch-archive-test-'))
  await fs.mkdir(path.join(tmpRoot, 'inbox'), { recursive: true })
  await fs.mkdir(path.join(tmpRoot, 'inbox', 'draft'), { recursive: true })
  await fs.mkdir(path.join(tmpRoot, 'literature'), { recursive: true })
  await fs.mkdir(path.join(tmpRoot, 'literature', 'draft'), { recursive: true })
  await fs.mkdir(path.join(tmpRoot, 'archive'), { recursive: true })
  await fs.mkdir(path.join(tmpRoot, 'projects'), { recursive: true })
  await fs.mkdir(path.join(tmpRoot, 'archive', 'concepts'), { recursive: true })
  await fs.writeFile(path.join(tmpRoot, 'inbox', 'foo.md'), '---\ntitle: Foo\n---\n\nbody\n', 'utf8')
  await fs.writeFile(path.join(tmpRoot, 'inbox', 'draft', 'draft-foo.md'), '---\ntitle: Draft Foo\n---\n\nbody\n', 'utf8')
  await fs.writeFile(path.join(tmpRoot, 'literature', 'ahrens.md'), '---\ntitle: Ahrens\n---\n\nbody\n', 'utf8')
  await fs.writeFile(path.join(tmpRoot, 'literature', 'draft', 'draft-ahrens.md'), '---\ntitle: Draft Ahrens\n---\n\nbody\n', 'utf8')
  await fs.writeFile(path.join(tmpRoot, 'projects', 'old.md'), '---\ntitle: Old\n---\n\nbody\n', 'utf8')
  await fs.writeFile(path.join(tmpRoot, 'archive', 'perm.md'), '---\ntitle: Perm\n---\n\nbody\n', 'utf8')
})

afterEach(async () => {
  closeAuthTestContext(auth)
  __setMetadataDbForTesting(null)
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

afterAll(() => db.close())

describe('PATCH /api/posts/* Archive Soft-Policy contract', () => {
  it('moves inbox/foo.md to archive/foo.md', async () => {
    const r = await patch('/api/posts/inbox/foo', { targetPath: 'archive/foo' })
    expect(r.status).toBe(200)
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'foo.md'))).toBeTruthy()
    // Source is gone.
    await expect(fs.stat(path.join(tmpRoot, 'inbox', 'foo.md'))).rejects.toThrow()
  })

  it('moves literature/ahrens.md to archive/ahrens.md', async () => {
    const r = await patch('/api/posts/literature/ahrens', { targetPath: 'archive/ahrens' })
    expect(r.status).toBe(200)
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'ahrens.md'))).toBeTruthy()
  })

  it('moves inbox draft files to archive/<name>.md', async () => {
    const r = await patch('/api/posts/inbox/draft/draft-foo', { targetPath: 'archive/draft-foo' })
    expect(r.status).toBe(200)
    const body = await r.json() as { path: string }
    expect(body.path).toBe('archive/draft-foo')
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'draft-foo.md'))).toBeTruthy()
  })

  it('moves literature draft files to archive/<name>.md', async () => {
    const r = await patch('/api/posts/literature/draft/draft-ahrens', { targetPath: 'archive/draft-ahrens' })
    expect(r.status).toBe(200)
    const body = await r.json() as { path: string }
    expect(body.path).toBe('archive/draft-ahrens')
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'draft-ahrens.md'))).toBeTruthy()
  })

  it('appends a suffix when archiving into an existing archive path', async () => {
    await fs.writeFile(path.join(tmpRoot, 'archive', 'foo.md'), '---\ntitle: Existing Foo\n---\n\nbody\n', 'utf8')
    const r = await patch('/api/posts/inbox/foo', { targetPath: 'archive/foo' })
    expect(r.status).toBe(200)
    const body = await r.json() as { path: string }
    expect(body.path).toBe('archive/foo-2')
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'foo-2.md'))).toBeTruthy()
  })

  it('moves inbox/foo.md to a archive subfolder for classified archiving', async () => {
    const r = await patch('/api/posts/inbox/foo', { targetPath: 'archive/concepts/foo' })
    expect(r.status).toBe(200)
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'concepts', 'foo.md'))).toBeTruthy()
  })

  it('allows archive/* → archive/* reclassification', async () => {
    const r = await patch('/api/posts/archive/perm', { targetPath: 'archive/concepts/perm' })
    expect(r.status).toBe(200)
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'concepts', 'perm.md'))).toBeTruthy()
  })

  it('allows archive/* → inbox/*', async () => {
    const r = await patch('/api/posts/archive/perm', { targetPath: 'inbox/perm' })
    expect(r.status).toBe(200)
    await expect(fs.stat(path.join(tmpRoot, 'archive', 'perm.md'))).rejects.toThrow()
    expect(await fs.stat(path.join(tmpRoot, 'inbox', 'perm.md'))).toBeTruthy()
  })

  it('allows archive rename via PATCH body.name', async () => {
    const r = await patch('/api/posts/archive/perm', { name: 'renamed' })
    expect(r.status).toBe(200)
    await expect(fs.stat(path.join(tmpRoot, 'archive', 'perm.md'))).rejects.toThrow()
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'renamed.md'))).toBeTruthy()
  })

  it('allows DELETE inside archive/', async () => {
    const r = await del('/api/posts/archive/perm')
    expect(r.status).toBe(200)
    await expect(fs.stat(path.join(tmpRoot, 'archive', 'perm.md'))).rejects.toThrow()
  })

  it('does not add a case-variant archive workflow restriction', async () => {
    // Real requests reject uppercase segments in paths.ts. This mocked path
    // seam only checks that archive membership itself is not a write gate.
    await fs.mkdir(path.join(tmpRoot, 'Archive'), { recursive: true })
    await fs.writeFile(path.join(tmpRoot, 'Archive', 'perm.md'), '---\ntitle: P\n---\n\nbody\n', 'utf8')
    const r = await patch('/api/posts/Archive/perm', { targetPath: 'inbox/perm' })
    expect(r.status).toBe(200)
    await expect(fs.stat(path.join(tmpRoot, 'Archive', 'perm.md'))).rejects.toThrow()
    expect(await fs.stat(path.join(tmpRoot, 'inbox', 'perm.md'))).toBeTruthy()
  })

  it('allows projects/old.md → archive/old as an ordinary move', async () => {
    const r = await patch('/api/posts/projects/old', { targetPath: 'archive/old' })
    expect(r.status).toBe(200)
    await expect(fs.stat(path.join(tmpRoot, 'projects', 'old.md'))).rejects.toThrow()
    expect(await fs.stat(path.join(tmpRoot, 'archive', 'old.md'))).toBeTruthy()
  })

  it('still allows ordinary inbox → literature moves', async () => {
    const r = await patch('/api/posts/inbox/foo', { targetPath: 'literature/foo' })
    expect(r.status).toBe(200)
    expect(await fs.stat(path.join(tmpRoot, 'literature', 'foo.md'))).toBeTruthy()
  })

  it('preserves orphan metadata at the destination when rename fails', async () => {
    // The endpoint used to delete the destPath row BEFORE the fs.rename
    // ran, so any rename failure (cross-device, permission, etc.) left
    // the user with a wiped destPath row even though the file never
    // actually moved. Capture the orphan first and run the rename only
    // after we know it's about to succeed.
    saveDocumentMetadata(db, {
      path: 'archive/foo', title: 'Original Foo', summary: 'Important', tags: ['keep'],
    })
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated cross-device'))
    try {
      const r = await patch('/api/posts/inbox/foo', { targetPath: 'archive/foo' })
      expect(r.status).toBeGreaterThanOrEqual(500)
    } finally {
      spy.mockRestore()
    }
    expect(getDocumentMetadata(db, 'archive/foo')?.title).toBe('Original Foo')
    expect(getDocumentMetadata(db, 'archive/foo')?.tags).toEqual(['keep'])
    expect(await fs.readFile(path.join(tmpRoot, 'inbox', 'foo.md'), 'utf8')).toContain('Foo')
  })
})
