import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import app from '../index'
import { closeAuthTestContext, createAuthenticatedTestContext, jsonRequest, unlockDiaryAccessForTesting, withAuthCookie, withDiaryCapability, type AuthenticatedTestContext } from './helpers/auth'
import { diaryLifeCrypto } from '../diaryAccess/lifeCrypto'
import { diaryLifeStore } from '../diaryLife'
import { applyMigrations } from '../db'

let db: Database.Database
let auth: AuthenticatedTestContext
let capability: string
const base = '/api/diary/life'
function request(method: string, path: string, body?: unknown, unlocked = true) {
  const req = jsonRequest(`${base}${path}`, { method, body, origin: auth.runtime.config.publicOrigin })
  return app.fetch(unlocked ? withDiaryCapability(auth, req, capability) : withAuthCookie(auth, req))
}
const event = { title: '私人生日', description: '加密正文', emoji: '🎂', type: 'anniversary', startDate: '2024-02-29', endDate: '2024-02-29', startTime: null, endTime: null, allDay: true, recurrence: 'yearly', showCountdown: true, isPrimary: false, expectedVersion: 0 }
describe('Diary database API', () => {
  beforeEach(async () => { db = new Database(':memory:'); auth = createAuthenticatedTestContext({ db }); capability = await unlockDiaryAccessForTesting(auth) })
  afterEach(() => { closeAuthTestContext(auth); db.close() })
  it('requires unlock and never caches private responses', async () => {
    const response = await request('GET', '/days/2026-11-15', undefined, false)
    expect(response.status).toBe(423)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await request('GET', '/events/list', undefined, false)).status).toBe(423)
  })
  it('repairs a version 43 database missing Diary deletion receipts', async () => {
    db.exec('DROP TABLE diary_deleted_records; UPDATE schema_version SET version = 43')
    const path = '/days/2026-11-15'
    const eventPath = `/events/${randomUUID()}`
    const day = { moodId: null, description: 'Diary upgrade test', expectedVersion: 0 }

    expect((await request('PUT', path, day)).status).toBe(503)
    expect((await request('GET', path)).status).toBe(503)
    expect((await request('PUT', eventPath, event)).status).toBe(503)

    applyMigrations(db)
    const emptyDay = await request('GET', path)
    expect(emptyDay.status).toBe(200)
    expect(await emptyDay.json()).toEqual({ day: null, version: 0 })
    expect((await request('PUT', path, day)).status).toBe(200)
    expect((await request('PUT', eventPath, event)).status).toBe(200)
    expect((await request('DELETE', path, { expectedVersion: 1 })).status).toBe(200)

    // A complete version 43 database already has the table and can have receipts.
    db.exec('UPDATE schema_version SET version = 43')
    applyMigrations(db)
    expect((await request('PUT', path, day)).status).toBe(409)
    expect((await request('GET', eventPath)).status).toBe(200)
  })
  it('creates one day, encrypts fields, detects conflicts, clears mood, and deletes', async () => {
    const fields = { moodId: 'happy', description: '仅用于测试的私人记录', expectedVersion: 0 }
    expect((await request('PUT', '/days/2026-11-15', fields)).status).toBe(200)
    expect((await request('PUT', '/days/2026-11-15', fields)).status).toBe(409)
    const row = db.prepare('SELECT * FROM diary_days').get() as { encrypted_fields: Buffer }
    expect(row.encrypted_fields.toString()).not.toContain(fields.description)
    expect((await request('PUT', '/days/2026-11-15', { ...fields, moodId: null, expectedVersion: 1 })).status).toBe(200)
    expect((await (await request('GET', '/days/2026-11-15')).json()).day.moodId).toBeNull()
    expect((await request('DELETE', '/days/2026-11-15', { expectedVersion: 1 })).status).toBe(409)
    expect((await request('DELETE', '/days/2026-11-15', { expectedVersion: 2 })).status).toBe(200)
    expect((await request('PUT', '/days/2026-11-15', fields)).status).toBe(409)
    const deleted = await (await request('GET', '/days/2026-11-15')).json()
    expect(deleted.day).toBeNull()
    expect((await request('PUT', '/days/2026-11-15', { ...fields, expectedVersion: deleted.version })).status).toBe(200)
    expect((await request('PUT', '/days/2026-11-15', { ...fields, expectedVersion: 1 })).status).toBe(409)
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
