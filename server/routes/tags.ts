import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { CONTENT_DIR } from '../paths.js'
import { preflightTagIdentityHealth } from '../tagIdentityMigration.js'
import {
  applyTagOperation,
  TagManagementError,
  isPlanFingerprint,
  listManagedTags,
  parseTagApplyRequest,
  parsePreviewPageRequest,
  parseTagOperation,
  previewTagOperation,
  previewTagOperationPage,
} from '../tagManagement.js'
import {
  applyTagUndo,
  getTagUndoAvailability,
  getTagUndoPreviewPage,
  previewTagUndo,
  TagUndoPlannerError,
  type TagUndoApplyInput,
  type TagUndoApplyResult,
  type TagUndoAvailability,
  type TagUndoPreview,
  type TagUndoPreviewPageRequest,
} from '../tagUndo.js'
import { metadataDb } from './shared.js'

const tagRoutes = new Hono()

function managementUnavailable(c: any, code: string | undefined) {
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: 'Tag management is temporarily unavailable.',
    code: 'TAG_MANAGEMENT_UNAVAILABLE',
    details: code ? { healthCode: code.slice(0, 128) } : {},
  }, 503)
}

async function requireManagementHealth(c: any): Promise<Response | null> {
  try {
    const health = await preflightTagIdentityHealth(metadataDb(), CONTENT_DIR)
    if (health.state !== 'healthy') return managementUnavailable(c, health.code)
    return null
  } catch {
    return managementUnavailable(c, 'TAG_MANAGEMENT_UNAVAILABLE')
  }
}

function domainError(c: any, error: TagManagementError, apply = false): Response {
  if (error.code === 'TRANSACTION_FAILED') return unexpectedError(c)
  const status = error.code === 'diary-private-metadata-unsupported' ? 422
    : error.code === 'TAG_NOT_FOUND' ? 404
    : error.code === 'TAG_MANAGEMENT_UNAVAILABLE' || error.code === 'TAG_IDENTITY_CONFLICT' ? 503
      : error.code === 'PREVIEW_STALE'
        || error.code === 'PREVIEW_REQUIRED'
        || error.code === 'DESTINATION_EXISTS'
        || error.code === 'SOURCE_DESTINATION_SAME'
        || (apply && error.code === 'INVALID_OPERATION') ? 409
          : 400
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: error.message,
    code: error.code,
    details: {
      ...error.details,
      ...(error.code === 'DESTINATION_EXISTS' ? {
        destinationTagId: error.details.destinationTagId ?? null,
        destinationDisplayName: error.details.destinationDisplayName ?? null,
      } : {}),
    },
  }, status)
}

function unexpectedError(c: any): Response {
  const correlationId = randomUUID()
  const method = typeof c.req.method === 'string' ? c.req.method.slice(0, 16) : 'UNKNOWN'
  const route = typeof c.req.path === 'string' ? c.req.path.slice(0, 128) : '/api/tags'
  console.error(`[tag-management] ${correlationId} ${method} ${route} TRANSACTION_FAILED`)
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: 'Tag management operation failed.',
    code: 'TRANSACTION_FAILED',
    details: { correlationId },
  }, 500)
}

const UNDO_RECORD_ID_MAX_LENGTH = 128
const UNDO_DOCUMENT_ID_MAX_LENGTH = 512
const UNDO_FINGERPRINT = /^[0-9a-f]{64}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key))
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function invalidUndoRequest(message: string): never {
  throw new TagUndoPlannerError('INVALID_PREVIEW', message)
}

function parseUndoRecordId(value: unknown, field = 'recordId'): string {
  if (!boundedString(value, UNDO_RECORD_ID_MAX_LENGTH)) {
    invalidUndoRequest(`${field} must be a bounded non-empty string`)
  }
  return value
}

function parseUndoLimit(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    invalidUndoRequest(`limit must be an integer from 1 to ${max}`)
  }
  return value
}

export type TagUndoPreviewRouteRequest = {
  recordId: string
  limit?: number
}

export function parseTagUndoPreviewRouteRequest(value: unknown): TagUndoPreviewRouteRequest {
  if (!isPlainObject(value) || !hasExactKeys(value, ['recordId'], ['limit'])) {
    invalidUndoRequest('Undo Preview requires exactly recordId and optional limit')
  }
  const recordId = parseUndoRecordId(value.recordId)
  const limit = value.limit === undefined ? undefined : parseUndoLimit(value.limit, 20)
  return { recordId, ...(limit === undefined ? {} : { limit }) }
}

