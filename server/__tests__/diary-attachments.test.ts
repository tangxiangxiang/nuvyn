import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app from '../index.js'
import { createSession } from '../auth/session.js'
import { MAX_DIARY_ATTACHMENT_BYTES } from '../../shared/diaryAttachments.js'
import { __setDiaryAttachmentRootForTesting, DiaryAttachmentStorage } from '../diaryAttachments/storage.js'
import { discardStagedDiaryAttachment } from '../diaryAttachments/service.js'
import { __setDurableArtifactTestHooksForTesting } from '../durableCreateOnlyFile.js'
import { closeAuthTestContext, createAuthenticatedTestContext, jsonRequest, unlockDiaryAccessForTesting, withAuthCookie, withDiaryCapability, type AuthenticatedTestContext } from './helpers/auth.js'

// Structurally valid 1x1 PNG used only as deterministic test content.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n9\n%%EOF\n')
const DATE = '2026-11-15'
let db: Database.Database
let auth: AuthenticatedTestContext
let capability: string
let tempRoot: string
const life = '/api/diary/life'
const attachment = '/api/diary/attachments'

function fetchAttachment(method: string, pathName: string, body?: BodyInit, unlocked = true, extraHeaders?: HeadersInit) {
  const headers = new Headers({ Origin: auth.runtime.config.publicOrigin, ...Object.fromEntries(new Headers(extraHeaders)) })
  const request = new Request(`http://localhost${pathName}`, { method, headers, body })
  return app.fetch(unlocked ? withDiaryCapability(auth, request, capability) : withAuthCookie(auth, request))
}

function upload(name = 'private-memory.png', bytes: Uint8Array = PNG, mimeType = 'image/png', requestKey = randomUUID(), unlocked = true) {
  const form = new FormData()
  form.set('date', DATE)
  form.set('file', new File([bytes], name, { type: mimeType }))
  return fetchAttachment('POST', `${attachment}/stage`, form, unlocked, { 'Idempotency-Key': requestKey })
}

function saveDay(date: string, fields: unknown) {
  return app.fetch(withDiaryCapability(auth, jsonRequest(`${life}/days/${date}`, {
    method: 'PUT', origin: auth.runtime.config.publicOrigin, body: fields,
  }), capability))
}

beforeEach(async () => {
  db = new Database(':memory:')
  auth = createAuthenticatedTestContext({ db })
  capability = await unlockDiaryAccessForTesting(auth)
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-diary-attachments-'))
  __setDiaryAttachmentRootForTesting(path.join(tempRoot, 'private'))
})

