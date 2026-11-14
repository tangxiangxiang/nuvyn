import { Hono, type Context } from 'hono'
import { diaryLogicalPathForDate, parseDiaryDate } from '../../shared/diaryProtocol.js'
import type { DiaryPlanDaySummary } from '../../shared/diaryPlan.js'
import { withDiaryBodyOperation } from '../diaryAccess/guard.js'
import type { DiaryBodyOperation } from '../diaryAccess/service.js'
import { migrateDiaryPlans } from '../diaryPlanMigration.js'
import { summarizeDiaryTasks } from '../diaryPlanMarkdown.js'
import { getDocumentMetadata } from '../documentMetadata.js'
import { withDocumentWriteLock } from '../documentWriteLock.js'
import { CONTENT_DIR, readSafeRelativeFile } from '../paths.js'
import { DIARY_BODY_MAX_ENVELOPE_BYTES } from '../diaryAccess/body.js'
import { metadataDb } from './shared.js'

type OwnerEnv = { Variables: { authUser: { id: number } } }
type PlanContext = Context<OwnerEnv>
const routes = new Hono<OwnerEnv>()

routes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

async function guarded(c: PlanContext, run: (ownerId: number, operation: DiaryBodyOperation) => Promise<Response>) {
  const ownerId = c.get('authUser')?.id
  if (!ownerId) return c.json({ code: 'auth-session-required' }, 401)
  const response = await withDiaryBodyOperation(c, async (operation) => {
    try {
      return await run(ownerId, operation)
    } catch {
      return operation.isCurrent() ? c.json({ code: 'diary-plan-unavailable' }, 503) : null
    }
  })
  return response ?? c.json({ code: 'diary-locked' }, 423)
}

routes.post('/migrate', (c) => guarded(c, async (ownerId, operation) => {
  const cursor = c.req.query('offset') ?? '0'
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== cursor) {
    return c.json({ code: 'invalid-diary-plan-cursor' }, 400)
  }
  const result = await migrateDiaryPlans(metadataDb(), ownerId, operation, offset, c.req.raw.signal)
  operation.assertCurrent()
  return c.json(result)
}))

routes.get('/calendar', (c) => guarded(c, async (_ownerId, operation) => {
  const month = c.req.query('month')
  if (!month || month.length !== 7 || !parseDiaryDate(`${month}-01`)) {
    return c.json({ code: 'invalid-diary-plan' }, 400)
  }
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const start = new Date(0)
  start.setUTCFullYear(year, monthNumber - 1, 1)
  // Cover adjacent cells in both Sunday- and Monday-first calendars.
  start.setUTCDate(1 - Math.max(start.getUTCDay(), (start.getUTCDay() + 6) % 7))
  const end = new Date(0)
  end.setUTCFullYear(year, monthNumber, 7)
  const days: DiaryPlanDaySummary[] = []
  const unavailable: string[] = []
  for (; start < end; start.setUTCDate(start.getUTCDate() + 1)) {
    operation.assertCurrent()
    const date = parseDiaryDate(start.toISOString().slice(0, 10))
    if (!date) continue
    const logicalPath = diaryLogicalPathForDate(date)
    try {
      const summary = await withDocumentWriteLock(logicalPath, async () => {
        const metadata = getDocumentMetadata(metadataDb(), logicalPath)
        if (!metadata) return null
        const bytes = await readSafeRelativeFile(CONTENT_DIR, `${logicalPath}.md`, undefined, {
          signal: c.req.raw.signal,
          maxBytes: DIARY_BODY_MAX_ENVELOPE_BYTES,
        })
        if (!Buffer.isBuffer(bytes)) return null
        const { raw } = operation.decrypt(bytes, { documentId: metadata.id, logicalPath })
        return summarizeDiaryTasks(raw)
      })
      if (summary?.total) days.push({ date, ...summary })
    } catch (error) {
      operation.assertCurrent()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unavailable.push(date)
    }
  }
  operation.assertCurrent()
  return c.json({ days, unavailable })
}))

// Explicitly reject stale clients, including delayed create/delete retries.
routes.all('/', () => retired())
routes.all('/:id', () => retired())

function retired() {
  return new Response(JSON.stringify({ code: 'diary-plan-moved-to-markdown' }), {
    status: 410,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export default routes
