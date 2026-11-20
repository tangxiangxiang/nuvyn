import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../index.js'
import { createSession } from '../auth/session.js'
import { DIARY_ATTACHMENT_STAGE_LEASE_MS, MAX_DIARY_ATTACHMENT_BYTES } from '../../shared/diaryAttachments.js'
import { cleanupDiaryAttachmentStorage, DiaryAttachmentStorage } from '../diaryAttachments/storage.js'
import { discardStagedDiaryAttachment, stageDiaryAttachment } from '../diaryAttachments/service.js'
import { __setDurableArtifactTestHooksForTesting } from '../durableCreateOnlyFile.js'
import { closeAuthTestContext, createAuthenticatedTestContext, jsonRequest, unlockDiaryAccessForTesting, withAuthCookie, withDiaryCapability, type AuthenticatedTestContext } from './helpers/auth.js'

// Structurally valid 1x1 PNG used only as deterministic test content.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
const JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x00, 0xff, 0xd9,
])
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nstartxref\n9\n%%EOF\n')
const DATE = '2026-11-15'
const SESSION_A = randomUUID()
const SESSION_B = randomUUID()
const SESSION_C = randomUUID()
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

function upload(name = 'private-memory.png', bytes: Uint8Array = PNG, mimeType = 'image/png', requestKey = randomUUID(), unlocked = true, sessionId = SESSION_A, date = DATE, timeZone?: string) {
  const form = new FormData()
  form.set('date', date)
  form.set('sessionId', sessionId)
  form.set('file', new File([bytes], name, { type: mimeType }))
  return fetchAttachment('POST', `${attachment}/stage`, form, unlocked, {
    'Idempotency-Key': requestKey,
    ...(timeZone === undefined ? {} : { 'X-Diary-Time-Zone': timeZone }),
  })
}

function saveDay(date: string, fields: unknown, timeZone?: string) {
  const initial = jsonRequest(`${life}/days/${date}`, {
    method: 'PUT', origin: auth.runtime.config.publicOrigin, body: fields,
  })
  const headers = new Headers(initial.headers)
  if (timeZone !== undefined) headers.set('X-Diary-Time-Zone', timeZone)
  return app.fetch(withDiaryCapability(auth, new Request(initial, { headers }), capability))
}