export function parseTagUndoPreviewPageRouteRequest(value: unknown): TagUndoPreviewPageRequest & { recordId: string } {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['recordId', 'undoFingerprint'], ['afterDocumentId', 'limit'])
    || typeof value.undoFingerprint !== 'string'
    || !UNDO_FINGERPRINT.test(value.undoFingerprint)) {
    invalidUndoRequest('Undo Preview page requires recordId and a lowercase 64-character fingerprint')
  }
  const recordId = parseUndoRecordId(value.recordId)
  const afterDocumentId = value.afterDocumentId
  if (afterDocumentId !== undefined
    && afterDocumentId !== null
    && !boundedString(afterDocumentId, UNDO_DOCUMENT_ID_MAX_LENGTH)) {
    invalidUndoRequest('afterDocumentId must be null or a bounded non-empty string')
  }
  const limit = value.limit === undefined ? undefined : parseUndoLimit(value.limit, 100)
  return {
    recordId,
    undoFingerprint: value.undoFingerprint,
    ...(afterDocumentId === undefined ? {} : { afterDocumentId }),
    ...(limit === undefined ? {} : { limit }),
  }
}

export function parseTagUndoApplyRouteRequest(value: unknown): TagUndoApplyInput {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['recordId', 'undoFingerprint'])
    || typeof value.undoFingerprint !== 'string'
    || !UNDO_FINGERPRINT.test(value.undoFingerprint)) {
    invalidUndoRequest('Undo Apply requires exactly recordId and undoFingerprint')
  }
  return {
    recordId: parseUndoRecordId(value.recordId),
    undoFingerprint: value.undoFingerprint,
  }
}

function mapUndoReasonCode(reasonCode: string | null): string | null {
  if (reasonCode === null) return null
  if (reasonCode === 'UNDO_TARGET_UNAVAILABLE') return 'UNDO_UNAVAILABLE'
  if (reasonCode === 'UNDO_SOURCE_IDENTITY_OCCUPIED'
    || reasonCode === 'UNDO_DESTINATION_IDENTITY_OCCUPIED') return 'UNDO_IDENTITY_CONFLICT'
  if (reasonCode === 'UNDO_SOURCE_ID_OCCUPIED'
    || reasonCode === 'UNDO_SOURCE_POST_STATE_CHANGED'
    || reasonCode === 'UNDO_SOURCE_POST_STATE_MISSING'
    || reasonCode === 'UNDO_DESTINATION_POST_STATE_CHANGED'
    || reasonCode === 'UNDO_DESTINATION_POST_STATE_MISSING') return 'UNDO_STABLE_ID_CONFLICT'
  if (reasonCode === 'UNDO_MISSING_DOCUMENT') return 'UNDO_DOCUMENT_MISSING'
  if (reasonCode === 'UNDO_ASSOCIATION_CONFLICT'
    || reasonCode === 'UNDO_MALFORMED_OWNERSHIP') return 'UNDO_ASSOCIATION_CONFLICT'
  if (reasonCode === 'UNDO_MALFORMED_TAG'
    || reasonCode === 'UNDO_CORRUPT') return 'UNDO_RECORD_CORRUPT'
  if (reasonCode === 'TAG_UNDO_FOUNDATION_UNHEALTHY') return 'TAG_MANAGEMENT_UNAVAILABLE'
  if (reasonCode === 'UNDO_UNAVAILABLE'
    || reasonCode === 'UNDO_PREVIEW_REQUIRED'
    || reasonCode === 'UNDO_STALE'
    || reasonCode === 'UNDO_CONFLICT'
    || reasonCode === 'UNDO_SUPERSEDED'
    || reasonCode === 'UNDO_ALREADY_APPLIED'
    || reasonCode === 'UNDO_RECORD_CORRUPT'
    || reasonCode === 'UNDO_STABLE_ID_CONFLICT'
    || reasonCode === 'UNDO_IDENTITY_CONFLICT'
    || reasonCode === 'UNDO_DOCUMENT_MISSING'
    || reasonCode === 'TAG_MANAGEMENT_UNAVAILABLE') return reasonCode
  return 'UNDO_CONFLICT'
}

