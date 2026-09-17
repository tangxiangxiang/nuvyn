// Smoke test for POST /api/posts. Verifies body-only Markdown creation,
// database-owned metadata, and the compatible wire response.

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import app, { __setMetadataDbForTesting } from '../index'
import { CONTENT_DIR } from '../paths'
import { applyMigrations } from '../db'
import { deleteDocumentMetadata, getDocumentMetadata, snapshotDocumentMetadataDatabase } from '../documentMetadata'
import { closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth'

const TEST_PATH = 'post-smoke'
const TEST_ABS = path.join(CONTENT_DIR, 'post-smoke.md')
const db = new Database(':memory:')
db.pragma('foreign_keys = ON')
applyMigrations(db)
let auth: AuthenticatedTestContext

async function call(method: string, urlPath: string, body?: unknown) {
  const req = new Request(`http://localhost${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      Cookie: auth.cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return app.fetch(req)
}

const today = new Date().toISOString().slice(0, 10)

beforeAll(() => {
  __setMetadataDbForTesting(db)
  auth = createAuthenticatedTestContext({ db })
})

afterAll(async () => {
  closeAuthTestContext(auth)
  __setMetadataDbForTesting(null)
  await fs.rm(TEST_ABS, { force: true })
  db.close()
})

describe('POST /api/posts', () => {
  it('creates a body-only file and stores metadata in SQLite', async () => {
    const r = await call('POST', '/api/posts', { path: TEST_PATH, title: 'Smoke' })
    expect(r.status).toBe(201)

    const onDisk = await fs.readFile(TEST_ABS, 'utf8')
    expect(onDisk).toBe('# Smoke\n')
    expect(getDocumentMetadata(db, TEST_PATH)).toMatchObject({ title: 'Smoke', summary: '', tags: [] })

    // The response keeps the existing PostSummary shape for clients.
    const body = (await r.json()) as Record<string, unknown>
    expect(body.path).toBe(TEST_PATH)
    expect(body.title).toBe('Smoke')
    expect(body.created).toBe(today)
    expect(body.updated).toBe(today)
    expect(body.tags).toEqual([])
    expect(body.summary).toBe('')
  })

  it('uses the final path segment as the title when none is given', async () => {
    const path2 = 'post-no-title'
    const abs2 = path.join(CONTENT_DIR, 'post-no-title.md')
    try {
      const r = await call('POST', '/api/posts', { path: path2 })
      expect(r.status).toBe(201)
      const onDisk = await fs.readFile(abs2, 'utf8')
      expect(onDisk).toBe('# post-no-title\n')
      expect(getDocumentMetadata(db, path2)?.title).toBe('post-no-title')
    } finally {
      await fs.rm(abs2, { force: true })
      deleteDocumentMetadata(db, path2)
    }
  })

  it('rejects a path that already exists', async () => {
    // Re-using TEST_PATH from the first test — `afterAll` hasn't fired
    // yet, so the file should still be on disk.
    const r = await call('POST', '/api/posts', { path: TEST_PATH, title: 'Smoke' })
    expect(r.status).toBe(409)
  })

  it('restores file bytes and every metadata table when staged delete unlink fails', async () => {
    const metadata = getDocumentMetadata(db, TEST_PATH)!
    db.prepare(`INSERT OR REPLACE INTO metadata_migrations
      (path, document_id, original_path, status, source_hash, error, updated_at, frontmatter_backup, cleaned_hash)
      VALUES (?, ?, '', 'cleaned', '', '', 17, '', 'hash')`)
      .run(TEST_PATH, metadata.id)
    const before = snapshotDocumentMetadataDatabase(db)
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(new Error('injected staged unlink failure'))
    try {
      const response = await call('DELETE', `/api/posts/${TEST_PATH}`)
      expect(response.status).toBe(500)
      expect(await fs.readFile(TEST_ABS, 'utf8')).toBe('# Smoke\n')
      expect(snapshotDocumentMetadataDatabase(db)).toEqual(before)
    } finally {
      unlink.mockRestore()
    }
  })

  it('never overwrites a file an external writer lands between the check and the create', async () => {
    const externalAbs = path.join(CONTENT_DIR, 'ext-race.md')
    // link(2) is the create-only commit: simulate an external writer
    // landing the target in the window between the exists-check and
    // the commit. The route must report a conflict and leave the
    // external bytes untouched — never writeFile over them.
    const link = vi.spyOn(fs, 'link').mockImplementationOnce(async (_existing, newPath) => {
      await fs.writeFile(String(newPath), 'external body', 'utf8')
      throw Object.assign(new Error('link EEXIST'), { code: 'EEXIST' })
    })
    try {
      const r = await call('POST', '/api/posts', { path: 'ext-race', title: 'Race' })
      expect(r.status).toBe(409)
      expect(await fs.readFile(externalAbs, 'utf8')).toBe('external body')
      expect(getDocumentMetadata(db, 'ext-race')).toBeFalsy()
    } finally {
      link.mockRestore()
      await fs.rm(externalAbs, { force: true })
      deleteDocumentMetadata(db, 'ext-race')
    }
  })

  it('rejects a request body without a path', async () => {
    const r = await call('POST', '/api/posts', { title: 'no path' })
    expect(r.status).toBe(400)
  })

  it('rejects non-English path segments', async () => {
    const r = await call('POST', '/api/posts', { path: 'inbox/第一性原理', title: '第一性原理' })
    expect(r.status).toBe(400)
  })

  it('allows a Chinese title when the path is an English slug', async () => {
    const path2 = 'post-chinese-title'
    const abs2 = path.join(CONTENT_DIR, 'post-chinese-title.md')
    try {
      const r = await call('POST', '/api/posts', { path: path2, title: '第一性原理' })
      expect(r.status).toBe(201)
      const onDisk = await fs.readFile(abs2, 'utf8')
      expect(onDisk).toBe('# 第一性原理\n')
      expect(getDocumentMetadata(db, path2)?.title).toBe('第一性原理')
    } finally {
      await fs.rm(abs2, { force: true })
      deleteDocumentMetadata(db, path2)
    }
  })

  it('allows direct note creation inside archive/', async () => {
    const archivePath = 'archive/direct'
    const archiveAbs = path.join(CONTENT_DIR, 'archive', 'direct.md')
    try {
      const r = await call('POST', '/api/posts', { path: archivePath, title: 'Direct' })
      expect(r.status).toBe(201)
      expect(await fs.readFile(archiveAbs, 'utf8')).toBe('# Direct\n')
      expect(getDocumentMetadata(db, archivePath)?.title).toBe('Direct')
    } finally {
      await fs.rm(archiveAbs, { force: true })
      deleteDocumentMetadata(db, archivePath)
    }
  })

  it('allows organizational folder creation inside archive/', async () => {
    const folder = path.join(CONTENT_DIR, 'archive', 'concepts-test')
    try {
      const r = await call('POST', '/api/folders', { path: 'archive/concepts-test' })
      expect(r.status).toBe(201)
      await expect(fs.stat(folder)).resolves.toBeTruthy()
    } finally {
      await fs.rm(folder, { recursive: true, force: true })
    }
  })

  it('rejects case-variant Archive/ prefix before it can create a file', async () => {
    // The strict path validator rejects uppercase path segments before any
    // archive-area semantics run. This keeps the canonical namespace and
    // filesystem confinement unchanged.
    const r = await call('POST', '/api/posts', { path: 'Archive/direct', title: 'Direct' })
    expect(r.status).toBe(400)
    await expect(fs.stat(path.join(CONTENT_DIR, 'Archive', 'direct.md'))).rejects.toThrow()
  })

  it('returns 400 (not 500) for a whitespace-only title', async () => {
    // saveDocumentMetadata throws on a blank title, which used to bubble
    // out of the route as an unhandled 500. Validate at the boundary so
    // malformed client input is reported as 400.
    const abs = path.join(CONTENT_DIR, 'post-whitespace.md')
    try {
      const r = await call('POST', '/api/posts', { path: 'post-whitespace', title: '   ' })
      expect(r.status).toBe(400)
      await expect(fs.stat(abs)).rejects.toThrow()
    } finally {
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'post-whitespace')
    }
  })

  it('rejects invalid title input before creating parent directories', async () => {
    const parent = path.join(CONTENT_DIR, 'post-invalid-parent', 'nested')
    try {
      const whitespace = await call('POST', '/api/posts', {
        path: 'post-invalid-parent/nested/blank', title: '   ',
      })
      expect(whitespace.status).toBe(400)
      await expect(fs.stat(parent)).rejects.toThrow()

      const wrongType = await call('POST', '/api/posts', {
        path: 'post-invalid-parent/nested/number', title: 123,
      })
      expect(wrongType.status).toBe(400)
      await expect(fs.stat(parent)).rejects.toThrow()
    } finally {
      await fs.rm(path.join(CONTENT_DIR, 'post-invalid-parent'), { recursive: true, force: true })
    }
  })
})

describe('PUT /api/recover', () => {
  it('never removes a file an external writer lands between the check and the create', async () => {
    // The dangerous EEXIST case: the commit fails because an external
    // writer landed the SAME path with bytes identical to requestedRaw.
    // Recovery never created the target, so its catch must NOT run the
    // "remove our own write" compensation — doing so would delete the
    // external file.
    const abs = path.join(CONTENT_DIR, 'recover-race.md')
    const requestedRaw = '# recovered\n'
    const link = vi.spyOn(fs, 'link').mockImplementationOnce(async (_existing, newPath) => {
      await fs.writeFile(String(newPath), requestedRaw, 'utf8')
      throw Object.assign(new Error('link EEXIST'), { code: 'EEXIST' })
    })
    try {
      const r = await call('PUT', '/api/recover/recover-race', { raw: requestedRaw })
      expect(r.status).toBe(409)
      expect(await fs.readFile(abs, 'utf8')).toBe(requestedRaw)
      expect(getDocumentMetadata(db, 'recover-race')).toBeFalsy()
    } finally {
      link.mockRestore()
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'recover-race')
    }
  })
})

describe('DELETE /api/posts path-reuse identity', () => {
  // Path-reuse identity contract: a re-used path must NEVER inherit the
  // old documentId. When a failed delete's rollback finds the path
  // occupied by a new external generation, the old identity is dropped
  // (the new file gets a fresh one) and the old generation stays
  // quarantined under its staging name. When the path is still empty,
  // the old file AND its identity are restored.
  it('gives a re-used path a fresh documentId and quarantines the old generation', async () => {
    const documentPath = 'delete-reuse'
    const abs = path.join(CONTENT_DIR, `${documentPath}.md`)
    await fs.rm(abs, { force: true })
    const created = await call('POST', '/api/posts', { path: documentPath, title: 'Old' })
    expect(created.status).toBe(201)
    const oldId = getDocumentMetadata(db, documentPath)!.id

    // The staged unlink fails AND an external writer recreates the path
    // with a new generation inside the failure window.
    const unlink = vi.spyOn(fs, 'unlink').mockImplementationOnce(async () => {
      await fs.writeFile(abs, '# new generation\n', 'utf8')
      throw Object.assign(new Error('injected staged unlink failure'), { code: 'EIO' })
    })
    try {
      const response = await call('DELETE', `/api/posts/${documentPath}`)
      expect(response.status).toBe(500)
      // The new generation keeps its bytes and must NOT inherit oldId.
      expect(await fs.readFile(abs, 'utf8')).toBe('# new generation\n')
      const metadata = getDocumentMetadata(db, documentPath)
      expect(metadata).not.toBeNull()
      expect(metadata!.id).not.toBe(oldId)
      // The old generation survives quarantined under its staging name.
      const quarantined = (await fs.readdir(CONTENT_DIR))
        .filter((name) => name.startsWith(`${documentPath}.md.nuvyn-quarantine-reuse-`))
      expect(quarantined).toHaveLength(1)
      expect(await fs.readFile(path.join(CONTENT_DIR, quarantined[0]!), 'utf8')).toBe('# Old\n')
    } finally {
      unlink.mockRestore()
      for (const name of await fs.readdir(CONTENT_DIR)) {
        if (name.startsWith(`${documentPath}.md.nuvyn-quarantine-reuse-`)) {
          await fs.rm(path.join(CONTENT_DIR, name), { force: true })
        }
      }
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, documentPath)
    }
  })

  it('restores the old file and its identity when the path stays empty', async () => {
    const documentPath = 'delete-empty-path'
    const abs = path.join(CONTENT_DIR, `${documentPath}.md`)
    await fs.rm(abs, { force: true })
    const created = await call('POST', '/api/posts', { path: documentPath, title: 'Keep' })
    expect(created.status).toBe(201)
    const oldId = getDocumentMetadata(db, documentPath)!.id
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('injected staged unlink failure'), { code: 'EIO' }),
    )
    try {
      const response = await call('DELETE', `/api/posts/${documentPath}`)
      expect(response.status).toBe(500)
      // Create-only restore succeeded: same bytes, same identity.
      expect(await fs.readFile(abs, 'utf8')).toBe('# Keep\n')
      expect(getDocumentMetadata(db, documentPath)!.id).toBe(oldId)
      expect((await fs.readdir(CONTENT_DIR))
        .some((name) => name.startsWith(`${documentPath}.md.nuvyn-delete-`))).toBe(false)
    } finally {
      unlink.mockRestore()
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, documentPath)
    }
  })
})
