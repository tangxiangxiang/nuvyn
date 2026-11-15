import { Hono, type Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { bodyLimit } from 'hono/body-limit'
import { civilDate, dayDistance, parseDay, parseEvent, occursOn, nextOccurrence } from '../../shared/diaryLife.js'
import { withDiaryBodyOperation } from '../diaryAccess/guard.js'
import { diaryLifeStore, DiaryConflict } from '../diaryLife.js'
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
async function guarded(c: Context<Env>, run: (store: Store, db: Database) => Promise<Response> | Response) {
  const owner = c.get('authUser')?.id
  if (!owner) return c.json({ code: 'auth-session-required' }, 401)
  try {
    return await withDiaryBodyOperation(c, async (op) => {
      const db = metadataDb()
      const result = await run(diaryLifeStore(db, owner, op), db)
      op.assertCurrent()
      return result
    }) ?? c.json({ code: 'diary-locked' }, 423)
  } catch (error) {
    if (error instanceof DiaryConflict) return c.json({ code: 'diary-conflict' }, 409)
    if (error instanceof DiaryAttachmentError) return c.json({ code: `diary-attachment-${error.code}` }, error.status)
    return c.json({ code: 'diary-unavailable' }, 503)
  }
}
const version = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < Number.MAX_SAFE_INTEGER
const idValid = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
routes.get('/day-policy', c => guarded(c, () => c.json({ today: diaryToday() })))
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