afterEach(async () => {
  closeAuthTestContext(auth)
  __setDurableArtifactTestHooksForTesting(null)
  __setDiaryAttachmentRootForTesting(null)
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('Diary private attachments', () => {
  it('requires an authenticated unlocked Diary capability and rejects untrusted file types', async () => {
    expect((await upload('private-memory.png', PNG, 'image/png', randomUUID(), false)).status).toBe(423)
    const stagedResponse = await upload()
    expect(stagedResponse.status).toBe(201)
    const staged = await stagedResponse.json() as { attachment: { id: string } }
    const request = new Request(`http://localhost${attachment}/${staged.attachment.id}/content`, {
      headers: { Origin: auth.runtime.config.publicOrigin },
    })
    expect((await app.fetch(request.clone())).status).toBe(401)
    expect((await app.fetch(withAuthCookie(auth, request))).status).toBe(423)
    const secondSession = createSession(db, auth.userId)
    const otherSessionRequest = new Request(`http://localhost${attachment}/${staged.attachment.id}/content`, {
      headers: { Origin: auth.runtime.config.publicOrigin },
    })
    expect((await app.fetch(withDiaryCapability(
      { cookie: `${auth.runtime.config.cookie.name}=${secondSession.rawToken}` },
      otherSessionRequest,
      capability,
    ))).status).toBe(423)

    const unsupported = await upload('payload.svg', Buffer.from('<svg/>'), 'image/svg+xml')
    expect(unsupported.status).toBe(415)
    const mismatched = await upload('payload.png', Buffer.from('%PDF-1.7\nstartxref 0\n%%EOF'), 'image/png')
    expect(mismatched.status).toBe(415)
    await auth.runtime.diaryAccess.lock(auth.session.id)
    expect((await fetchAttachment('GET', `${attachment}/${staged.attachment.id}/content`)).status).toBe(423)
  })

  it('keeps staged bytes and metadata encrypted, then attaches, reads, and deletes them with the day', async () => {
    const stagedResponse = await upload()
    expect(stagedResponse.status).toBe(201)
    const staged = (await stagedResponse.json() as { attachment: { id: string; name: string; mimeType: string; size: number } }).attachment
    const storage = new DiaryAttachmentStorage()
    const ciphertext = await fs.readFile(storage.pathFor(staged.id))
    const row = db.prepare('SELECT encrypted_metadata, status FROM diary_day_attachments WHERE id = ?').get(staged.id) as { encrypted_metadata: Buffer; status: string }
    expect(row.status).toBe('staged')
    expect(row.encrypted_metadata.toString('utf8')).not.toContain(staged.name)
    expect(ciphertext.equals(PNG)).toBe(false)
    expect(ciphertext.includes(PNG)).toBe(false)
    expect(path.basename(storage.pathFor(staged.id))).toBe(staged.id)
    expect(() => storage.pathFor('../private-memory.png')).toThrow()
    const outside = path.join(tempRoot, 'outside')
    const symlinkId = randomUUID().toLowerCase()
    await fs.writeFile(outside, 'outside file')
    await fs.symlink(outside, storage.pathFor(symlinkId))
    await expect(storage.read(symlinkId)).rejects.toThrow()

    expect((await fetchAttachment('GET', `${attachment}/${staged.id}/content`)).status).toBe(404)
    const saved = await saveDay(DATE, { moodId: null, entries: [], expectedVersion: 0, attachments: [staged.id] })
    expect(saved.status).toBe(200)
    const day = await saved.json() as { day: { entries: string[] }; version: number; attachments: Array<{ id: string }> }
    expect(day.day.entries).toEqual([])
    expect(day.version).toBe(1)
    expect(day.attachments.map(item => item.id)).toEqual([staged.id])

    const summary = await app.fetch(withDiaryCapability(auth, jsonRequest(`${life}/days?start=${DATE}&end=${DATE}`, {
      method: 'GET', origin: auth.runtime.config.publicOrigin,
    }), capability))
    expect(await summary.json()).toMatchObject({ days: [{ date: DATE, hasAttachments: true }] })
    const ordinaryAsset = await app.fetch(withAuthCookie(auth, new Request(`http://localhost/api/assets/${staged.id}/preview`, {
      headers: { Origin: auth.runtime.config.publicOrigin },
    })))
    expect(ordinaryAsset.status).not.toBe(200)

    const content = await fetchAttachment('GET', `${attachment}/${staged.id}/content`)
    expect(content.status).toBe(200)
    expect(content.headers.get('cache-control')).toBe('no-store')
    expect(content.headers.get('x-content-type-options')).toBe('nosniff')
    expect(content.headers.get('content-type')).toBe('image/png')
    expect(content.headers.get('content-disposition')).toBe('inline; filename*=UTF-8\'\'private-memory.png')
    expect(Buffer.from(await content.arrayBuffer())).toEqual(PNG)

    expect((await fetchAttachment('DELETE', `${attachment}/${staged.id}`)).status).toBe(409)
    const deleted = await app.fetch(withDiaryCapability(auth, jsonRequest(`${life}/days/${DATE}`, {
      method: 'DELETE', origin: auth.runtime.config.publicOrigin, body: { expectedVersion: 1 },
    }), capability))
    expect(deleted.status).toBe(200)
    expect(await fs.stat(storage.pathFor(staged.id)).catch(() => null)).toBeNull()
    expect(db.prepare('SELECT id FROM diary_day_attachments WHERE id = ?').get(staged.id)).toBeUndefined()
    expect(await (await app.fetch(withDiaryCapability(auth, jsonRequest(`${life}/days/${DATE}`, {
      method: 'GET', origin: auth.runtime.config.publicOrigin,
    }), capability))).json()).toMatchObject({ day: null, attachments: [] })
  })

  it('makes upload retries idempotent and prevents an unowned ID from deleting a file', async () => {
    const requestKey = randomUUID()
    const first = await upload('private-memory.png', PNG, 'image/png', requestKey)
    const second = await upload('private-memory.png', PNG, 'image/png', requestKey)
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    const firstId = (await first.json() as { attachment: { id: string } }).attachment.id
    const secondId = (await second.json() as { attachment: { id: string } }).attachment.id
    expect(secondId).toBe(firstId)

    const storage = new DiaryAttachmentStorage()
    const before = await fs.readFile(storage.pathFor(firstId))
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, async operation => {
      await discardStagedDiaryAttachment({ db, owner: auth.userId + 1, id: firstId, operation, storage })
    })
    expect(await fs.readFile(storage.pathFor(firstId))).toEqual(before)
    expect((db.prepare('SELECT status FROM diary_day_attachments WHERE id = ?').get(firstId) as { status: string }).status).toBe('staged')

    expect((await fetchAttachment('DELETE', `${attachment}/${firstId}`)).status).toBe(200)
    expect(await fs.stat(storage.pathFor(firstId)).catch(() => null)).toBeNull()
    expect((await fetchAttachment('DELETE', `${attachment}/${firstId}`)).status).toBe(200)
  })

  it('rejects cross-date attachment binding', async () => {
    const staged = await upload()
    const id = (await staged.json() as { attachment: { id: string } }).attachment.id
    const wrongDate = await saveDay('2026-11-16', { moodId: null, entries: [], expectedVersion: 0, attachments: [id] })
    expect(wrongDate.status).toBe(409)
    expect(db.prepare('SELECT date FROM diary_days').get()).toBeUndefined()
  })

  it('rejects oversized uploads before creating a file or row', async () => {
    const oversized = Buffer.alloc(MAX_DIARY_ATTACHMENT_BYTES + 1)
    const response = await upload('oversized.png', oversized, 'image/png')
    expect(response.status).toBe(413)
    expect(db.prepare('SELECT id FROM diary_day_attachments').all()).toEqual([])
    expect(await new DiaryAttachmentStorage().list()).toEqual([])
  }, 15_000)

  it('removes encrypted bytes when the attachment metadata transaction fails', async () => {
    db.exec(`CREATE TRIGGER fail_diary_attachment_insert BEFORE INSERT ON diary_day_attachments
      BEGIN SELECT RAISE(ABORT, 'simulated metadata failure'); END`)
    const response = await upload()
    expect(response.status).toBe(503)
    expect(db.prepare('SELECT id FROM diary_day_attachments').all()).toEqual([])
    expect(await new DiaryAttachmentStorage().list()).toEqual([])
  })

  it('removes expired staged files and filesystem orphans during recovery', async () => {
    const staged = await upload()
    const id = (await staged.json() as { attachment: { id: string } }).attachment.id
    const storage = new DiaryAttachmentStorage()
    const orphanId = randomUUID().toLowerCase()
    await fs.writeFile(storage.pathFor(orphanId), Buffer.from('orphan ciphertext'))
    db.prepare('UPDATE diary_day_attachments SET expires_at = 0 WHERE id = ?').run(id)

    const day = await app.fetch(withDiaryCapability(auth, jsonRequest(`${life}/days/${DATE}`, {
      method: 'GET', origin: auth.runtime.config.publicOrigin,
    }), capability))
    expect(day.status).toBe(200)
    expect(await (await day.json()).attachments).toEqual([])
    expect(db.prepare('SELECT id FROM diary_day_attachments WHERE id = ?').get(id)).toBeUndefined()
    expect(await fs.stat(storage.pathFor(id)).catch(() => null)).toBeNull()
    expect(await fs.stat(storage.pathFor(orphanId)).catch(() => null)).toBeNull()
  })

  it('fails closed after ciphertext tampering without exposing storage details', async () => {
    const staged = await upload()
    const id = (await staged.json() as { attachment: { id: string } }).attachment.id
    expect((await saveDay(DATE, { moodId: null, entries: [], expectedVersion: 0, attachments: [id] })).status).toBe(200)
    const storage = new DiaryAttachmentStorage()
    const encrypted = await fs.readFile(storage.pathFor(id))
    encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1
    await fs.writeFile(storage.pathFor(id), encrypted)

    const response = await fetchAttachment('GET', `${attachment}/${id}/content`)
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).toBe(JSON.stringify({ code: 'diary-attachment-unavailable' }))
    expect(body).not.toContain(tempRoot)
  })

  it('serves PDF only as an authenticated download', async () => {
    const staged = await upload('private-note.pdf', PDF, 'application/pdf')
    expect(staged.status).toBe(201)
    const id = (await staged.json() as { attachment: { id: string } }).attachment.id
    expect((await saveDay(DATE, { moodId: null, entries: [], expectedVersion: 0, attachments: [id] })).status).toBe(200)
    const response = await fetchAttachment('GET', `${attachment}/${id}/content`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''private-note.pdf")
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF)
  })

  it('keeps failed physical cleanup tombstoned and retries it on the next Diary request', async () => {
    const staged = await upload()
    const id = (await staged.json() as { attachment: { id: string } }).attachment.id
    expect((await saveDay(DATE, { moodId: null, entries: [], expectedVersion: 0, attachments: [id] })).status).toBe(200)
    const storage = new DiaryAttachmentStorage()
    __setDurableArtifactTestHooksForTesting({ beforeDurableArtifactUnlink: () => { throw new Error('simulated unlink failure') } })

    const deleted = await app.fetch(withDiaryCapability(auth, jsonRequest(`${life}/days/${DATE}`, {
      method: 'DELETE', origin: auth.runtime.config.publicOrigin, body: { expectedVersion: 1 },
    }), capability))
    expect(deleted.status).toBe(200)
    expect((db.prepare('SELECT status FROM diary_day_attachments WHERE id = ?').get(id) as { status: string }).status).toBe('deleting')
    expect((await fs.stat(storage.pathFor(id))).isFile()).toBe(true)

    __setDurableArtifactTestHooksForTesting(null)
    const retry = await app.fetch(withDiaryCapability(auth, jsonRequest(`${life}/days/${DATE}`, {
      method: 'GET', origin: auth.runtime.config.publicOrigin,
    }), capability))
    expect(retry.status).toBe(200)
    expect(await fs.stat(storage.pathFor(id)).catch(() => null)).toBeNull()
    expect(db.prepare('SELECT id FROM diary_day_attachments WHERE id = ?').get(id)).toBeUndefined()
  })

  it('enforces the per-day attachment count on the server', async () => {
    for (let index = 0; index < 20; index += 1) {
      const response = await upload(`private-${index}.png`)
      expect(response.status).toBe(201)
    }
    expect((await upload('private-over-limit.png')).status).toBe(400)
  }, 15_000)
})
