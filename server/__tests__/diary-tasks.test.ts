import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../index'
import { createSession } from '../auth/session'
import { closeAuthTestContext, createAuthenticatedTestContext, jsonRequest, unlockDiaryAccessForTesting, withAuthCookie, withDiaryCapability, type AuthenticatedTestContext } from './helpers/auth'
import { DiaryTaskCursorError, diaryTaskStore } from '../diaryTasks'
import * as database from '../db'
import { isTaskOverdue } from '../../shared/diaryTasks'
import { lunarToSolar } from '../../shared/lunarCalendar'

let db: Database.Database
let auth: AuthenticatedTestContext
let capability: string
let tempRoot: string
const base = '/api/diary/life'
const accessPassword = 'diary-access-test-password'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function request(method: string, route: string, body?: unknown, unlocked = true) {
  const req = jsonRequest(`${base}${route}`, { method, body, origin: auth.runtime.config.publicOrigin })
  return app.fetch(unlocked ? withDiaryCapability(auth, req, capability) : withAuthCookie(auth, req))
}

function fields(overrides: Record<string, unknown> = {}) {
  return { title: 'Buy groceries', description: 'Milk\nBread', dueDate: '2026-11-17', dueTime: '09:30', ...overrides }
}

describe('Diary task API', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-16T08:00:00Z'))
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-diary-tasks-'))
    db = new Database(path.join(tempRoot, 'fixture.db'))
    auth = createAuthenticatedTestContext({ db })
    capability = await unlockDiaryAccessForTesting(auth, accessPassword)
  })

  afterEach(async () => {
    vi.useRealTimers()
    closeAuthTestContext(auth)
    db.close()
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('validates task fields, defaults optional values, and rejects client completion timestamps', async () => {
    const id = randomUUID()
    const invalid = [
      { title: '   ' },
      { title: 'x'.repeat(161) },
      { title: 'Valid', description: 'd'.repeat(4001) },
      { title: 'Valid', dueDate: '2026-02-29' },
      { title: 'Valid', dueDate: '2026-11-17', dueTime: '9:30' },
      { title: 'Valid', dueDate: null, dueTime: '09:30' },
      { title: 'Valid', completedAt: 1 },
    ]
    for (const body of invalid) {
      expect((await request('PUT', `/tasks/${id}`, { ...body, expectedVersion: 0 })).status).toBe(400)
    }

    const undated = await request('PUT', `/tasks/${id}`, { title: '  Undated  ', expectedVersion: 0 })
    expect(undated.status).toBe(200)
    expect((await undated.json()).task).toMatchObject({ title: 'Undated', description: '', dueDate: null, dueTime: null, completedAt: null, version: 1 })
    const validDateOnly = await request('PUT', `/tasks/${randomUUID()}`, { ...fields({ dueTime: null }), expectedVersion: 0 })
    expect(validDateOnly.status).toBe(200)
    expect((await validDateOnly.json()).task).toMatchObject({ dueDate: '2026-11-17', dueTime: null })
  })

  it('supports encrypted CRUD, completion, reopening, and completed-state-preserving edits with CAS versions', async () => {
    const id = randomUUID()
    const createdResponse = await request('PUT', `/tasks/${id}`, { ...fields(), expectedVersion: 0 })
    expect(createdResponse.status).toBe(200)
    const created = (await createdResponse.json()).task
    expect(created).toMatchObject({ ...fields(), id, completedAt: null, version: 1 })
    expect(created.createdAt).toBe(Date.now())

    const row = db.prepare('SELECT due_date, encrypted_fields FROM diary_tasks WHERE owner_user_id = ? AND id = ?').get(auth.userId, id) as { due_date: string; encrypted_fields: Buffer }
    expect(row.due_date).toBe('2026-11-17')
    expect(row.encrypted_fields.toString()).not.toContain('Buy groceries')
    expect(row.encrypted_fields.toString()).not.toContain('Milk')
    expect((await (await request('GET', `/tasks/${id}`)).json()).task).toEqual(created)

    const completed = await request('POST', `/tasks/${id}/complete`, { expectedVersion: 1 })
    expect(completed.status).toBe(200)
    expect((await completed.json()).task).toMatchObject({ ...created, completedAt: Date.now(), version: 2 })
    expect((await request('POST', `/tasks/${id}/complete`, { expectedVersion: 2 })).status).toBe(409)
    expect((await request('PUT', `/tasks/${id}`, { ...fields({ title: 'Updated task' }), expectedVersion: 1 })).status).toBe(409)

    const edited = await request('PUT', `/tasks/${id}`, { ...fields({ title: 'Updated task' }), expectedVersion: 2 })
    expect(edited.status).toBe(200)
    const editedTask = (await edited.json()).task
    expect(editedTask).toMatchObject({ title: 'Updated task', description: 'Milk\nBread', dueDate: '2026-11-17', dueTime: '09:30', completedAt: Date.now(), version: 3 })

    const reopened = await request('POST', `/tasks/${id}/reopen`, { expectedVersion: 3 })
    expect(reopened.status).toBe(200)
    const reopenedTask = (await reopened.json()).task
    expect(reopenedTask).toMatchObject({ ...editedTask, completedAt: null, version: 4 })
    expect((await request('POST', `/tasks/${id}/reopen`, { expectedVersion: 4 })).status).toBe(409)
    const completedAgain = await request('POST', `/tasks/${id}/complete`, { expectedVersion: 4 })
    expect((await completedAgain.json()).task).toMatchObject({ ...editedTask, completedAt: Date.now(), version: 5 })
  })

  it('uses content-free delete tombstones to reject stale task resurrection', async () => {
    const id = randomUUID()
    expect((await request('PUT', `/tasks/${id}`, { ...fields(), expectedVersion: 0 })).status).toBe(200)
    expect((await request('DELETE', `/tasks/${id}`, { expectedVersion: 0 })).status).toBe(400)
    const removed = await request('DELETE', `/tasks/${id}`, { expectedVersion: 1 })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual({ ok: true, version: 2 })
    expect((await request('GET', `/tasks/${id}`)).status).toBe(404)
    expect((await request('PUT', `/tasks/${id}`, { ...fields(), expectedVersion: 0 })).status).toBe(409)
    expect((db.prepare('SELECT * FROM diary_task_deleted_records WHERE owner_user_id = ? AND id = ?').get(auth.userId, id) as object)).toBeTruthy()

    const reused = await request('PUT', `/tasks/${id}`, { ...fields({ title: 'Explicitly versioned reuse' }), expectedVersion: 2 })
    expect(reused.status).toBe(200)
    expect((await reused.json()).task).toMatchObject({ title: 'Explicitly versioned reuse', version: 3 })
  })

  it('lists dated and undated tasks with stable cursor pagination and no repeated or missing rows', async () => {
    const total = 203
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, operation => {
      const store = diaryTaskStore(db, auth.userId, operation)
      for (let index = 0; index < total; index += 1) {
        store.putTask(randomUUID(), {
          title: `Task ${index}`,
          description: '',
          dueDate: index === 0 ? null : `2026-11-${String(1 + (index % 17)).padStart(2, '0')}`,
          dueTime: null,
        }, 0)
      }
    })
    const first = await (await request('GET', '/tasks/list')).json()
    expect(first.items).toHaveLength(200)
    expect(first.nextCursor).toEqual(expect.any(String))
    const cursorPayload = JSON.parse(Buffer.from(first.nextCursor.split('.')[0], 'base64url').toString())
    expect(cursorPayload).toMatchObject({ v: 1, owner: auth.userId, revision: total, query: { type: 'list' } })
    expect(cursorPayload).toMatchObject({ id: first.items.at(-1).id, dueDate: first.items.at(-1).dueDate })
    const second = await (await request('GET', `/tasks/list?cursor=${encodeURIComponent(first.nextCursor)}`)).json()
    expect(second.items).toHaveLength(3)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.items, ...second.items].map((task: { id: string }) => task.id)
    expect(new Set(ids).size).toBe(total)
    expect(ids).toEqual([...ids].sort((left, right) => {
      const leftTask = [...first.items, ...second.items].find((task: { id: string }) => task.id === left)!
      const rightTask = [...first.items, ...second.items].find((task: { id: string }) => task.id === right)!
      const leftDate = leftTask.dueDate ?? '9999-12-31'
      const rightDate = rightTask.dueDate ?? '9999-12-31'
      return leftDate.localeCompare(rightDate) || left.localeCompare(right)
    }))
    expect((await request('GET', '/tasks/list?offset=0')).status).toBe(400)
    expect((await request('GET', '/tasks/list?cursor=')).status).toBe(400)
    expect((await request('GET', `/tasks/list?cursor=${'x'.repeat(1025)}`)).status).toBe(400)
    const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('A') ? 'B' : 'A'}`
    expect((await request('GET', `/tasks/list?cursor=${tampered}`)).status).toBe(400)

    const rangePath = '/tasks?start=2026-11-01&end=2026-11-17'
    const rangeFirst = await (await request('GET', rangePath)).json()
    expect(rangeFirst.items).toHaveLength(200)
    expect(rangeFirst.nextCursor).toEqual(expect.any(String))
    const rangeSecond = await (await request('GET', `${rangePath}&cursor=${encodeURIComponent(rangeFirst.nextCursor)}`)).json()
    expect([...rangeFirst.items, ...rangeSecond.items].map((task: { id: string }) => task.id)).toHaveLength(total - 1)
    expect((await request('GET', `/tasks?start=2026-11-02&end=2026-11-17&cursor=${encodeURIComponent(rangeFirst.nextCursor)}`)).status).toBe(400)
    expect((await request('GET', `/tasks?start=2026-11-01&end=2026-11-17&offset=0`)).status).toBe(400)
    expect((await request('GET', `/tasks?start=2026-11-01&end=2026-11-17&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400)

    const listRowsBefore = Number((db.prepare('SELECT COUNT(*) AS count FROM diary_tasks WHERE owner_user_id = ?').get(auth.userId) as { count: number }).count)
    const revisionBefore = Number((db.prepare('SELECT revision FROM diary_task_list_revisions WHERE owner_user_id = ?').get(auth.userId) as { revision: number }).revision)
    expect((await request('GET', '/tasks/list?cursor=not-a-cursor')).status).toBe(400)
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM diary_tasks WHERE owner_user_id = ?').get(auth.userId) as { count: number }).count)).toBe(listRowsBefore)
    expect(Number((db.prepare('SELECT revision FROM diary_task_list_revisions WHERE owner_user_id = ?').get(auth.userId) as { revision: number }).revision)).toBe(revisionBefore)
  })

  it('queries inclusive date-range boundaries across years and excludes undated tasks', async () => {
    const before = randomUUID()
    const start = randomUUID()
    const end = randomUUID()
    const after = randomUUID()
    const undated = randomUUID()
    const rows = [
      [before, '2025-12-30'], [start, '2025-12-31'], [end, '2026-01-01'], [after, '2026-01-02'], [undated, null],
    ] as const
    for (const [id, dueDate] of rows) {
      expect((await request('PUT', `/tasks/${id}`, { ...fields({ title: id, dueDate, dueTime: null }), expectedVersion: 0 })).status).toBe(200)
    }
    const boundary = await request('GET', '/tasks?start=2025-12-31&end=2026-01-01')
    expect(boundary.status).toBe(200)
    expect((await boundary.json()).items.map((task: { id: string }) => task.id)).toEqual([start, end])
    expect((await request('GET', '/tasks?start=2026-02-30&end=2026-03-01')).status).toBe(400)
    expect((await request('GET', '/tasks?start=2026-11-17&end=2026-11-16')).status).toBe(400)
  })

  it('invalidates cursors after every task mutation and isolates revisions by owner', async () => {
    const ids = Array.from({ length: 201 }, () => randomUUID())
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, operation => {
      const store = diaryTaskStore(db, auth.userId, operation)
      for (const [index, id] of ids.entries()) {
        store.putTask(id, { title: `Revision ${index}`, description: '', dueDate: '2026-12-01', dueTime: null }, 0)
      }
    })
    const readRevision = (owner = auth.userId) => Number((db.prepare(
      'SELECT revision FROM diary_task_list_revisions WHERE owner_user_id = ?',
    ).get(owner) as { revision: number } | undefined)?.revision ?? 0)
    const firstPage = await (await request('GET', '/tasks/list')).json()
    expect(firstPage.items).toHaveLength(200)
    expect(firstPage.nextCursor).toEqual(expect.any(String))

    const ownerB = Number(db.prepare(`INSERT INTO users (username, username_normalized, password_hash, disabled, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)`).run('task-revision-owner-b', 'task-revision-owner-b', 'test', Date.now(), Date.now()).lastInsertRowid)
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, operation => {
      diaryTaskStore(db, ownerB, operation).putTask(randomUUID(), {
        title: 'Other owner task', description: '', dueDate: '2026-12-01', dueTime: null,
      }, 0)
    })
    expect(readRevision(ownerB)).toBe(1)
    expect(readRevision()).toBe(201)
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, operation => {
      expect(() => diaryTaskStore(db, ownerB, operation).listTasks(firstPage.nextCursor)).toThrow(DiaryTaskCursorError)
    })
    const pageTwoBeforeOwnerChange = await request('GET', `/tasks/list?cursor=${encodeURIComponent(firstPage.nextCursor)}`)
    expect(pageTwoBeforeOwnerChange.status).toBe(200)

    const expectCursorInvalidated = async (cursor: string) => {
      const response = await request('GET', `/tasks/list?cursor=${encodeURIComponent(cursor)}`)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ code: 'diary-task-list-changed' })
    }
    let revision = readRevision()
    const createdId = randomUUID()
    expect((await request('PUT', `/tasks/${createdId}`, { ...fields(), expectedVersion: 0 })).status).toBe(200)
    expect(readRevision()).toBe(revision + 1)
    await expectCursorInvalidated(firstPage.nextCursor)

    const secondPage = await (await request('GET', '/tasks/list')).json()
    revision = readRevision()
    expect((await request('DELETE', `/tasks/${ids[0]}`, { expectedVersion: 1 })).status).toBe(200)
    expect(readRevision()).toBe(revision + 1)
    await expectCursorInvalidated(secondPage.nextCursor)

    const thirdPage = await (await request('GET', '/tasks/list')).json()
    revision = readRevision()
    expect((await request('PUT', `/tasks/${ids[1]}`, {
      ...fields({ title: 'Moved to another due date', dueDate: '2027-01-01', dueTime: null }), expectedVersion: 1,
    })).status).toBe(200)
    expect(readRevision()).toBe(revision + 1)
    await expectCursorInvalidated(thirdPage.nextCursor)

    const fourthPage = await (await request('GET', '/tasks/list')).json()
    revision = readRevision()
    expect((await request('POST', `/tasks/${ids[2]}/complete`, { expectedVersion: 1 })).status).toBe(200)
    expect(readRevision()).toBe(revision + 1)
    await expectCursorInvalidated(fourthPage.nextCursor)

    const fifthPage = await (await request('GET', '/tasks/list')).json()
    revision = readRevision()
    expect((await request('POST', `/tasks/${ids[2]}/reopen`, { expectedVersion: 2 })).status).toBe(200)
    expect(readRevision()).toBe(revision + 1)
    await expectCursorInvalidated(fifthPage.nextCursor)

    const beforeCasFailure = readRevision()
    expect((await request('PUT', `/tasks/${ids[2]}`, { ...fields(), expectedVersion: 1 })).status).toBe(409)
    expect(readRevision()).toBe(beforeCasFailure)

    db.prepare('UPDATE diary_task_list_revisions SET revision = ? WHERE owner_user_id = ?').run(Number.MAX_SAFE_INTEGER, auth.userId)
    const beforeExhaustion = db.prepare('SELECT version, encrypted_fields FROM diary_tasks WHERE owner_user_id = ? AND id = ?')
      .get(auth.userId, ids[2]) as { version: number; encrypted_fields: Buffer }
    const exhausted = await request('PUT', `/tasks/${ids[2]}`, {
      ...fields({ title: 'Revision exhausted' }), expectedVersion: 3,
    })
    expect(exhausted.status).toBe(503)
    expect(db.prepare('SELECT version, encrypted_fields FROM diary_tasks WHERE owner_user_id = ? AND id = ?')
      .get(auth.userId, ids[2])).toEqual(beforeExhaustion)
    expect(readRevision()).toBe(Number.MAX_SAFE_INTEGER)
    expect(readRevision(ownerB)).toBe(1)
  })

  it('calculates overdue by due date and ignores the due-time threshold', async () => {
    const id = randomUUID()
    await request('PUT', `/tasks/${id}`, { ...fields({ dueDate: '2026-11-15', dueTime: '23:59' }), expectedVersion: 0 })
    const overdue = await request('GET', `/tasks/${id}`)
    const task = (await overdue.json()).task
    expect(task).toMatchObject({ dueDate: '2026-11-15', dueTime: '23:59', completedAt: null })
    expect(isTaskOverdue(task, '2026-11-16')).toBe(true)
    expect(isTaskOverdue(task, '2026-11-15')).toBe(false)
    expect(isTaskOverdue({ ...task, completedAt: Date.now() }, '2026-11-16')).toBe(false)
  })

  it('scopes identical task IDs by owner and authenticates the owner in ciphertext', async () => {
    const id = randomUUID()
    expect((await request('PUT', `/tasks/${id}`, { ...fields(), expectedVersion: 0 })).status).toBe(200)
    const ownerRow = db.prepare('SELECT * FROM diary_tasks WHERE owner_user_id = ? AND id = ?').get(auth.userId, id) as { encrypted_fields: Buffer; version: number }
    const owner2 = Number(db.prepare(`INSERT INTO users (username, username_normalized, password_hash, disabled, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)`).run('second-task-owner', 'second-task-owner', 'test', Date.now(), Date.now()).lastInsertRowid)
    await auth.runtime.diaryAccess.withBodyOperation(auth.session.id, capability, operation => {
      const owner2Store = diaryTaskStore(db, owner2, operation)
      expect(owner2Store.getTask(id)).toBeNull()
      const otherOnlyId = randomUUID()
      owner2Store.putTask(otherOnlyId, {
        title: 'Private to other owner', description: '', dueDate: '2026-11-17', dueTime: null,
      }, 0)
      const other = owner2Store.putTask(id, {
        title: 'Other owner task', description: '', dueDate: '2026-11-17', dueTime: null,
      }, 0)
      expect(other.title).toBe('Other owner task')
      expect(diaryTaskStore(db, auth.userId, operation).getTask(id)?.title).toBe('Buy groceries')

      const otherRow = db.prepare('SELECT * FROM diary_tasks WHERE owner_user_id = ? AND id = ?').get(owner2, id) as { encrypted_fields: Buffer; version: number }
      db.prepare('UPDATE diary_tasks SET encrypted_fields = ? WHERE owner_user_id = ? AND id = ?').run(ownerRow.encrypted_fields, owner2, id)
      expect(() => owner2Store.getTask(id)).toThrow()
      db.prepare('UPDATE diary_tasks SET encrypted_fields = ? WHERE owner_user_id = ? AND id = ?').run(otherRow.encrypted_fields, owner2, id)
      expect((owner2Store.listTasks().items).some(task => task.id === otherOnlyId)).toBe(true)
    })
    const foreignTaskId = db.prepare('SELECT id FROM diary_tasks WHERE owner_user_id = ? AND id <> ? ORDER BY id LIMIT 1').get(owner2, id) as { id: string }
    expect((await request('GET', `/tasks/${foreignTaskId.id}`)).status).toBe(404)
    expect((await request('DELETE', `/tasks/${foreignTaskId.id}`, { expectedVersion: 1 })).status).toBe(404)
    expect(db.prepare('SELECT id FROM diary_tasks WHERE owner_user_id = ? AND id = ?').get(owner2, foreignTaskId.id)).toBeTruthy()
  })

  it('rejects tampered ciphertext and inconsistent plaintext due-date indexes', async () => {
    const first = randomUUID()
    const second = randomUUID()
    const third = randomUUID()
    const fourth = randomUUID()
    await request('PUT', `/tasks/${first}`, { ...fields(), expectedVersion: 0 })
    await request('PUT', `/tasks/${second}`, { ...fields(), expectedVersion: 0 })
    await request('PUT', `/tasks/${third}`, { ...fields({ dueDate: null, dueTime: null }), expectedVersion: 0 })
    await request('PUT', `/tasks/${fourth}`, { ...fields(), expectedVersion: 0 })
    const firstCipher = (db.prepare('SELECT encrypted_fields FROM diary_tasks WHERE id = ?').get(first) as { encrypted_fields: Buffer }).encrypted_fields
    db.prepare('UPDATE diary_tasks SET encrypted_fields = ? WHERE id = ?').run(firstCipher, second)
    expect((await request('GET', `/tasks/${second}`)).status).toBe(503)
    db.prepare('UPDATE diary_tasks SET due_date = ? WHERE id = ?').run('2026-11-18', third)
    expect((await request('GET', `/tasks/${third}`)).status).toBe(503)
    db.prepare('UPDATE diary_tasks SET version = 2 WHERE id = ?').run(fourth)
    expect((await request('GET', `/tasks/${fourth}`)).status).toBe(503)

    const encrypted = db.prepare('SELECT encrypted_fields FROM diary_tasks WHERE id = ?').get(first) as { encrypted_fields: Buffer }
    const changed = Buffer.from(encrypted.encrypted_fields)
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    db.prepare('UPDATE diary_tasks SET encrypted_fields = ? WHERE id = ?').run(changed, first)
    expect((await request('GET', `/tasks/${first}`)).status).toBe(503)
  })

  it('requires authentication and an unlocked Diary session for every Todo API operation', async () => {
    const id = randomUUID()
    const lockedRequests: Array<[string, string, unknown?]> = [
      ['GET', '/tasks/list'],
      ['GET', '/tasks?start=2026-11-01&end=2026-11-30'],
      ['GET', `/tasks/${id}`],
      ['PUT', `/tasks/${id}`, { ...fields(), expectedVersion: 0 }],
      ['POST', `/tasks/${id}/complete`, { expectedVersion: 1 }],
      ['POST', `/tasks/${id}/reopen`, { expectedVersion: 2 }],
      ['DELETE', `/tasks/${id}`, { expectedVersion: 1 }],
    ]
    for (const [method, route, body] of lockedRequests) {
      const locked = await request(method, route, body, false)
      expect(locked.status, `${method} ${route}`).toBe(423)
      expect(locked.headers.get('cache-control')).toBe('no-store')
    }
    const noAuth = await app.fetch(jsonRequest(`${base}/tasks/list`, { method: 'GET', origin: auth.runtime.config.publicOrigin }))
    expect(noAuth.status).toBe(401)
    expect(noAuth.headers.get('cache-control')).toBe('no-store')
  })

  it('drains in-flight Todo writes before lock and logout invalidation, then rejects old capabilities', async () => {
    const createBlockedWrite = (id: string, title: string) => {
      const bodyReadStarted = deferred<void>()
      const releaseBody = deferred<void>()
      let pulled = false
      const jsonBody = JSON.stringify({ ...fields({ title }), expectedVersion: 0 })
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (pulled) return
          pulled = true
          bodyReadStarted.resolve()
          await releaseBody.promise
          controller.enqueue(new TextEncoder().encode(jsonBody))
          controller.close()
        },
      }, { highWaterMark: 0 })
      const raw = new Request(`http://localhost${base}/tasks/${id}`, {
        method: 'PUT',
        headers: {
          Origin: auth.runtime.config.publicOrigin,
          'Content-Type': 'application/json',
          'Content-Length': String(new TextEncoder().encode(jsonBody).length),
        },
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      return {
        response: app.fetch(withDiaryCapability(auth, raw, capability)),
        bodyReadStarted: bodyReadStarted.promise,
        releaseBody: () => releaseBody.resolve(),
      }
    }
    const rowCount = () => Number((db.prepare(
      'SELECT COUNT(*) AS count FROM diary_tasks WHERE owner_user_id = ?',
    ).get(auth.userId) as { count: number }).count)
    const revision = () => Number((db.prepare(
      'SELECT revision FROM diary_task_list_revisions WHERE owner_user_id = ?',
    ).get(auth.userId) as { revision: number } | undefined)?.revision ?? 0)

    const firstId = randomUUID()
    const firstWrite = createBlockedWrite(firstId, 'Write leased before lock')
    await firstWrite.bodyReadStarted
    let lockSettled = false
    const lock = auth.runtime.diaryAccess.lock(auth.session.id).then((result) => {
      lockSettled = true
      return result
    })
    expect(lockSettled).toBe(false)
    expect((await request('GET', '/tasks/list')).status).toBe(423)
    expect(rowCount()).toBe(0)
    firstWrite.releaseBody()
    const firstResponse = await firstWrite.response
    expect(firstResponse.status).toBe(200)
    expect((await firstResponse.json()).task.title).toBe('Write leased before lock')
    await expect(lock).resolves.toEqual({ state: 'LOCKED' })
    expect(lockSettled).toBe(true)
    expect(rowCount()).toBe(1)
    expect(revision()).toBe(1)
    const oldRead = await request('GET', `/tasks/${firstId}`)
    expect(oldRead.status).toBe(423)
    expect(await oldRead.json()).toEqual({ code: 'diary-locked' })
    expect((await request('PUT', `/tasks/${randomUUID()}`, { ...fields(), expectedVersion: 0 })).status).toBe(423)
    expect(rowCount()).toBe(1)

    capability = (await auth.runtime.diaryAccess.unlock(auth.session.id, accessPassword)).capability
    const secondId = randomUUID()
    const secondWrite = createBlockedWrite(secondId, 'Write leased before logout')
    await secondWrite.bodyReadStarted
    let invalidationSettled = false
    const invalidation = auth.runtime.diaryAccess.invalidateAuthSession(auth.session.id).then(() => {
      invalidationSettled = true
    })
    expect(invalidationSettled).toBe(false)
    expect((await request('GET', '/tasks/list')).status).toBe(423)
    secondWrite.releaseBody()
    const secondResponse = await secondWrite.response
    expect(secondResponse.status).toBe(200)
    expect((await secondResponse.json()).task.title).toBe('Write leased before logout')
    await invalidation
    expect(invalidationSettled).toBe(true)
    expect(rowCount()).toBe(2)
    expect(revision()).toBe(2)
    expect((await request('GET', `/tasks/${secondId}`)).status).toBe(423)
    expect((await request('DELETE', `/tasks/${firstId}`, { expectedVersion: 1 })).status).toBe(423)
    expect(rowCount()).toBe(2)
  })

  it('preserves Diary rows and task migration tombstones when upgrading from version 46', async () => {
    const dayDate = '2026-11-15'
    const eventId = randomUUID()
    const taskId = randomUUID()
    const savedDay = await request('PUT', `/days/${dayDate}`, { moodId: null, entries: ['Existing diary entry'], expectedVersion: 0 })
    expect(savedDay.status).toBe(200)
    const eventFields = {
      title: 'Existing anniversary', description: '', emoji: '🎉', type: 'anniversary',
      startDate: '2026-11-14', endDate: '2026-11-14', startTime: null, endTime: null,
      allDay: true, recurrence: 'none', showCountdown: false, isPrimary: false,
    }
    expect((await request('PUT', `/events/${eventId}`, { ...eventFields, expectedVersion: 0 })).status).toBe(200)
    expect((await request('DELETE', `/events/${eventId}`, { expectedVersion: 1 })).status).toBe(200)
    const birthLunarYear = 1951
    const birthdayDate = lunarToSolar({ year: birthLunarYear, month: 10, day: 7, isLeapMonth: false })
    expect(birthdayDate).not.toBeNull()
    const birthdayId = randomUUID()
    const birthdayRule = {
      calendar: 'chinese',
      lunarMonth: 10,
      lunarDay: 7,
      isLeapMonth: false,
      leapMonthPolicy: 'regular-month',
      shortMonthPolicy: 'last-day',
    }
    expect((await request('PUT', `/events/${birthdayId}`, {
      title: 'Grandpa', description: '', emoji: '🎂', type: 'birthday',
      startDate: birthdayDate, endDate: birthdayDate, startTime: null, endTime: null,
      allDay: true, dateRule: birthdayRule, birthday: { birthLunarYear }, recurrence: 'yearly',
      showCountdown: true, isPrimary: false, expectedVersion: 0,
    })).status).toBe(200)

    db.exec('DROP TABLE diary_task_list_cursor_key; DROP TABLE diary_task_list_revisions; DROP TABLE diary_task_deleted_records; DROP TABLE diary_tasks; UPDATE schema_version SET version = 46')
    database.applyMigrations(db)

    expect((await (await request('GET', `/days/${dayDate}`)).json()).day.entries).toEqual(['Existing diary entry'])
    expect((await request('GET', `/events/${eventId}`)).status).toBe(404)
    expect((await request('PUT', `/events/${eventId}`, { ...eventFields, expectedVersion: 1 })).status).toBe(409)
    expect((await (await request('GET', `/events/${birthdayId}`)).json()).event).toMatchObject({
      type: 'birthday',
      birthday: { birthLunarYear },
      startDate: birthdayDate,
      dateRule: birthdayRule,
    })
    expect((await request('GET', `/tasks/${taskId}`)).status).toBe(404)
    expect(db.prepare("SELECT version FROM diary_deleted_records WHERE owner_user_id = ? AND kind = 'event' AND id = ?").get(auth.userId, eventId)).toMatchObject({ version: 2 })
    expect(db.prepare("SELECT version FROM schema_version").get()).toMatchObject({ version: 48 })
  })

  it('adds the list revision foundation without changing existing Todo ciphertext or version', async () => {
    const id = randomUUID()
    const saved = await request('PUT', `/tasks/${id}`, { ...fields(), expectedVersion: 0 })
    expect(saved.status).toBe(200)
    const task = (await saved.json()).task
    const before = db.prepare('SELECT owner_user_id, id, due_date, encrypted_fields, version FROM diary_tasks WHERE owner_user_id = ? AND id = ?')
      .get(auth.userId, id) as { owner_user_id: number; id: string; due_date: string; encrypted_fields: Buffer; version: number }

    db.exec('DROP TABLE diary_task_list_cursor_key; DROP TABLE diary_task_list_revisions; UPDATE schema_version SET version = 47')
    database.applyMigrations(db)

    const after = db.prepare('SELECT owner_user_id, id, due_date, encrypted_fields, version FROM diary_tasks WHERE owner_user_id = ? AND id = ?')
      .get(auth.userId, id) as typeof before
    expect(after).toEqual(before)
    expect((await (await request('GET', `/tasks/${id}`)).json()).task).toEqual(task)
    expect((await (await request('GET', '/tasks/list')).json()).items).toContainEqual(task)
    expect(db.prepare('SELECT version FROM schema_version').get()).toMatchObject({ version: 48 })
    expect((db.prepare('SELECT revision FROM diary_task_list_revisions WHERE owner_user_id = ?').get(auth.userId) as { revision: number }).revision).toBe(0)
  })
})
