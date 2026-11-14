import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../index'
import { applyMigrations } from '../db'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  jsonRequest,
  unlockDiaryAccessForTesting,
  withAuthCookie,
  withDiaryCapability,
  type AuthenticatedTestContext,
} from './helpers/auth'

const base = '/api/diary/plans'
const date = '2032-02-29'
const list = `${base}?date=${date}`
const month = `${base}/calendar?month=2032-02`
const password = 'diary-access-test-password'
let db: Database.Database
let auth: AuthenticatedTestContext
let capability: string

function request(method: string, path: string, body?: unknown, unlocked = true, origin = auth.runtime.config.publicOrigin) {
  const req = jsonRequest(path, { method, body, origin })
  return app.fetch(unlocked ? withDiaryCapability(auth, req, capability) : withAuthCookie(auth, req))
}

describe('Diary Plan migration', () => {
  it('adds the table on fresh databases and preserves an existing owner on upgrade', () => {
    for (const upgrade of [false, true]) {
      const database = new Database(':memory:')
      try {
        database.pragma('foreign_keys = ON')
        if (upgrade) {
          applyMigrations(database, 39)
          database.prepare(`
            INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
            VALUES ('existing', 'existing', 'test', 1, 1)
          `).run()
        }
        applyMigrations(database)
        applyMigrations(database)
        expect(database.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 40 })
        expect(database.prepare('SELECT id FROM diary_plan_items').all()).toEqual([])
        expect(database.prepare('SELECT username FROM users').all()).toEqual(upgrade ? [{ username: 'existing' }] : [])
      } finally {
        database.close()
      }
    }
  })
})

