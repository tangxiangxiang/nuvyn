import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import app, { __setMetadataDbForTesting } from '../index'
import { applyMigrations } from '../db'
import {
  deleteDocumentMetadata,
  ensureDocumentMetadata,
  getDocumentMetadata,
  restoreDocumentMetadataMutation,
  saveDocumentMetadata,
  snapshotDocumentMetadataMutation,
} from '../documentMetadata'
import { ensureInitialFolders } from '../seed'
import { CONTENT_DIR, setContentDir } from '../paths'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  unlockDiaryAccessForTesting,
  withDiaryCapability,
  type AuthenticatedTestContext,
} from './helpers/auth'

const ORIGINAL_CONTENT_DIR = CONTENT_DIR

let vault: string
let db: Database.Database
let auth: AuthenticatedTestContext
let diaryCapability: string

async function write(logicalPath: string, raw: string): Promise<void> {
  const absolute = path.join(vault, `${logicalPath}.md`)
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  await fs.writeFile(absolute, raw, 'utf8')
}

async function call(method: string, urlPath: string, body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return app.fetch(withDiaryCapability(auth, request, diaryCapability))
}

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-diary-mood-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  __setMetadataDbForTesting(db)
  setContentDir(vault)
  auth = createAuthenticatedTestContext({ db })
  diaryCapability = await unlockDiaryAccessForTesting(auth)
  await ensureInitialFolders(vault)
})

afterEach(async () => {
  __setMetadataDbForTesting(null)
  closeAuthTestContext(auth)
  db.close()
  setContentDir(ORIGINAL_CONTENT_DIR)
  await fs.rm(vault, { recursive: true, force: true })
})

