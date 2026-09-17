import { Hono } from 'hono'
import { CONTENT_DIR } from '../paths.js'
import { metadataDb } from './shared.js'
import { withDiaryBodyOperation } from '../diaryAccess/guard.js'
import { DiaryAccessServiceError } from '../diaryAccess/service.js'
import { getDiaryMigrationService } from '../diaryMigration/service.js'
import { DiaryMigrationError, type MigrationResolveAction, type MigrationStartScope } from '../diaryMigration/types.js'

const migrationRoutes = new Hono()

function service() {
  return getDiaryMigrationService(metadataDb(), CONTENT_DIR)
}

function noStore(c: any): void {
  c.header('Cache-Control', 'no-store')
}

function errorResponse(c: any, error: unknown): Response {
  noStore(c)
  if (error instanceof DiaryMigrationError) {
    return c.json({
      code: error.code,
      error: error.message,
      ...(error.details ? { details: error.details } : {}),
    }, error.status)
  }
  if (error instanceof DiaryAccessServiceError) {
    return c.json({ code: 'diary-migration-locked', error: 'Diary unlock is required.' }, 423)
  }
  return c.json({ code: 'diary-migration-unavailable', error: 'Diary migration is temporarily unavailable.' }, 503)
}

const RESOLVE_ACTIONS: readonly MigrationResolveAction[] = [
  'adopt-metadata',
  'import-to-primary',
  'discard-draft',
  'discard-ai-session',
  'retain-ai-history',
  'bind-frontmatter-identity',
  'retry-item',
  'acknowledge-attention',
]

function lockedError(runId: string, inventoryRevision: number): DiaryMigrationError {
  const snapshot = service().status(runId, inventoryRevision)
  const deferred = snapshot.items.some((item) => (
    item.state === 'RECOVERY_AUTH_REQUIRED' || item.classification === 'RECOVERY_AUTH_REQUIRED'
  ))
  return new DiaryMigrationError(
    deferred ? 'diary-migration-auth-required' : 'diary-migration-locked',
    423,
    deferred ? 'Diary authentication is required to reconcile this migration.' : 'Diary unlock is required.',
  )
}

migrationRoutes.get('/api/diary/migration/status', (c) => {
  try {
    noStore(c)
    const runId = c.req.query('runId')
    const revisionRaw = c.req.query('inventoryRevision')
    const revision = revisionRaw ? Number(revisionRaw) : undefined
    return c.json(service().status(runId || undefined, Number.isSafeInteger(revision) ? revision : undefined))
  } catch (error) {
    return errorResponse(c, error)
  }
})

migrationRoutes.post('/api/diary/migration/scan', async (c) => {
  try {
    // Scanning is login-only and remains available while locked.  When a
    // caller already has a valid Diary lease, pass it through so the same
    // immutable revision can authenticate V1 envelopes and classify AI
    // tool-result ownership without exposing any body to the route.  An
    // absent/expired capability simply falls back to the structural scan.
    const run = service()
    const unlockedResult = await withDiaryBodyOperation(c, (operation) => run.scan(operation))
    const result = unlockedResult ?? await run.scan()
    noStore(c)
    return c.json(result, 202)
  } catch (error) {
    return errorResponse(c, error)
  }
})

migrationRoutes.post('/api/diary/migration/start', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    runId?: unknown
    inventoryRevision?: unknown
    requestedScopes?: unknown
  } | null
  if (
    typeof body?.runId !== 'string'
    || !Number.isSafeInteger(body.inventoryRevision)
    || !Array.isArray(body.requestedScopes)
  ) return errorResponse(c, new DiaryMigrationError('diary-migration-invalid-confirmation', 400, 'Migration start fields are invalid.'))
  const scopes = body.requestedScopes as MigrationStartScope[]
  try {
    const run = service()
    if (body.requestedScopes && body.requestedScopes.length && body.requestedScopes.some((item: any) => item?.scope === 'MIGRATE_PRIMARY' || item?.scope === 'IMPORT_DRAFT' || item?.scope === 'DISCARD_AI_SESSION' || item?.scope === 'RETAIN_AI_HISTORY' || item?.scope === 'BIND_FRONTMATTER_IDENTITY')) {
      const result = await withDiaryBodyOperation(c, (operation) => run.start(body.runId as string, body.inventoryRevision as number, scopes, operation))
      if (result === null) return errorResponse(c, lockedError(body.runId as string, body.inventoryRevision as number))
      noStore(c)
      return c.json(result, 202)
    }
    noStore(c)
    return c.json(await run.start(body.runId as string, body.inventoryRevision as number, scopes), 202)
  } catch (error) {
    return errorResponse(c, error)
  }
})

migrationRoutes.post('/api/diary/migration/resume', async (c) => {
  const body = await c.req.json().catch(() => null) as { runId?: unknown; inventoryRevision?: unknown } | null
  if (typeof body?.runId !== 'string' || !Number.isSafeInteger(body.inventoryRevision)) {
    return errorResponse(c, new DiaryMigrationError('diary-migration-invalid-confirmation', 400, 'Migration resume fields are invalid.'))
  }
  try {
    const run = service()
    const result = await withDiaryBodyOperation(c, (operation) => run.resume(body.runId as string, body.inventoryRevision as number, operation))
    if (result === null) return errorResponse(c, lockedError(body.runId as string, body.inventoryRevision as number))
    noStore(c)
    return c.json(result, 202)
  } catch (error) {
    return errorResponse(c, error)
  }
})

migrationRoutes.post('/api/diary/migration/items/:itemKey/resolve', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    inventoryRevision?: unknown
    action?: unknown
    confirmation?: unknown
  } | null
  if (!Number.isSafeInteger(body?.inventoryRevision) || typeof body?.action !== 'string') {
    return errorResponse(c, new DiaryMigrationError('diary-migration-invalid-confirmation', 400, 'Migration resolution fields are invalid.'))
  }
  try {
    const run = service()
    const runId = c.req.query('runId') ?? (typeof (body as any)?.runId === 'string' ? (body as any).runId : '')
    const effectiveRunId = runId || run.status().runId
    if (!effectiveRunId) return errorResponse(c, new DiaryMigrationError('diary-migration-run-not-found', 404, 'Migration run was not specified.'))
    const itemKey = c.req.param('itemKey')
    const action = body.action as MigrationResolveAction
    if (!RESOLVE_ACTIONS.includes(action)) {
      return errorResponse(c, new DiaryMigrationError('diary-migration-invalid-confirmation', 400, 'Migration resolution action is invalid.'))
    }
    const needsBody = ['import-to-primary', 'discard-ai-session', 'retain-ai-history', 'bind-frontmatter-identity', 'retry-item'].includes(action)
    if (needsBody) {
      const result = await withDiaryBodyOperation(c, (operation) => run.resolve(effectiveRunId, body.inventoryRevision as number, itemKey, action, typeof body.confirmation === 'string' ? body.confirmation : undefined, operation))
      if (result === null) return errorResponse(c, lockedError(effectiveRunId, body.inventoryRevision as number))
      noStore(c)
      return c.json(result, 202)
    }
    noStore(c)
    return c.json(await run.resolve(effectiveRunId, body.inventoryRevision as number, itemKey, action, typeof body.confirmation === 'string' ? body.confirmation : undefined), 202)
  } catch (error) {
    return errorResponse(c, error)
  }
})

export default migrationRoutes
