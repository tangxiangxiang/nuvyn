import { authFetch } from './auth-session'
import { jsonOrThrow } from './api'

const MAX_TAG_NAME_LENGTH = 100
const MAX_OPERATION_STRING_LENGTH = 2048
const MAX_DOCUMENT_FIELD_LENGTH = 4096
const MAX_ERROR_LENGTH = 2048
const INITIAL_SAMPLE_LIMIT = 20
const PAGE_SAMPLE_LIMIT = 100
const PLAN_FINGERPRINT = /^[0-9a-f]{64}$/

export type TagOperationRequest =
  | {
      kind: 'rename'
      sourceTagId: number
      destinationName: string
    }
  | {
      kind: 'merge'
      sourceTagId: number
      destinationTagId: number
    }
  | {
      kind: 'remove'
      sourceTagId: number
    }

export type TagOperationKind = TagOperationRequest['kind']

export interface ManagedTag {
  id: number
  normalizedName: string
  displayName: string
  documentCount: number
}

export interface TagRowView {
  id: number
  normalizedName: string
  displayName: string
}

export interface PreviewDocument {
  id: string
  path: string
  title: string
}

export type TagWarningCode = 'DESTRUCTIVE' | 'HIGH_IMPACT'

export type TagPlanConflictCode =
  | 'INVALID_OPERATION'
  | 'SOURCE_DESTINATION_SAME'
  | 'DESTINATION_EXISTS'

export type TagManagementErrorCode =
  | 'INVALID_TAG_NAME'
  | 'INVALID_OPERATION'
  | 'TAG_NOT_FOUND'
  | 'SOURCE_DESTINATION_SAME'
  | 'DESTINATION_EXISTS'
  | 'TAG_IDENTITY_CONFLICT'
  | 'TAG_MANAGEMENT_UNAVAILABLE'
  | 'PREVIEW_REQUIRED'
  | 'PREVIEW_STALE'
  | 'METADATA_VERSION_CONFLICT'
  | 'TRANSACTION_FAILED'

export type TagManagementClientErrorCode = TagManagementErrorCode | 'CLIENT_PROTOCOL_ERROR'

export interface TagManagementErrorEnvelope {
  error: string
  code: TagManagementErrorCode
  details: Record<string, string | number | null>
}

export class TagManagementApiError extends Error {
  readonly status: number
  readonly code: TagManagementClientErrorCode
  readonly details: Record<string, string | number | null>

  constructor(
    message: string,
    status: number,
    code: TagManagementClientErrorCode,
    details: Record<string, string | number | null> = {},
  ) {
    super(message)
    this.name = 'TagManagementApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface TagOperationPreview {
  operation: TagOperationRequest
  sourceTag: TagRowView
  destinationTag: TagRowView | null
  requestedDestination: { displayName: string; normalizedName: string } | null
  survivorTag: TagRowView | null
  displayOnly: boolean
  affectedCount: number
  associationAdds: number
  associationRemoves: number
  duplicateCollapses: number
  tagCreates: number
  tagDeletes: number
  warnings: TagWarningCode[]
  allowedToApply: boolean
  conflictCode?: TagPlanConflictCode
  conflictMessage?: string
  planFingerprint: string
  healthContractVersion: 'tag-identity-v1'
  sample: PreviewDocument[]
  nextAfterDocumentId: string | null
}

export interface TagOperationApplyResult {
  operationId: string
  resultId: string
  kind: TagOperationKind
  operation: TagOperationRequest
  sourceTagId: number
  destinationTagId: number | null
  survivorTagId: number | null
  sourceTag: TagRowView | null
  destinationTag: TagRowView | null
  survivorTag: TagRowView | null
  sourceDisplayName: string | null
  sourceNormalizedName: string | null
  destinationDisplayName: string | null
  destinationNormalizedName: string | null
  survivorDisplayName: string | null
  survivorNormalizedName: string | null
  sourceDeleted: boolean
  affectedCount: number
  associationAdds: number
  associationRemoves: number
  duplicateCollapses: number
  tagCreates: number
  tagDeletes: number
  displayOnly: boolean
  versionUpdateCount: number
  commitTimestamp: number
  appliedFingerprint: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key))
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function requiredPositiveInteger(value: unknown, field: string): number {
  assert(isPositiveSafeInteger(value), `${field} is invalid`)
  return value
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  assert(isNonNegativeSafeInteger(value), `${field} is invalid`)
  return value
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
}