describe('Diary Mood live metadata', () => {
  it('does not import a raw Frontmatter mood into the SQLite owner', () => {
    const logicalPath = 'diary/2026-08-26'
    const raw = '---\nmood: happy\n---\n\n# Diary\n'

    const observed = ensureDocumentMetadata(db, logicalPath, raw, 100)

    expect(observed.mood).toBeNull()
    expect(getDocumentMetadata(db, logicalPath)?.mood).toBeNull()
  })

  it('sets, changes, and clears Mood with a required CAS version without touching Markdown', async () => {
    const logicalPath = 'diary/2026-08-24'
    const raw = '---\nmood: custom-frontmatter\n---\n\n# Diary\n'
    await write(logicalPath, raw)
    const initial = saveDocumentMetadata(db, {
      id: 'diary-mood-id',
      path: logicalPath,
      title: 'Diary',
      summary: 'Summary',
      tags: ['daily'],
      updatedAt: 100,
    })

    const set = await call('PATCH', `/api/metadata/documents/${logicalPath}`, {
      mood: 'happy', expectedUpdatedAt: initial.updatedAt,
    })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({ path: logicalPath, mood: 'happy' })
    expect(getDocumentMetadata(db, logicalPath)).toMatchObject({ mood: 'happy', tags: ['daily'] })
    expect(await fs.readFile(path.join(vault, `${logicalPath}.md`), 'utf8')).toBe(raw)

    const afterSet = getDocumentMetadata(db, logicalPath)!
    const staleSameValue = await call('PATCH', `/api/metadata/documents/${logicalPath}`, {
      mood: 'happy', expectedUpdatedAt: initial.updatedAt,
    })
    expect(staleSameValue.status).toBe(409)
    expect(await staleSameValue.json()).toMatchObject({ code: 'METADATA_VERSION_CONFLICT' })

    const clear = await call('PATCH', `/api/metadata/documents/${logicalPath}`, {
      mood: null, expectedUpdatedAt: afterSet.updatedAt,
    })
    expect(clear.status).toBe(200)
    expect(await clear.json()).toMatchObject({ path: logicalPath, mood: null })
    expect(await fs.readFile(path.join(vault, `${logicalPath}.md`), 'utf8')).toBe(raw)
  })

  it('rejects Mood writes outside canonical managed Diary dates before creating metadata', async () => {
    await write('inbox/note', '# Note\n')
    const ordinary = await call('PATCH', '/api/metadata/documents/inbox/note', {
      mood: 'happy', expectedUpdatedAt: 1,
    })
    expect(ordinary.status).toBe(400)
    expect(await ordinary.json()).toMatchObject({ code: 'INVALID_MOOD' })
    expect(getDocumentMetadata(db, 'inbox/note')).toBeNull()

    await write('diary/unmanaged', '# External\n')
    saveDocumentMetadata(db, { path: 'diary/unmanaged', title: 'External', updatedAt: 2 })
    const unmanaged = await call('PATCH', '/api/metadata/documents/diary/unmanaged', {
      mood: null, expectedUpdatedAt: 2,
    })
    expect(unmanaged.status).toBe(400)
    expect(await unmanaged.json()).toMatchObject({ code: 'INVALID_MOOD' })
    expect(getDocumentMetadata(db, 'diary/unmanaged')?.mood).toBeNull()

    await write('diary/2026-08-30', '# Invalid request\n')
    const invalid = await call('PATCH', '/api/metadata/documents/diary/2026-08-30', {
      mood: 'not-in-registry', expectedUpdatedAt: 1,
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'INVALID_MOOD' })
    expect(getDocumentMetadata(db, 'diary/2026-08-30')).toBeNull()
  })

  it('keeps an unknown stored Mood private when managed metadata writes are blocked', async () => {
    const logicalPath = 'diary/2026-08-25'
    await write(logicalPath, '# Diary\n')
    const initial = saveDocumentMetadata(db, {
      id: 'future-mood-id', path: logicalPath, title: 'Before', summary: 'Keep', tags: ['tag'], updatedAt: 10,
    })
    db.prepare('UPDATE documents SET mood = ? WHERE id = ?').run('future-mood-v3', initial.id)

    const update = await call('PATCH', `/api/metadata/documents/${logicalPath}`, { title: 'After' })
    expect(update.status).toBe(422)
    expect(await update.json()).toMatchObject({ code: 'diary-private-metadata-unsupported' })

    const tagsUpdate = await call('PATCH', `/api/metadata/documents/${logicalPath}`, {
      tags: ['next-tag'], expectedUpdatedAt: initial.updatedAt,
    })
    expect(tagsUpdate.status).toBe(422)
    expect(await tagsUpdate.json()).toMatchObject({ code: 'diary-private-metadata-unsupported' })
    expect(getDocumentMetadata(db, logicalPath)).toMatchObject({
      title: 'Before', summary: 'Keep', tags: ['tag'], mood: 'future-mood-v3',
    })

    const byId = await call('GET', `/api/metadata/documents/${initial.id}`)
    expect(await byId.json()).toMatchObject({ title: 'Before', mood: 'future-mood-v3' })
  })

  it('keeps an unknown Mood opaque in bulk projection until explicit replace or clear', async () => {
    const logicalPath = 'diary/2026-08-26'
    const raw = '# Unknown Mood projection\n'
    await write(logicalPath, raw)
    const initial = saveDocumentMetadata(db, {
      id: 'bulk-unknown-mood-id', path: logicalPath, title: 'Diary', updatedAt: 10,
    })
    db.prepare('UPDATE documents SET mood = ? WHERE id = ?').run('unknown-mood-v1', initial.id)

    const bulkResponse = await call('GET', '/api/posts')
    expect(bulkResponse.status).toBe(200)
    const posts = await bulkResponse.json() as Array<Record<string, unknown> & { path: string }>
    expect(posts.find((post) => post.path === logicalPath)).toMatchObject({
      mood: 'unknown-mood-v1',
      documentId: initial.id,
      metadataUpdatedAt: 10,
    })
    const detailResponse = await call('GET', `/api/posts/${logicalPath}`)
    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toMatchObject({
      metadata: { id: initial.id, mood: 'unknown-mood-v1' },
    })

    const replaced = await call('PATCH', `/api/metadata/documents/${logicalPath}`, {
      mood: 'happy', expectedUpdatedAt: initial.updatedAt,
    })
    expect(replaced.status).toBe(200)
    const replacedMetadata = await replaced.json() as { mood: string | null; updatedAt: number }
    expect(replacedMetadata.mood).toBe('happy')

    db.prepare('UPDATE documents SET mood = ? WHERE id = ?').run('unknown-mood-v1', initial.id)
    const opaqueVersion = getDocumentMetadata(db, logicalPath)!.updatedAt
    const cleared = await call('PATCH', `/api/metadata/documents/${logicalPath}`, {
      mood: null, expectedUpdatedAt: opaqueVersion,
    })
    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toMatchObject({ mood: null, id: initial.id })
    expect(await fs.readFile(path.join(vault, `${logicalPath}.md`), 'utf8')).toBe(raw)
  })

  it('preserves the SQL Mood and opaque Frontmatter through a body save', async () => {
    const logicalPath = 'diary/2026-08-27'
    const beforeRaw = '---\nmood: legacy-frontmatter\n---\n\n# Before\n'
    const afterRaw = '---\nmood: legacy-frontmatter\n---\n\n# After\n'
    await write(logicalPath, beforeRaw)
    const initial = saveDocumentMetadata(db, {
      id: 'body-save-mood-id',
      path: logicalPath,
      title: 'Before',
      mood: 'future-mood-v3',
      updatedAt: 20,
    })

    const response = await call('PUT', `/api/posts/${logicalPath}`, {
      raw: afterRaw,
      baseRaw: beforeRaw,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      post: {
        path: logicalPath,
        mood: 'future-mood-v3',
        documentId: initial.id,
      },
    })
    expect(await fs.readFile(path.join(vault, `${logicalPath}.md`), 'utf8')).not.toContain(afterRaw)
    const readBack = await call('GET', `/api/posts/${logicalPath}`)
    expect(await readBack.json()).toMatchObject({ raw: afterRaw, content: '\n# After\n' })
    expect(getDocumentMetadata(db, logicalPath)).toMatchObject({
      id: initial.id,
      mood: 'future-mood-v3',
    })
  })

  it('includes Mood in the existing metadata mutation snapshot rollback', async () => {
    const logicalPath = 'diary/2026-08-28'
    await write(logicalPath, '# Diary\n')
    saveDocumentMetadata(db, {
      id: 'snapshot-mood-id',
      path: logicalPath,
      title: 'Diary',
      mood: 'future-mood-v3',
      updatedAt: 30,
    })

    const snapshot = snapshotDocumentMetadataMutation(db, [logicalPath])
    saveDocumentMetadata(db, {
      id: 'snapshot-mood-id',
      path: logicalPath,
      title: 'Changed',
      mood: 'sad',
      updatedAt: 31,
    })
    restoreDocumentMetadataMutation(db, snapshot)

    expect(getDocumentMetadata(db, logicalPath)).toMatchObject({
      id: 'snapshot-mood-id',
      title: 'Diary',
      mood: 'future-mood-v3',
    })
  })

  it('removes Mood on Diary deletion and starts a recreated generation unset', async () => {
    const logicalPath = 'diary/2026-08-29'
    await write(logicalPath, '# Diary\n')
    const initial = saveDocumentMetadata(db, {
      id: 'deleted-mood-id',
      path: logicalPath,
      title: 'Original',
      mood: 'happy',
      updatedAt: 40,
    })

    expect(deleteDocumentMetadata(db, logicalPath)).toBe(true)
    expect(getDocumentMetadata(db, logicalPath)).toBeNull()

    const recreated = saveDocumentMetadata(db, {
      id: 'recreated-mood-id',
      path: logicalPath,
      title: 'Recreated',
    })
    expect(recreated.id).not.toBe(initial.id)
    expect(recreated.mood).toBeNull()
  })

  it('exposes managed Diary Mood and CAS metadata through the existing bulk PostSummary seam only', async () => {
    const diaryPath = 'diary/2026-08-26'
    await write(diaryPath, '# Diary\n')
    const metadata = saveDocumentMetadata(db, {
      id: 'bulk-diary-id', path: diaryPath, title: 'Diary', updatedAt: 123,
    })
    db.prepare('UPDATE documents SET mood = ? WHERE id = ?').run('happy', metadata.id)
    await write('inbox/note', '# Note\n')

    const response = await call('GET', '/api/posts')
    expect(response.status).toBe(200)
    const posts = await response.json() as Array<Record<string, unknown> & { path: string }>
    const diary = posts.find((post) => post.path === diaryPath)
    const note = posts.find((post) => post.path === 'inbox/note')
    expect(diary).toMatchObject({ mood: 'happy', documentId: 'bulk-diary-id', metadataUpdatedAt: 123 })
    expect(note).toBeDefined()
    expect(note).not.toHaveProperty('mood')
  })

  it('does not create an orphan metadata row for a missing future or past date', async () => {
    for (const logicalPath of ['diary/1900-01-01', 'diary/2099-12-31']) {
      const response = await call('PATCH', `/api/metadata/documents/${logicalPath}`, {
        mood: 'happy', expectedUpdatedAt: 0,
      })
      expect(response.status).toBe(404)
      expect(getDocumentMetadata(db, logicalPath)).toBeNull()
    }
  })

  it('keeps the existing Diary create authority and returns an unset Mood', async () => {
    const response = await call('POST', '/api/diary/dates', {
      date: '2026-08-24',
      timeZone: 'Asia/Shanghai',
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      date: '2026-08-24',
      path: 'diary/2026-08-24',
      created: true,
      post: {
        path: 'diary/2026-08-24',
        mood: null,
        metadataUpdatedAt: expect.any(Number),
      },
    })
    expect(getDocumentMetadata(db, 'diary/2026-08-24')?.mood).toBeNull()
  })

  it('allows Mood mutation for an already-existing future Diary document', async () => {
    const logicalPath = 'diary/2099-12-31'
    await write(logicalPath, '# Future Diary\n')
    const initial = saveDocumentMetadata(db, {
      id: 'future-diary-id', path: logicalPath, title: 'Future Diary', updatedAt: 50,
    })

    const response = await call('PATCH', `/api/metadata/documents/${logicalPath}`, {
      mood: 'happy', expectedUpdatedAt: initial.updatedAt,
    })

    // A future date is blocked only by the existing create command; an
    // already-existing canonical Diary remains a valid metadata target.
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: logicalPath, mood: 'happy' })
  })
})
