import { authFetch } from './auth-session'
import { jsonOrThrow } from './api'
import type { TagRowView } from './tag-management-api'

export const UNDO_FINGERPRINT_CONTRACT_VERSION = 'tag-undo-fingerprint-v1' as const
export const UNDO_PREVIEW_SAMPLE_LIMIT = 20
export const UNDO_PREVIEW_PAGE_MAX_LIMIT = 100

const MAX_TAG_NAME_LENGTH = 100
const MAX_RECORD_ID_LENGTH = 128
const MAX_DOCUMENT_FIELD_LENGTH = 4096
const MAX_ERROR_LENGTH = 2048
const MAX_ERROR_DETAIL_KEYS = 16
const FINGERPRINT = /^[0-9a-f]{64}$/

export type UndoAvailabilityState =
  | 'unavailable'
  | 'available'
  | 'consumed'
  | 'superseded'
  | 'terminal-unavailable'

export type UndoValidation =
  | 'safe'
  | 'conflict'
  | 'temporary-unavailable'
  | 'stale'
  | 'terminal-unavailable'

export type UndoKind = 'rename' | 'merge' | 'remove'
export type UndoWarningCode = 'DESTRUCTIVE' | 'HIGH_IMPACT' | 'DYNAMIC_CONFLICT'

export type UndoServerErrorCode =
  | 'UNDO_UNAVAILABLE'
  | 'UNDO_PREVIEW_REQUIRED'
  | 'UNDO_STALE'
  | 'UNDO_CONFLICT'
  | 'UNDO_SUPERSEDED'
  | 'UNDO_ALREADY_APPLIED'
  | 'UNDO_RECORD_CORRUPT'
  | 'UNDO_STABLE_ID_CONFLICT'
  | 'UNDO_IDENTITY_CONFLICT'
  | 'UNDO_DOCUMENT_MISSING'
  | 'UNDO_ASSOCIATION_CONFLICT'
  | 'TAG_MANAGEMENT_UNAVAILABLE'
  | 'INVALID_OPERATION'
  | 'TRANSACTION_FAILED'

export type UndoErrorCode = UndoServerErrorCode | 'CLIENT_PROTOCOL_ERROR'

export interface UndoError {
  error: string
  code: UndoServerErrorCode
  details: Record<string, string | number | null>
}

export class TagUndoApiError extends Error {
  readonly status: number
  readonly code: UndoErrorCode
  readonly details: Record<string, string | number | null>
  /** The submitted record remains the recovery anchor after ambiguous Apply. */
  readonly recoveryRecordId: string | null

  constructor(
    message: string,
    status: number,
    code: UndoErrorCode,
    details: Record<string, string | number | null> = {},
    recoveryRecordId: string | null = null,
  ) {
    super(message)
    this.name = 'TagUndoApiError'
    this.status = status
    this.code = code
    this.details = details
    this.recoveryRecordId = recoveryRecordId
  }
}

export interface UndoAvailability {
  supported: true
  state: UndoAvailabilityState
  validation: UndoValidation
  recordId: string | null
  originalOperationId: string | null
  originalResultId: string | null
  kind: UndoKind | null
  displayOnly: boolean
  committedAt: number | null
  sourceBefore: TagRowView | null
  sourceAfter: TagRowView | null
  destinationBefore: TagRowView | null
  destinationAfter: TagRowView | null
  affectedCount: number
  associationAdds: number
  associationRemoves: number
  versionUpdateCount: number
  reasonCode: string | null
}

export interface UndoPreview extends UndoAvailability {
  warnings: UndoWarningCode[]
  sample: Array<{ id: string; path: string; title: string }>
  nextCursor: string | null
  undoFingerprint: string | null
  undoContractVersion: typeof UNDO_FINGERPRINT_CONTRACT_VERSION
  allowedToApply: boolean
}

export interface UndoApplyRequest {
  recordId: string
  undoFingerprint: string
}

export interface UndoPreviewPageRequest {
  recordId: string
  undoFingerprint: string
  afterDocumentId?: string | null
  limit?: number
}