function mapUndoReadModelReasonCode(value: Pick<TagUndoAvailability, 'state' | 'validation' | 'reasonCode'>): string | null {
  const mapped = mapUndoReasonCode(value.reasonCode)
  const terminalReadModel = value.state === 'terminal-unavailable'
    || value.validation === 'terminal-unavailable'
  if (terminalReadModel
    && value.reasonCode !== null
    && mapped === 'UNDO_CONFLICT'
    && value.reasonCode !== 'UNDO_CONFLICT') {
    return 'UNDO_RECORD_CORRUPT'
  }
  return mapped
}

function publicUndoAvailability(value: TagUndoAvailability): TagUndoAvailability {
  return { ...value, reasonCode: mapUndoReadModelReasonCode(value) }
}

function publicUndoPreview(value: TagUndoPreview): Omit<TagUndoPreview, 'nextAfterDocumentId'> {
  const { nextAfterDocumentId: _nextAfterDocumentId, ...preview } = value
  return { ...preview, reasonCode: mapUndoReadModelReasonCode(value) }
}

function publicUndoApplyResult(value: TagUndoApplyResult) {
  return {
    undoRecordId: value.recordId,
    originalOperationId: value.originalOperationId,
    originalResultId: value.originalResultId,
    undoOperationId: value.undoOperationId,
    undoResultId: value.undoResultId,
    kind: value.kind,
    displayOnly: value.displayOnly,
    sourceTag: value.sourceTag,
    destinationTag: value.destinationTag,
    affectedCount: value.affectedCount,
    associationAdds: value.associationAdds,
    associationRemoves: value.associationRemoves,
    versionUpdateCount: value.versionUpdateCount,
    committedAt: value.committedAt,
    appliedUndoFingerprint: value.appliedUndoFingerprint,
    lifecycle: value.lifecycle,
  }
}

const UNDO_ERROR_CODES = new Set([
  'UNDO_UNAVAILABLE',
  'UNDO_PREVIEW_REQUIRED',
  'UNDO_STALE',
  'UNDO_CONFLICT',
  'UNDO_SUPERSEDED',
  'UNDO_ALREADY_APPLIED',
  'UNDO_RECORD_CORRUPT',
  'UNDO_STABLE_ID_CONFLICT',
  'UNDO_IDENTITY_CONFLICT',
  'UNDO_DOCUMENT_MISSING',
  'UNDO_ASSOCIATION_CONFLICT',
  'TAG_MANAGEMENT_UNAVAILABLE',
  'INVALID_OPERATION',
  'TRANSACTION_FAILED',
  'diary-private-metadata-unsupported',
] as const)

type UndoRouteErrorCode = typeof UNDO_ERROR_CODES extends Set<infer T> ? T : never

function undoRouteErrorCode(error: TagUndoPlannerError): UndoRouteErrorCode {
  if (error.code === 'diary-private-metadata-unsupported') return 'diary-private-metadata-unsupported'
  if (error.code === 'INVALID_PREVIEW') return 'INVALID_OPERATION'
  if (error.code === 'UNDO_TARGET_UNAVAILABLE') return 'UNDO_UNAVAILABLE'
  if (error.code === 'UNDO_CONFLICT') {
    const reasonCode = typeof error.details.reasonCode === 'string'
      ? mapUndoReasonCode(error.details.reasonCode)
      : null
    if (reasonCode === 'UNDO_STABLE_ID_CONFLICT'
      || reasonCode === 'UNDO_IDENTITY_CONFLICT'
      || reasonCode === 'UNDO_DOCUMENT_MISSING'
      || reasonCode === 'UNDO_ASSOCIATION_CONFLICT'
      || reasonCode === 'UNDO_RECORD_CORRUPT') return reasonCode
    return 'UNDO_CONFLICT'
  }
  if (error.code === 'TAG_MANAGEMENT_UNAVAILABLE') return 'TAG_MANAGEMENT_UNAVAILABLE'
  if (error.code === 'TRANSACTION_FAILED') return 'TRANSACTION_FAILED'
  return error.code as UndoRouteErrorCode
}