describe('Diary Plan API', () => {
  beforeAll(async () => {
    db = new Database(':memory:')
    auth = createAuthenticatedTestContext({ db })
    capability = await unlockDiaryAccessForTesting(auth, password)
  })

  afterAll(() => {
    closeAuthTestContext(auth)
    db.close()
  })

  it('requires auth, CSRF and a Diary capability for list, markers and writes', async () => {
    for (const path of [list, month]) {
      const unauthenticated = await app.request(path)
      expect(unauthenticated.status).toBe(401)
      expect(unauthenticated.headers.get('Cache-Control')).toBe('no-store')
      const locked = await request('GET', path, undefined, false)
      expect(locked.status).toBe(423)
      expect(await locked.json()).toEqual({ code: 'diary-locked' })
    }
    const input = { id: randomUUID(), date, title: 'private' }
    expect((await request('POST', base, input, false)).status).toBe(423)
    expect((await request('POST', base, input, true, 'https://untrusted.test')).status).toBe(403)
  })

  it('rejects invalid dates, times, titles, version values and unknown fields', async () => {
    const input = { id: randomUUID(), date, title: 'Plan' }
    for (const patch of [
      { date: '2031-02-29' }, { date: '2032-2-29' }, { plannedTime: '24:00' },
      { plannedTime: '9:00' }, { plannedTime: '09:00\n' }, { title: '  ' },
      { title: '🙂'.repeat(201) }, { title: undefined }, { completed: true },
    ]) {
      expect((await request('POST', base, { ...input, ...patch })).status).toBe(400)
    }
    expect((await request('GET', `${base}/calendar?month=2032-13`)).status).toBe(400)
    expect((await request('DELETE', `${base}/${input.id}?version=01`)).status).toBe(400)
  })

  it('creates multiple items, deduplicates retries and supports edits, completion, restore and CAS deletion', async () => {
    const id = randomUUID()
    const input = { id, date, title: 'Private no-time item' }
    const responses = await Promise.all([request('POST', base, input), request('POST', base, input)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201])
    expect((await responses[0]!.json()).item).toMatchObject({ id, plannedTime: null, version: 1 })
    expect((await request('POST', base, { ...input, title: 'Different input' })).status).toBe(409)
    const early = { id: randomUUID(), date, title: 'Early', plannedTime: '09:30' }
    const late = { id: randomUUID(), date, title: 'Late', plannedTime: '14:45' }
    const otherMonth = { id: randomUUID(), date: '2032-03-01', title: 'Next month' }
    for (const fields of [late, early, otherMonth]) {
      expect((await request('POST', base, fields)).status).toBe(201)
    }
    const items = (await (await request('GET', list)).json()).items
    expect(items.map((item: { id: string }) => item.id)).toEqual([early.id, late.id, id])
    const itemPath = `${base}/${early.id}`
    const complete = await request('PATCH', itemPath, { version: 1, completed: true, title: 'Renamed', plannedTime: '08:00' })
    expect((await complete.json()).item).toMatchObject({
      version: 2, title: 'Renamed', plannedTime: '08:00', completedAt: expect.any(Number),
    })
    expect((await request('PATCH', itemPath, { version: 1, title: 'Stale' })).status).toBe(409)
    expect((await request('DELETE', `${itemPath}?version=1`)).status).toBe(409)
    expect((await (await request('GET', month)).json()).days).toEqual([{ date, total: 3, completed: 1 }])
    expect((await (await request('GET', list)).json()).items.at(-1).id).toBe(early.id)
    expect((await (await request('PATCH', itemPath, { version: 2, completed: false })).json()).item)
      .toMatchObject({ version: 3, completedAt: null })
    expect((await request('DELETE', `${itemPath}?version=3`)).status).toBe(204)
    expect((await request('DELETE', `${itemPath}?version=3`)).status).toBe(204)
    expect((await request('POST', base, early)).status).toBe(409)
    expect((await (await request('GET', month)).json()).days).toEqual([{ date, total: 2, completed: 0 }])
  })

  it('encrypts private fields, isolates owners, survives lock/unlock and fails closed on tampering', async () => {
    const id = randomUUID()
    const privateDate = '2033-01-06'
    const path = `${base}?date=${privateDate}`
    const title = 'Sensitive appointment'
    expect((await request('POST', base, { id, date: privateDate, title, plannedTime: '08:15' })).status).toBe(201)
    const row = db.prepare('SELECT encrypted_fields FROM diary_plan_items WHERE id = ?').get(id) as { encrypted_fields: Buffer }
    expect(Buffer.isBuffer(row.encrypted_fields)).toBe(true)
    expect(row.encrypted_fields.includes(title)).toBe(false)
    expect(row.encrypted_fields.includes('08:15')).toBe(false)
    const other = db.prepare(`
      INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
      VALUES ('other', 'other', 'test', 1, 1)
    `).run().lastInsertRowid
    const foreignId = randomUUID()
    db.prepare(`
      INSERT INTO diary_plan_items (owner_user_id, id, date, encrypted_fields, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1)
    `).run(other, foreignId, privateDate, row.encrypted_fields)
    expect((await request('PATCH', `${base}/${foreignId}`, { version: 1, title: 'Not mine' })).status).toBe(404)
    expect((await request('DELETE', `${base}/${foreignId}?version=1`)).status).toBe(404)
    expect((await (await request('GET', `${base}/calendar?month=2033-01`)).json()).days)
      .toEqual([{ date: privateDate, total: 1, completed: 0 }])
    await auth.runtime.diaryAccess.lock(auth.session.id)
    expect((await request('GET', path)).status).toBe(423)
    capability = (await auth.runtime.diaryAccess.unlock(auth.session.id, password)).capability
    expect((await (await request('GET', path)).json()).items).toMatchObject([{ id, title }])
    const tampered = Buffer.from(row.encrypted_fields)
    tampered[tampered.length - 1] ^= 1
    db.prepare('UPDATE diary_plan_items SET encrypted_fields = ? WHERE id = ?').run(tampered, id)
    const response = await request('GET', path)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ code: 'diary-plan-payload-invalid' })
    expect(auth.logs.join(' ')).not.toContain(title)
  })
})
