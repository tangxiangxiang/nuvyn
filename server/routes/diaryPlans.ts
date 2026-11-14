import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getDb } from '../db.js'
import { parseDiaryDate, type DiaryDate } from '../../shared/diaryProtocol.js'
import { compareDiaryPlanItems, parseDiaryPlanFields, type DiaryPlanDaySummary, type DiaryPlanItem } from '../../shared/diaryPlan.js'
import { withDiaryBodyOperation } from '../diaryAccess/guard.js'
import { DiaryPlanCryptoError, type diaryPlanCrypto } from '../diaryAccess/planCrypto.js'

type OwnerEnv = { Variables: { authUser: { id: number } } }
type PlanContext = Context<OwnerEnv>
type PlanCrypto = ReturnType<typeof diaryPlanCrypto>
type PlanRow = {
  id: string
  date: DiaryDate
  encrypted_fields: Buffer | null
  completed_at: number | null
  created_at: number
  updated_at: number
  version: number
}

const routes = new Hono<OwnerEnv>()
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const live = 'encrypted_fields IS NOT NULL'

function invalid(c: PlanContext) {
  return c.json({ code: 'invalid-diary-plan' }, 400)
}

function conflict(c: PlanContext) {
  return c.json({ code: 'diary-plan-conflict' }, 409)
}

function missing(c: PlanContext) {
  return c.json({ code: 'diary-plan-not-found' }, 404)
}