function seedStagedRows(count: number, expiresAt: number, sessionId = SESSION_A) {
  const insert = db.prepare(`INSERT INTO diary_day_attachments
    (id, owner_user_id, day_date, encrypted_metadata, status, display_order, created_at, expires_at, request_key, stage_session_id)
    VALUES (?, ?, ?, ?, 'staged', ?, ?, ?, NULL, ?)`)
  const now = Date.now()
  const ids: string[] = []
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID().toLowerCase()
      ids.push(id)
      insert.run(id, auth.userId, DATE, Buffer.from('test metadata'), index, now, expiresAt, sessionId)
    }
  })()
  return ids
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'))
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-diary-attachments-'))
  db = new Database(path.join(tempRoot, 'fixture.db'))
  auth = createAuthenticatedTestContext({ db })
  capability = await unlockDiaryAccessForTesting(auth)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  closeAuthTestContext(auth)
  db.close()
  __setDurableArtifactTestHooksForTesting(null)
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('Diary private attachments', () => {
  it('preserves legacy future days and attachments while blocking writes and allowing staged cleanup', async () => {
    const date = '2026-11-16'
    const uploadForDay = () => upload(undefined, PNG, 'image/png', randomUUID(), true, SESSION_A, date)
    const first = await uploadForDay()
    expect(first.status).toBe(201)
    const { attachment: { id } } = await first.json()
    const fields = { moodId: null, entries: ['历史记录'], expectedVersion: 0, attachments: [id] }
    expect((await saveDay(date, fields)).status).toBe(200)
    const second = await uploadForDay()
    expect(second.status).toBe(201)
    const { attachment: { id: stagedId } } = await second.json()

    vi.setSystemTime(new Date('2026-11-15T23:59:00Z'))
    const denied = await uploadForDay()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ code: 'diary-future-date' })
    const heartbeat = await fetchAttachment('POST', `${attachment}/sessions/${SESSION_A}/heartbeat`, JSON.stringify({ date }), true, { 'Content-Type': 'application/json' })
    expect(heartbeat.status).toBe(403)
    expect((await saveDay(date, { ...fields, expectedVersion: 1, attachments: [id, stagedId] })).status).toBe(403)
    const dayPath = `${life}/days/${date}`
    expect((await fetchAttachment('DELETE', dayPath, JSON.stringify({ expectedVersion: 1 }), true, { 'Content-Type': 'application/json' })).status).toBe(403)
    expect(await (await fetchAttachment('GET', dayPath)).json()).toMatchObject({
      day: { entries: fields.entries, version: 1 }, attachments: [{ id }],
    })
    const content = await fetchAttachment('GET', `${attachment}/${id}/content`)
    expect(content.status).toBe(200)
    expect(Buffer.from(await content.arrayBuffer())).toEqual(PNG)
    expect((await fetchAttachment('DELETE', `${attachment}/${stagedId}`)).status).toBe(200)
    expect(db.prepare('SELECT status FROM diary_day_attachments').all()).toEqual([{ status: 'attached' }])
  })

  it('stages and renews Shanghai diary attachments before the UTC container reaches the date', async () => {
    vi.stubEnv('TZ', 'UTC')
    vi.setSystemTime(new Date('2026-11-19T16:01:00Z'))
    const date = '2026-11-20'
    const staged = await upload('shanghai-diary.png', PNG, 'image/png', randomUUID(), true, SESSION_A, date, 'Asia/Shanghai')
    expect(staged.status).toBe(201)
    const { attachment: { id } } = await staged.json()

    const heartbeat = await fetchAttachment(
      'POST', `${attachment}/sessions/${SESSION_A}/heartbeat`, JSON.stringify({ date }), true,
      { 'Content-Type': 'application/json', 'X-Diary-Time-Zone': 'Asia/Shanghai' },
    )
    expect(heartbeat.status).toBe(204)
    expect((await saveDay(date, { moodId: null, entries: ['北京零点日记'], expectedVersion: 0, attachments: [id] }, 'Asia/Shanghai')).status).toBe(200)

    const future = await upload('future.png', PNG, 'image/png', randomUUID(), true, SESSION_B, '2026-11-21', 'Asia/Shanghai')
    expect(future.status).toBe(403)
    expect(await future.json()).toEqual({ code: 'diary-future-date' })
    const invalidZone = await upload('invalid-zone.png', PNG, 'image/png', randomUUID(), true, SESSION_B, date, '+08:00')
    expect(invalidZone.status).toBe(400)
    expect(await invalidZone.json()).toEqual({ code: 'invalid-diary-time-zone' })
  })

  it('requires an authenticated unlocked Diary capability and rejects untrusted file types', async () => {
    expect((await upload('private-memory.png', PNG, 'image/png', randomUUID(), false)).status).toBe(423)
    const stagedResponse = await upload()
    expect(stagedResponse.status).toBe(201)
    expect((await upload('photo.jpeg', JPEG, 'image/jpeg')).status).toBe(201)
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
    const storage = new DiaryAttachmentStorage(db)
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

  it('saves encrypted image groups with stable entries and never treats PDFs as gallery images', async () => {
    const imageResponse = await upload('breakfast.png', PNG)
    const pdfResponse = await upload('recipe.pdf', PDF, 'application/pdf')
    const imageId = (await imageResponse.json() as { attachment: { id: string } }).attachment.id
    const pdfId = (await pdfResponse.json() as { attachment: { id: string } }).attachment.id
    const entryId = randomUUID().toLowerCase()
    const attachments = [imageId, pdfId]
    const saved = await saveDay(DATE, {
      moodId: null,
      entries: ['早上吃了南瓜饼'],
      entryIds: [entryId],
      imageGroups: [{ entryId, attachmentIds: [imageId] }],
      expectedVersion: 0,
      attachments,
    })
    expect(saved.status).toBe(200)
    expect((await saved.json() as { day: { entryIds: string[]; imageGroups: Array<{ entryId: string | null; attachmentIds: string[] }> } }).day)
      .toMatchObject({ entryIds: [entryId], imageGroups: [{ entryId, attachmentIds: [imageId] }] })

    expect((await saveDay(DATE, {
      moodId: null, entries: ['早上吃了南瓜饼'], entryIds: [entryId],
      imageGroups: [{ entryId, attachmentIds: [pdfId] }], expectedVersion: 1, attachments,
    })).status).toBe(400)
    expect((await saveDay('2026-11-16', {
      moodId: null, entries: ['另一条日记'], entryIds: [entryId],
      imageGroups: [{ entryId, attachmentIds: [imageId] }], expectedVersion: 0, attachments: [imageId],
    })).status).toBe(409)
    expect((await saveDay(DATE, {
      moodId: null, entries: ['早上吃了南瓜饼'], entryIds: [entryId],
      imageGroups: [{ entryId, attachmentIds: [imageId] }, { entryId: null, attachmentIds: [imageId] }],
      expectedVersion: 1, attachments,
    })).status).toBe(400)

    const deletedEntry = await saveDay(DATE, {
      moodId: null, entries: [], entryIds: [],
      imageGroups: [{ entryId: null, attachmentIds: [imageId] }], expectedVersion: 1, attachments,
    })
    expect(deletedEntry.status).toBe(200)
    expect((await deletedEntry.json() as { day: { imageGroups: Array<{ entryId: string | null; attachmentIds: string[] }> }; attachments: Array<{ id: string }> }))
      .toMatchObject({ day: { imageGroups: [{ entryId: null, attachmentIds: [imageId] }] }, attachments: [{ id: imageId }, { id: pdfId }] })
    expect((await saveDay(DATE, {
      moodId: null, entries: [], entryIds: [], imageGroups: [{ entryId: null, attachmentIds: [imageId] }],
      expectedVersion: 1, attachments,
    })).status).toBe(409)
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

    const storage = new DiaryAttachmentStorage(db)
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

  it('renews only the staged uploads owned by the matching date and edit session', async () => {
    const staged = await upload('leased.png', PNG, 'image/png', randomUUID(), true, SESSION_A)
    const id = (await staged.json() as { attachment: { id: string } }).attachment.id
    const initialExpiry = Date.now() + 5_000
    db.prepare('UPDATE diary_day_attachments SET expires_at = ? WHERE id = ?').run(initialExpiry, id)

    const otherSession = await fetchAttachment('POST', `${attachment}/sessions/${SESSION_B}/heartbeat`, JSON.stringify({ date: DATE }), true, { 'Content-Type': 'application/json' })
    expect(otherSession.status).toBe(204)
    expect((db.prepare('SELECT expires_at FROM diary_day_attachments WHERE id = ?').get(id) as { expires_at: number }).expires_at).toBe(initialExpiry)

    const matchingSession = await fetchAttachment('POST', `${attachment}/sessions/${SESSION_A}/heartbeat`, JSON.stringify({ date: DATE }), true, { 'Content-Type': 'application/json' })
    expect(matchingSession.status).toBe(204)
    const renewed = (db.prepare('SELECT expires_at FROM diary_day_attachments WHERE id = ?').get(id) as { expires_at: number }).expires_at
    expect(renewed).toBeGreaterThanOrEqual(Date.now() + DIARY_ATTACHMENT_STAGE_LEASE_MS - 1_000)
  })

  it('does not clean another Owner staged file during an authorized request', async () => {
    const otherOwner = Number(db.prepare(`INSERT INTO users (
      username, username_normalized, password_hash, disabled, created_at, updated_at
    ) VALUES ('other-owner', 'other-owner', 'test-hash', 0, 1, 1)`).run().lastInsertRowid)
    const staged = await upload('other-owner.png')
    const otherId = (await staged.json() as { attachment: { id: string } }).attachment.id
    const storage = new DiaryAttachmentStorage(db)
    db.prepare('UPDATE diary_day_attachments SET owner_user_id = ?, expires_at = 0 WHERE id = ?').run(otherOwner, otherId)

    const currentUpload = await upload('current-owner.png')
    expect(currentUpload.status).toBe(201)
    expect((db.prepare('SELECT status FROM diary_day_attachments WHERE owner_user_id = ? AND id = ?').get(otherOwner, otherId) as { status: string }).status).toBe('staged')
    expect((await fs.stat(storage.pathFor(otherId))).isFile()).toBe(true)

    await cleanupDiaryAttachmentStorage(db, storage, otherOwner)
    expect(db.prepare('SELECT id FROM diary_day_attachments WHERE owner_user_id = ? AND id = ?').get(otherOwner, otherId)).toBeUndefined()
    expect(await fs.stat(storage.pathFor(otherId)).catch(() => null)).toBeNull()
  })

  it('reclaims expired staged quota without removing another active edit session', async () => {
    const abandonedIds = seedStagedRows(19, Date.now() + DIARY_ATTACHMENT_STAGE_LEASE_MS, SESSION_A)
    const activeResponse = await upload('active-device.png', PNG, 'image/png', randomUUID(), true, SESSION_B)
    expect(activeResponse.status).toBe(201)
    const activeId = (await activeResponse.json() as { attachment: { id: string } }).attachment.id
    db.prepare(`UPDATE diary_day_attachments SET expires_at = 0 WHERE id IN (${abandonedIds.map(() => '?').join(',')})`).run(...abandonedIds)

    const recovered = await upload('replacement.png', PNG, 'image/png', randomUUID(), true, SESSION_C)
    expect(recovered.status).toBe(201)
    const replacementId = (await recovered.json() as { attachment: { id: string } }).attachment.id
    expect(db.prepare('SELECT status FROM diary_day_attachments WHERE id = ?').get(activeId)).toEqual({ status: 'staged' })
    expect(db.prepare('SELECT id FROM diary_day_attachments WHERE id = ?').get(abandonedIds[0]!)).toBeUndefined()
    expect(db.prepare("SELECT COUNT(*) AS count FROM diary_day_attachments WHERE status = 'staged' AND expires_at <= ?").get(Date.now())).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM diary_day_attachments WHERE owner_user_id = ? AND day_date = ? AND status IN (\'staged\', \'attached\')').get(auth.userId, DATE)).toEqual({ count: 2 })
    expect(await fs.stat(new DiaryAttachmentStorage(db).pathFor(activeId))).toBeDefined()
    expect(await fs.stat(new DiaryAttachmentStorage(db).pathFor(replacementId))).toBeDefined()
  }, 30_000)

  it('keeps a deleting tombstone when rollback cleanup fails, then retries it', async () => {
    const storage = new DiaryAttachmentStorage(db)
    const remove = vi.spyOn(storage, 'remove').mockRejectedValue(new Error('simulated unlink failure'))
    const result = await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, async operation => {
      const failingOperation = new Proxy(operation, {
        get(target, property, receiver) {
          if (property === 'assertCurrent') return () => {
            if (db.prepare("SELECT 1 FROM diary_day_attachments WHERE status = 'staged'").get()) throw new Error('simulated capability revocation after insert')
            operation.assertCurrent()
          }
          return Reflect.get(target, property, receiver)
        },
      })
      await expect(stageDiaryAttachment({
        db, owner: auth.userId, date: DATE, sessionId: SESSION_A,
        name: 'rollback.png', mimeType: 'image/png', bytes: PNG,
        requestKey: randomUUID(), operation: failingOperation, storage,
      })).rejects.toThrow()
    })
    expect(result).toBeUndefined()
    remove.mockRestore()

    const row = db.prepare("SELECT id, status FROM diary_day_attachments WHERE status = 'deleting'").get() as { id: string; status: string }
    expect(row.status).toBe('deleting')
    expect((await fs.stat(storage.pathFor(row.id))).isFile()).toBe(true)

    const retry = await app.fetch(withDiaryCapability(auth, jsonRequest(`${life}/days/${DATE}`, {
      method: 'GET', origin: auth.runtime.config.publicOrigin,
    }), capability))
    expect(retry.status).toBe(200)
    expect(await fs.stat(storage.pathFor(row.id)).catch(() => null)).toBeNull()
    expect(db.prepare('SELECT id FROM diary_day_attachments WHERE id = ?').get(row.id)).toBeUndefined()
  })

  it('reconciles encrypted orphans after metadata insertion and unlink both fail', async () => {
    db.exec(`CREATE TRIGGER fail_diary_attachment_insert BEFORE INSERT ON diary_day_attachments
      BEGIN SELECT RAISE(ABORT, 'simulated metadata failure'); END`)
    const remove = vi.spyOn(DiaryAttachmentStorage.prototype, 'remove').mockRejectedValueOnce(new Error('simulated unlink failure'))
    const failed = await upload('orphan.png')
    expect(failed.status).toBe(503)
    expect(db.prepare('SELECT id FROM diary_day_attachments').all()).toEqual([])
    const storage = new DiaryAttachmentStorage(db)
    const [orphanId] = await storage.list()
    expect(orphanId).toMatch(/^[a-f0-9-]{36}$/u)
    expect(await fs.stat(storage.pathFor(orphanId!))).toBeDefined()

    remove.mockRestore()
    db.exec('DROP TRIGGER fail_diary_attachment_insert')
    const recovered = await upload('after-recovery.png')
    expect(recovered.status).toBe(201)
    const newId = (await recovered.json() as { attachment: { id: string } }).attachment.id
    expect(await fs.stat(storage.pathFor(orphanId!)).catch(() => null)).toBeNull()
    expect((await storage.list()).sort()).toEqual([newId])
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
    expect(await new DiaryAttachmentStorage(db).list()).toEqual([])
  }, 30_000)

  it('removes encrypted bytes when the attachment metadata transaction fails', async () => {
    db.exec(`CREATE TRIGGER fail_diary_attachment_insert BEFORE INSERT ON diary_day_attachments
      BEGIN SELECT RAISE(ABORT, 'simulated metadata failure'); END`)
    const response = await upload()
    expect(response.status).toBe(503)
    expect(db.prepare('SELECT id FROM diary_day_attachments').all()).toEqual([])
    expect(await new DiaryAttachmentStorage(db).list()).toEqual([])
  })

  it('removes expired staged files and filesystem orphans during recovery', async () => {
    const staged = await upload()
    const id = (await staged.json() as { attachment: { id: string } }).attachment.id
    const storage = new DiaryAttachmentStorage(db)
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
    const storage = new DiaryAttachmentStorage(db)
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
    const storage = new DiaryAttachmentStorage(db)
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
    seedStagedRows(19, Date.now() + DIARY_ATTACHMENT_STAGE_LEASE_MS)
    expect((await upload('private-20.png')).status).toBe(201)
    expect((await upload('private-over-limit.png')).status).toBe(400)
  })
})