function protocolError(message: string): TagManagementApiError {
  return new TagManagementApiError(
    'Tag management returned an invalid response.',
    200,
    'CLIENT_PROTOCOL_ERROR',
    { reason: message.slice(0, 256) },
  )
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw protocolError(message)
}

function parseTagRow(value: unknown, field: string): TagRowView {
  assert(isPlainObject(value), `${field} must be an object`)
  assert(hasExactKeys(value, ['id', 'normalizedName', 'displayName']), `${field} shape is invalid`)
  assert(isPositiveSafeInteger(value.id), `${field}.id is invalid`)
  assert(boundedString(value.normalizedName, MAX_TAG_NAME_LENGTH), `${field}.normalizedName is invalid`)
  assert(boundedString(value.displayName, MAX_TAG_NAME_LENGTH), `${field}.displayName is invalid`)
  return {
    id: value.id,
    normalizedName: value.normalizedName,
    displayName: value.displayName,
  }
}

function parseManagedTag(value: unknown, index: number): ManagedTag {
  assert(isPlainObject(value), `managed tag ${index} must be an object`)
  assert(hasExactKeys(value, ['id', 'normalizedName', 'displayName', 'documentCount']), `managed tag ${index} shape is invalid`)
  const tag = parseTagRow({
    id: value.id,
    normalizedName: value.normalizedName,
    displayName: value.displayName,
  }, `managed tag ${index}`)
  assert(isNonNegativeSafeInteger(value.documentCount), `managed tag ${index}.documentCount is invalid`)
  return { ...tag, documentCount: value.documentCount }
}

function parseOperation(value: unknown, field = 'operation'): TagOperationRequest {
  assert(isPlainObject(value), `${field} must be an object`)
  assert(typeof value.kind === 'string', `${field}.kind is invalid`)
  if (value.kind === 'rename') {
    assert(hasExactKeys(value, ['kind', 'sourceTagId', 'destinationName']), `${field} shape is invalid`)
    assert(isPositiveSafeInteger(value.sourceTagId), `${field}.sourceTagId is invalid`)
    assert(boundedString(value.destinationName, MAX_OPERATION_STRING_LENGTH), `${field}.destinationName is invalid`)
    return {
      kind: 'rename',
      sourceTagId: value.sourceTagId,
      destinationName: value.destinationName,
    }
  }
  if (value.kind === 'merge') {
    assert(hasExactKeys(value, ['kind', 'sourceTagId', 'destinationTagId']), `${field} shape is invalid`)
    assert(isPositiveSafeInteger(value.sourceTagId), `${field}.sourceTagId is invalid`)
    assert(isPositiveSafeInteger(value.destinationTagId), `${field}.destinationTagId is invalid`)
    assert(value.sourceTagId !== value.destinationTagId, `${field} source and destination must differ`)
    return {
      kind: 'merge',
      sourceTagId: value.sourceTagId,
      destinationTagId: value.destinationTagId,
    }
  }
  if (value.kind === 'remove') {
    assert(hasExactKeys(value, ['kind', 'sourceTagId']), `${field} shape is invalid`)
    assert(isPositiveSafeInteger(value.sourceTagId), `${field}.sourceTagId is invalid`)
    return { kind: 'remove', sourceTagId: value.sourceTagId }
  }
  throw protocolError(`${field}.kind is unknown`)
}

