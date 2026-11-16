import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Temporal } from '@js-temporal/polyfill'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import app from '../index'
import { closeAuthTestContext, createAuthenticatedTestContext, jsonRequest, unlockDiaryAccessForTesting, withAuthCookie, withDiaryCapability, type AuthenticatedTestContext } from './helpers/auth'
import { diaryLifeCrypto } from '../diaryAccess/lifeCrypto'
import { diaryLifeStore } from '../diaryLife'
import { diaryToday } from '../diaryDate'
import * as database from '../db'
import { DiaryAttachmentStorage } from '../diaryAttachments/storage'

let db: Database.Database
let auth: AuthenticatedTestContext
let capability: string
let tempRoot: string
const base = '/api/diary/life'
function request(method: string, path: string, body?: unknown, unlocked = true) {
  const req = jsonRequest(`${base}${path}`, { method, body, origin: auth.runtime.config.publicOrigin })
  return app.fetch(unlocked ? withDiaryCapability(auth, req, capability) : withAuthCookie(auth, req))
}
const event = { title: '私人生日', description: '加密正文', emoji: '🎂', type: 'anniversary', startDate: '2024-02-29', endDate: '2024-02-29', startTime: null, endTime: null, allDay: true, recurrence: 'yearly', showCountdown: true, isPrimary: false, expectedVersion: 0 }
describe('Diary database API', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-16T07:59:00Z'))
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-diary-life-'))
    db = new Database(path.join(tempRoot, 'fixture.db'))
    auth = createAuthenticatedTestContext({ db })
    capability = await unlockDiaryAccessForTesting(auth)
  })
  afterEach(async () => {
    vi.useRealTimers()
    closeAuthTestContext(auth)
    db.close()
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('uses the server time zone at midnight and protects future dates without blocking future Events', async () => {
    const zone = vi.spyOn(Temporal.Now, 'timeZoneId').mockReturnValue('America/Los_Angeles')
    const fields = { moodId: null, entries: ['测试日记'], expectedVersion: 0 }
    try {
      expect(await (await request('GET', '/day-policy')).json()).toEqual({ today: '2026-11-15' })
      for (const date of ['2026-11-14', '2026-11-15']) {
        expect((await request('PUT', `/days/${date}`, fields)).status).toBe(200)
        expect((await request('PUT', `/days/${date}`, { ...fields, expectedVersion: 1 })).status).toBe(200)
      }
      for (const date of ['2026-11-16', '2026-12-01', '2027-01-01']) {
        const denied = await request('PUT', `/days/${date}`, { ...fields, today: date })
        expect(denied.status).toBe(403)
        expect(await denied.json()).toEqual({ code: 'diary-future-date' })
        const deletion = await request('DELETE', `/days/${date}`, { expectedVersion: 1 })
        expect(deletion.status).toBe(403)
        expect(await deletion.json()).toEqual({ code: 'diary-future-date' })
        expect(await (await request('GET', `/days/${date}`)).json()).toMatchObject({ day: null, version: 0 })
      }
      expect((await request('PUT', `/events/${randomUUID()}`, {
        ...event, startDate: '2027-01-01', endDate: '2027-01-01',
      })).status).toBe(200)

      vi.setSystemTime(new Date('2026-11-16T08:00:00Z'))
      expect(await (await request('GET', '/day-policy')).json()).toEqual({ today: '2026-11-16' })
      expect((await request('PUT', '/days/2026-11-16', fields)).status).toBe(200)
    } finally { zone.mockRestore() }
  })

  it('reconciles only the attachment files belonging to the active database', async () => {
    const unrelatedRoot = path.join(tempRoot, 'other-instance')
    const unrelatedStorage = path.join(unrelatedRoot, 'diary-attachments')
    await fs.mkdir(unrelatedRoot)
    await fs.mkdir(unrelatedStorage, { mode: 0o700 })
    const otherFile = path.join(unrelatedStorage, randomUUID())
    const otherBytes = Buffer.from('attachment bytes from another instance')
    await fs.writeFile(otherFile, otherBytes, { mode: 0o600 })
    const storage = new DiaryAttachmentStorage(db)
    const orphan = randomUUID()
    await storage.write(orphan, Buffer.from('local orphan'))

    const configuredDataDir = vi.spyOn(database, 'getDataDir').mockReturnValue(unrelatedRoot)
    try {
      expect((await request('GET', '/days/2026-11-15')).status).toBe(200)
      expect(await storage.list()).toEqual([])
      expect(await fs.readFile(otherFile)).toEqual(otherBytes)
    } finally { configuredDataDir.mockRestore() }
  })
  it('requires unlock and never caches private responses', async () => {
    const response = await request('GET', '/days/2026-11-15', undefined, false)
    expect(response.status).toBe(423)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const privateSearch = await request('POST', '/search', { query: '私密内容' }, false)
    expect(privateSearch.status).toBe(423)
    expect(privateSearch.headers.get('cache-control')).toBe('no-store')
    expect((await request('GET', '/events/list', undefined, false)).status).toBe(423)
  })
  it('searches only unlocked encrypted Diary entries and returns one hit per day', async () => {
    const firstDate = '2026-11-15'
    const firstEntries = ['早餐做了南瓜饼', '晚上又吃了南瓜饼']
    const firstIds = [randomUUID(), randomUUID()]
    expect((await request('PUT', `/days/${firstDate}`, { moodId: null, entries: firstEntries, entryIds: firstIds, expectedVersion: 0 })).status).toBe(200)
    expect((await request('PUT', '/days/2026-11-14', { moodId: null, entries: ['nUvYn confidential phrase 2026-11-15'], expectedVersion: 0 })).status).toBe(200)
    expect((await request('PUT', '/days/2026-11-10', { moodId: 'happy', entries: [], expectedVersion: 0 })).status).toBe(200)
    expect((await request('PUT', `/events/${randomUUID()}`, { ...event, title: '南瓜饼' })).status).toBe(200)

    const chinese = await (await request('POST', '/search', { query: '南瓜饼' })).json()
    expect(chinese).toMatchObject({ nextCursor: null, items: [{ date: firstDate, entryId: firstIds[0], snippet: '早餐做了南瓜饼', match: 'entry' }] })
    expect(chinese.items).toHaveLength(1)
    const english = await (await request('POST', '/search', { query: 'NUVYN CONFIDENTIAL' })).json()
    expect(english.items).toMatchObject([{ date: '2026-11-14', snippet: 'nUvYn confidential phrase 2026-11-15', match: 'entry' }])
    const dateHits = (await (await request('POST', '/search', { query: '2026-11-15' })).json()).items
    expect(dateHits).toMatchObject([{ date: firstDate, match: 'date' }, { date: '2026-11-14', match: 'entry' }])
    expect((await (await request('POST', '/search', { query: '2026-11-10' })).json()).items).toMatchObject([{ date: '2026-11-10', match: 'date' }])
    expect((await (await request('POST', '/search', { query: '2026-11-13' })).json()).items).toEqual([])

    const encrypted = db.prepare('SELECT encrypted_fields FROM diary_days WHERE date = ?').get(firstDate) as { encrypted_fields: Buffer }
    expect(encrypted.encrypted_fields.toString()).not.toContain(firstEntries[0])
  })
  it('paginates Diary search by descending date without skipping older matches', async () => {
    const dates = Array.from({ length: 23 }, (_, index) => Temporal.PlainDate.from('2026-11-15').subtract({ days: index }).toString())
    for (const date of dates) {
      const saved = await request('PUT', `/days/${date}`, { moodId: null, entries: ['shared page marker'], expectedVersion: 0 })
      expect(saved.status).toBe(200)
    }
    const first = await (await request('POST', '/search', { query: 'shared page marker', limit: 20 })).json()
    expect(first.items).toHaveLength(20)
    expect(first.items.map((item: { date: string }) => item.date)).toEqual([...dates].slice(0, 20))
    expect(first.nextCursor).toBe(dates[19])
    const second = await (await request('POST', '/search', { query: 'shared page marker', limit: 20, cursor: first.nextCursor })).json()
    expect(second.items.map((item: { date: string }) => item.date)).toEqual(dates.slice(20))
    expect(second.nextCursor).toBeNull()
  })
  it('scopes Diary search to the authenticated owner and validates the query', async () => {
    expect((await request('POST', '/search', { query: '   ' })).status).toBe(400)
    expect((await request('POST', '/search', { query: 'x'.repeat(121) })).status).toBe(400)
    expect((await request('POST', '/search', { query: 'valid', limit: 21 })).status).toBe(400)
    expect((await request('POST', '/search', { query: 'valid', cursor: '2026-02-30' })).status).toBe(400)
    expect((await request('PUT', '/days/2026-11-15', { moodId: null, entries: ['owner-only marker'], expectedVersion: 0 })).status).toBe(200)

    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, async operation => {
      const otherOwner = diaryLifeStore(db, auth.userId + 1, operation)
      expect(await otherOwner.searchDays('owner-only marker', 20, null)).toEqual({ items: [], nextCursor: null })
    })
  })
  it('limits search requests per unlocked session and resets the window', async () => {
    for (let index = 0; index < 8; index += 1) {
      expect((await request('POST', '/search', { query: 'missing' })).status).toBe(200)
    }
    expect((await request('POST', '/search', { query: 'missing' })).status).toBe(429)
    vi.setSystemTime(new Date('2026-11-16T08:00:01Z'))
    expect((await request('POST', '/search', { query: 'missing' })).status).toBe(200)
  })
  it('scans a large encrypted history without returning or persisting body text outside results', async () => {
    const total = 1_200
    const newest = Temporal.PlainDate.from('2026-11-15')
    const insert = db.prepare('INSERT INTO diary_days VALUES (?, ?, ?, ?, ?, ?)')
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, async operation => {
      for (let index = 0; index < total; index += 1) {
        const date = newest.subtract({ days: index }).toString()
        const entries = [index === total - 1 ? 'oldest private history needle' : `private history row ${index}`]
        const encrypted = operation.life!.encrypt({ moodId: null, entries }, JSON.stringify([auth.userId, 'day', date, 1]))
        insert.run(auth.userId, date, encrypted, 1, 1, 1)
      }
    })
    const result = await (await request('POST', '/search', { query: 'oldest private history needle' })).json()
    expect(result.items).toMatchObject([{ date: newest.subtract({ days: total - 1 }).toString(), snippet: 'oldest private history needle' }])
    const stored = db.prepare('SELECT encrypted_fields FROM diary_days ORDER BY date ASC LIMIT 1').get() as { encrypted_fields: Buffer }
    expect(stored.encrypted_fields.toString()).not.toContain('oldest private history needle')

    const controller = new AbortController()
    const aborted = await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, async operation => {
      const search = diaryLifeStore(db, auth.userId, operation).searchDays('oldest private history needle', 20, null, controller.signal)
      await new Promise<void>(resolve => setImmediate(resolve))
      controller.abort()
      return search
    })
    expect(aborted).toEqual({ items: [], nextCursor: null })
  })
  it('repairs a version 43 database missing Diary deletion receipts', async () => {
    db.exec('DROP TABLE diary_day_attachments; DROP TABLE diary_deleted_records; UPDATE schema_version SET version = 43')
    const path = '/days/2026-11-15'
    const eventPath = `/events/${randomUUID()}`
    const day = { moodId: null, description: 'Diary upgrade test', expectedVersion: 0 }

    expect((await request('PUT', path, day)).status).toBe(503)
    expect((await request('GET', path)).status).toBe(503)
    expect((await request('PUT', eventPath, event)).status).toBe(503)

    database.applyMigrations(db)
    const emptyDay = await request('GET', path)
    expect(emptyDay.status).toBe(200)
    expect(await emptyDay.json()).toEqual({ day: null, version: 0, attachments: [], today: diaryToday() })
    expect((await request('PUT', path, day)).status).toBe(200)
    expect((await request('PUT', eventPath, event)).status).toBe(200)
    expect((await request('DELETE', path, { expectedVersion: 1 })).status).toBe(200)

    // Migration 44 is idempotent for installations that already had deletion receipts.
    db.exec('UPDATE schema_version SET version = 43')
    database.applyMigrations(db, 44)
    expect((await request('PUT', path, day)).status).toBe(409)
    expect((await request('GET', eventPath)).status).toBe(200)
  })
  it('creates one day, encrypts fields, detects conflicts, clears mood, and deletes', async () => {
    const fields = { moodId: 'happy', entries: ['仅用于测试的私人记录'], expectedVersion: 0 }
    expect((await request('PUT', '/days/2026-11-15', fields)).status).toBe(200)
    expect((await request('PUT', '/days/2026-11-15', fields)).status).toBe(409)
    const row = db.prepare('SELECT * FROM diary_days').get() as { encrypted_fields: Buffer }
    expect(row.encrypted_fields.toString()).not.toContain(fields.entries[0])
    expect((await request('PUT', '/days/2026-11-15', { moodId: null, entries: [], expectedVersion: 1 })).status).toBe(400)
    expect((await request('PUT', '/days/2026-11-15', { moodId: null, entries: ['  '], expectedVersion: 1 })).status).toBe(400)
    expect((await request('PUT', '/days/2026-11-15', { moodId: null, entries: ['更新'], expectedVersion: 1 })).status).toBe(200)
    expect((await (await request('GET', '/days/2026-11-15')).json()).day.moodId).toBeNull()
    expect((await request('DELETE', '/days/2026-11-15', { expectedVersion: 1 })).status).toBe(409)
    expect((await request('DELETE', '/days/2026-11-15', { expectedVersion: 2 })).status).toBe(200)
    expect((await request('PUT', '/days/2026-11-15', fields)).status).toBe(409)
    const deleted = await (await request('GET', '/days/2026-11-15')).json()
    expect(deleted.day).toBeNull()
    expect((await request('PUT', '/days/2026-11-15', { ...fields, expectedVersion: deleted.version })).status).toBe(200)
    expect((await request('PUT', '/days/2026-11-15', { ...fields, expectedVersion: 1 })).status).toBe(409)
  })
  it('reads legacy encrypted descriptions as one entry and writes the new entries payload', async () => {
    const date = '2026-11-15'
    const legacyText = '第一行  \n第二行保留原换行\n'
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, operation => {
      const payload = operation.life!.encrypt({ moodId: null, description: legacyText }, JSON.stringify([auth.userId, 'day', date, 1]))
      db.prepare('INSERT INTO diary_days VALUES (?, ?, ?, ?, ?, ?)').run(auth.userId, date, payload, 1, 1, 1)
    })

    const legacy = await request('GET', `/days/${date}`)
    expect((await legacy.json()).day).toMatchObject({ moodId: null, entries: [legacyText], version: 1 })
    const summary = await request('GET', '/days?start=2026-11-01&end=2026-11-30')
    expect((await summary.json()).days).toContainEqual({ date, moodId: null, hasEntries: true, hasAttachments: false, version: 1 })
    expect((await request('GET', '/days?start=2026-11-01&end=2026-11-30', undefined, false)).status).toBe(423)

    const replacement = ['新的第一条', '新的第二条']
    expect((await request('PUT', `/days/${date}`, { moodId: 'happy', entries: replacement, expectedVersion: 1 })).status).toBe(200)
    const saved = await request('GET', `/days/${date}`)
    expect((await saved.json()).day).toMatchObject({ moodId: 'happy', entries: replacement, version: 2 })
    const row = db.prepare('SELECT encrypted_fields FROM diary_days WHERE date = ?').get(date) as { encrypted_fields: Buffer }
    expect(row.encrypted_fields.toString()).not.toContain(replacement[0])
  })
  it('rejects invalid date and empty day', async () => {
    expect((await request('PUT', '/days/2026-02-29', { moodId: 'happy', description: '', expectedVersion: 0 })).status).toBe(400)
    expect((await request('PUT', '/days/2026-11-15', { moodId: null, description: '', expectedVersion: 0 })).status).toBe(400)
  })
  it('supports several events, optimistic updates, and annual date filtering', async () => {
    const first = randomUUID(); const second = randomUUID()
    expect((await request('PUT', `/events/${first}`, event)).status).toBe(200)
    expect((await request('PUT', `/events/${second}`, event)).status).toBe(200)
    expect((await request('PUT', `/events/${first}`, event)).status).toBe(409)
    const response = await request('GET', '/events?start=2025-02-01&end=2025-03-01&date=2025-02-28')
    expect((await response.json()).items).toHaveLength(2)
    const unrelatedMonth = await request('GET', '/events?start=2025-11-01&end=2025-11-30')
    expect((await unrelatedMonth.json()).items).toHaveLength(0)
    await request('PUT', `/events/${randomUUID()}`, { ...event, recurrence: 'none' })
    const latest = randomUUID()
    expect((await request('PUT', `/events/${latest}`, { ...event, startDate: '2026-12-01', endDate: '2026-12-01', recurrence: 'none', showCountdown: false })).status).toBe(200)
    const list = await request('GET', '/events/list?offset=0')
    expect((await list.json()).items[0].id).toBe(latest)
    const countdowns = await request('GET', '/countdowns?today=2025-02-01')
    expect((await countdowns.json()).items.map((item: { id: string }) => item.id).sort()).toEqual([first, second].sort())
    expect((await request('PUT', `/events/${first}`, { ...event, title: '更新', expectedVersion: 1 })).status).toBe(200)
    expect((await request('DELETE', `/events/${first}`, { expectedVersion: 1 })).status).toBe(409)
  })
  it('authenticates encryption identity and tampering', () => {
    const crypto = diaryLifeCrypto(Buffer.alloc(32, 9), 'vault', () => {})
    const bytes = crypto.encrypt(event, 'owner:1')
    expect(crypto.decrypt(bytes, 'owner:1')).toEqual(event)
    expect(() => crypto.decrypt(bytes, 'owner:2')).toThrow()
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    expect(() => crypto.decrypt(bytes, 'owner:1')).toThrow()
  })
  it('isolates another owner at both SQL and ciphertext boundaries', async () => {
    await request('PUT', '/days/2026-11-15', { moodId: 'happy', description: 'private', expectedVersion: 0 })
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, operation => {
      const other = diaryLifeStore(db, auth.userId + 1, operation)
      expect(other.getDay('2026-11-15')).toBeNull()
      expect(other.days('2026-11-01', '2026-11-30')).toEqual([])
      expect(other.events('2026-11-01', '2026-11-30').items).toEqual([])
    })
  })
})