function undoRouteErrorMessage(code: UndoRouteErrorCode): string {
  if (code === 'diary-private-metadata-unsupported') {
    return 'Tag management is unavailable for managed Diary metadata.'
  }
  if (code === 'INVALID_OPERATION') return 'Invalid Undo request.'
  if (code === 'TAG_MANAGEMENT_UNAVAILABLE') return 'Tag management is temporarily unavailable.'
  if (code === 'TRANSACTION_FAILED') return 'Undo operation failed.'
  if (code === 'UNDO_PREVIEW_REQUIRED') return 'A current Undo Preview is required.'
  if (code === 'UNDO_STALE') return 'The Undo Preview is stale.'
  if (code === 'UNDO_CONFLICT') return 'Undo is blocked by a current-state conflict.'
  if (code === 'UNDO_SUPERSEDED') return 'The Undo target was superseded.'
  if (code === 'UNDO_ALREADY_APPLIED') return 'The Undo target was already applied.'
  if (code === 'UNDO_RECORD_CORRUPT') return 'The Undo target is permanently unavailable.'
  if (code === 'UNDO_STABLE_ID_CONFLICT') return 'Undo stable identity validation failed.'
  if (code === 'UNDO_IDENTITY_CONFLICT') return 'Undo identity validation failed.'
  if (code === 'UNDO_DOCUMENT_MISSING') return 'A required document is missing.'
  if (code === 'UNDO_ASSOCIATION_CONFLICT') return 'Undo association validation failed.'
  return 'No Undo operation is available.'
}

const UNDO_REASON_DIAGNOSTIC_CODES = new Set<string>([
  'UNDO_SOURCE_ID_OCCUPIED',
  'UNDO_SOURCE_POST_STATE_CHANGED',
  'UNDO_SOURCE_POST_STATE_MISSING',
  'UNDO_DESTINATION_POST_STATE_CHANGED',
  'UNDO_DESTINATION_POST_STATE_MISSING',
  'UNDO_SOURCE_IDENTITY_OCCUPIED',
  'UNDO_DESTINATION_IDENTITY_OCCUPIED',
  'UNDO_MISSING_DOCUMENT',
  'UNDO_ASSOCIATION_CONFLICT',
  'UNDO_MALFORMED_OWNERSHIP',
  'UNDO_MALFORMED_TAG',
])

function undoErrorDetails(error: TagUndoPlannerError): Record<string, string | number | null> {
  const details: Record<string, string | number | null> = {}
  if (typeof error.details.recordId === 'string') details.recordId = error.details.recordId.slice(0, UNDO_RECORD_ID_MAX_LENGTH)
  if (typeof error.details.healthCode === 'string') details.healthCode = error.details.healthCode.slice(0, 128)
  const reasonCode = typeof error.details.reasonCode === 'string'
    && UNDO_REASON_DIAGNOSTIC_CODES.has(error.details.reasonCode)
    ? error.details.reasonCode
    : null
  if (reasonCode) details.reasonCode = reasonCode
  return details
}

function undoDomainError(c: any, error: TagUndoPlannerError): Response {
  const code = undoRouteErrorCode(error)
  if (code === 'TRANSACTION_FAILED') return unexpectedError(c)
  const status = code === 'diary-private-metadata-unsupported' ? 422
    : code === 'TAG_MANAGEMENT_UNAVAILABLE' ? 503
    : code === 'INVALID_OPERATION' ? 400
      : 409
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: undoRouteErrorMessage(code),
    code,
    details: undoErrorDetails(error),
  }, status)
}

function isUndoFoundationUnavailable(value: TagUndoAvailability | TagUndoPreview): boolean {
  return value.reasonCode === 'TAG_MANAGEMENT_UNAVAILABLE'
    || value.reasonCode === 'TAG_UNDO_FOUNDATION_UNHEALTHY'
}

function parseUndoQueryRecordId(c: any): string | undefined {
  const value = c.req.query('recordId')
  return value === undefined ? undefined : parseUndoRecordId(value, 'recordId query')
}

tagRoutes.get('/api/tags', async (c) => {
  const unavailable = await requireManagementHealth(c)
  if (unavailable) return unavailable
  try {
    return c.json(listManagedTags(metadataDb()))
  } catch (error) {
    if (error instanceof TagManagementError) return domainError(c, error)
    return unexpectedError(c)
  }
})