function parseRequestedDestination(value: unknown): { displayName: string; normalizedName: string } | null {
  if (value === null) return null
  assert(isPlainObject(value), 'requestedDestination is invalid')
  assert(hasExactKeys(value, ['displayName', 'normalizedName']), 'requestedDestination shape is invalid')
  assert(boundedString(value.displayName, MAX_TAG_NAME_LENGTH), 'requestedDestination.displayName is invalid')
  assert(boundedString(value.normalizedName, MAX_TAG_NAME_LENGTH), 'requestedDestination.normalizedName is invalid')
  return { displayName: value.displayName, normalizedName: value.normalizedName }
}

function parseDocument(value: unknown, index: number): PreviewDocument {
  assert(isPlainObject(value), `preview sample ${index} must be an object`)
  assert(hasExactKeys(value, ['id', 'path', 'title']), `preview sample ${index} shape is invalid`)
  assert(boundedString(value.id, MAX_DOCUMENT_FIELD_LENGTH), `preview sample ${index}.id is invalid`)
  assert(boundedString(value.path, MAX_DOCUMENT_FIELD_LENGTH), `preview sample ${index}.path is invalid`)
  assert(boundedString(value.title, MAX_DOCUMENT_FIELD_LENGTH, true), `preview sample ${index}.title is invalid`)
  return { id: value.id, path: value.path, title: value.title }
}