function item(row: PlanRow, ownerId: number, crypto: PlanCrypto): DiaryPlanItem {
  if (!row.encrypted_fields) throw new DiaryPlanCryptoError()
  return {
    ...crypto.decrypt(row.encrypted_fields, { ownerId, id: row.id, date: row.date }),
    id: row.id,
    date: row.date,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

async function guarded(c: PlanContext, run: (ownerId: number, crypto: PlanCrypto) => Response) {
  const ownerId = c.get('authUser')?.id
  if (!ownerId) return c.json({ code: 'auth-session-required' }, 401)
  try {
    const response = await withDiaryBodyOperation(c, (operation) => {
      if (!operation.plan) return null
      return run(ownerId, operation.plan)
    })
    return response ?? c.json({ code: 'diary-locked' }, 423)
  } catch (error) {
    // Neither input nor raw driver/crypto errors are sent to logs or clients.
    if (error instanceof DiaryPlanCryptoError) {
      return c.json({ code: 'diary-plan-payload-invalid' }, 409)
    }
    return c.json({ code: 'diary-plan-unavailable' }, 503)
  }
}

async function readBody(c: PlanContext): Promise<Record<string, unknown> | null> {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return null
  const body: unknown = await c.req.json().catch(() => null)
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
}

function validVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

routes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
routes.use('*', bodyLimit({
  maxSize: 4096,
  onError: (c) => c.json({ code: 'invalid-diary-plan' }, 413),
}))

routes.get('/calendar', (c) => guarded(c, (ownerId) => {
  const month = c.req.query('month')
  if (!month || month.length !== 7 || !parseDiaryDate(`${month}-01`)) return invalid(c)
  const days = getDb().prepare(`
    SELECT date, COUNT(*) AS total, COUNT(completed_at) AS completed
    FROM diary_plan_items
    WHERE owner_user_id = ? AND date >= ? AND date < ? AND ${live}
    GROUP BY date ORDER BY date
  `).all(ownerId, `${month}-01`, `${month}-32`) as DiaryPlanDaySummary[]
  return c.json({ days })
}))

routes.get('/', (c) => guarded(c, (ownerId, crypto) => {
  const date = parseDiaryDate(c.req.query('date'))
  if (!date) return invalid(c)
  const rows = getDb().prepare(`
    SELECT * FROM diary_plan_items WHERE owner_user_id = ? AND date = ? AND ${live}
  `).all(ownerId, date) as PlanRow[]
  const items = rows.map((row) => item(row, ownerId, crypto)).sort(compareDiaryPlanItems)
  return c.json({ items })
}))

routes.post('/', async (c) => {
  const input = await readBody(c)
  return guarded(c, (ownerId, crypto) => {
    if (!input || Object.keys(input).some((key) => !['id', 'date', 'title', 'plannedTime'].includes(key))) return invalid(c)
    const { id } = input
    const date = parseDiaryDate(input.date)
    const fields = parseDiaryPlanFields(input)
    if (!date || !fields || typeof id !== 'string' || id.length !== 36 || !idPattern.test(id)) return invalid(c)
    const db = getDb()
    return db.transaction(() => {
      const previous = db.prepare('SELECT * FROM diary_plan_items WHERE owner_user_id = ? AND id = ?')
        .get(ownerId, id) as PlanRow | undefined
      if (previous) {
        if (previous.date !== date || !previous.encrypted_fields) return conflict(c)
        const current = item(previous, ownerId, crypto)
        if (current.title !== fields.title || current.plannedTime !== fields.plannedTime) return conflict(c)
        return c.json({ item: current }, 200)
      }
      const now = Date.now()
      const payload = crypto.encrypt(fields, { ownerId, id, date })
      db.prepare(`
        INSERT INTO diary_plan_items (owner_user_id, id, date, encrypted_fields, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(ownerId, id, date, payload, now, now)
      return c.json({
        item: { ...fields, id, date, completedAt: null, createdAt: now, updatedAt: now, version: 1 },
      }, 201)
    }).immediate()
  })
})

routes.patch('/:id', async (c) => {
  const input = await readBody(c)
  return guarded(c, (ownerId, crypto) => {
    const id = c.req.param('id')
    if (id.length !== 36 || !idPattern.test(id) || !input
      || Object.keys(input).some((key) => !['version', 'title', 'plannedTime', 'completed'].includes(key))
      || !validVersion(input.version)
      || ('completed' in input && typeof input.completed !== 'boolean')
      || !('title' in input || 'plannedTime' in input || 'completed' in input)) return invalid(c)
    const db = getDb()
    return db.transaction(() => {
      const row = db.prepare(`SELECT * FROM diary_plan_items WHERE owner_user_id = ? AND id = ? AND ${live}`)
        .get(ownerId, id) as PlanRow | undefined
      if (!row) return missing(c)
      if (row.version !== input.version) return conflict(c)
      const previous = item(row, ownerId, crypto)
      const fields = parseDiaryPlanFields({
        title: 'title' in input ? input.title : previous.title,
        plannedTime: 'plannedTime' in input ? input.plannedTime : previous.plannedTime,
      })
      if (!fields) return invalid(c)
      const now = Date.now()
      const completedAt = input.completed === true ? previous.completedAt ?? now
        : input.completed === false ? null : previous.completedAt
      const payload = crypto.encrypt(fields, { ownerId, id, date: row.date })
      db.prepare(`
        UPDATE diary_plan_items SET encrypted_fields = ?, completed_at = ?, updated_at = ?, version = version + 1
        WHERE owner_user_id = ? AND id = ?
      `).run(payload, completedAt, now, ownerId, id)
      return c.json({ item: { ...previous, ...fields, completedAt, updatedAt: now, version: row.version + 1 } })
    }).immediate()
  })
})

routes.delete('/:id', (c) => guarded(c, (ownerId) => {
  const id = c.req.param('id')
  const version = Number(c.req.query('version'))
  if (id.length !== 36 || !idPattern.test(id) || !validVersion(version)
    || c.req.query('version') !== String(version)) return invalid(c)
  const db = getDb()
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE diary_plan_items
      SET encrypted_fields = NULL, completed_at = NULL, updated_at = ?, version = version + 1
      WHERE owner_user_id = ? AND id = ? AND version = ? AND ${live}
    `).run(Date.now(), ownerId, id, version)
    if (result.changes) return c.body(null, 204)
    const previous = db.prepare('SELECT encrypted_fields, version FROM diary_plan_items WHERE owner_user_id = ? AND id = ?')
      .get(ownerId, id) as Pick<PlanRow, 'encrypted_fields' | 'version'> | undefined
    if (!previous) return missing(c)
    if (!previous.encrypted_fields && previous.version === version + 1) return c.body(null, 204)
    return conflict(c)
  }).immediate()
}))

export default routes