tagRoutes.get('/api/tags/undo', async (c) => {
  const unavailable = await requireManagementHealth(c)
  if (unavailable) return unavailable
  try {
    const availability = getTagUndoAvailability(metadataDb(), parseUndoQueryRecordId(c))
    if (isUndoFoundationUnavailable(availability)) {
      return managementUnavailable(c, availability.reasonCode ?? undefined)
    }
    return c.json(publicUndoAvailability(availability))
  } catch (error) {
    if (error instanceof TagUndoPlannerError) return undoDomainError(c, error)
    return unexpectedError(c)
  }
})

tagRoutes.post('/api/tags/undo/preview', async (c) => {
  const unavailable = await requireManagementHealth(c)
  if (unavailable) return unavailable
  const body = await c.req.json().catch(() => null)
  try {
    const parsed = parseTagUndoPreviewRouteRequest(body)
    const preview = previewTagUndo(metadataDb(), parsed)
    if (isUndoFoundationUnavailable(preview)) {
      return managementUnavailable(c, preview.reasonCode ?? undefined)
    }
    return c.json(publicUndoPreview(preview))
  } catch (error) {
    if (error instanceof TagUndoPlannerError) return undoDomainError(c, error)
    return unexpectedError(c)
  }
})

tagRoutes.post('/api/tags/undo/preview/page', async (c) => {
  const unavailable = await requireManagementHealth(c)
  if (unavailable) return unavailable
  const body = await c.req.json().catch(() => null)
  try {
    const parsed = parseTagUndoPreviewPageRouteRequest(body)
    const page = getTagUndoPreviewPage(metadataDb(), parsed)
    if (isUndoFoundationUnavailable(page)) {
      return managementUnavailable(c, page.reasonCode ?? undefined)
    }
    return c.json(publicUndoPreview(page))
  } catch (error) {
    if (error instanceof TagUndoPlannerError) return undoDomainError(c, error)
    return unexpectedError(c)
  }
})

tagRoutes.post('/api/tags/undo/apply', async (c) => {
  const unavailable = await requireManagementHealth(c)
  if (unavailable) return unavailable
  const body = await c.req.json().catch(() => null)
  try {
    const parsed = parseTagUndoApplyRouteRequest(body)
    return c.json(publicUndoApplyResult(await applyTagUndo(metadataDb(), parsed)))
  } catch (error) {
    if (error instanceof TagUndoPlannerError) return undoDomainError(c, error)
    return unexpectedError(c)
  }
})

tagRoutes.post('/api/tags/operations/preview', async (c) => {
  const unavailable = await requireManagementHealth(c)
  if (unavailable) return unavailable
  const body = await c.req.json().catch(() => null)
  try {
    const parsed = parseTagOperation(body)
    return c.json(previewTagOperation(metadataDb(), parsed.operation))
  } catch (error) {
    if (error instanceof TagManagementError) return domainError(c, error)
    return unexpectedError(c)
  }
})

tagRoutes.post('/api/tags/operations/preview/page', async (c) => {
  const unavailable = await requireManagementHealth(c)
  if (unavailable) return unavailable
  const body = await c.req.json().catch(() => null)
  try {
    const parsed = parsePreviewPageRequest(body)
    if (!isPlanFingerprint(parsed.planFingerprint)) {
      return domainError(c, new TagManagementError('INVALID_OPERATION', 'planFingerprint is invalid'))
    }
    return c.json(previewTagOperationPage(
      metadataDb(),
      parsed.operation,
      parsed.planFingerprint,
      parsed.afterDocumentId,
      parsed.limit,
    ))
  } catch (error) {
    if (error instanceof TagManagementError) return domainError(c, error)
    return unexpectedError(c)
  }
})

tagRoutes.post('/api/tags/operations/apply', async (c) => {
  const unavailable = await requireManagementHealth(c)
  if (unavailable) return unavailable
  const body = await c.req.json().catch(() => null)
  let parsed: ReturnType<typeof parseTagApplyRequest>
  try {
    parsed = parseTagApplyRequest(body)
  } catch (error) {
    if (error instanceof TagManagementError) return domainError(c, error)
    return unexpectedError(c)
  }
  try {
    return c.json(await applyTagOperation(metadataDb(), parsed.operation, parsed.planFingerprint))
  } catch (error) {
    if (error instanceof TagManagementError) return domainError(c, error, true)
    return unexpectedError(c)
  }
})

export default tagRoutes