export interface UndoApplyResult {
  undoRecordId: string
  originalOperationId: string
  originalResultId: string
  undoOperationId: string
  undoResultId: string
  kind: UndoKind
  displayOnly: boolean
  sourceTag: TagRowView
  destinationTag: TagRowView | null
  affectedCount: number
  associationAdds: number
  associationRemoves: number
  versionUpdateCount: number
  committedAt: number
  appliedUndoFingerprint: string
  lifecycle: 'consumed'
}

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

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function requiredBoundedString(value: unknown, maxLength: number, field: string): string {
  assert(boundedString(value, maxLength), `${field} is invalid`)
  return value
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  assert(nonNegativeSafeInteger(value), `${field} is invalid`)
  return value
}

function protocolError(message: string, status = 200, recoveryRecordId: string | null = null): TagUndoApiError {
  return new TagUndoApiError(
    'Undo returned an invalid protocol response.',
    status,
    'CLIENT_PROTOCOL_ERROR',
    { reason: message.slice(0, 256) },
    recoveryRecordId,
  )
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw protocolError(message)
}

function parseTagRow(value: unknown, field: string): TagRowView {
  assert(isPlainObject(value), `${field} must be an object`)
  assert(hasExactKeys(value, ['id', 'normalizedName', 'displayName']), `${field} shape is invalid`)
  assert(positiveSafeInteger(value.id), `${field}.id is invalid`)
  assert(boundedString(value.normalizedName, MAX_TAG_NAME_LENGTH), `${field}.normalizedName is invalid`)
  assert(boundedString(value.displayName, MAX_TAG_NAME_LENGTH), `${field}.displayName is invalid`)
  return {
    id: value.id,
    normalizedName: value.normalizedName,
    displayName: value.displayName,
  }
}

function parseNullableTag(value: unknown, field: string): TagRowView | null {
  return value === null ? null : parseTagRow(value, field)
}

function parseNullableId(value: unknown, field: string): string | null {
  assert(value === null || boundedString(value, MAX_RECORD_ID_LENGTH), `${field} is invalid`)
  return value
}

function parseKind(value: unknown, field: string): UndoKind | null {
  assert(value === null || value === 'rename' || value === 'merge' || value === 'remove', `${field} is invalid`)
  return value
}

function parseAvailabilityState(value: unknown): UndoAvailabilityState {
  assert(value === 'unavailable'
    || value === 'available'
    || value === 'consumed'
    || value === 'superseded'
    || value === 'terminal-unavailable', 'state is invalid')
  return value
}

function parseValidation(value: unknown): UndoValidation {
  assert(value === 'safe'
    || value === 'conflict'
    || value === 'temporary-unavailable'
    || value === 'stale'
    || value === 'terminal-unavailable', 'validation is invalid')
  return value
}

const AVAILABILITY_KEYS = [
  'supported', 'state', 'validation', 'recordId', 'originalOperationId', 'originalResultId',
  'kind', 'displayOnly', 'committedAt', 'sourceBefore', 'sourceAfter', 'destinationBefore',
  'destinationAfter', 'affectedCount', 'associationAdds', 'associationRemoves',
  'versionUpdateCount', 'reasonCode',
] as const