function parseWarnings(value: unknown): TagWarningCode[] {
  assert(Array.isArray(value), 'warnings must be an array')
  const warnings: TagWarningCode[] = []
  for (const warning of value) {
    assert(warning === 'DESTRUCTIVE' || warning === 'HIGH_IMPACT', 'warning code is unknown')
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  return warnings
}

function parsePreview(value: unknown, maxSample: number): TagOperationPreview {
  assert(isPlainObject(value), 'preview must be an object')
  assert(hasExactKeys(value, [
    'operation', 'sourceTag', 'destinationTag', 'requestedDestination', 'survivorTag',
    'displayOnly', 'affectedCount', 'sample', 'associationAdds', 'associationRemoves',
    'duplicateCollapses', 'tagCreates', 'tagDeletes', 'warnings', 'allowedToApply',
    'planFingerprint', 'healthContractVersion', 'nextAfterDocumentId',
  ], ['conflictCode', 'conflictMessage']), 'preview shape is invalid')
  const operation = parseOperation(value.operation)
  const sourceTag = parseTagRow(value.sourceTag, 'sourceTag')
  const destinationTag = value.destinationTag === null ? null : parseTagRow(value.destinationTag, 'destinationTag')
  const requestedDestination = parseRequestedDestination(value.requestedDestination)
  const survivorTag = value.survivorTag === null ? null : parseTagRow(value.survivorTag, 'survivorTag')
  assert(typeof value.displayOnly === 'boolean', 'displayOnly is invalid')
  const affectedCount = requiredNonNegativeInteger(value.affectedCount, 'affectedCount')
  const associationAdds = requiredNonNegativeInteger(value.associationAdds, 'associationAdds')
  const associationRemoves = requiredNonNegativeInteger(value.associationRemoves, 'associationRemoves')
  const duplicateCollapses = requiredNonNegativeInteger(value.duplicateCollapses, 'duplicateCollapses')
  const tagCreates = requiredNonNegativeInteger(value.tagCreates, 'tagCreates')
  const tagDeletes = requiredNonNegativeInteger(value.tagDeletes, 'tagDeletes')
  assert(Array.isArray(value.sample), 'sample must be an array')
  assert(value.sample.length <= maxSample, 'sample exceeds the approved bound')
  const sample = value.sample.map((entry, index) => parseDocument(entry, index))
  const warnings = parseWarnings(value.warnings)
  assert(typeof value.allowedToApply === 'boolean', 'allowedToApply is invalid')
  assert(typeof value.planFingerprint === 'string' && PLAN_FINGERPRINT.test(value.planFingerprint), 'planFingerprint is invalid')
  assert(value.healthContractVersion === 'tag-identity-v1', 'healthContractVersion is invalid')
  assert(value.nextAfterDocumentId === null || boundedString(value.nextAfterDocumentId, MAX_DOCUMENT_FIELD_LENGTH), 'nextAfterDocumentId is invalid')
  if (value.conflictCode !== undefined) {
    assert(value.conflictCode === 'INVALID_OPERATION'
      || value.conflictCode === 'SOURCE_DESTINATION_SAME'
      || value.conflictCode === 'DESTINATION_EXISTS', 'conflictCode is unknown')
  }
  if (value.conflictMessage !== undefined) {
    assert(boundedString(value.conflictMessage, MAX_ERROR_LENGTH), 'conflictMessage is invalid')
  }
  if (operation.kind === 'rename') {
    assert(requestedDestination !== null, 'rename requestedDestination is required')
  } else {
    assert(requestedDestination === null, 'non-rename requestedDestination must be null')
  }
  return {
    operation,
    sourceTag,
    destinationTag,
    requestedDestination,
    survivorTag,
    displayOnly: value.displayOnly,
    affectedCount,
    associationAdds,
    associationRemoves,
    duplicateCollapses,
    tagCreates,
    tagDeletes,
    warnings,
    allowedToApply: value.allowedToApply,
    ...(value.conflictCode === undefined ? {} : { conflictCode: value.conflictCode }),
    ...(value.conflictMessage === undefined ? {} : { conflictMessage: value.conflictMessage }),
    planFingerprint: value.planFingerprint,
    healthContractVersion: value.healthContractVersion,
    sample,
    nextAfterDocumentId: value.nextAfterDocumentId,
  }
}

function assertPreviewSemantics(preview: TagOperationPreview, operation: TagOperationRequest): void {
  assert(operationsEqual(preview.operation, operation), 'preview operation does not match request')
  assert(preview.sourceTag.id === operation.sourceTagId, 'preview source identity does not match request')

  if (operation.kind === 'merge') {
    assert(preview.destinationTag !== null, 'merge preview destination is required')
    assert(preview.destinationTag.id === operation.destinationTagId, 'merge preview destination identity does not match request')
    assert(preview.survivorTag !== null, 'merge preview survivor is required')
    assert(preview.survivorTag.id === operation.destinationTagId, 'merge preview survivor identity does not match request')
    assert(preview.displayOnly === false, 'merge preview cannot be display-only')
    assert(preview.requestedDestination === null, 'merge preview cannot have a requested display name')
    if (preview.allowedToApply) {
      assert(preview.tagCreates === 0, 'merge preview tagCreates must be zero')
      assert(preview.tagDeletes === 1, 'merge preview must delete one tag')
    }
    return
  }

  if (operation.kind === 'rename') {
    assert(preview.survivorTag !== null, 'rename preview survivor is required')
    assert(preview.survivorTag.id === operation.sourceTagId, 'rename preview survivor identity does not match request')
  }
}

function parseNullableTag(value: unknown, field: string): TagRowView | null {
  return value === null ? null : parseTagRow(value, field)
}

function parseNullableBoundedString(value: unknown, field: string): string | null {
  assert(value === null || boundedString(value, MAX_TAG_NAME_LENGTH), `${field} is invalid`)
  return value
}

function assertRowFieldContract(
  row: TagRowView | null,
  id: number | null,
  displayName: string | null,
  normalizedName: string | null,
  field: string,
): void {
  if (id === null) {
    assert(row === null, `${field} must be null when its identity is null`)
    assert(displayName === null, `${field} display name must be null without a row`)
    assert(normalizedName === null, `${field} normalized name must be null without a row`)
    return
  }
  assert(row !== null, `${field} is required for its identity`)
  assert(row.id === id, `${field}.id does not match its identity`)
  assert(displayName === row.displayName, `${field} display name does not match its row`)
  assert(normalizedName === row.normalizedName, `${field} normalized name does not match its row`)
}

function assertSameTagRow(left: TagRowView | null, right: TagRowView | null, field: string): void {
  assert(left !== null && right !== null, `${field} rows are required`)
  assert(left.id === right.id, `${field} IDs do not agree`)
  assert(left.displayName === right.displayName, `${field} display names do not agree`)
  assert(left.normalizedName === right.normalizedName, `${field} normalized names do not agree`)
}

/**
 * The server result is consumed by stable-ID reconciliation. Shape checks are
 * not enough here: a response can be structurally valid while pointing the
 * selection at a different row. Keep these checks aligned with
 * server/tagManagement.ts's buildApplyResult contract.
 */
function assertApplyResultSemantics(result: TagOperationApplyResult): void {
  assert(result.sourceTagId === result.operation.sourceTagId, 'sourceTagId does not match operation')
  if (result.sourceTag !== null) {
    assert(result.sourceTag.id === result.sourceTagId, 'sourceTag.id does not match sourceTagId')
  }
  assertRowFieldContract(
    result.sourceTag,
    result.sourceTag?.id ?? null,
    result.sourceDisplayName,
    result.sourceNormalizedName,
    'sourceTag',
  )
  assertRowFieldContract(
    result.destinationTag,
    result.destinationTagId,
    result.destinationDisplayName,
    result.destinationNormalizedName,
    'destinationTag',
  )
  assertRowFieldContract(
    result.survivorTag,
    result.survivorTagId,
    result.survivorDisplayName,
    result.survivorNormalizedName,
    'survivorTag',
  )

  assert(result.tagCreates === 0, 'tagCreates must be zero for MVP operations')

  if (result.operation.kind === 'rename') {
    assert(result.destinationTagId === null, 'rename destinationTagId must be null')
    assert(result.destinationTag === null, 'rename destinationTag must be null')
    assert(result.survivorTagId === result.sourceTagId, 'rename survivorTagId must preserve source identity')
    assert(result.sourceTag !== null, 'rename sourceTag is required')
    assert(result.survivorTag !== null, 'rename survivorTag is required')
    assertSameTagRow(result.sourceTag, result.survivorTag, 'rename source/survivor')
    assert(result.sourceDeleted === false, 'rename sourceDeleted must be false')
    assert(result.tagDeletes === 0, 'rename tagDeletes must be zero')
    assert(result.associationAdds === 0, 'rename associationAdds must be zero')
    assert(result.associationRemoves === 0, 'rename associationRemoves must be zero')
    assert(result.duplicateCollapses === 0, 'rename duplicateCollapses must be zero')
    return
  }

  if (result.operation.kind === 'merge') {
    assert(result.operation.sourceTagId !== result.operation.destinationTagId, 'merge source and destination must differ')
    assert(result.destinationTagId === result.operation.destinationTagId, 'merge destinationTagId does not match operation')
    assert(result.destinationTag !== null, 'merge destinationTag is required')
    assert(result.survivorTagId === result.operation.destinationTagId, 'merge survivorTagId must preserve destination identity')
    assert(result.survivorTag !== null, 'merge survivorTag is required')
    assertSameTagRow(result.destinationTag, result.survivorTag, 'merge destination/survivor')
    assert(result.sourceTag === null, 'merge sourceTag must be null after deletion')
    assert(result.sourceDeleted === true, 'merge sourceDeleted must be true')
    assert(result.displayOnly === false, 'merge displayOnly must be false')
    assert(result.tagDeletes === 1, 'merge must delete exactly one tag row')
    return
  }

  assert(result.destinationTagId === null, 'remove destinationTagId must be null')
  assert(result.destinationTag === null, 'remove destinationTag must be null')
  assert(result.survivorTagId === null, 'remove survivorTagId must be null')
  assert(result.survivorTag === null, 'remove survivorTag must be null')
  assert(result.sourceTag === null, 'remove sourceTag must be null after deletion')
  assert(result.sourceDeleted === true, 'remove sourceDeleted must be true')
  assert(result.displayOnly === false, 'remove displayOnly must be false')
  assert(result.tagDeletes === 1, 'remove must delete exactly one tag row')
}

function operationsEqual(left: TagOperationRequest, right: TagOperationRequest): boolean {
  if (left.kind !== right.kind || left.sourceTagId !== right.sourceTagId) return false
  if (left.kind === 'rename' && right.kind === 'rename') return left.destinationName === right.destinationName
  if (left.kind === 'merge' && right.kind === 'merge') return left.destinationTagId === right.destinationTagId
  return left.kind === 'remove' && right.kind === 'remove'
}

/**
 * Bind a successful Apply response to the exact Preview the user reviewed.
 * This is intentionally a client-only protocol check: the Preview is never
 * sent back to the server and no mutable Apply fields are compared here.
 */
export function assertApplyResultMatchesReviewedPreview(
  result: TagOperationApplyResult,
  preview: TagOperationPreview,
): void {
  assert(operationsEqual(result.operation, preview.operation), 'apply operation does not match reviewed Preview')
  assert(result.appliedFingerprint === preview.planFingerprint, 'apply fingerprint does not match reviewed Preview')

  if (preview.operation.kind !== 'merge') return

  assert(preview.destinationTag !== null, 'reviewed merge destination is required')
  assert(preview.survivorTag !== null, 'reviewed merge survivor is required')
  assert(preview.destinationTag.id === preview.operation.destinationTagId, 'reviewed merge destination identity does not match operation')
  assert(preview.survivorTag.id === preview.operation.destinationTagId, 'reviewed merge survivor identity does not match operation')

  assert(result.kind === 'merge', 'merge apply result kind is invalid')
  assert(result.destinationTagId === preview.destinationTag.id, 'merge apply destination identity changed from reviewed Preview')
  assert(result.survivorTagId === preview.destinationTag.id, 'merge apply survivor identity changed from reviewed Preview')
  assert(result.destinationTag !== null, 'merge apply destination is required')
  assert(result.survivorTag !== null, 'merge apply survivor is required')
  assertSameTagRow(result.destinationTag, preview.destinationTag, 'merge apply/reviewed destination')
  assertSameTagRow(result.survivorTag, preview.destinationTag, 'merge apply survivor/reviewed destination')
  assertSameTagRow(result.survivorTag, preview.survivorTag, 'merge apply/reviewed survivor')
}

function parseApplyResult(value: unknown): TagOperationApplyResult {
  assert(isPlainObject(value), 'apply result must be an object')
  assert(hasExactKeys(value, [
    'operationId', 'resultId', 'kind', 'operation', 'sourceTagId', 'destinationTagId',
    'survivorTagId', 'sourceTag', 'destinationTag', 'survivorTag', 'sourceDisplayName',
    'sourceNormalizedName', 'destinationDisplayName', 'destinationNormalizedName',
    'survivorDisplayName', 'survivorNormalizedName', 'sourceDeleted', 'affectedCount',
    'associationAdds', 'associationRemoves', 'duplicateCollapses', 'tagCreates',
    'tagDeletes', 'displayOnly', 'versionUpdateCount', 'commitTimestamp', 'appliedFingerprint',
  ]), 'apply result shape is invalid')
  assert(boundedString(value.operationId, MAX_OPERATION_STRING_LENGTH), 'operationId is invalid')
  assert(boundedString(value.resultId, MAX_OPERATION_STRING_LENGTH), 'resultId is invalid')
  const operation = parseOperation(value.operation)
  assert(value.kind === operation.kind, 'apply result kind is invalid')
  const kind = value.kind as TagOperationKind
  const sourceTagId = requiredPositiveInteger(value.sourceTagId, 'sourceTagId')
  assert(value.destinationTagId === null || isPositiveSafeInteger(value.destinationTagId), 'destinationTagId is invalid')
  assert(value.survivorTagId === null || isPositiveSafeInteger(value.survivorTagId), 'survivorTagId is invalid')
  const destinationTagId = value.destinationTagId as number | null
  const survivorTagId = value.survivorTagId as number | null
  const sourceTag = parseNullableTag(value.sourceTag, 'sourceTag')
  const destinationTag = parseNullableTag(value.destinationTag, 'destinationTag')
  const survivorTag = parseNullableTag(value.survivorTag, 'survivorTag')
  const sourceDisplayName = parseNullableBoundedString(value.sourceDisplayName, 'sourceDisplayName')
  const sourceNormalizedName = parseNullableBoundedString(value.sourceNormalizedName, 'sourceNormalizedName')
  const destinationDisplayName = parseNullableBoundedString(value.destinationDisplayName, 'destinationDisplayName')
  const destinationNormalizedName = parseNullableBoundedString(value.destinationNormalizedName, 'destinationNormalizedName')
  const survivorDisplayName = parseNullableBoundedString(value.survivorDisplayName, 'survivorDisplayName')
  const survivorNormalizedName = parseNullableBoundedString(value.survivorNormalizedName, 'survivorNormalizedName')
  assert(typeof value.sourceDeleted === 'boolean', 'sourceDeleted is invalid')
  const affectedCount = requiredNonNegativeInteger(value.affectedCount, 'affectedCount')
  const associationAdds = requiredNonNegativeInteger(value.associationAdds, 'associationAdds')
  const associationRemoves = requiredNonNegativeInteger(value.associationRemoves, 'associationRemoves')
  const duplicateCollapses = requiredNonNegativeInteger(value.duplicateCollapses, 'duplicateCollapses')
  const tagCreates = requiredNonNegativeInteger(value.tagCreates, 'tagCreates')
  const tagDeletes = requiredNonNegativeInteger(value.tagDeletes, 'tagDeletes')
  const versionUpdateCount = requiredNonNegativeInteger(value.versionUpdateCount, 'versionUpdateCount')
  const commitTimestamp = requiredNonNegativeInteger(value.commitTimestamp, 'commitTimestamp')
  assert(typeof value.displayOnly === 'boolean', 'displayOnly is invalid')
  assert(typeof value.appliedFingerprint === 'string' && PLAN_FINGERPRINT.test(value.appliedFingerprint), 'appliedFingerprint is invalid')
  const result: TagOperationApplyResult = {
    operationId: value.operationId,
    resultId: value.resultId,
    kind,
    operation,
    sourceTagId,
    destinationTagId,
    survivorTagId,
    sourceTag,
    destinationTag,
    survivorTag,
    sourceDisplayName,
    sourceNormalizedName,
    destinationDisplayName,
    destinationNormalizedName,
    survivorDisplayName,
    survivorNormalizedName,
    sourceDeleted: value.sourceDeleted,
    affectedCount,
    associationAdds,
    associationRemoves,
    duplicateCollapses,
    tagCreates,
    tagDeletes,
    displayOnly: value.displayOnly,
    versionUpdateCount,
    commitTimestamp,
    appliedFingerprint: value.appliedFingerprint,
  }
  assertApplyResultSemantics(result)
  return result
}

const ERROR_CODES = new Set<TagManagementErrorCode>([
  'INVALID_TAG_NAME', 'INVALID_OPERATION', 'TAG_NOT_FOUND', 'SOURCE_DESTINATION_SAME',
  'DESTINATION_EXISTS', 'TAG_IDENTITY_CONFLICT', 'TAG_MANAGEMENT_UNAVAILABLE',
  'PREVIEW_REQUIRED', 'PREVIEW_STALE', 'METADATA_VERSION_CONFLICT', 'TRANSACTION_FAILED',
])

function parseErrorEnvelope(value: unknown): TagManagementErrorEnvelope {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['error', 'code'], ['details'])
    || !boundedString(value.error, MAX_ERROR_LENGTH)
    || typeof value.code !== 'string'
    || !ERROR_CODES.has(value.code as TagManagementErrorCode)) {
    throw protocolError('error envelope is invalid')
  }
  const details: Record<string, string | number | null> = {}
  if (value.details !== undefined) {
    if (!isPlainObject(value.details)) throw protocolError('error details are invalid')
    for (const [key, item] of Object.entries(value.details)) {
      if (!boundedString(key, 128) || !(item === null || typeof item === 'string' || (typeof item === 'number' && Number.isSafeInteger(item)))) {
        throw protocolError('error details are invalid')
      }
      if (typeof item === 'string' && item.length > MAX_ERROR_LENGTH) throw protocolError('error details are invalid')
      details[key] = item
    }
  }
  return { error: value.error, code: value.code as TagManagementErrorCode, details }
}

