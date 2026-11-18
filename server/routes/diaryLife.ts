import { Hono, type Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { bodyLimit } from 'hono/body-limit'
import { civilDate, dayDistance, parseDay, parseEvent, occursOn, nextOccurrence } from '../../shared/diaryLife.js'
import { parseTaskFields, parseTaskSeriesFields } from '../../shared/diaryTasks.js'
import { withDiaryBodyOperation } from '../diaryAccess/guard.js'
import { DiaryAccessServiceError } from '../diaryAccess/service.js'
import { diaryLifeStore, DiaryConflict } from '../diaryLife.js'
import { diaryTaskStore, DiaryTaskCursorError, DiaryTaskExpansionLimit, DiaryTaskHistoryProtectedError, DiaryTaskListChanged, DiaryTaskNotFound, DiaryTaskRecurrenceError } from '../diaryTasks.js'
import { diaryToday } from '../diaryDate.js'
import { DiaryAttachmentError } from '../diaryAttachments/service.js'
import { cleanupDiaryAttachmentStorage, DiaryAttachmentStorage, ensureDiaryAttachmentStorage } from '../diaryAttachments/storage.js'
import { MAX_DIARY_DAY_ATTACHMENTS } from '../../shared/diaryAttachments.js'
import { metadataDb } from './shared.js'

type Env = { Variables: { authUser: { id: number }; authSessionId: number } }
const routes = new Hono<Env>()
routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })
routes.use('*', bodyLimit({ maxSize: 32768 }))
type Store = ReturnType<typeof diaryLifeStore>
type TaskStore = ReturnType<typeof diaryTaskStore>
function hasLegacyTaskEventAssociation(body: Record<string, unknown>): boolean {
  return ['eventId', 'eventOccurrenceDate', 'occurrenceDate'].some(key => body[key] !== undefined && body[key] !== null)
}
async function guarded(c: Context<Env>, run: (store: Store, db: Database, tasks: TaskStore) => Promise<Response> | Response) {
  const owner = c.get('authUser')?.id
  if (!owner) return c.json({ code: 'auth-session-required' }, 401)
  try {
    return await withDiaryBodyOperation(c, async (op) => {
      const db = metadataDb()
      const result = await run(diaryLifeStore(db, owner, op), db, diaryTaskStore(db, owner, op))
      op.assertCurrent()
      return result
    }) ?? c.json({ code: 'diary-locked' }, 423)
  } catch (error) {
    if (error instanceof DiaryAccessServiceError) return c.json({ code: 'diary-locked' }, 423)
    if (error instanceof DiaryTaskCursorError) return c.json({ code: 'invalid-diary-task-cursor' }, 400)
    if (error instanceof DiaryTaskListChanged) return c.json({ code: 'diary-task-list-changed' }, 409)
    if (error instanceof DiaryConflict) return c.json({ code: 'diary-conflict' }, 409)
    if (error instanceof DiaryTaskNotFound) return c.json({ code: 'diary-not-found' }, 404)
    if (error instanceof DiaryTaskHistoryProtectedError) return c.json({ code: 'diary-task-history-protected' }, 409)
    if (error instanceof DiaryTaskRecurrenceError) return c.json({ code: 'invalid-diary-task-occurrence' }, 400)
    if (error instanceof DiaryTaskExpansionLimit) return c.json({ code: 'diary-task-range-too-large' }, 413)
    if (error instanceof DiaryAttachmentError) return c.json({ code: `diary-attachment-${error.code}` }, error.status)
    return c.json({ code: 'diary-unavailable' }, 503)
  }
}
const version = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < Number.MAX_SAFE_INTEGER
const idValid = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
routes.get('/day-policy', c => guarded(c, () => c.json({ today: diaryToday() })))
const diarySearchRequests = new WeakMap<Database, Map<number, { startedAt: number; count: number }>>()
function allowDiarySearch(db: Database, sessionId: number): boolean {
  const now = Date.now()
  let requests = diarySearchRequests.get(db)
  if (!requests) {
    requests = new Map()
    diarySearchRequests.set(db, requests)
  }
  for (const [key, window] of requests) if (now - window.startedAt >= 1000) requests.delete(key)
  const current = requests.get(sessionId)
  if (!current || now - current.startedAt >= 1000) {
    if (requests.size >= 1024) {
      const oldest = [...requests].sort((a, b) => a[1].startedAt - b[1].startedAt)[0]?.[0]
      if (oldest !== undefined) requests.delete(oldest)
    }
    requests.set(sessionId, { startedAt: now, count: 1 })
    return true
  }
  if (current.count >= 8) return false
  current.count += 1
  return true
}
routes.post('/search', async c => {
  const sessionId = c.get('authSessionId')
  if (typeof sessionId !== 'number') return c.json({ code: 'auth-session-required' }, 401)
  return guarded(c, async (store, db) => {
    if (!allowDiarySearch(db, sessionId)) return c.json({ code: 'diary-search-rate-limited' }, 429)
    const body = await c.req.json().catch(() => null)
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    const limit = body?.limit ?? 20
    const cursor = body?.cursor ?? null
    if (!query || query.length > 120 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20
      || (cursor !== null && !civilDate(cursor))) return c.json({ code: 'invalid-diary-search' }, 400)
    return c.json(await store.searchDays(query, limit, cursor, c.req.raw.signal))
  })
})
routes.get('/days', c => guarded(c, store => {
  const { start, end } = c.req.query()
  if (!civilDate(start) || !civilDate(end) || end < start || dayDistance(start, end) > 62) return c.json({ code: 'invalid-diary-range' }, 400)
  return c.json({ days: store.days(start, end).map(({ date, moodId, entries, hasAttachments, version }) => ({ date, moodId, hasEntries: entries.length > 0, hasAttachments, version })) })
}))
routes.get('/days/:date', c => guarded(c, async (store, db) => {
  const date = c.req.param('date')
  if (!civilDate(date)) return c.json({ code: 'invalid-diary-date' }, 400)
  const storage = new DiaryAttachmentStorage(db)
  await ensureDiaryAttachmentStorage(db, storage)
  await cleanupDiaryAttachmentStorage(db, storage, c.get('authUser')?.id)
  return c.json({ day: store.getDay(date), version: store.dayVersion(date), attachments: store.dayAttachments(date), today: diaryToday() })
}))
routes.put('/days/:date', c => guarded(c, async (store, db) => {
  const date = c.req.param('date')
  if (!civilDate(date)) return c.json({ code: 'invalid-diary-day' }, 400)
  if (date > diaryToday()) return c.json({ code: 'diary-future-date' }, 403)
  const body = await c.req.json().catch(() => null)
  const fields = parseDay(body)
  const attachmentIds = body?.attachments
  if (!fields || !version(body?.expectedVersion)
    || (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_DIARY_DAY_ATTACHMENTS || attachmentIds.some((id: unknown) => typeof id !== 'string' || !idValid(id))))
    || (!fields.moodId && !fields.entries.length && !(Array.isArray(attachmentIds) && attachmentIds.length))) return c.json({ code: 'invalid-diary-day' }, 400)
  const day = store.putDay(date, fields, body.expectedVersion, attachmentIds)
  // The SQLite transaction has already committed. Physical deletion is
  // represented by durable tombstones and will be retried on later requests
  // or startup recovery, so cleanup failure must not report a false save error.
  await cleanupDiaryAttachmentStorage(db, undefined, c.get('authUser')?.id).catch(() => {})
  return c.json({ day, version: day.version, attachments: store.dayAttachments(date) })
}))
routes.get('/events', c => guarded(c, store => {
  const { start, end, offset = '0', date } = c.req.query()
  if (!civilDate(start) || !civilDate(end) || end < start || dayDistance(start, end) > 366
    || !/^\d{1,7}$/.test(offset) || (date !== undefined && (!civilDate(date) || date < start || date > end))) return c.json({ code: 'invalid-diary-range' }, 400)
  const result = store.events(start, end, Number(offset))
  result.items = result.items.filter(event => {
    if (date) return occursOn(event, date)
    const next = nextOccurrence(event, start)
    return occursOn(event, start) || (next !== null && next <= end)
  })
  return c.json(result)
}))
routes.get('/events/list', c => guarded(c, store => {
  const { offset = '0' } = c.req.query()
  if (!/^\d{1,7}$/.test(offset)) return c.json({ code: 'invalid-diary-event-list-query' }, 400)
  return c.json(store.allEvents(Number(offset)))
}))
routes.get('/events/:id', c => guarded(c, store => {
  const event = store.getEvent(c.req.param('id'))
  return event ? c.json({ event }) : c.json({ code: 'diary-not-found' }, 404)
}))
routes.get('/countdowns', c => guarded(c, store => {
  const { today, offset = '0' } = c.req.query()
  if (!civilDate(today) || !/^\d{1,7}$/.test(offset)) return c.json({ code: 'invalid-diary-countdown-query' }, 400)
  const result = store.events(today, '9999-12-31', Number(offset))
  result.items = result.items.filter(event => event.showCountdown && nextOccurrence(event, today) !== null)
  return c.json(result)
}))