function assertAvailabilitySemantics(value: UndoAvailability): void {
  const hasRecord = value.recordId !== null
  if (!hasRecord) {
    assert(value.state === 'unavailable' || value.state === 'superseded', 'missing record has an invalid state')
    if (value.state === 'superseded') {
      assert(value.validation === 'terminal-unavailable', 'superseded tombstone validation is invalid')
      assert(value.reasonCode === 'UNDO_SUPERSEDED', 'superseded tombstone reason is invalid')
    } else {
      assert(value.validation === 'temporary-unavailable' || value.validation === 'stale', 'unavailable state validation is invalid')
    }
    assert(value.originalOperationId === null && value.originalResultId === null, 'missing record has operation identity')
    assert(value.kind === null && value.displayOnly === false, 'missing record has operation kind')
    assert(value.committedAt === null, 'missing record has commit time')
    assert(value.sourceBefore === null && value.sourceAfter === null, 'missing record has source identity')
    assert(value.destinationBefore === null && value.destinationAfter === null, 'missing record has destination identity')
    assert(value.affectedCount === 0 && value.associationAdds === 0
      && value.associationRemoves === 0 && value.versionUpdateCount === 0, 'missing record has counts')
  } else {
    assert(value.state !== 'unavailable', 'record has an unavailable state')
    assert(value.originalOperationId !== null && value.originalResultId !== null, 'record operation identity is missing')
    assert(value.kind !== null && value.committedAt !== null, 'record identity is incomplete')
    assert(value.sourceBefore !== null, 'record sourceBefore is missing')
    if (value.kind === 'rename') {
      assert(value.sourceAfter !== null, 'rename sourceAfter is missing')
      assert(value.sourceAfter.id === value.sourceBefore.id, 'rename source identity changed')
      if (value.displayOnly) {
        assert(value.sourceAfter.normalizedName === value.sourceBefore.normalizedName, 'display rename normalized identity changed')
      } else {
        assert(value.sourceAfter.normalizedName !== value.sourceBefore.normalizedName, 'identity rename did not change normalized identity')
      }
      assert(value.destinationBefore === null && value.destinationAfter === null, 'rename has destination identity')
    } else if (value.kind === 'merge') {
      assert(value.displayOnly === false, 'merge cannot be display-only')
      assert(value.sourceAfter === null, 'merge has sourceAfter')
      assert(value.destinationBefore !== null && value.destinationAfter !== null, 'merge destination identity is incomplete')
      assert(value.destinationAfter.id === value.destinationBefore.id, 'merge destination identity changed')
      assert(value.destinationAfter.normalizedName === value.destinationBefore.normalizedName, 'merge destination normalized identity changed')
      assert(value.destinationAfter.displayName === value.destinationBefore.displayName, 'merge destination display identity changed')
    } else {
      assert(value.displayOnly === false, 'remove cannot be display-only')
      assert(value.sourceAfter === null, 'remove has sourceAfter')
      assert(value.destinationBefore === null && value.destinationAfter === null, 'remove has destination identity')
    }
  }

  if (value.state === 'available') {
    assert(hasRecord && (value.validation === 'safe' || value.validation === 'conflict'), 'available state is invalid')
  } else if (value.state === 'consumed' || value.state === 'terminal-unavailable') {
    assert(value.validation === 'terminal-unavailable', 'terminal state validation is invalid')
  } else if (value.state === 'superseded') {
    assert(!hasRecord, 'superseded state has a retained record')
    assert(value.validation === 'terminal-unavailable', 'superseded validation is invalid')
  } else {
    assert(value.validation === 'temporary-unavailable' || value.validation === 'stale', 'unavailable validation is invalid')
  }
}

function parseAvailability(value: unknown): UndoAvailability {
  assert(isPlainObject(value), 'availability must be an object')
  assert(hasExactKeys(value, AVAILABILITY_KEYS), 'availability shape is invalid')
  assert(value.supported === true, 'Undo is not supported by this protocol')
  const displayOnly = value.displayOnly
  const committedAt = value.committedAt
  const affectedCount = value.affectedCount
  const associationAdds = value.associationAdds
  const associationRemoves = value.associationRemoves
  const versionUpdateCount = value.versionUpdateCount
  const reasonCode = value.reasonCode
  assert(typeof displayOnly === 'boolean', 'displayOnly is invalid')
  assert(committedAt === null || nonNegativeSafeInteger(committedAt), 'committedAt is invalid')
  assert(nonNegativeSafeInteger(affectedCount), 'affectedCount is invalid')
  assert(nonNegativeSafeInteger(associationAdds), 'associationAdds is invalid')
  assert(nonNegativeSafeInteger(associationRemoves), 'associationRemoves is invalid')
  assert(nonNegativeSafeInteger(versionUpdateCount), 'versionUpdateCount is invalid')
  assert(reasonCode === null || boundedString(reasonCode, 128), 'reasonCode is invalid')
  const availability: UndoAvailability = {
    supported: true,
    state: parseAvailabilityState(value.state),
    validation: parseValidation(value.validation),
    recordId: parseNullableId(value.recordId, 'recordId'),
    originalOperationId: parseNullableId(value.originalOperationId, 'originalOperationId'),
    originalResultId: parseNullableId(value.originalResultId, 'originalResultId'),
    kind: parseKind(value.kind, 'kind'),
    displayOnly,
    committedAt,
    sourceBefore: parseNullableTag(value.sourceBefore, 'sourceBefore'),
    sourceAfter: parseNullableTag(value.sourceAfter, 'sourceAfter'),
    destinationBefore: parseNullableTag(value.destinationBefore, 'destinationBefore'),
    destinationAfter: parseNullableTag(value.destinationAfter, 'destinationAfter'),
    affectedCount,
    associationAdds,
    associationRemoves,
    versionUpdateCount,
    reasonCode,
  }
  assertAvailabilitySemantics(availability)
  return availability
}