function isSharedJsonError(value: unknown): value is { status: number; body: unknown } {
  return isPlainObject(value)
    && typeof value.status === 'number'
    && Object.hasOwn(value, 'body')
}

async function request<T>(
  path: string,
  init: RequestInit,
  guard: (value: unknown) => T,
): Promise<T> {
  try {
    const value = await jsonOrThrow<unknown>(await authFetch(path, init))
    return guard(value)
  } catch (error) {
    if (error instanceof TagManagementApiError) throw error
    if (isSharedJsonError(error)) {
      try {
        const envelope = parseErrorEnvelope(error.body)
        throw new TagManagementApiError(envelope.error, error.status, envelope.code, envelope.details)
      } catch (nested) {
        throw nested
      }
    }
    throw new TagManagementApiError(
      'Tag management returned an invalid response.',
      200,
      'CLIENT_PROTOCOL_ERROR',
    )
  }
}

function operationBody(operation: TagOperationRequest): string {
  return JSON.stringify(operation)
}

function requestHeaders(): HeadersInit {
  return { 'content-type': 'application/json' }
}

export async function listManagedTags(): Promise<ManagedTag[]> {
  return request('/api/tags', {}, (value) => {
    assert(Array.isArray(value), 'managed tag list must be an array')
    return value.map((tag, index) => parseManagedTag(tag, index))
  })
}

