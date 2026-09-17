import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import app, { __setMetadataDbForTesting } from '../index'
import { applyMigrations } from '../db'
import { ensureInitialFolders } from '../seed'
import { deleteDocumentMetadata, getDocumentMetadata, patchDocumentMetadata } from '../documentMetadata'
import { __resetLinkIndexForTesting, getIndex, LinkIndex } from '../linkIndex'
import { __setManagedDiaryDeleteTestHooksForTesting } from '../diaryAccess/delete'
import { CONTENT_DIR, setContentDir } from '../paths'
import { localDiaryDateForTimeZone } from '../routes/diary'
import { __setAtomicWriteTestHooksForTesting } from '../atomicTextWrite'
import { DIARY_BODY_ENVELOPE_MAGIC } from '../diaryAccess/body'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  jsonRequest,
  unlockDiaryAccessForTesting,
  withAuthCookie,
  withDiaryCapability,
  type AuthenticatedTestContext,
} from './helpers/auth'

const ORIGINAL_CONTENT_DIR = CONTENT_DIR
const TIME_ZONE = 'Asia/Shanghai'

let vault: string
let db: Database.Database
let auth: AuthenticatedTestContext
let diaryCapability: string

async function call(method: string, urlPath: string, body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost${urlPath}`, {
    method,
    headers: {
      Origin: auth.runtime.config.publicOrigin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return app.fetch(withDiaryCapability(auth, request, diaryCapability))
}

async function callWithoutDiaryCapability(method: string, urlPath: string, body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return app.fetch(withAuthCookie(auth, request))
}

function today(): string {
  return localDiaryDateForTimeZone(new Date(), TIME_ZONE)
}

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-diary-route-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  __setMetadataDbForTesting(db)
  setContentDir(vault)
  auth = createAuthenticatedTestContext({ db })
  diaryCapability = await unlockDiaryAccessForTesting(auth)
  __resetLinkIndexForTesting()
  await ensureInitialFolders(vault)
})

afterEach(async () => {
  __setMetadataDbForTesting(null)
  closeAuthTestContext(auth)
  db.close()
  setContentDir(ORIGINAL_CONTENT_DIR)
  __resetLinkIndexForTesting()
  __setAtomicWriteTestHooksForTesting(null)
  __setManagedDiaryDeleteTestHooksForTesting(null)
  await fs.rm(vault, { recursive: true, force: true })
})

describe('POST /api/diary/dates', () => {
  it('creates today at the exact date-derived path', async () => {
    const date = today()
    const response = await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      date,
      path: `diary/${date}`,
      created: true,
      post: { path: `diary/${date}` },
    })
    await expect(fs.readFile(path.join(vault, 'diary', `${date}.md`), 'utf8'))
      .resolves.not.toContain(`# ${date}`)
    const body = await call('GET', `/api/posts/diary/${date}`)
    expect(await body.json()).toMatchObject({ raw: `# ${date}\n`, content: `# ${date}\n` })
    expect(getDocumentMetadata(db, `diary/${date}`)).not.toBeNull()
  })

  it('returns the existing exact identity instead of creating a duplicate', async () => {
    const date = today()
    const first = await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })
    const firstBody = await first.json() as { post: { path: string; mtime: number } }
    const second = await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      date,
      path: `diary/${date}`,
      created: false,
      post: { path: firstBody.post.path, mtime: firstBody.post.mtime },
    })
    expect((await fs.readdir(path.join(vault, 'diary'))).filter(name => name.endsWith('.md')))
      .toEqual([`${date}.md`])
  })

  it('fails closed for an encrypted Diary whose metadata identity is missing', async () => {
    const date = '2000-02-28'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const diaryPath = path.join(vault, 'diary', `${date}.md`)
    const encryptedBefore = await fs.readFile(diaryPath)

    deleteDocumentMetadata(db, `diary/${date}`)
    const response = await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'diary-body-identity-mismatch' })
    expect(getDocumentMetadata(db, `diary/${date}`)).toBeNull()
    expect(await fs.readFile(diaryPath)).toEqual(encryptedBefore)
  })

  it('creates a missing past date and rejects a missing future without a file', async () => {
    const past = '2000-02-29'
    const future = '2999-12-31'
    const pastResponse = await call('POST', '/api/diary/dates', { date: past, timeZone: TIME_ZONE })
    const futureResponse = await call('POST', '/api/diary/dates', { date: future, timeZone: TIME_ZONE })

    expect(pastResponse.status).toBe(201)
    expect(futureResponse.status).toBe(422)
    expect(await futureResponse.json()).toMatchObject({ code: 'future-diary-date' })
    await expect(fs.stat(path.join(vault, 'diary', `${past}.md`))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(vault, 'diary', `${future}.md`))).rejects.toThrow()
  })

  it('returns an existing future Diary without creating a second identity', async () => {
    const date = '2999-12-30'
    const absolute = path.join(vault, 'diary', `${date}.md`)
    await fs.writeFile(absolute, '# future\n', 'utf8')

    const response = await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ created: false, path: `diary/${date}` })
    expect(await fs.readFile(absolute, 'utf8')).toBe('# future\n')
  })

  it('rejects malformed dates, invalid timezones, and path-shaped identity input', async () => {
    const invalidDate = await call('POST', '/api/diary/dates', { date: '2026-02-31', timeZone: TIME_ZONE })
    const invalidTimeZone = await call('POST', '/api/diary/dates', { date: today(), timeZone: 'Not/A-Timezone' })
    const pathIdentity = await call('POST', '/api/diary/dates', { path: 'diary/2026-08-24', timeZone: TIME_ZONE })

    expect(invalidDate.status).toBe(400)
    expect(invalidTimeZone.status).toBe(400)
    expect(pathIdentity.status).toBe(400)
  })

  it('linearizes concurrent requests to one exact physical file with no suffix', async () => {
    const date = '2000-03-01'
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })),
    )
    const bodies = await Promise.all(responses.map(response => response.json() as Promise<{ path: string }>))

    expect(responses.filter(response => response.status === 201)).toHaveLength(1)
    expect(responses.filter(response => response.status === 200)).toHaveLength(7)
    expect(new Set(bodies.map(body => body.path))).toEqual(new Set([`diary/${date}`]))
    expect((await fs.readdir(path.join(vault, 'diary'))).filter(name => name.endsWith('.md')))
      .toEqual([`${date}.md`])
    expect(await fs.readFile(path.join(vault, 'diary', `${date}.md`), 'utf8')).not.toContain(`# ${date}`)
  })

  it('keeps private body sentinels out of the final and temporary physical representations', async () => {
    const date = '2000-03-02'
    const sentinel = 'D8_2_PRIVATE_BODY_SENTINEL'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const current = await call('GET', `/api/posts/diary/${date}`)
    const currentRaw = (await current.json() as { raw: string }).raw
    let temporaryPath: string | null = null
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    __setAtomicWriteTestHooksForTesting({
      afterTemporaryCloseBeforeIdentity: async (pathName) => {
        temporaryPath = pathName
        await paused
      },
    })
    const save = call('PUT', `/api/posts/diary/${date}`, {
      raw: `${currentRaw}${sentinel}\n`,
      baseRaw: currentRaw,
    })
    while (temporaryPath === null) await new Promise<void>((resolve) => setImmediate(resolve))
    const temporary = await fs.readFile(temporaryPath, 'utf8')
    expect(temporary).toContain(DIARY_BODY_ENVELOPE_MAGIC)
    expect(temporary).not.toContain(sentinel)
    release()
    expect((await save).status).toBe(200)
    expect(await fs.readFile(path.join(vault, 'diary', `${date}.md`), 'utf8')).not.toContain(sentinel)
    expect((await (await call('GET', `/api/posts/diary/${date}`)).json() as { raw: string }).raw)
      .toContain(sentinel)
  })

  it('restores metadata when encrypted Diary preparation fails before a file is created', async () => {
    const date = '2000-03-03'
    __setAtomicWriteTestHooksForTesting({
      afterParentIdentityBeforeTemporaryOpen: () => { throw new Error('D8_2_TEMP_SENTINEL prepare failure') },
    })
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(500)
    expect(getDocumentMetadata(db, `diary/${date}`)).toBeNull()
    await expect(fs.stat(path.join(vault, 'diary', `${date}.md`))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back the exact encrypted generation when a failure follows create commit', async () => {
    const date = '2000-03-04'
    __setAtomicWriteTestHooksForTesting({
      afterCreateCommitBeforeCleanup: () => { throw new Error('D8_3_POST_COMMIT_CREATE_SENTINEL') },
    })

    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(500)
    expect(getDocumentMetadata(db, `diary/${date}`)).toBeNull()
    await expect(fs.stat(path.join(vault, 'diary', `${date}.md`))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Diary REST mutation contract', () => {
  it('does not complete auth logout before an active encrypted Diary save finishes', async () => {
    const date = '2000-05-02'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const current = await call('GET', `/api/posts/diary/${date}`)
    const currentRaw = (await current.json() as { raw: string }).raw
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    let temporaryPath: string | null = null
    __setAtomicWriteTestHooksForTesting({
      afterTemporaryCloseBeforeIdentity: async (pathName) => {
        temporaryPath = pathName
        await paused
      },
    })

    const save = call('PUT', `/api/posts/diary/${date}`, {
      raw: `${currentRaw}save-before-logout\n`,
      baseRaw: currentRaw,
    })
    while (temporaryPath === null) await new Promise<void>((resolve) => setImmediate(resolve))

    let logoutSettled = false
    const logout = app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST',
      origin: auth.runtime.config.publicOrigin,
      cookie: auth.cookie,
    })).then((response) => {
      logoutSettled = true
      return response
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(logoutSettled).toBe(false)

    release()
    expect((await save).status).toBe(200)
    expect((await logout).status).toBe(204)
    expect(logoutSettled).toBe(true)
  })

  it('fails closed for managed body reads and date resolution without Diary capability while keeping structural listing available', async () => {
    const date = '2000-05-01'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)

    const body = await callWithoutDiaryCapability('GET', `/api/posts/diary/${date}`)
    const resolve = await callWithoutDiaryCapability('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })
    const listing = await callWithoutDiaryCapability('GET', '/api/posts')

    expect(body.status).toBe(423)
    expect(await body.json()).toMatchObject({ code: 'diary-locked' })
    expect(resolve.status).toBe(423)
    expect(await resolve.json()).toMatchObject({ code: 'diary-locked' })
    expect(listing.status).toBe(200)
    expect((await listing.json()).map((post: { path: string }) => post.path)).toContain(`diary/${date}`)
  })

  it('keeps SQLite-owned Mood metadata editable without a Diary body capability', async () => {
    const date = '2000-05-02'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const current = getDocumentMetadata(db, `diary/${date}`)
    expect(current).not.toBeNull()

    const response = await callWithoutDiaryCapability('PATCH', `/api/metadata/documents/diary/${date}`, {
      mood: 'happy',
      expectedUpdatedAt: current!.updatedAt,
    })

    expect(response.status).toBe(200)
    expect((await response.json())).toMatchObject({ path: `diary/${date}`, mood: 'happy' })
  })

  it('never leaks private managed-Diary metadata through locked structural or Mood routes', async () => {
    const date = '2000-05-04'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const pathName = `diary/${date}`
    const secretTitle = 'PRIVATE_DIARY_TITLE_SENTINEL'
    const secretSummary = 'PRIVATE_DIARY_SUMMARY_SENTINEL'
    const secretTag = 'PRIVATE_DIARY_TAG_SENTINEL'
    const privateMetadata = patchDocumentMetadata(db, {
      path: pathName,
      changes: [
        { field: 'title', value: secretTitle },
        { field: 'summary', value: secretSummary },
        { field: 'tags', values: [secretTag] },
      ],
      expectedUpdatedAt: getDocumentMetadata(db, pathName)!.updatedAt,
    })

    const posts = await callWithoutDiaryCapability('GET', '/api/posts')
    const tree = await callWithoutDiaryCapability('GET', '/api/tree')
    const byId = await callWithoutDiaryCapability('GET', `/api/metadata/documents/${privateMetadata.id}`)
    const moodPatch = await callWithoutDiaryCapability('PATCH', `/api/metadata/documents/${pathName}`, {
      mood: 'happy', expectedUpdatedAt: privateMetadata.updatedAt,
    })
    for (const response of [posts, tree, byId, moodPatch]) {
      expect(response.status).toBe(200)
      const wire = JSON.stringify(await response.json())
      expect(wire).not.toContain(secretTitle)
      expect(wire).not.toContain(secretSummary)
      expect(wire).not.toContain(secretTag)
    }
    const lockedPrivatePatch = await callWithoutDiaryCapability('PATCH', `/api/metadata/documents/${pathName}`, {
      title: 'still-private',
    })
    expect(lockedPrivatePatch.status).toBe(422)
    expect(await lockedPrivatePatch.json()).toMatchObject({ code: 'diary-private-metadata-unsupported' })

    const unlockedById = await call('GET', `/api/metadata/documents/${privateMetadata.id}`)
    expect(await unlockedById.json()).toMatchObject({
      title: secretTitle,
      summary: secretSummary,
      tags: [secretTag],
    })
  })

  it('blocks generic create/recovery and nested folder creation under diary', async () => {
    const generic = await call('POST', '/api/posts', { path: 'diary/generic', title: 'Generic' })
    const recovery = await call('PUT', '/api/recover/diary/recovered', { raw: '# bypass\n' })
    const folder = await call('POST', '/api/folders', { path: 'diary/2026' })

    expect(generic.status).toBe(422)
    expect(recovery.status).toBe(422)
    expect(folder.status).toBe(422)
    await expect(fs.stat(path.join(vault, 'diary', 'generic.md'))).rejects.toThrow()
    await expect(fs.stat(path.join(vault, 'diary', 'recovered.md'))).rejects.toThrow()
    await expect(fs.stat(path.join(vault, 'diary', '2026'))).rejects.toThrow()
  })

  it('allows managed edit, blocks identity-changing moves, and deletes through the encrypted owner', async () => {
    const date = '2000-04-01'
    const created = await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })
    expect(created.status).toBe(201)

    const edit = await call('PUT', `/api/posts/diary/${date}`, {
      raw: '# edited\n',
      baseRaw: `# ${date}\n`,
    })
    const rename = await call('PATCH', `/api/posts/diary/${date}`, {
      targetPath: 'diary/2000-04-02',
    })
    const moveOut = await call('PATCH', `/api/posts/diary/${date}`, {
      targetPath: 'inbox/moved-out',
    })
    const generic = await call('POST', '/api/posts', { path: 'inbox/moved-in', title: 'Move in' })
    const moveIn = await call('PATCH', '/api/posts/inbox/moved-in', {
      targetPath: 'diary/2000-04-03',
    })
    const beforeDelete = await fs.readFile(path.join(vault, 'diary', `${date}.md`))
    const metadataBeforeDelete = getDocumentMetadata(db, `diary/${date}`)
    const index = await getIndex()
    expect(index.hasPath(`diary/${date}`)).toBe(true)
    const deleted = await call('DELETE', `/api/posts/diary/${date}`)

    expect(edit.status).toBe(200)
    expect(rename.status).toBe(422)
    expect(moveOut.status).toBe(422)
    expect(generic.status).toBe(201)
    expect(moveIn.status).toBe(422)
    expect(deleted.status).toBe(200)
    const deletedWire = await deleted.json()
    expect(deletedWire).toEqual({ ok: true })
    expect(JSON.stringify(deletedWire)).not.toContain(beforeDelete.toString('base64'))
    await expect(fs.stat(path.join(vault, 'diary', `${date}.md`))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getDocumentMetadata(db, `diary/${date}`)).toBeNull()
    expect(metadataBeforeDelete?.id).toBeTruthy()
    expect(index.hasPath(`diary/${date}`)).toBe(false)
    await expect(fs.stat(path.join(vault, 'inbox', 'moved-in.md'))).resolves.toBeTruthy()
  })

  it('rejects locked managed delete without touching the encrypted generation', async () => {
    const date = '2000-04-06'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const physical = path.join(vault, 'diary', `${date}.md`)
    const before = await fs.readFile(physical)

    const response = await callWithoutDiaryCapability('DELETE', `/api/posts/diary/${date}`)

    expect(response.status).toBe(423)
    expect(await response.json()).toMatchObject({ code: 'diary-locked' })
    expect(await fs.readFile(physical)).toEqual(before)
    expect(getDocumentMetadata(db, `diary/${date}`)).not.toBeNull()
  })

  it('fails closed when managed metadata is missing and makes a repeat delete deterministic', async () => {
    const missingDate = '2000-04-07'
    expect((await call('POST', '/api/diary/dates', { date: missingDate, timeZone: TIME_ZONE })).status).toBe(201)
    const missingPhysical = path.join(vault, 'diary', `${missingDate}.md`)
    const missingBefore = await fs.readFile(missingPhysical)
    deleteDocumentMetadata(db, `diary/${missingDate}`)
    const missing = await call('DELETE', `/api/posts/diary/${missingDate}`)
    expect(missing.status).toBe(503)
    expect(await missing.json()).toMatchObject({ code: 'diary-metadata-unavailable' })
    expect(await fs.readFile(missingPhysical)).toEqual(missingBefore)

    const deletedDate = '2000-04-08'
    expect((await call('POST', '/api/diary/dates', { date: deletedDate, timeZone: TIME_ZONE })).status).toBe(201)
    expect((await call('DELETE', `/api/posts/diary/${deletedDate}`)).status).toBe(200)
    const repeated = await call('DELETE', `/api/posts/diary/${deletedDate}`)
    expect(repeated.status).toBe(404)
  })

  it('rolls back a managed delete without reading or parsing the staged body', async () => {
    const date = '2000-04-09'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const physical = path.join(vault, 'diary', `${date}.md`)
    const before = await fs.readFile(physical)
    const readFile = vi.spyOn(fs, 'readFile')
    __setManagedDiaryDeleteTestHooksForTesting({
      beforeStagedUnlink: () => { throw new Error('injected managed delete unlink failure') },
    })
    try {
      const response = await call('DELETE', `/api/posts/diary/${date}`)
      expect(response.status).toBe(409)
      const deleteReadCalls = readFile.mock.calls.slice()
      expect(await fs.readFile(physical)).toEqual(before)
      expect(getDocumentMetadata(db, `diary/${date}`)).not.toBeNull()
      expect(deleteReadCalls.some(([candidate]) => String(candidate) === physical)).toBe(false)
    } finally {
      readFile.mockRestore()
      __setManagedDiaryDeleteTestHooksForTesting(null)
    }
  })

  it('lets a reused canonical path win without adopting the old Diary identity', async () => {
    const date = '2000-04-10'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const physical = path.join(vault, 'diary', `${date}.md`)
    const oldCiphertext = await fs.readFile(physical)
    const oldId = getDocumentMetadata(db, `diary/${date}`)!.id
    __setManagedDiaryDeleteTestHooksForTesting({
      afterSourceStaged: async (_staged, target) => { await fs.writeFile(target, 'foreign generation\n', 'utf8') },
    })
    try {
      const response = await call('DELETE', `/api/posts/diary/${date}`)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: 'diary-delete-path-reused' })
      expect(await fs.readFile(physical, 'utf8')).toBe('foreign generation\n')
      expect(getDocumentMetadata(db, `diary/${date}`)).toBeNull()
      const quarantines = (await fs.readdir(path.join(vault, 'diary')))
        .filter((name) => name.startsWith(`${date}.md.nuvyn-quarantine-reuse-`))
      expect(quarantines).toHaveLength(1)
      expect(await fs.readFile(path.join(vault, 'diary', quarantines[0]!))).toEqual(oldCiphertext)
      expect((await getIndex()).hasPath(`diary/${date}`)).toBe(true)
      expect(oldId).toBeTruthy()
    } finally {
      __setManagedDiaryDeleteTestHooksForTesting(null)
      await fs.rm(physical, { force: true })
      for (const name of await fs.readdir(path.join(vault, 'diary'))) {
        if (name.startsWith(`${date}.md.nuvyn-quarantine-reuse-`)) await fs.rm(path.join(vault, 'diary', name), { force: true })
      }
      deleteDocumentMetadata(db, `diary/${date}`)
    }
  })

  it('keeps logout quiescent until an in-flight managed delete reaches its boundary', async () => {
    const date = '2000-04-11'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    let release!: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    let staged = false
    __setManagedDiaryDeleteTestHooksForTesting({
      afterSourceStaged: async () => {
        staged = true
        await paused
      },
    })

    const deletion = call('DELETE', `/api/posts/diary/${date}`)
    while (!staged) await new Promise<void>((resolve) => setImmediate(resolve))
    let logoutSettled = false
    const logout = app.fetch(jsonRequest('/api/auth/logout', {
      method: 'POST',
      origin: auth.runtime.config.publicOrigin,
      cookie: auth.cookie,
    })).then((response) => {
      logoutSettled = true
      return response
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(logoutSettled).toBe(false)
    release()
    expect((await deletion).status).toBe(200)
    expect((await logout).status).toBe(204)
  })

  it('rolls back safely when structural LinkIndex cleanup fails', async () => {
    const date = '2000-04-12'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    const physical = path.join(vault, 'diary', `${date}.md`)
    const before = await fs.readFile(physical)
    const cleanup = vi.spyOn(LinkIndex.prototype, 'applyDelete').mockImplementationOnce(() => {
      throw new Error('injected structural index failure')
    })
    try {
      const response = await call('DELETE', `/api/posts/diary/${date}`)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: 'diary-delete-index-cleanup-failed' })
      expect(await fs.readFile(physical)).toEqual(before)
      expect(getDocumentMetadata(db, `diary/${date}`)).not.toBeNull()
      expect((await getIndex()).hasPath(`diary/${date}`)).toBe(true)
    } finally {
      cleanup.mockRestore()
    }
  })

  it('rejects an ordinary document move into Diary before any filesystem or metadata mutation', async () => {
    const sourcePath = 'inbox/ordinary'
    const destinationPath = 'diary/ordinary'
    const created = await call('POST', '/api/posts', { path: sourcePath, title: 'Ordinary' })
    expect(created.status).toBe(201)
    const sourceMetadataBefore = getDocumentMetadata(db, sourcePath)
    expect(sourceMetadataBefore).not.toBeNull()

    const move = await call('PATCH', `/api/posts/${sourcePath}`, { targetPath: destinationPath })

    expect(move.status).toBe(422)
    expect(await move.json()).toMatchObject({
      error: expect.stringContaining('Diary namespace'),
    })
    await expect(fs.readFile(path.join(vault, 'inbox', 'ordinary.md'), 'utf8'))
      .resolves.toBe('# Ordinary\n')
    await expect(fs.stat(path.join(vault, 'diary', 'ordinary.md'))).rejects.toThrow()
    expect(getDocumentMetadata(db, sourcePath)).toMatchObject({ id: sourceMetadataBefore!.id, path: sourcePath })
    expect(getDocumentMetadata(db, destinationPath)).toBeNull()
  })

  it('blocks a locked file rename before reading a managed Diary backlink body', async () => {
    const date = '2000-04-04'
    const targetPath = 'inbox/rename-target'
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    expect((await call('POST', '/api/posts', { path: targetPath, title: 'Target' })).status).toBe(201)
    const diaryBody = `# ${date}\n\n[[${targetPath}]]\n`
    expect((await call('PUT', `/api/posts/diary/${date}`, {
      raw: diaryBody,
      baseRaw: `# ${date}\n`,
    })).status).toBe(200)

    const rename = await callWithoutDiaryCapability('PATCH', `/api/posts/${targetPath}`, {
      name: 'rename-target-new',
      updateReferences: true,
    })

    expect(rename.status).toBe(423)
    await expect(fs.readFile(path.join(vault, 'inbox', 'rename-target.md'), 'utf8'))
      .resolves.toBe('# Target\n')
    await expect(fs.readFile(path.join(vault, 'diary', `${date}.md`), 'utf8'))
      .resolves.not.toContain(diaryBody)
  })

  it('blocks a locked folder rename before reading a managed Diary backlink body', async () => {
    const date = '2000-04-05'
    const folderPath = 'inbox/rename-folder'
    const targetPath = `${folderPath}/child`
    expect((await call('POST', '/api/diary/dates', { date, timeZone: TIME_ZONE })).status).toBe(201)
    expect((await call('POST', '/api/folders', { path: folderPath })).status).toBe(201)
    expect((await call('POST', '/api/posts', { path: targetPath, title: 'Child' })).status).toBe(201)
    const diaryBody = `# ${date}\n\n[[${targetPath}]]\n`
    expect((await call('PUT', `/api/posts/diary/${date}`, {
      raw: diaryBody,
      baseRaw: `# ${date}\n`,
    })).status).toBe(200)

    const rename = await callWithoutDiaryCapability('PATCH', `/api/folders/${folderPath}`, {
      newPath: 'inbox/renamed-folder',
      updateReferences: true,
    })

    expect(rename.status).toBe(423)
    await expect(fs.stat(path.join(vault, 'inbox', 'rename-folder', 'child.md'))).resolves.toBeTruthy()
    await expect(fs.readFile(path.join(vault, 'diary', `${date}.md`), 'utf8'))
      .resolves.not.toContain(diaryBody)
  })

  it('fails closed for generic recovery even when a missing Diary path looks managed', async () => {
    const date = '2999-12-31'

    const recovered = await call('PUT', `/api/recover/diary/${date}`, { raw: '# bypass\n' })

    expect(recovered.status).toBe(422)
    expect(await recovered.json()).toMatchObject({
      error: expect.stringContaining('verified prior identity'),
    })
    await expect(fs.stat(path.join(vault, 'diary', `${date}.md`))).rejects.toThrow()
  })

  it('preserves invalid external Diary files and generic listing visibility', async () => {
    const unmanaged = path.join(vault, 'diary', 'foo.md')
    const invalid = path.join(vault, 'diary', '2026-02-31.md')
    await fs.writeFile(unmanaged, '# external\n', 'utf8')
    await fs.writeFile(invalid, '# invalid\n', 'utf8')

    const response = await call('GET', '/api/posts')
    const posts = await response.json() as Array<{ path: string }>

    expect(response.status).toBe(200)
    expect(posts.map(post => post.path)).toEqual(expect.arrayContaining([
      'diary/foo',
      'diary/2026-02-31',
    ]))
    expect(await fs.readFile(unmanaged, 'utf8')).toBe('# external\n')
    expect(await fs.readFile(invalid, 'utf8')).toBe('# invalid\n')
    expect(getDocumentMetadata(db, 'diary/2026-02-31')).toBeNull()
    deleteDocumentMetadata(db, 'diary/foo')
  })

  it('keeps the Diary root itself protected', async () => {
    const rename = await call('PATCH', '/api/folders/diary', { newPath: 'diary-renamed' })
    const deleted = await call('DELETE', '/api/folders/diary?recursive=true')

    expect(rename.status).toBe(422)
    expect(deleted.status).toBe(422)
    await expect(fs.stat(path.join(vault, 'diary'))).resolves.toBeTruthy()
  })
})