function parsePreviewDocument(value: unknown, index: number): { id: string; path: string; title: string } {
  assert(isPlainObject(value), `sample ${index} must be an object`)
  assert(hasExactKeys(value, ['id', 'path', 'title']), `sample ${index} shape is invalid`)
  assert(boundedString(value.id, MAX_DOCUMENT_FIELD_LENGTH), `sample ${index}.id is invalid`)
  assert(boundedString(value.path, MAX_DOCUMENT_FIELD_LENGTH), `sample ${index}.path is invalid`)
  assert(boundedString(value.title, MAX_DOCUMENT_FIELD_LENGTH, true), `sample ${index}.title is invalid`)
  return { id: value.id, path: value.path, title: value.title }
}

function parsePreview(value: unknown, maxSample: number): UndoPreview {
  assert(isPlainObject(value), 'Undo Preview must be an object')
  assert(hasExactKeys(value, [
    ...AVAILABILITY_KEYS,
    'warnings', 'sample', 'nextCursor', 'undoFingerprint', 'undoContractVersion', 'allowedToApply',
  ]), 'Undo Preview shape is invalid')
  const availability = parseAvailability(Object.fromEntries(
    AVAILABILITY_KEYS.map((key) => [key, value[key]]),
  ))
  assert(Array.isArray(value.warnings) && value.warnings.length <= 3, 'warnings are invalid')
  const warnings: UndoWarningCode[] = []
  for (const warning of value.warnings) {
    assert(warning === 'DESTRUCTIVE' || warning === 'HIGH_IMPACT' || warning === 'DYNAMIC_CONFLICT', 'warning code is invalid')
    assert(!warnings.includes(warning), 'warning code is duplicated')
    warnings.push(warning)
  }
  assert(Array.isArray(value.sample) && value.sample.length <= maxSample, 'sample exceeds the approved bound')
  const sample = value.sample.map((document, index) => parsePreviewDocument(document, index))
  const sampleIds = new Set<string>()
  for (const document of sample) {
    assert(!sampleIds.has(document.id), 'sample contains duplicate document IDs')
    sampleIds.add(document.id)
  }
  assert(value.nextCursor === null || boundedString(value.nextCursor, MAX_DOCUMENT_FIELD_LENGTH), 'nextCursor is invalid')
  if (value.nextCursor !== null) {
    assert(sample.length > 0 && sample[sample.length - 1]!.id === value.nextCursor, 'nextCursor is inconsistent with sample')
  }
  assert(value.undoContractVersion === UNDO_FINGERPRINT_CONTRACT_VERSION, 'undoContractVersion is invalid')
  assert(value.undoFingerprint === null || (typeof value.undoFingerprint === 'string' && FINGERPRINT.test(value.undoFingerprint)), 'undoFingerprint is invalid')
  assert(typeof value.allowedToApply === 'boolean', 'allowedToApply is invalid')
  if (availability.state === 'available') {
    assert(value.undoFingerprint !== null, 'available Preview has no fingerprint')
    assert(value.allowedToApply === (availability.validation === 'safe'), 'allowedToApply contradicts validation')
  } else {
    assert(value.undoFingerprint === null && value.allowedToApply === false, 'unavailable Preview has apply authority')
    assert(sample.length === 0 && value.nextCursor === null, 'unavailable Preview exposes scope')
  }
  return {
    ...availability,
    warnings,
    sample,
    nextCursor: value.nextCursor,
    undoFingerprint: value.undoFingerprint,
    undoContractVersion: value.undoContractVersion,
    allowedToApply: value.allowedToApply,
  }
}