export async function previewTagOperation(operation: TagOperationRequest): Promise<TagOperationPreview> {
  parseOperation(operation)
  const preview = await request('/api/tags/operations/preview', {
    method: 'POST',
    headers: requestHeaders(),
    body: operationBody(operation),
  }, (value) => parsePreview(value, INITIAL_SAMPLE_LIMIT))
  assertPreviewSemantics(preview, operation)
  return preview
}

export async function getTagOperationPreviewPage(
  operation: TagOperationRequest,
  planFingerprint: string,
  afterDocumentId?: string,
  limit = 100,
): Promise<TagOperationPreview> {
  parseOperation(operation)
  assert(PLAN_FINGERPRINT.test(planFingerprint), 'planFingerprint is invalid')
  assert(afterDocumentId === undefined || boundedString(afterDocumentId, MAX_DOCUMENT_FIELD_LENGTH), 'afterDocumentId is invalid')
  assert(Number.isSafeInteger(limit) && limit > 0 && limit <= PAGE_SAMPLE_LIMIT, 'limit is invalid')
  const body = {
    operation,
    planFingerprint,
    ...(afterDocumentId === undefined ? {} : { afterDocumentId }),
    limit,
  }
  const page = await request('/api/tags/operations/preview/page', {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify(body),
  }, (value) => parsePreview(value, PAGE_SAMPLE_LIMIT))
  if (page.planFingerprint !== planFingerprint) throw protocolError('page fingerprint changed')
  assertPreviewSemantics(page, operation)
  return page
}

export async function applyTagOperation(
  operation: TagOperationRequest,
  planFingerprint: string,
): Promise<TagOperationApplyResult> {
  parseOperation(operation)
  assert(PLAN_FINGERPRINT.test(planFingerprint), 'planFingerprint is invalid')
  const result = await request('/api/tags/operations/apply', {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify({ operation, planFingerprint }),
  }, parseApplyResult)
  if (result.appliedFingerprint !== planFingerprint) throw protocolError('apply fingerprint changed')
  if (!operationsEqual(result.operation, operation)) throw protocolError('apply operation changed')
  return result
}