routes.get('/tasks/list', c => guarded(c, (_store, _db, tasks) => {
  const query = c.req.query()
  if (Object.keys(query).some(key => !['cursor', 'status'].includes(key))
    || (query.status !== undefined && query.status !== 'open' && query.status !== 'completed')
    || (query.cursor !== undefined && (!query.cursor || query.cursor.length > 1024))) {
    return c.json({ code: 'invalid-diary-task-list-query' }, 400)
  }
  return c.json(tasks.listTasks(query.cursor, query.status === undefined ? undefined : query.status === 'completed'))
}))
routes.get('/tasks', c => guarded(c, (_store, _db, tasks) => {
  const query = c.req.query()
  const { start, end, cursor } = query
  if (!civilDate(start) || !civilDate(end) || end < start || dayDistance(start, end) > 366
    || Object.keys(query).some(key => !['start', 'end', 'cursor'].includes(key))
    || (cursor !== undefined && (!cursor || cursor.length > 1024))) return c.json({ code: 'invalid-diary-task-range' }, 400)
  return c.json(tasks.tasksInRange(start, end, cursor))
}))
routes.get('/task-occurrences', c => guarded(c, (_store, _db, tasks) => {
  const query = c.req.query()
  const { start, end, cursor } = query
  if (!civilDate(start) || !civilDate(end) || end < start || dayDistance(start, end) > 366
    || Object.keys(query).some(key => !['start', 'end', 'cursor'].includes(key))
    || (cursor !== undefined && (!cursor || cursor.length > 1024))) return c.json({ code: 'invalid-diary-task-range' }, 400)
  return c.json(tasks.taskItemsInRange(start, end, cursor))
}))
routes.get('/task-items', c => guarded(c, (_store, _db, tasks) => {
  const query = c.req.query()
  const { start, end, cursor, status } = query
  if (!civilDate(start) || !civilDate(end) || end < start || dayDistance(start, end) > 366
    || Object.keys(query).some(key => !['start', 'end', 'cursor', 'status'].includes(key))
    || (status !== undefined && status !== 'open' && status !== 'completed')
    || (cursor !== undefined && (!cursor || cursor.length > 1024))) return c.json({ code: 'invalid-diary-task-list-query' }, 400)
  return c.json(tasks.listTaskItems(start, end, cursor, status))
}))
routes.get('/task-series/:id', c => guarded(c, (_store, _db, tasks) => {
  const id = c.req.param('id')
  if (!idValid(id)) return c.json({ code: 'invalid-diary-task-series-id' }, 400)
  const series = tasks.getSeries(id)
  return series ? c.json({ series }) : c.json({ code: 'diary-not-found' }, 404)
}))
routes.get('/task-series/:id/occurrences/:date', c => guarded(c, (_store, _db, tasks) => {
  const { id, date } = c.req.param()
  if (!idValid(id) || !civilDate(date)) return c.json({ code: 'invalid-diary-task-occurrence' }, 400)
  const occurrence = tasks.occurrence(id, date)
  return occurrence ? c.json({ occurrence }) : c.json({ code: 'diary-not-found' }, 404)
}))
routes.put('/task-series/:id', c => guarded(c, async (_store, _db, tasks) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const fields = parseTaskSeriesFields(body)
  if (!idValid(id) || !fields || !version(body?.expectedVersion)
    || hasLegacyTaskEventAssociation(body)) return c.json({ code: 'invalid-diary-task-series' }, 400)
  if (body.expectedVersion === 0) return c.json({ series: tasks.putSeries(id, fields, 0) })
  if (!idValid(body.newSeriesId) || !civilDate(body.effectiveDate)) return c.json({ code: 'invalid-diary-task-series' }, 400)
  return c.json({ series: tasks.updateSeriesFrom(id, body.newSeriesId, body.effectiveDate, fields, body.expectedVersion) })
}))
routes.post('/task-series/:id/stop', c => guarded(c, async (_store, _db, tasks) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  if (!idValid(id) || !civilDate(body?.effectiveDate) || !version(body?.expectedVersion) || body.expectedVersion < 1) {
    return c.json({ code: 'invalid-diary-task-series-stop' }, 400)
  }
  return c.json({ series: tasks.stopSeries(id, body.effectiveDate, body.expectedVersion) })
}))
routes.delete('/task-series/:id', c => guarded(c, async (_store, _db, tasks) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  if (!idValid(id) || !version(body?.expectedVersion) || body.expectedVersion < 1) return c.json({ code: 'invalid-diary-task-series-delete' }, 400)
  return c.json({ ok: true, version: tasks.removeSeries(id, body.expectedVersion) })
}))
for (const action of ['complete', 'reopen', 'skip'] as const) {
  routes.post(`/task-series/:id/occurrences/:date/${action}`, c => guarded(c, async (_store, _db, tasks) => {
    const { id, date } = c.req.param()
    const body = await c.req.json().catch(() => null)
    if (!idValid(id) || !civilDate(date) || !version(body?.expectedVersion)) return c.json({ code: 'invalid-diary-task-occurrence' }, 400)
    const occurrence = action === 'complete'
      ? tasks.completeOccurrence(id, date, body.expectedVersion)
      : action === 'skip'
        ? tasks.skipOccurrence(id, date, body.expectedVersion)
        : tasks.reopenOccurrence(id, date, body.expectedVersion)
    return c.json({ occurrence })
  }))
}
routes.get('/tasks/:id', c => guarded(c, (_store, _db, tasks) => {
  const id = c.req.param('id')
  if (!idValid(id)) return c.json({ code: 'invalid-diary-task-id' }, 400)
  const task = tasks.getTask(id)
  return task ? c.json({ task }) : c.json({ code: 'diary-not-found' }, 404)
}))
routes.put('/tasks/:id', c => guarded(c, async (_store, _db, tasks) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  if (!idValid(id) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.prototype.hasOwnProperty.call(body, 'completedAt')) return c.json({ code: 'invalid-diary-task' }, 400)
  const fields = parseTaskFields(body)
  if (!fields || !version(body.expectedVersion) || hasLegacyTaskEventAssociation(body)) {
    return c.json({ code: 'invalid-diary-task' }, 400)
  }
  return c.json({ task: tasks.putTask(id, fields, body.expectedVersion) })
}))
for (const action of ['complete', 'reopen'] as const) {
  routes.post(`/tasks/:id/${action}`, c => guarded(c, async (_store, _db, tasks) => {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => null)
    if (!idValid(id) || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.prototype.hasOwnProperty.call(body, 'completedAt')
      || !version(body.expectedVersion) || body.expectedVersion < 1) {
      return c.json({ code: 'invalid-diary-task-transition' }, 400)
    }
    const task = action === 'complete'
      ? tasks.completeTask(id, body.expectedVersion)
      : tasks.reopenTask(id, body.expectedVersion)
    return c.json({ task })
  }))
}
routes.delete('/tasks/:id', c => guarded(c, async (_store, _db, tasks) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  if (!idValid(id) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.prototype.hasOwnProperty.call(body, 'completedAt')
    || !version(body.expectedVersion) || body.expectedVersion < 1) {
    return c.json({ code: 'invalid-diary-task-delete' }, 400)
  }
  const versionAfterDelete = tasks.removeTask(id, body.expectedVersion)
  return c.json({ ok: true, version: versionAfterDelete })
}))
routes.put('/events/:id', c => guarded(c, async store => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const fields = parseEvent(body)
  if (!idValid(id) || !fields || !version(body?.expectedVersion)) return c.json({ code: 'invalid-diary-event' }, 400)
  return c.json({ event: store.putEvent(id, fields, body.expectedVersion) })
}))
for (const kind of ['days', 'events'] as const) {
  routes.delete(`/${kind}/:id`, c => guarded(c, async (store, db) => {
    const body = await c.req.json().catch(() => null)
    const id = c.req.param('id')
    if (!version(body?.expectedVersion) || body.expectedVersion < 1 || !(kind === 'days' ? civilDate(id) : idValid(id))) return c.json({ code: 'invalid-diary-delete' }, 400)
    if (kind === 'days' && id > diaryToday()) return c.json({ code: 'diary-future-date' }, 403)
    store.remove(kind === 'days' ? 'day' : 'event', id, body.expectedVersion)
    if (kind === 'days') await cleanupDiaryAttachmentStorage(db, undefined, c.get('authUser')?.id).catch(() => {})
    return c.json({ ok: true })
  }))
}
export default routes