const APPLY_RESULT_KEYS = [
  'undoRecordId', 'originalOperationId', 'originalResultId', 'undoOperationId', 'undoResultId',
  'kind', 'displayOnly', 'sourceTag', 'destinationTag', 'affectedCount', 'associationAdds',
  'associationRemoves', 'versionUpdateCount', 'committedAt', 'appliedUndoFingerprint', 'lifecycle',
] as const

function parseApplyResult(value: unknown): UndoApplyResult {
  assert(isPlainObject(value), 'Undo Apply result must be an object')
  assert(hasExactKeys(value, APPLY_RESULT_KEYS), 'Undo Apply result shape is invalid')
  const kind = value.kind
  assert(kind === 'rename' || kind === 'merge' || kind === 'remove', 'Undo Apply kind is invalid')
  const displayOnly = value.displayOnly
  assert(typeof displayOnly === 'boolean', 'Undo Apply displayOnly is invalid')
  const affectedCount = requiredNonNegativeInteger(value.affectedCount, 'affectedCount')
  const associationAdds = requiredNonNegativeInteger(value.associationAdds, 'associationAdds')
  const associationRemoves = requiredNonNegativeInteger(value.associationRemoves, 'associationRemoves')
  const versionUpdateCount = requiredNonNegativeInteger(value.versionUpdateCount, 'versionUpdateCount')
  const committedAt = requiredNonNegativeInteger(value.committedAt, 'committedAt')
  const appliedUndoFingerprint = validateFingerprint(value.appliedUndoFingerprint, 'appliedUndoFingerprint')
  const lifecycle = value.lifecycle
  assert(lifecycle === 'consumed', 'Undo Apply lifecycle is invalid')
  const result: UndoApplyResult = {
    undoRecordId: requiredBoundedString(value.undoRecordId, MAX_RECORD_ID_LENGTH, 'undoRecordId'),
    originalOperationId: requiredBoundedString(value.originalOperationId, MAX_RECORD_ID_LENGTH, 'originalOperationId'),
    originalResultId: requiredBoundedString(value.originalResultId, MAX_RECORD_ID_LENGTH, 'originalResultId'),
    undoOperationId: requiredBoundedString(value.undoOperationId, MAX_RECORD_ID_LENGTH, 'undoOperationId'),
    undoResultId: requiredBoundedString(value.undoResultId, MAX_RECORD_ID_LENGTH, 'undoResultId'),
    kind,
    displayOnly,
    sourceTag: parseTagRow(value.sourceTag, 'sourceTag'),
    destinationTag: parseNullableTag(value.destinationTag, 'destinationTag'),
    affectedCount,
    associationAdds,
    associationRemoves,
    versionUpdateCount,
    committedAt,
    appliedUndoFingerprint,
    lifecycle,
  }
  assert(result.sourceTag !== null, 'Undo Apply sourceTag is missing')
  assert(result.destinationTag === null || result.kind === 'merge', 'Undo Apply destinationTag is invalid')
  if (result.kind === 'merge') assert(result.displayOnly === false && result.destinationTag !== null, 'Merge Undo result identity is invalid')
  if (result.kind === 'remove') assert(result.displayOnly === false && result.destinationTag === null, 'Remove Undo result identity is invalid')
  if (result.kind === 'rename') assert(result.destinationTag === null, 'Rename Undo result identity is invalid')
  return result
}

const SERVER_ERROR_CODES = new Set<UndoServerErrorCode>([
  'UNDO_UNAVAILABLE', 'UNDO_PREVIEW_REQUIRED', 'UNDO_STALE', 'UNDO_CONFLICT',
  'UNDO_SUPERSEDED', 'UNDO_ALREADY_APPLIED', 'UNDO_RECORD_CORRUPT', 'UNDO_STABLE_ID_CONFLICT',
  'UNDO_IDENTITY_CONFLICT', 'UNDO_DOCUMENT_MISSING', 'UNDO_ASSOCIATION_CONFLICT',
  'TAG_MANAGEMENT_UNAVAILABLE', 'INVALID_OPERATION', 'TRANSACTION_FAILED',
])

