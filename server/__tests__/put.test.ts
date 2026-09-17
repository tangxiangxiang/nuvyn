import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs, writeFileSync } from 'node:fs'
import path from 'node:path'
import app, { __setMetadataDbForTesting } from '../index'
import { CONTENT_DIR } from '../paths'
import { applyMigrations } from '../db'
import {
  deleteDocumentMetadata,
  getDocumentMetadata,
  saveDocumentMetadata,
  snapshotDocumentMetadataDatabase,
} from '../documentMetadata'
import type { SavePostResult } from '../../src/lib/api'
import { closeAuthTestContext, createAuthenticatedTestContext, type AuthenticatedTestContext } from './helpers/auth'

const TEST_PATH = 'put-smoke.md'
const TEST_ABS = path.join(CONTENT_DIR, 'put-smoke.md')
const ORIGINAL = '---\ntitle: smoke\n---\n\noriginal\n'
const UPDATED_BODY = '---\ntitle: smoke\n---\n\nupdated content\n'
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

describe('PUT /api/posts/* (Task 7 smoke)', () => {
  beforeAll(async () => {
    __setMetadataDbForTesting(db)
    auth = createAuthenticatedTestContext({ db })
    await fs.mkdir(CONTENT_DIR, { recursive: true })
    await fs.writeFile(TEST_ABS, ORIGINAL, 'utf8')
  })

  afterAll(async () => {
    closeAuthTestContext(auth)
    __setMetadataDbForTesting(null)
    await fs.rm(TEST_ABS, { force: true })
    db.close()
  })

  it('writes raw content verbatim and updates metadata', async () => {
    saveDocumentMetadata(db, {
      path: 'put-smoke',
      title: 'Database title',
      summary: 'Database summary',
      tags: ['metadata', 'save'],
      createdAt: Date.UTC(2025, 0, 2),
      updatedAt: Date.UTC(2025, 0, 3),
    })
    const r = await call('PUT', '/api/posts/put-smoke', {
      raw: UPDATED_BODY,
      baseRaw: ORIGINAL,
    })
    expect(r.status).toBe(200)
    const onDisk = await fs.readFile(TEST_ABS, 'utf8')
    // Content is byte-for-byte what the client submitted.
    expect(onDisk).toBe(UPDATED_BODY)
    const metadata = getDocumentMetadata(db, 'put-smoke')!
    expect(metadata.title).toBe('Database title')
    // The response mirrors the bytes persisted on disk.
    const body = (await r.json()) as SavePostResult
    const stat = await fs.stat(TEST_ABS)
    expect(body.ok).toBe(true)
    expect(body.raw).toBe(onDisk)
    expect(body.post).toEqual({
      path: 'put-smoke',
      title: metadata.title,
      created: new Date(metadata.createdAt).toISOString().slice(0, 10),
      updated: new Date(metadata.updatedAt).toISOString().slice(0, 10),
      tags: metadata.tags,
      summary: metadata.summary,
      size: stat.size,
      mtime: stat.mtimeMs,
    })
    expect(body.post).not.toHaveProperty('updatedReferences')
  })

  it('returns 404 for non-existent file', async () => {
    const r = await call('PUT', '/api/posts/does-not-exist-xyz', { raw: 'x', baseRaw: '' })
    expect(r.status).toBe(404)
  })

  it('rejects body without raw string', async () => {
    const r = await call('PUT', '/api/posts/put-smoke', { foo: 'bar' })
    expect(r.status).toBe(400)
  })

  it('recovers a deleted document even when its metadata was removed', async () => {
    const documentPath = 'put-ai-deleted'
    const abs = path.join(CONTENT_DIR, `${documentPath}.md`)
    const raw = '# Restored from the editor\n\nLast copy.\n'
    await fs.rm(abs, { force: true })
    deleteDocumentMetadata(db, documentPath)

    const response = await call('PUT', `/api/recover/${documentPath}`, { raw })

    expect(response.status).toBe(200)
    expect(await fs.readFile(abs, 'utf8')).toBe(raw)
    const metadata = getDocumentMetadata(db, documentPath)
    expect(metadata).not.toBeNull()
    const body = await response.json() as {
      ok: true
      raw: string
      mtime: number
      post: SavePostResult['post']
    }
    const stat = await fs.stat(abs)
    expect(body).toMatchObject({
      ok: true,
      raw,
      mtime: stat.mtimeMs,
      post: {
        path: documentPath,
        title: metadata!.title,
        size: stat.size,
        mtime: stat.mtimeMs,
      },
    })

    await fs.rm(abs, { force: true })
    deleteDocumentMetadata(db, documentPath)
  })

  it('does not remove a newer external body when recovery metadata creation fails', async () => {
    const documentPath = 'put-recover-external'
    const abs = path.join(CONTENT_DIR, `${documentPath}.md`)
    const requested = '# Recovered A\n'
    const external = '# External B\n'
    await fs.rm(abs, { force: true })
    deleteDocumentMetadata(db, documentPath)
    db.function('write_external_recover_body', () => {
      writeFileSync(abs, external, 'utf8')
      return 1
    })
    db.exec(`
      CREATE TRIGGER fail_recover_metadata_insert
      BEFORE INSERT ON documents
      WHEN NEW.path = '${documentPath}'
      BEGIN
        SELECT write_external_recover_body();
        SELECT RAISE(ABORT, 'forced recover metadata failure');
      END;
    `)
    try {
      const response = await call('PUT', `/api/recover/${documentPath}`, { raw: requested })

      expect(response.status).toBe(500)
      expect(await fs.readFile(abs, 'utf8')).toBe(external)
      expect(getDocumentMetadata(db, documentPath)).toBeNull()
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_recover_metadata_insert')
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, documentPath)
    }
  })

  it('restores the file and complete metadata graph when cleaned-write tracking fails', async () => {
    const documentPath = 'put-track-failure'
    const abs = path.join(CONTENT_DIR, `${documentPath}.md`)
    const original = '# Original\n'
    const requested = '# Requested\n'
    await fs.writeFile(abs, original, 'utf8')
    const metadata = saveDocumentMetadata(db, {
      id: 'put-track-stable-id', path: documentPath, title: 'Stable', tags: ['stable'], updatedAt: 10,
    })
    db.prepare(`INSERT INTO metadata_migrations
      (path, document_id, status, source_hash, cleaned_hash, error, updated_at)
      VALUES (?, ?, 'cleaned', 'source', 'old-cleaned-hash', '', 10)`)
      .run(documentPath, metadata.id)
    const before = snapshotDocumentMetadataDatabase(db)
    db.exec(`
      CREATE TRIGGER fail_put_cleaned_tracking
      BEFORE UPDATE OF cleaned_hash ON metadata_migrations
      WHEN OLD.path = '${documentPath}'
      BEGIN
        SELECT RAISE(ABORT, 'forced cleaned tracking failure');
      END;
    `)
    try {
      const response = await call('PUT', `/api/posts/${documentPath}`, {
        raw: requested,
        baseRaw: original,
      })

      expect(response.status).toBe(500)
      expect(await fs.readFile(abs, 'utf8')).toBe(original)
      expect(snapshotDocumentMetadataDatabase(db)).toEqual(before)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_put_cleaned_tracking')
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, documentPath)
    }
  })

  it('rejects body without an exact baseRaw string', async () => {
    const r = await call('PUT', '/api/posts/put-smoke', { raw: 'new value' })
    expect(r.status).toBe(400)
    expect(await fs.readFile(TEST_ABS, 'utf8')).toBe(UPDATED_BODY)
  })

  it('returns a typed conflict without changing content or metadata', async () => {
    const metadataBefore = getDocumentMetadata(db, 'put-smoke')
    const r = await call('PUT', '/api/posts/put-smoke', {
      raw: 'client edit',
      baseRaw: ORIGINAL,
    })

    expect(r.status).toBe(409)
    const body = await r.json()
    const stat = await fs.stat(TEST_ABS)
    expect(body).toEqual({
      error: 'document changed on disk',
      code: 'EDIT_CONFLICT',
      current: {
        raw: UPDATED_BODY,
        mtime: stat.mtimeMs,
        size: stat.size,
      },
    })
    expect(await fs.readFile(TEST_ABS, 'utf8')).toBe(UPDATED_BODY)
    expect(getDocumentMetadata(db, 'put-smoke')).toEqual(metadataBefore)
    // Scoped to this file's own temp prefix: other suites share the
    // real CONTENT_DIR under parallel workers, and their in-flight
    // temps are not this route's leak.
    expect((await fs.readdir(CONTENT_DIR)).some((name) => name.startsWith('.put-smoke.md.nuvyn-save-'))).toBe(false)
  })

  it('treats an already-present requested body as an idempotent success', async () => {
    const r = await call('PUT', '/api/posts/put-smoke', {
      raw: UPDATED_BODY,
      baseRaw: ORIGINAL,
    })

    expect(r.status).toBe(200)
    const body = (await r.json()) as SavePostResult
    expect(body.ok).toBe(true)
    expect(body.raw).toBe(UPDATED_BODY)
    expect(body.post.path).toBe('put-smoke')
    expect(await fs.readFile(TEST_ABS, 'utf8')).toBe(UPDATED_BODY)
  })

  it('returns a conflict when an idempotent candidate changes during snapshot validation', async () => {
    const external = 'external C'
    await fs.writeFile(TEST_ABS, UPDATED_BODY, 'utf8')
    const originalReadFile = fs.readFile.bind(fs)
    const readFile = vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
      const raw = await originalReadFile(...args)
      await fs.writeFile(TEST_ABS, external, 'utf8')
      return raw
    })
    try {
      const r = await call('PUT', '/api/posts/put-smoke', {
        raw: UPDATED_BODY,
        baseRaw: ORIGINAL,
      })

      expect(r.status).toBe(409)
      expect(await r.json()).toMatchObject({
        code: 'EDIT_CONFLICT',
        current: { raw: external },
      })
      expect(await fs.readFile(TEST_ABS, 'utf8')).toBe(external)
    } finally {
      readFile.mockRestore()
      await fs.writeFile(TEST_ABS, UPDATED_BODY, 'utf8')
    }
  })

  it('fails closed without renaming when the disk snapshot never stabilizes', async () => {
    await fs.writeFile(TEST_ABS, UPDATED_BODY, 'utf8')
    const readFile = vi.spyOn(fs, 'readFile')
      .mockResolvedValueOnce(UPDATED_BODY)
      .mockResolvedValueOnce('external C')
      .mockResolvedValueOnce(UPDATED_BODY)
      .mockResolvedValueOnce('external C')
      .mockResolvedValueOnce(UPDATED_BODY)
      .mockResolvedValueOnce('external C')
    const rename = vi.spyOn(fs, 'rename')

    try {
      const r = await call('PUT', '/api/posts/put-smoke', {
        raw: 'requested B',
        baseRaw: UPDATED_BODY,
      })

      expect(r.status).toBe(409)
      expect(await r.json()).toMatchObject({
        code: 'EDIT_CONFLICT',
        current: { raw: 'external C' },
      })
      expect(readFile).toHaveBeenCalledTimes(6)
      expect(rename).not.toHaveBeenCalled()
    } finally {
      readFile.mockRestore()
      rename.mockRestore()
    }
    expect(await fs.readFile(TEST_ABS, 'utf8')).toBe(UPDATED_BODY)
  })

  it('preserves an external save that lands in the final commit window (409, no overwrite)', async () => {
    // The reviewer scenario for the PUT save path: the file holds base,
    // the server verified base and prepared the new body, and an
    // external writer saves in the final window before the commit
    // touches the path. The ownership-verified commit must detect the
    // external generation and fail closed with a typed conflict — the
    // external bytes are never overwritten and no intermediate files
    // are left behind.
    const abs = path.join(CONTENT_DIR, 'put-final-window.md')
    const base = '# base\n'
    const nuvyn = '# nuvyn save\n'
    const external = '# external\n'
    await fs.writeFile(abs, base, 'utf8')
    const originalRename = fs.rename.bind(fs)
    // The commit's FIRST step is the takeover rename of the current
    // generation; an external save landing right before it must travel
    // with the generation into staging and be detected there.
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      writeFileSync(abs, external, 'utf8')
      return originalRename(from, to)
    })
    try {
      const r = await call('PUT', '/api/posts/put-final-window', {
        raw: nuvyn,
        baseRaw: base,
      })

      expect(r.status).toBe(409)
      expect(await r.json()).toMatchObject({
        code: 'EDIT_CONFLICT',
        current: { raw: external },
      })
      expect(await fs.readFile(abs, 'utf8')).toBe(external)
      const names = await fs.readdir(CONTENT_DIR)
      expect(names.some((name) => name.startsWith('.put-final-window.md.nuvyn-save-'))).toBe(false)
      expect(names.some((name) => name.startsWith('.put-final-window.md.nuvyn-staged-'))).toBe(false)
    } finally {
      rename.mockRestore()
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'put-final-window')
    }
  })

  it('serializes concurrent writes to the same document baseline', async () => {
    const abs = path.join(CONTENT_DIR, 'put-concurrent.md')
    const initial = 'A'
    await fs.writeFile(abs, initial, 'utf8')
    try {
      const responses = await Promise.all([
        call('PUT', '/api/posts/put-concurrent', { raw: 'B', baseRaw: initial }),
        call('PUT', '/api/posts/put-concurrent', { raw: 'C', baseRaw: initial }),
      ])
      const statuses = responses.map((response) => response.status).sort()
      expect(statuses).toEqual([200, 409])
      const successfulIndex = responses.findIndex((response) => response.status === 200)
      expect(await fs.readFile(abs, 'utf8')).toBe(successfulIndex === 0 ? 'B' : 'C')
      expect((await fs.readdir(CONTENT_DIR)).some((name) => name.startsWith('.put-concurrent.md.nuvyn-save-'))).toBe(false)
    } finally {
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'put-concurrent')
    }
  })

  it('atomically restores the previous body when metadata update fails after replacement', async () => {
    const abs = path.join(CONTENT_DIR, 'put-metadata-rollback.md')
    const original = '# Original\n'
    await fs.writeFile(abs, original, 'utf8')
    saveDocumentMetadata(db, {
      path: 'put-metadata-rollback',
      title: 'Rollback',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    db.exec(`
      CREATE TABLE put_metadata_update_count (count INTEGER NOT NULL);
      INSERT INTO put_metadata_update_count VALUES (0);
      CREATE TRIGGER fail_put_metadata_update
      BEFORE UPDATE ON documents
      BEGIN
        UPDATE put_metadata_update_count SET count = count + 1;
        SELECT CASE
          WHEN (SELECT count FROM put_metadata_update_count) >= 1
          THEN RAISE(ABORT, 'forced metadata failure')
        END;
      END;
    `)
    try {
      const r = await call('PUT', '/api/posts/put-metadata-rollback', {
        raw: '# Replacement\n',
        baseRaw: original,
      })

      expect(r.status).toBe(500)
      expect(await fs.readFile(abs, 'utf8')).toBe(original)
      expect((await fs.readdir(CONTENT_DIR)).some((name) => name.startsWith('.put-metadata-rollback.md.nuvyn-save-'))).toBe(false)
    } finally {
      db.exec(`
        DROP TRIGGER IF EXISTS fail_put_metadata_update;
        DROP TABLE IF EXISTS put_metadata_update_count;
      `)
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'put-metadata-rollback')
    }
  })

  it('does not roll metadata failure back over a newer external body', async () => {
    const abs = path.join(CONTENT_DIR, 'put-metadata-external.md')
    const original = '# Original\n'
    const requested = '# Replacement\n'
    const external = '# External\n'
    await fs.writeFile(abs, original, 'utf8')
    saveDocumentMetadata(db, {
      path: 'put-metadata-external',
      title: 'External rollback guard',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    db.function('write_external_body_for_put_test', () => {
      writeFileSync(abs, external, 'utf8')
      return 1
    })
    db.exec(`
      CREATE TABLE put_external_update_count (count INTEGER NOT NULL);
      INSERT INTO put_external_update_count VALUES (0);
      CREATE TRIGGER fail_put_external_update
      BEFORE UPDATE ON documents
      BEGIN
        SELECT CASE
          WHEN (SELECT count FROM put_external_update_count) >= 0
          THEN write_external_body_for_put_test()
        END;
        UPDATE put_external_update_count SET count = count + 1;
        SELECT CASE
          WHEN (SELECT count FROM put_external_update_count) >= 1
          THEN RAISE(ABORT, 'forced metadata failure after external write')
        END;
      END;
    `)
    try {
      const r = await call('PUT', '/api/posts/put-metadata-external', {
        raw: requested,
        baseRaw: original,
      })

      expect(r.status).toBe(500)
      expect(await fs.readFile(abs, 'utf8')).toBe(external)
      expect((await fs.readdir(CONTENT_DIR)).some((name) => name.startsWith('.put-metadata-external.md.nuvyn-save-'))).toBe(false)
    } finally {
      db.exec(`
        DROP TRIGGER IF EXISTS fail_put_external_update;
        DROP TABLE IF EXISTS put_external_update_count;
      `)
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'put-metadata-external')
    }
  })

  it('does not insert or replace legacy updated fields', async () => {
    // Pre-write a file that already has an `updated` line, then PUT
    // a body without one — the server should overwrite, not stack.
    const abs = path.join(CONTENT_DIR, 'put-replace.md')
    await fs.writeFile(
      abs,
      `---\ntitle: replace\nupdated: 2020-01-01\n---\n\nbody\n`,
      'utf8',
    )
    try {
      const r = await call('PUT', '/api/posts/put-replace', {
        raw: '---\ntitle: replace\n---\n\nbody\n',
        baseRaw: `---\ntitle: replace\nupdated: 2020-01-01\n---\n\nbody\n`,
      })
      expect(r.status).toBe(200)
      const onDisk = await fs.readFile(abs, 'utf8')
      expect(onDisk).toBe('---\ntitle: replace\n---\n\nbody\n')
      expect(getDocumentMetadata(db, 'put-replace')?.title).toBe('replace')
    } finally {
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'put-replace')
    }
  })

  it('keeps body-only files free of Frontmatter', async () => {
    const abs = path.join(CONTENT_DIR, 'put-no-fm.md')
    await fs.writeFile(abs, '# Body only, no frontmatter\n', 'utf8')
    try {
      const r = await call('PUT', '/api/posts/put-no-fm', {
        raw: '# Body only, no frontmatter\n',
        baseRaw: '# Body only, no frontmatter\n',
      })
      expect(r.status).toBe(200)
      const onDisk = await fs.readFile(abs, 'utf8')
      expect(onDisk).toBe('# Body only, no frontmatter\n')
      expect(getDocumentMetadata(db, 'put-no-fm')?.title).toBe('Body only, no frontmatter')
    } finally {
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'put-no-fm')
    }
  })

  it('imports legacy metadata before Frontmatter is removed', async () => {
    const abs = path.join(CONTENT_DIR, 'put-import-before-clean.md')
    await fs.writeFile(abs, [
      '---',
      'title: Imported title',
      'summary: Imported summary',
      'tags: [legacy, keep]',
      '---',
      '',
      '# Body title',
      '',
    ].join('\n'), 'utf8')
    try {
      const raw = '# Body title\n'
      const baseRaw = await fs.readFile(abs, 'utf8')
      const r = await call('PUT', '/api/posts/put-import-before-clean', { raw, baseRaw })
      expect(r.status).toBe(200)
      expect(await fs.readFile(abs, 'utf8')).toBe(raw)
      expect(getDocumentMetadata(db, 'put-import-before-clean')).toMatchObject({
        title: 'Imported title',
        summary: 'Imported summary',
        tags: ['keep', 'legacy'],
      })
    } finally {
      await fs.rm(abs, { force: true })
      deleteDocumentMetadata(db, 'put-import-before-clean')
    }
  })

  it('restores original content verbatim for downstream tests', async () => {
    const r = await call('PUT', '/api/posts/put-smoke', {
      raw: ORIGINAL,
      baseRaw: UPDATED_BODY,
    })
    expect(r.status).toBe(200)
    const onDisk = await fs.readFile(TEST_ABS, 'utf8')
    expect(onDisk).toBe(ORIGINAL)
  })
})