function parseErrorEnvelope(value: unknown): UndoError {
  assert(isPlainObject(value), 'Undo error must be an object')
  assert(hasExactKeys(value, ['error', 'code'], ['details']), 'Undo error shape is invalid')
  assert(boundedString(value.error, MAX_ERROR_LENGTH), 'Undo error message is invalid')
  assert(typeof value.code === 'string' && SERVER_ERROR_CODES.has(value.code as UndoServerErrorCode), 'Undo error code is invalid')
  const details: Record<string, string | number | null> = {}
  if (value.details !== undefined) {
    assert(isPlainObject(value.details), 'Undo error details are invalid')
    const entries = Object.entries(value.details)
    assert(entries.length <= MAX_ERROR_DETAIL_KEYS, 'Undo error details are too large')
    for (const [key, item] of entries) {
      assert(boundedString(key, 128), 'Undo error detail key is invalid')
      assert(item === null || boundedString(item, MAX_ERROR_LENGTH)
        || (typeof item === 'number' && Number.isSafeInteger(item)), 'Undo error detail value is invalid')
      details[key] = item
    }
  }
  return {
    error: value.error,
    code: value.code as UndoServerErrorCode,
    details,
  }
}

function isSharedJsonError(value: unknown): value is { status: number; body: unknown } {
  return isPlainObject(value)
    && typeof value.status === 'number'
    && Object.hasOwn(value, 'body')
}

function withRecoveryAnchor(error: unknown, recordId: string): TagUndoApiError {
  if (error instanceof TagUndoApiError) {
    if (error.recoveryRecordId === recordId) return error
    return new TagUndoApiError(error.message, error.status, error.code, error.details, recordId)
  }
  return new TagUndoApiError(
    'Undo response or transport could not be validated.',
    0,
    'CLIENT_PROTOCOL_ERROR',
    {},
    recordId,
  )
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  guard: (value: unknown) => T,
  recoveryRecordId: string | null = null,
): Promise<T> {
  try {
    const value = await jsonOrThrow<unknown>(await authFetch(path, init))
    return guard(value)
  } catch (error) {
    if (error instanceof TagUndoApiError) {
      if (recoveryRecordId !== null) throw withRecoveryAnchor(error, recoveryRecordId)
      throw error
    }
    if (isSharedJsonError(error)) {
      const isUndoPath = path.startsWith('/api/tags/undo')
      if (error.status === 404 && isUndoPath) {
        throw new TagUndoApiError('Undo is unavailable on this server.', 404, 'UNDO_UNAVAILABLE', {}, recoveryRecordId)
      }
      if (error.status === 503 && isUndoPath) {
        let envelope: UndoError | null = null
        try {
          envelope = parseErrorEnvelope(error.body)
        } catch { /* legacy/non-Undo 503 */ }
        if (envelope) {
          throw new TagUndoApiError(envelope.error, error.status, envelope.code, envelope.details, recoveryRecordId)
        }
        throw new TagUndoApiError('Undo is unavailable on this server.', 503, 'UNDO_UNAVAILABLE', {}, recoveryRecordId)
      }
      try {
        const envelope = parseErrorEnvelope(error.body)
        throw new TagUndoApiError(envelope.error, error.status, envelope.code, envelope.details, recoveryRecordId)
      } catch (nested) {
        if (nested instanceof TagUndoApiError) throw nested
        throw protocolError('error envelope is invalid', error.status, recoveryRecordId)
      }
    }
    throw new TagUndoApiError(
      'Undo request could not be completed or validated.',
      0,
      'CLIENT_PROTOCOL_ERROR',
      {},
      recoveryRecordId,
    )
  }
}

function validateRecordId(value: unknown, field = 'recordId'): string {
  if (!boundedString(value, MAX_RECORD_ID_LENGTH)) throw protocolError(`${field} is invalid`)
  return value
}

function validateFingerprint(value: unknown, field = 'undoFingerprint'): string {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) throw protocolError(`${field} is invalid`)
  return value
}

function validateLimit(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw protocolError(`limit must be an integer from 1 to ${max}`)
  }
  return value
}

function requestHeaders(): HeadersInit {
  return { 'content-type': 'application/json' }
}

function previewRequest(value: string | { recordId: string; limit?: number }, limit?: number): { recordId: string; limit?: number } {
  if (typeof value === 'string') {
    const recordId = validateRecordId(value)
    if (limit === undefined) return { recordId }
    return { recordId, limit: validateLimit(limit, UNDO_PREVIEW_SAMPLE_LIMIT) }
  }
  if (!isPlainObject(value) || !hasExactKeys(value, ['recordId'], ['limit'])) throw protocolError('Preview request shape is invalid')
  const recordId = validateRecordId(value.recordId)
  const requestedLimit = value.limit === undefined ? undefined : validateLimit(value.limit, UNDO_PREVIEW_SAMPLE_LIMIT)
  return { recordId, ...(requestedLimit === undefined ? {} : { limit: requestedLimit }) }
}

function pageRequest(
  value: UndoPreviewPageRequest | string,
  fingerprint?: string,
  afterDocumentId?: string | null,
  limit?: number,
): UndoPreviewPageRequest {
  if (typeof value === 'string') {
    const recordId = validateRecordId(value)
    const undoFingerprint = validateFingerprint(fingerprint)
    if (afterDocumentId !== undefined && afterDocumentId !== null
      && !boundedString(afterDocumentId, MAX_DOCUMENT_FIELD_LENGTH)) throw protocolError('afterDocumentId is invalid')
    const requestedLimit = limit === undefined ? undefined : validateLimit(limit, UNDO_PREVIEW_PAGE_MAX_LIMIT)
    return {
      recordId,
      undoFingerprint,
      ...(afterDocumentId === undefined ? {} : { afterDocumentId }),
      ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
    }
  }
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['recordId', 'undoFingerprint'], ['afterDocumentId', 'limit'])) {
    throw protocolError('Preview page request shape is invalid')
  }
  const recordId = validateRecordId(value.recordId)
  const undoFingerprint = validateFingerprint(value.undoFingerprint)
  if (value.afterDocumentId !== undefined && value.afterDocumentId !== null
    && !boundedString(value.afterDocumentId, MAX_DOCUMENT_FIELD_LENGTH)) throw protocolError('afterDocumentId is invalid')
  const requestedLimit = value.limit === undefined ? undefined : validateLimit(value.limit, UNDO_PREVIEW_PAGE_MAX_LIMIT)
  return {
    recordId,
    undoFingerprint,
    ...(value.afterDocumentId === undefined ? {} : { afterDocumentId: value.afterDocumentId }),
    ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
  }
}

function parseApplyRequest(value: unknown): UndoApplyRequest {
  if (!isPlainObject(value) || !hasExactKeys(value, ['recordId', 'undoFingerprint'])) {
    throw protocolError('Apply request shape is invalid')
  }
  return {
    recordId: validateRecordId(value.recordId),
    undoFingerprint: validateFingerprint(value.undoFingerprint),
  }
}

function assertReviewedPreviewReady(preview: UndoPreview): void {
  assert(preview.state === 'available' && preview.validation === 'safe' && preview.allowedToApply, 'Undo Preview is not apply-ready')
  assert(preview.recordId !== null && preview.undoFingerprint !== null, 'Undo Preview identity is missing')
}

function assertTagRowEqual(left: TagRowView | null, right: TagRowView | null, field: string): void {
  assert(left !== null && right !== null, `${field} is missing`)
  assert(left.id === right.id, `${field}.id changed`)
  assert(left.normalizedName === right.normalizedName, `${field}.normalizedName changed`)
  assert(left.displayName === right.displayName, `${field}.displayName changed`)
}

/** Bind a committed response to the exact server Preview reviewed by the client. */
export function assertUndoApplyMatchesReviewedPreview(
  result: UndoApplyResult,
  preview: UndoPreview,
): void {
  assertReviewedPreviewReady(preview)
  assert(result.undoRecordId === preview.recordId, 'Undo Apply record identity changed')
  assert(result.appliedUndoFingerprint === preview.undoFingerprint, 'Undo Apply fingerprint changed')
  assert(result.originalOperationId === preview.originalOperationId, 'Undo Apply original operation identity changed')
  assert(result.originalResultId === preview.originalResultId, 'Undo Apply original result identity changed')
  assert(result.kind === preview.kind, 'Undo Apply kind changed')
  assert(result.displayOnly === preview.displayOnly, 'Undo Apply displayOnly changed')
  assert(result.affectedCount === preview.affectedCount, 'Undo Apply affected count changed')
  assert(result.associationAdds === preview.associationAdds, 'Undo Apply association add count changed')
  assert(result.associationRemoves === preview.associationRemoves, 'Undo Apply association remove count changed')
  assert(result.versionUpdateCount === preview.versionUpdateCount, 'Undo Apply version count changed')
  assert(result.lifecycle === 'consumed', 'Undo Apply lifecycle is not consumed')
  assertTagRowEqual(result.sourceTag, preview.sourceBefore, 'Undo Apply sourceTag')
  if (preview.kind === 'merge') {
    assertTagRowEqual(result.destinationTag, preview.destinationAfter, 'Undo Apply destinationTag')
  } else {
    assert(result.destinationTag === null, 'Undo Apply has an unexpected destinationTag')
  }
}

export async function getUndoAvailability(recordId?: string): Promise<UndoAvailability> {
  const query = recordId === undefined
    ? ''
    : `?recordId=${encodeURIComponent(validateRecordId(recordId))}`
  return requestJson(`/api/tags/undo${query}`, {}, parseAvailability)
}

export async function recoverCommittedUndo(recordId: string): Promise<UndoAvailability> {
  return getUndoAvailability(validateRecordId(recordId))
}

export async function previewUndo(
  value: string | { recordId: string; limit?: number },
  limit?: number,
): Promise<UndoPreview> {
  const request = previewRequest(value, limit)
  return requestJson('/api/tags/undo/preview', {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify(request),
  }, (response) => {
    const preview = parsePreview(response, UNDO_PREVIEW_SAMPLE_LIMIT)
    assert(preview.recordId === request.recordId, 'Preview record identity changed')
    return preview
  })
}

export async function getUndoPreviewPage(
  value: UndoPreviewPageRequest | string,
  fingerprint?: string,
  afterDocumentId?: string | null,
  limit?: number,
): Promise<UndoPreview> {
  const request = pageRequest(value, fingerprint, afterDocumentId, limit)
  return requestJson('/api/tags/undo/preview/page', {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify(request),
  }, (response) => {
    const page = parsePreview(response, UNDO_PREVIEW_PAGE_MAX_LIMIT)
    assert(page.state === 'available', 'page state is invalid')
    assert(page.recordId === request.recordId, 'page record identity changed')
    assert(page.undoFingerprint === request.undoFingerprint, 'page fingerprint changed')
    return page
  })
}

export function applyUndo(reviewedPreview: UndoPreview): Promise<UndoApplyResult>
export function applyUndo(request: UndoApplyRequest, reviewedPreview: UndoPreview): Promise<UndoApplyResult>
export async function applyUndo(
  value: UndoApplyRequest | UndoPreview,
  reviewedPreview?: UndoPreview,
): Promise<UndoApplyResult> {
  const preview = reviewedPreview ?? value as UndoPreview
  assertReviewedPreviewReady(preview)
  const request = reviewedPreview === undefined
    ? {
        recordId: validateRecordId(preview.recordId),
        undoFingerprint: validateFingerprint(preview.undoFingerprint),
      }
    : parseApplyRequest(value)
  assert(request.recordId === preview.recordId, 'Apply record identity does not match reviewed Preview')
  assert(request.undoFingerprint === preview.undoFingerprint, 'Apply fingerprint does not match reviewed Preview')

  try {
    const result = await requestJson('/api/tags/undo/apply', {
      method: 'POST',
      headers: requestHeaders(),
      body: JSON.stringify(request),
    }, parseApplyResult, request.recordId)
    try {
      assertUndoApplyMatchesReviewedPreview(result, preview)
    } catch (error) {
      throw withRecoveryAnchor(error, request.recordId)
    }
    return result
  } catch (error) {
    throw withRecoveryAnchor(error, request.recordId)
  }
}
