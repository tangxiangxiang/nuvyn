import { createHash, randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import { withDocumentWriteLocks } from './documentWriteLock.js'
import { MetadataVersionError, nextMetadataUpdatedAt } from './metadataVersion.js'
import {
  TAG_IDENTITY_CONTRACT_VERSION,
  validatePersistentTag,
  type PersistentTagValidation,
} from '../shared/tagNormalization.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'
import {
  beginTagUndoRecording,
  captureTagUndoCreatedDestinationDeltas,
  captureTagUndoRemovedSourceDeltas,
  finalizeTagUndoRecording,
  stageTagUndoMergeSourceOnlyDocuments,
  TagUndoRecordingError,
  updateTagUndoVersionCount,
} from './tagUndo.js'

export const MANAGEMENT_PREVIEW_SAMPLE_LIMIT = 20
export const MANAGEMENT_PREVIEW_PAGE_DEFAULT_LIMIT = 50
export const MANAGEMENT_PREVIEW_PAGE_MAX_LIMIT = 100

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

export type ManagedTag = {
  id: number
  normalizedName: string
  displayName: string
  documentCount: number
}

export type TagRowView = {
  id: number
  normalizedName: string
  displayName: string
}

export type PreviewDocument = {
  id: string
  path: string
  title: string
}

type FingerprintDocument = PreviewDocument & {
  summary: string
  createdAt: number
  updatedAt: number
  completeTagRows: TagRowView[]
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
  | 'diary-private-metadata-unsupported'
  | 'TRANSACTION_FAILED'

export type TagManagementErrorDetails = Record<string, string | number | null>

export class TagManagementError extends Error {
  readonly code: TagManagementErrorCode
  readonly details: TagManagementErrorDetails

  constructor(
    code: TagManagementErrorCode,
    message: string,
    details: TagManagementErrorDetails = {},
  ) {
    super(message)
    this.name = 'TagManagementError'
    this.code = code
    this.details = details
  }
}

export type TagOperationApplyResult = {
  operationId: string
  resultId: string
  kind: TagOperationRequest['kind']
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

export type TagManagementApplyFailureStage =
  | 'after-version-update'
  | 'after-association-mutation'
  | 'after-tag-row-mutation'
  | 'before-postcondition'
  | 'before-commit'
  | 'parent-insert'
  | 'removed-source-capture'
  | 'merge-source-staging'
  | 'created-destination-capture'
  | 'state-current-record'
  | 'state-last-superseded'
  | 'old-target-delete'
  | 'final-postcondition'

export type TagManagementApplyTestHooks = {
  afterDiscovery?: (state: TagOperationPlanState) => void
  afterLocks?: (paths: readonly string[]) => void
  failureStage?: TagManagementApplyFailureStage | null
  beforePostcondition?: (db: DatabaseT, plan: TagOperationPlan) => void
  afterCommit?: (result: TagOperationApplyResult) => void
}

let applyTestHooks: TagManagementApplyTestHooks | null = null

/** Test-only seams for atomicity and lock-ordering tests; never used by HTTP. */
export function __setTagManagementApplyHooksForTesting(
  hooks: TagManagementApplyTestHooks | null,
): void {
  applyTestHooks = hooks
}

type DatabaseTagRow = {
  id: number
  name: string
  normalized_name: string
}

type DatabaseDocumentRow = {
  id: string
  path: string
  title: string
  summary: string
  created_at: number
  updated_at: number
}

type DatabaseAssociationRow = DatabaseTagRow & {
  document_id: string
}

type PlannerTestHookStage = 'after-affected-document-read'
let plannerTestHook: ((stage: PlannerTestHookStage) => void) | null = null

/** Test-only seam for proving deferred snapshot behavior without async work in production. */
export function __setTagManagementPlannerHookForTesting(
  hook: ((stage: PlannerTestHookStage) => void) | null,
): void {
  plannerTestHook = hook
}

export type TagOperationPlan = {
  operation: TagOperationRequest
  sourceTag: TagRowView
  destinationTag: TagRowView | null
  requestedDestination: { displayName: string; normalizedName: string } | null
  survivorTag: TagRowView | null
  displayOnly: boolean
  affectedDocuments: FingerprintDocument[]
  affectedCount: number
  sample: PreviewDocument[]
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
  healthContractVersion: typeof TAG_IDENTITY_CONTRACT_VERSION
}

export type TagOperationPreview = Omit<TagOperationPlan, 'affectedDocuments'> & {
  nextAfterDocumentId: string | null
}

export type ResolvedTagOperation = {
  operation: TagOperationRequest
  requestedDestination: { displayName: string; normalizedName: string } | null
}

/**
 * Resolution is deliberately explicit so initial Preview and continuation
 * recomputation share the same lookup semantics. A null row is a real,
 * fingerprintable missing-row state, not an exception-only control path.
 */
export type TagResolutionState = {
  source: TagRowView | null
  destination: TagRowView | null
}

export type TagOperationPlanState = Omit<TagOperationPlan, 'sourceTag'> & {
  sourceTag: TagRowView | null
  resolution: TagResolutionState
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort()
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = ownKeys(value)
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TagManagementError('INVALID_OPERATION', 'operation contains unknown or missing fields')
  }
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function assertSafeIntegerInvariant(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TagManagementError('TAG_IDENTITY_CONFLICT', `${field} is outside the safe integer invariant`)
  }
}

function safeFingerprintInteger(value: unknown, field: string): number {
  assertSafeIntegerInvariant(value, field)
  return value
}

function safeNonNegativeFingerprintInteger(value: unknown, field: string): number {
  const integer = safeFingerprintInteger(value, field)
  if (integer < 0) {
    throw new TagManagementError('TAG_IDENTITY_CONFLICT', `${field} is outside the non-negative integer invariant`)
  }
  return integer
}

function parseTagId(value: unknown, field: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new TagManagementError('INVALID_OPERATION', `${field} must be a positive safe integer`)
  }
  return value
}

function validatedDestinationName(value: unknown): { displayName: string; normalizedName: string } {
  const validation: PersistentTagValidation = validatePersistentTag(value)
  if (!validation.ok) throw new TagManagementError('INVALID_TAG_NAME', validation.message)
  return { displayName: validation.displayName, normalizedName: validation.normalizedName }
}

/** Parse and normalize the client-owned operation at the HTTP boundary. */
export function parseTagOperation(value: unknown): ResolvedTagOperation {
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    throw new TagManagementError('INVALID_OPERATION', 'operation kind is required')
  }
  if (value.kind === 'rename') {
    requireExactKeys(value, ['kind', 'sourceTagId', 'destinationName'])
    const requestedDestination = validatedDestinationName(value.destinationName)
    const sourceTagId = parseTagId(value.sourceTagId, 'sourceTagId')
    return {
      operation: {
        kind: 'rename',
        sourceTagId,
        destinationName: requestedDestination.displayName,
      },
      requestedDestination,
    }
  }
  if (value.kind === 'merge') {
    requireExactKeys(value, ['kind', 'sourceTagId', 'destinationTagId'])
    return {
      operation: {
        kind: 'merge',
        sourceTagId: parseTagId(value.sourceTagId, 'sourceTagId'),
        destinationTagId: parseTagId(value.destinationTagId, 'destinationTagId'),
      },
      requestedDestination: null,
    }
  }
  if (value.kind === 'remove') {
    requireExactKeys(value, ['kind', 'sourceTagId'])
    return {
      operation: {
        kind: 'remove',
        sourceTagId: parseTagId(value.sourceTagId, 'sourceTagId'),
      },
      requestedDestination: null,
    }
  }
  throw new TagManagementError('INVALID_OPERATION', 'unknown tag operation kind')
}

function databaseTagToView(row: DatabaseTagRow): TagRowView {
  if (!isPositiveSafeInteger(row.id)) {
    throw new TagManagementError('TAG_IDENTITY_CONFLICT', 'tag identity invariant is unavailable')
  }
  return {
    id: row.id,
    displayName: row.name,
    normalizedName: row.normalized_name,
  }
}

function assertCanonicalTagRow(row: DatabaseTagRow): void {
  const validation = validatePersistentTag(row.name)
  if (!validation.ok || validation.displayName !== row.name || validation.normalizedName !== row.normalized_name) {
    throw new TagManagementError('TAG_IDENTITY_CONFLICT', 'tag identity invariant is unavailable')
  }
}

function tagTuple(row: TagRowView): [number, string, string] {
  const id = safeFingerprintInteger(row.id, 'tag.id')
  if (id <= 0) {
    throw new TagManagementError('TAG_IDENTITY_CONFLICT', 'tag.id is outside the positive integer invariant')
  }
  return [id, row.displayName, row.normalizedName]
}

function compareDocumentIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function fingerprintInput(plan: Omit<TagOperationPlanState, 'planFingerprint'>): unknown[] {
  const operationTuple = plan.operation.kind === 'rename'
    ? [
        'rename',
        safeFingerprintInteger(plan.operation.sourceTagId, 'operation.sourceTagId'),
        plan.operation.destinationName,
        plan.requestedDestination!.normalizedName,
      ]
    : plan.operation.kind === 'merge'
      ? [
          'merge',
          safeFingerprintInteger(plan.operation.sourceTagId, 'operation.sourceTagId'),
          safeFingerprintInteger(plan.operation.destinationTagId, 'operation.destinationTagId'),
        ]
      : ['remove', safeFingerprintInteger(plan.operation.sourceTagId, 'operation.sourceTagId')]

  const destinationResolutionTuple = plan.operation.kind === 'rename'
    ? [plan.requestedDestination!.normalizedName, plan.destinationTag ? tagTuple(plan.destinationTag) : null]
    : plan.operation.kind === 'merge'
      ? plan.destinationTag ? tagTuple(plan.destinationTag) : null
      : null

  const affectedDocumentTuples = [...plan.affectedDocuments]
    .sort((left, right) => compareDocumentIds(left.id, right.id))
    .map((document) => [
      document.id,
      document.path,
      document.title,
      document.summary,
      safeFingerprintInteger(document.createdAt, 'document.createdAt'),
      safeFingerprintInteger(document.updatedAt, 'document.updatedAt'),
      [...document.completeTagRows]
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map(tagTuple),
    ])

  const derivedPlanTuple = [
    plan.displayOnly,
    plan.allowedToApply,
    plan.conflictCode ?? null,
    safeNonNegativeFingerprintInteger(plan.affectedCount, 'plan.affectedCount'),
    safeNonNegativeFingerprintInteger(plan.associationAdds, 'plan.associationAdds'),
    safeNonNegativeFingerprintInteger(plan.associationRemoves, 'plan.associationRemoves'),
    safeNonNegativeFingerprintInteger(plan.duplicateCollapses, 'plan.duplicateCollapses'),
    safeNonNegativeFingerprintInteger(plan.tagCreates, 'plan.tagCreates'),
    safeNonNegativeFingerprintInteger(plan.tagDeletes, 'plan.tagDeletes'),
    [...plan.warnings],
  ]

  return [
    'nuvyn-tag-operation-plan',
    1,
    TAG_IDENTITY_CONTRACT_VERSION,
    operationTuple,
    plan.sourceTag ? tagTuple(plan.sourceTag) : null,
    destinationResolutionTuple,
    affectedDocumentTuples,
    derivedPlanTuple,
  ]
}

function fingerprintForPlan(plan: Omit<TagOperationPlanState, 'planFingerprint'>): string {
  return createHash('sha256')
    .update(JSON.stringify(fingerprintInput(plan)), 'utf8')
    .digest('hex')
}

function warningCodes(operation: TagOperationRequest, affectedCount: number): TagWarningCode[] {
  const warnings: TagWarningCode[] = []
  if (operation.kind === 'remove') warnings.push('DESTRUCTIVE')
  if (affectedCount >= 1000) warnings.push('HIGH_IMPACT')
  return warnings
}

function readResolvedTags(
  db: DatabaseT,
  operation: TagOperationRequest,
  requestedDestination: ResolvedTagOperation['requestedDestination'],
): TagResolutionState {
  let rows: DatabaseTagRow[]
  if (operation.kind === 'rename') {
    rows = db.prepare(`
      SELECT id, name, normalized_name
      FROM tags
      WHERE id = ? OR normalized_name = ? COLLATE BINARY
      ORDER BY id
    `).all(operation.sourceTagId, requestedDestination!.normalizedName) as DatabaseTagRow[]
  } else if (operation.kind === 'merge') {
    rows = db.prepare(`
      SELECT id, name, normalized_name
      FROM tags
      WHERE id IN (?, ?)
      ORDER BY id
    `).all(operation.sourceTagId, operation.destinationTagId) as DatabaseTagRow[]
  } else {
    rows = db.prepare(`
      SELECT id, name, normalized_name
      FROM tags
      WHERE id = ?
    `).all(operation.sourceTagId) as DatabaseTagRow[]
  }
  for (const row of rows) assertCanonicalTagRow(row)
  const source = rows.find((row) => row.id === operation.sourceTagId)
  const destination = operation.kind === 'rename'
    ? rows.find((row) => row.normalized_name === requestedDestination!.normalizedName)
    : operation.kind === 'merge'
      ? rows.find((row) => row.id === operation.destinationTagId)
      : null
  return {
    source: source ? databaseTagToView(source) : null,
    destination: destination ? databaseTagToView(destination) : null,
  }
}

function readAffectedDocuments(db: DatabaseT, sourceTagId: number): FingerprintDocument[] {
  // Keep the planner at a constant three statements while still preventing
  // private managed-Diary fields from entering the generic planner. The SQL
  // projection emits empty placeholders for canonical Diary paths; the
  // shared TypeScript path guard below remains authoritative (including date
  // validity) before any title/summary value is consumed.
  const documents = db.prepare(`
    SELECT d.id, d.path,
      CASE WHEN d.path GLOB 'diary/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(substr(d.path, 7)) = substr(d.path, 7)
        THEN '' ELSE d.title END AS title,
      CASE WHEN d.path GLOB 'diary/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(substr(d.path, 7)) = substr(d.path, 7)
        THEN '' ELSE d.summary END AS summary,
      d.created_at, d.updated_at
    FROM documents d
    JOIN (
      SELECT DISTINCT document_id
      FROM document_tags
      WHERE tag_id = ?
    ) source_documents ON source_documents.document_id = d.id
    ORDER BY d.id COLLATE BINARY
  `).all(sourceTagId) as DatabaseDocumentRow[]
  if (documents.some((document) => isManagedDiaryPath(document.path))) {
    throw new TagManagementError(
      'diary-private-metadata-unsupported',
      'tag operations are unavailable for managed Diary metadata',
    )
  }
  plannerTestHook?.('after-affected-document-read')

  const associations = db.prepare(`
    WITH affected_documents AS (
      SELECT DISTINCT document_id
      FROM document_tags
      WHERE tag_id = ?
    )
    SELECT affected_documents.document_id, t.id, t.name, t.normalized_name
    FROM affected_documents
    JOIN document_tags dt ON dt.document_id = affected_documents.document_id
    JOIN tags t ON t.id = dt.tag_id
    ORDER BY affected_documents.document_id COLLATE BINARY, t.id
  `).all(sourceTagId) as DatabaseAssociationRow[]

  const tagsByDocument = new Map<string, TagRowView[]>()
  for (const row of associations) {
    assertCanonicalTagRow(row)
    const list = tagsByDocument.get(row.document_id) ?? []
    list.push(databaseTagToView(row))
    tagsByDocument.set(row.document_id, list)
  }
  return documents.map((row) => ({
    id: row.id,
    path: row.path,
    title: row.title,
    summary: row.summary,
    createdAt: safeFingerprintInteger(row.created_at, 'document.created_at'),
    updatedAt: safeFingerprintInteger(row.updated_at, 'document.updated_at'),
    completeTagRows: tagsByDocument.get(row.id) ?? [],
  }))
}

function hasRequiredResolution(
  operation: TagOperationRequest,
  resolution: TagResolutionState,
): boolean {
  return resolution.source !== null
    && (operation.kind !== 'merge' || resolution.destination !== null)
}

function materializeResolvedPlan(state: TagOperationPlanState): TagOperationPlan {
  if (!state.sourceTag || !hasRequiredResolution(state.operation, state.resolution)) {
    throw new TagManagementError('TAG_NOT_FOUND', state.operation.kind === 'merge' && !state.resolution.destination
      ? 'destination tag was not found'
      : 'source tag was not found')
  }
  return state as TagOperationPlan
}

/**
 * Build the shared read-only planning state from the caller's current SQLite
 * snapshot. Missing source/destination rows remain explicit null states so
 * continuation can classify their disappearance as stale without re-running
 * a strict planner and translating its exception.
 */
export function buildTagOperationPlanState(
  db: DatabaseT,
  operationInput: TagOperationRequest,
): TagOperationPlanState {
  const resolved = parseTagOperation(operationInput)
  const { operation, requestedDestination } = resolved
  const resolution = readResolvedTags(db, operation, requestedDestination)
  const { source, destination } = resolution
  const requiredResolution = hasRequiredResolution(operation, resolution)

  const affectedDocuments = requiredResolution ? readAffectedDocuments(db, source!.id) : []
  let displayOnly = false
  let conflictCode: TagPlanConflictCode | undefined
  let conflictMessage: string | undefined
  let allowedToApply = requiredResolution
  let survivorTag: TagRowView | null = source
  let associationAdds = 0
  let associationRemoves = 0
  let duplicateCollapses = 0
  let tagDeletes = 0

  if (operation.kind === 'rename' && source) {
    if (destination && destination.id !== source.id) {
      allowedToApply = false
      conflictCode = 'DESTINATION_EXISTS'
      conflictMessage = 'destination identity is already owned by another tag'
    } else if (destination) {
      displayOnly = requestedDestination!.displayName !== source.displayName
      if (!displayOnly) {
        allowedToApply = false
        conflictCode = 'INVALID_OPERATION'
        conflictMessage = 'rename destination is the same as the current tag'
      }
    }
  } else if (operation.kind === 'merge' && requiredResolution) {
    survivorTag = destination
    if (source!.id === destination!.id) {
      allowedToApply = false
      conflictCode = 'SOURCE_DESTINATION_SAME'
      conflictMessage = 'merge source and destination must be different tags'
    } else {
      const destinationId = destination!.id
      for (const document of affectedDocuments) {
        if (document.completeTagRows.some((tag) => tag.id === destinationId)) duplicateCollapses++
        else associationAdds++
      }
      associationRemoves = affectedDocuments.length
      tagDeletes = 1
    }
  } else if (operation.kind === 'remove' && source) {
    survivorTag = null
    associationRemoves = affectedDocuments.length
    tagDeletes = 1
  }

  const warnings = warningCodes(operation, affectedDocuments.length)
  const planWithoutFingerprint: Omit<TagOperationPlanState, 'planFingerprint'> = {
    operation,
    sourceTag: source,
    destinationTag: destination,
    requestedDestination,
    survivorTag,
    displayOnly,
    affectedDocuments,
    affectedCount: affectedDocuments.length,
    sample: affectedDocuments.slice(0, MANAGEMENT_PREVIEW_SAMPLE_LIMIT).map(({ id, path, title }) => ({ id, path, title })),
    associationAdds,
    associationRemoves,
    duplicateCollapses,
    tagCreates: 0,
    tagDeletes,
    warnings,
    allowedToApply,
    ...(conflictCode ? { conflictCode } : {}),
    ...(conflictMessage ? { conflictMessage } : {}),
    resolution,
    healthContractVersion: TAG_IDENTITY_CONTRACT_VERSION as typeof TAG_IDENTITY_CONTRACT_VERSION,
  }
  return {
    ...planWithoutFingerprint,
    planFingerprint: fingerprintForPlan(planWithoutFingerprint),
  }
}

/** Build a strict initial-Preview plan from the shared resolution state. */
export function buildTagOperationPlan(
  db: DatabaseT,
  operationInput: TagOperationRequest,
): TagOperationPlan {
  return materializeResolvedPlan(buildTagOperationPlanState(db, operationInput))
}

export function previewFromPlan(
  plan: TagOperationPlan,
  documents: PreviewDocument[] = plan.sample,
): TagOperationPreview {
  const start = documents.length > 0 ? documents[documents.length - 1]!.id : null
  const lastFullDocument = plan.affectedDocuments[plan.affectedDocuments.length - 1]
  return {
    operation: plan.operation,
    sourceTag: plan.sourceTag,
    destinationTag: plan.destinationTag,
    requestedDestination: plan.requestedDestination,
    survivorTag: plan.survivorTag,
    displayOnly: plan.displayOnly,
    affectedCount: plan.affectedCount,
    sample: documents,
    associationAdds: plan.associationAdds,
    associationRemoves: plan.associationRemoves,
    duplicateCollapses: plan.duplicateCollapses,
    tagCreates: plan.tagCreates,
    tagDeletes: plan.tagDeletes,
    warnings: plan.warnings,
    allowedToApply: plan.allowedToApply,
    ...(plan.conflictCode ? { conflictCode: plan.conflictCode } : {}),
    ...(plan.conflictMessage ? { conflictMessage: plan.conflictMessage } : {}),
    planFingerprint: plan.planFingerprint,
    healthContractVersion: plan.healthContractVersion,
    nextAfterDocumentId: start !== null && start !== lastFullDocument?.id ? start : null,
  }
}

export function previewTagOperation(db: DatabaseT, operation: TagOperationRequest): TagOperationPreview {
  const transaction = db.transaction(() => {
    const plan = buildTagOperationPlan(db, operation)
    return previewFromPlan(plan)
  })
  return transaction()
}

export function previewTagOperationPage(
  db: DatabaseT,
  operation: TagOperationRequest,
  planFingerprint: string,
  afterDocumentId: string | undefined,
  limit: number,
): TagOperationPreview {
  if (!isPlanFingerprint(planFingerprint)) {
    throw new TagManagementError('INVALID_OPERATION', 'planFingerprint must be 64 lowercase hexadecimal characters')
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MANAGEMENT_PREVIEW_PAGE_MAX_LIMIT) {
    throw new TagManagementError('INVALID_OPERATION', `limit must be an integer from 1 to ${MANAGEMENT_PREVIEW_PAGE_MAX_LIMIT}`)
  }
  const transaction = db.transaction(() => {
    const state = buildTagOperationPlanState(db, operation)
    if (!hasRequiredResolution(operation, state.resolution)) {
      // Continuation uses the shared explicit resolution state. A previously
      // reviewed identity that disappeared is stale, not a new 404.
      throw new TagManagementError('PREVIEW_STALE', 'preview is stale')
    }
    const plan = materializeResolvedPlan(state)
    if (plan.planFingerprint !== planFingerprint) {
      throw new TagManagementError('PREVIEW_STALE', 'preview is stale')
    }
    const startIndex = afterDocumentId === undefined
      ? 0
      : plan.affectedDocuments.findIndex((document) => document.id === afterDocumentId) + 1
    if (afterDocumentId !== undefined && startIndex === 0) {
      throw new TagManagementError('INVALID_OPERATION', 'afterDocumentId is not in the affected document set')
    }
    const page = plan.affectedDocuments
      .slice(startIndex, startIndex + limit)
      .map(({ id, path, title }) => ({ id, path, title }))
    return previewFromPlan(plan, page)
  })
  return transaction()
}

export function listManagedTags(db: DatabaseT): ManagedTag[] {
  const rows = db.prepare(`
    SELECT
      t.id,
      t.normalized_name,
      t.name,
      COUNT(DISTINCT dt.document_id) AS document_count
    FROM tags t
    LEFT JOIN document_tags dt ON dt.tag_id = t.id
    GROUP BY t.id, t.name, t.normalized_name
    ORDER BY t.normalized_name COLLATE BINARY, t.id
  `).all() as Array<DatabaseTagRow & { document_count: number }>
  rows.forEach(assertCanonicalTagRow)
  // Managed Diary associations are private metadata and must not contribute
  // to the public tag counts. Keep this structural-only: no Diary body is
  // opened or parsed while building the projection.
  const managedCounts = new Map<number, number>()
  const associations = db.prepare(`
    SELECT dt.tag_id, d.path
    FROM document_tags dt
    JOIN documents d ON d.id = dt.document_id
  `).all() as Array<{ tag_id: number; path: string }>
  for (const association of associations) {
    if (!isManagedDiaryPath(association.path)) continue
    managedCounts.set(association.tag_id, (managedCounts.get(association.tag_id) ?? 0) + 1)
  }
  return rows.flatMap((row) => {
    const totalCount = Number(row.document_count)
    const documentCount = Math.max(0, totalCount - (managedCounts.get(row.id) ?? 0))
    // A tag attached only to private managed-Diary metadata is itself a
    // private association. Hide that tag row entirely; retain true orphan
    // tags (totalCount === 0) and tags also used by public Notes.
    if (totalCount > 0 && documentCount === 0) return []
    return [{ ...databaseTagToView(row), documentCount }]
  })
}

export function isPlanFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function parsePreviewPageRequest(value: unknown): {
  operation: TagOperationRequest
  planFingerprint: string
  afterDocumentId?: string
  limit: number
} {
  if (!isPlainObject(value)) throw new TagManagementError('INVALID_OPERATION', 'preview page body is required')
  const allowedKeys = ['operation', 'planFingerprint', 'afterDocumentId', 'limit']
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new TagManagementError('INVALID_OPERATION', 'preview page contains unknown fields')
  }
  if (!Object.hasOwn(value, 'operation') || !Object.hasOwn(value, 'planFingerprint')) {
    throw new TagManagementError('INVALID_OPERATION', 'operation and planFingerprint are required')
  }
  if (!isPlanFingerprint(value.planFingerprint)) {
    throw new TagManagementError('INVALID_OPERATION', 'planFingerprint must be 64 lowercase hexadecimal characters')
  }
  let afterDocumentId: string | undefined
  if (Object.hasOwn(value, 'afterDocumentId')) {
    if (typeof value.afterDocumentId !== 'string' || value.afterDocumentId.length === 0 || value.afterDocumentId.length > 512) {
      throw new TagManagementError('INVALID_OPERATION', 'afterDocumentId must be a bounded non-empty string')
    }
    afterDocumentId = value.afterDocumentId
  }
  const limit = value.limit === undefined ? MANAGEMENT_PREVIEW_PAGE_DEFAULT_LIMIT : value.limit
  if (typeof limit !== 'number'
    || !Number.isSafeInteger(limit)
    || limit <= 0
    || limit > MANAGEMENT_PREVIEW_PAGE_MAX_LIMIT) {
    throw new TagManagementError('INVALID_OPERATION', `limit must be an integer from 1 to ${MANAGEMENT_PREVIEW_PAGE_MAX_LIMIT}`)
  }
  const parsed = parseTagOperation(value.operation)
  return {
    operation: parsed.operation,
    planFingerprint: value.planFingerprint,
    ...(afterDocumentId === undefined ? {} : { afterDocumentId }),
    limit,
  }
}

export function parseTagApplyRequest(value: unknown): {
  operation: TagOperationRequest
  planFingerprint: string
} {
  if (!isPlainObject(value)) throw new TagManagementError('INVALID_OPERATION', 'apply body is required')
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'operation' && key !== 'planFingerprint')) {
    throw new TagManagementError('INVALID_OPERATION', 'apply body must contain only operation and planFingerprint')
  }
  if (!Object.hasOwn(value, 'planFingerprint') || !isPlanFingerprint(value.planFingerprint)) {
    throw new TagManagementError('PREVIEW_REQUIRED', 'a current Preview fingerprint is required')
  }
  if (!Object.hasOwn(value, 'operation')) {
    throw new TagManagementError('INVALID_OPERATION', 'operation is required')
  }
  return {
    operation: parseTagOperation(value.operation).operation,
    planFingerprint: value.planFingerprint,
  }
}

type ApplyAffectedDocumentRow = {
  document_id: string
  before_updated_at: unknown
  expected_updated_at: unknown
}

const APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE = 'tag_apply_affected_documents'

function assertApplyPostcondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TagManagementError('TRANSACTION_FAILED', message)
}

function throwInjectedApplyFailure(stage: TagManagementApplyFailureStage): void {
  if (applyTestHooks?.failureStage === stage) {
    throw new Error(`injected tag management failure at ${stage}`)
  }
}

function captureApplyAffectedDocuments(
  db: DatabaseT,
  plan: TagOperationPlan,
  commitTimestamp: number,
): ApplyAffectedDocumentRow[] {
  db.exec(`
    DROP TABLE IF EXISTS temp.${APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE};
    CREATE TEMP TABLE ${APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} (
      document_id TEXT PRIMARY KEY,
      before_updated_at INTEGER NOT NULL,
      expected_updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
  `)
  const inserted = db.prepare(`
    INSERT INTO temp.${APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} (
      document_id,
      before_updated_at,
      expected_updated_at
    )
    SELECT
      d.id,
      d.updated_at,
      CASE
        WHEN d.updated_at + 1 > ? THEN d.updated_at + 1
        ELSE ?
      END
    FROM documents d
    JOIN document_tags dt ON dt.document_id = d.id
    WHERE dt.tag_id = ?
    ORDER BY d.id COLLATE BINARY
  `).run(commitTimestamp, commitTimestamp, plan.operation.sourceTagId)
  assertApplyPostcondition(inserted.changes === plan.affectedCount, 'affected document set changed during tag operation')

  const rows = db.prepare(`
    SELECT document_id, before_updated_at, expected_updated_at
    FROM temp.${APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE}
    ORDER BY document_id COLLATE BINARY
  `).all() as ApplyAffectedDocumentRow[]
  const expectedDocuments = [...plan.affectedDocuments].sort((left, right) => compareDocumentIds(left.id, right.id))
  assertApplyPostcondition(rows.length === expectedDocuments.length, 'affected document count mismatched')
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const expected = expectedDocuments[index]!
    assertApplyPostcondition(row.document_id === expected.id, 'affected document identity changed during tag operation')
    if (typeof row.before_updated_at !== 'number'
      || !Number.isSafeInteger(row.before_updated_at)
      || row.before_updated_at < 0) {
      throw transactionFailed()
    }
    if (row.before_updated_at !== expected.updatedAt) {
      throw new TagManagementError('PREVIEW_STALE', 'preview is stale')
    }
    try {
      assertApplyPostcondition(
        row.expected_updated_at === nextMetadataUpdatedAt(expected.updatedAt, commitTimestamp),
        'document version candidate changed during tag operation',
      )
    } catch (error) {
      if (error instanceof MetadataVersionError) throw transactionFailed()
      throw error
    }
  }
  return rows
}

function assertApplyVersionPostcondition(db: DatabaseT, plan: TagOperationPlan): void {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS expected_count,
      COUNT(d.id) AS present_count,
      COALESCE(SUM(
        CASE
          WHEN d.id IS NULL OR d.updated_at <> affected.expected_updated_at THEN 1
          ELSE 0
        END
      ), 0) AS mismatched_count
    FROM temp.${APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} affected
    LEFT JOIN documents d ON d.id = affected.document_id
  `).get() as { expected_count: number; present_count: number; mismatched_count: number }
  assertApplyPostcondition(row.expected_count === plan.affectedCount, 'affected document version count mismatched')
  assertApplyPostcondition(row.present_count === plan.affectedCount, 'affected document disappeared during tag operation')
  assertApplyPostcondition(row.mismatched_count === 0, 'document version postcondition failed')
}

function readApplyTag(db: DatabaseT, id: number): TagRowView | null {
  const row = db.prepare(`
    SELECT id, name, normalized_name
    FROM tags
    WHERE id = ?
  `).get(id) as DatabaseTagRow | undefined
  if (!row) return null
  try {
    assertCanonicalTagRow(row)
  } catch (error) {
    if (error instanceof TagManagementError) throw transactionFailed()
    throw error
  }
  return databaseTagToView(row)
}

function readApplyAssociationCounts(
  db: DatabaseT,
  sourceTagId: number,
  destinationTagId: number | null,
): {
  sourceCount: number
  affectedSourceCount: number
  destinationCount: number | null
  affectedDestinationCount: number | null
} {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM document_tags WHERE tag_id = ?) AS source_count,
      (
        SELECT COUNT(*)
        FROM temp.${APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} affected
        JOIN document_tags dt ON dt.document_id = affected.document_id
        WHERE dt.tag_id = ?
      ) AS affected_source_count,
      ${destinationTagId === null ? 'NULL' : '(SELECT COUNT(*) FROM document_tags WHERE tag_id = ?)'} AS destination_count,
      ${destinationTagId === null
        ? 'NULL'
        : `(
            SELECT COUNT(*)
            FROM temp.${APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} affected
            JOIN document_tags dt ON dt.document_id = affected.document_id
            WHERE dt.tag_id = ?
          )`} AS affected_destination_count
  `).get(
    destinationTagId === null
      ? [sourceTagId, sourceTagId]
      : [sourceTagId, sourceTagId, destinationTagId, destinationTagId],
  ) as {
    source_count: number
    affected_source_count: number
    destination_count: number | null
    affected_destination_count: number | null
  }
  return {
    sourceCount: row.source_count,
    affectedSourceCount: row.affected_source_count,
    destinationCount: row.destination_count,
    affectedDestinationCount: row.affected_destination_count,
  }
}

function assertApplyPostconditions(
  db: DatabaseT,
  plan: TagOperationPlan,
  beforeDestinationAssociationCount: number | null,
): void {
  assertApplyVersionPostcondition(db, plan)

  if (plan.operation.kind === 'rename') {
    const source = readApplyTag(db, plan.sourceTag.id)
    assertApplyPostcondition(source !== null, 'rename source tag disappeared')
    assertApplyPostcondition(source.displayName === plan.requestedDestination!.displayName, 'rename display postcondition failed')
    assertApplyPostcondition(source.normalizedName === plan.requestedDestination!.normalizedName, 'rename identity postcondition failed')
    const ownerCount = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM tags
      WHERE normalized_name = ? COLLATE BINARY
    `).get(plan.requestedDestination!.normalizedName) as { count: number }).count
    assertApplyPostcondition(ownerCount === 1, 'rename destination identity is not unique')
    const associations = readApplyAssociationCounts(db, plan.sourceTag.id, null)
    assertApplyPostcondition(associations.sourceCount === plan.affectedCount, 'rename source association count changed')
    assertApplyPostcondition(
      associations.affectedSourceCount === plan.affectedCount,
      'rename source associations changed',
    )
  } else if (plan.operation.kind === 'merge') {
    const destination = readApplyTag(db, plan.operation.destinationTagId)
    assertApplyPostcondition(destination !== null, 'merge destination tag disappeared')
    assertApplyPostcondition(destination.displayName === plan.destinationTag!.displayName, 'merge destination display changed')
    assertApplyPostcondition(destination.normalizedName === plan.destinationTag!.normalizedName, 'merge destination identity changed')
    assertApplyPostcondition(readApplyTag(db, plan.operation.sourceTagId) === null, 'merge source tag remains')
    const associations = readApplyAssociationCounts(db, plan.operation.sourceTagId, plan.operation.destinationTagId)
    assertApplyPostcondition(associations.sourceCount === 0, 'merge source associations remain')
    assertApplyPostcondition(
      associations.affectedDestinationCount === plan.affectedCount,
      'merge survivor association is missing',
    )
    assertApplyPostcondition(
      beforeDestinationAssociationCount !== null
        && associations.destinationCount === beforeDestinationAssociationCount + plan.associationAdds,
      'merge destination association count changed',
    )
  } else {
    assertApplyPostcondition(readApplyTag(db, plan.operation.sourceTagId) === null, 'remove source tag remains')
    const associations = readApplyAssociationCounts(db, plan.operation.sourceTagId, null)
    assertApplyPostcondition(associations.sourceCount === 0, 'remove source associations remain')
  }
}

function conflictFromApplyPlan(plan: TagOperationPlan): never {
  const code = plan.conflictCode ?? 'INVALID_OPERATION'
  throw new TagManagementError(
    code,
    plan.conflictMessage ?? 'tag operation is not allowed by the reviewed Preview',
    code === 'DESTINATION_EXISTS' && plan.destinationTag
      ? {
          destinationTagId: plan.destinationTag.id,
          destinationDisplayName: plan.destinationTag.displayName,
        }
      : {},
  )
}

function buildApplyResult(
  operationId: string,
  plan: TagOperationPlan,
  commitTimestamp: number,
  versionUpdateCount: number,
  appliedFingerprint: string,
  finalSourceTag: TagRowView | null,
  finalDestinationTag: TagRowView | null,
): TagOperationApplyResult {
  const sourceDeleted = plan.operation.kind !== 'rename'
  const survivorTag = plan.operation.kind === 'merge'
    ? finalDestinationTag
    : plan.operation.kind === 'remove' ? null : finalSourceTag
  return {
    operationId,
    resultId: operationId,
    kind: plan.operation.kind,
    operation: plan.operation,
    sourceTagId: plan.operation.sourceTagId,
    destinationTagId: plan.operation.kind === 'merge' ? plan.operation.destinationTagId : null,
    survivorTagId: survivorTag?.id ?? null,
    sourceTag: finalSourceTag,
    destinationTag: finalDestinationTag,
    survivorTag,
    sourceDisplayName: finalSourceTag?.displayName ?? null,
    sourceNormalizedName: finalSourceTag?.normalizedName ?? null,
    destinationDisplayName: finalDestinationTag?.displayName ?? null,
    destinationNormalizedName: finalDestinationTag?.normalizedName ?? null,
    survivorDisplayName: survivorTag?.displayName ?? null,
    survivorNormalizedName: survivorTag?.normalizedName ?? null,
    sourceDeleted,
    affectedCount: plan.affectedCount,
    associationAdds: plan.associationAdds,
    associationRemoves: plan.associationRemoves,
    duplicateCollapses: plan.duplicateCollapses,
    tagCreates: plan.tagCreates,
    tagDeletes: plan.tagDeletes,
    displayOnly: plan.displayOnly,
    versionUpdateCount,
    commitTimestamp,
    appliedFingerprint,
  }
}

const MAX_TAG_APPLY_AUDIT_STRING_LENGTH = 256

function boundedAuditString(value: string | null): string | null {
  if (value === null) return null
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, MAX_TAG_APPLY_AUDIT_STRING_LENGTH)
}

function auditTagView(tag: TagRowView | null): { id: number; displayName: string; normalizedName: string } | null {
  if (!tag) return null
  return {
    id: tag.id,
    displayName: boundedAuditString(tag.displayName)!,
    normalizedName: boundedAuditString(tag.normalizedName)!,
  }
}

function buildTagManagementApplyAuditEvent(result: TagOperationApplyResult): Record<string, unknown> {
  const operation = result.operation.kind === 'rename'
    ? {
        kind: 'rename' as const,
        sourceTagId: result.operation.sourceTagId,
        destinationName: boundedAuditString(result.operation.destinationName)!,
      }
    : result.operation.kind === 'merge'
      ? {
          kind: 'merge' as const,
          sourceTagId: result.operation.sourceTagId,
          destinationTagId: result.operation.destinationTagId,
        }
      : {
          kind: 'remove' as const,
          sourceTagId: result.operation.sourceTagId,
        }

  return {
    operationId: result.operationId,
    resultId: result.resultId,
    kind: result.kind,
    operation,
    sourceTagId: result.sourceTagId,
    destinationTagId: result.destinationTagId,
    survivorTagId: result.survivorTagId,
    sourceTag: auditTagView(result.sourceTag),
    destinationTag: auditTagView(result.destinationTag),
    survivorTag: auditTagView(result.survivorTag),
    sourceDisplayName: boundedAuditString(result.sourceDisplayName),
    sourceNormalizedName: boundedAuditString(result.sourceNormalizedName),
    destinationDisplayName: boundedAuditString(result.destinationDisplayName),
    destinationNormalizedName: boundedAuditString(result.destinationNormalizedName),
    survivorDisplayName: boundedAuditString(result.survivorDisplayName),
    survivorNormalizedName: boundedAuditString(result.survivorNormalizedName),
    sourceDeleted: result.sourceDeleted,
    affectedCount: result.affectedCount,
    associationAdds: result.associationAdds,
    associationRemoves: result.associationRemoves,
    duplicateCollapses: result.duplicateCollapses,
    tagCreates: result.tagCreates,
    tagDeletes: result.tagDeletes,
    displayOnly: result.displayOnly,
    versionUpdateCount: result.versionUpdateCount,
    commitTimestamp: result.commitTimestamp,
    appliedFingerprint: result.appliedFingerprint,
  }
}

function logAppliedTagOperation(result: TagOperationApplyResult): void {
  const logResult = buildTagManagementApplyAuditEvent(result)
  try {
    console.info('[tag-management-apply]', JSON.stringify(logResult))
  } catch {
    // The SQLite commit is authoritative. Logging failure must not turn a
    // committed operation into a reported rollback.
  }
}

function transactionFailed(): TagManagementError {
  return new TagManagementError('TRANSACTION_FAILED', 'tag management operation failed')
}

/**
 * Apply one reviewed operation. Discovery is a short deferred read; the
 * mutation authority is the one synchronous IMMEDIATE transaction executed
 * while every currently affected document path lock is held.
 */
export async function applyTagOperation(
  db: DatabaseT,
  operationInput: TagOperationRequest,
  planFingerprint: string,
): Promise<TagOperationApplyResult> {
  if (!isPlanFingerprint(planFingerprint)) {
    throw new TagManagementError('PREVIEW_REQUIRED', 'a current Preview fingerprint is required')
  }
  let operation: TagOperationRequest
  try {
    operation = parseTagOperation(operationInput).operation
  } catch (error) {
    if (error instanceof TagManagementError) throw error
    throw transactionFailed()
  }

  let discovery: TagOperationPlanState
  try {
    const discoveryTransaction = db.transaction(() => buildTagOperationPlanState(db, operation))
    discovery = discoveryTransaction()
    applyTestHooks?.afterDiscovery?.(discovery)
  } catch (error) {
    if (error instanceof TagManagementError) throw error
    throw transactionFailed()
  }
  if (!hasRequiredResolution(operation, discovery.resolution)
    || discovery.planFingerprint !== planFingerprint) {
    throw new TagManagementError('PREVIEW_STALE', 'preview is stale')
  }

  const operationId = randomUUID()
  const paths = discovery.affectedDocuments.map((document) => document.path)
  try {
    const result = await withDocumentWriteLocks(paths, async () => {
      applyTestHooks?.afterLocks?.(paths)
      const mutation = db.transaction(() => {
        const lockedState = buildTagOperationPlanState(db, operation)
        if (!hasRequiredResolution(operation, lockedState.resolution)
          || lockedState.planFingerprint !== planFingerprint) {
          throw new TagManagementError('PREVIEW_STALE', 'preview is stale')
        }
        const plan = lockedState as TagOperationPlan
        if (!plan.allowedToApply) conflictFromApplyPlan(plan)

        const commitTimestamp = Date.now()
        const recording = beginTagUndoRecording(
          db,
          operation,
          plan,
          operationId,
          commitTimestamp,
          (stage) => throwInjectedApplyFailure(stage),
        )
        captureTagUndoRemovedSourceDeltas(db, recording)
        stageTagUndoMergeSourceOnlyDocuments(db, recording)
        captureApplyAffectedDocuments(db, plan, commitTimestamp)
        let beforeDestinationAssociationCount: number | null = null
        if (plan.operation.kind === 'merge') {
          beforeDestinationAssociationCount = (db.prepare(`
            SELECT COUNT(*) AS count
            FROM document_tags
            WHERE tag_id = ?
          `).get(plan.operation.destinationTagId) as { count: number }).count
        }

        const versionUpdate = db.prepare(`
          UPDATE documents
          SET updated_at = CASE
            WHEN updated_at + 1 > ? THEN updated_at + 1
            ELSE ?
          END
          WHERE id IN (
            SELECT document_id
            FROM document_tags
            WHERE tag_id = ?
          )
        `).run(commitTimestamp, commitTimestamp, plan.operation.sourceTagId)
        if (versionUpdate.changes !== plan.affectedCount) {
          throw transactionFailed()
        }
        updateTagUndoVersionCount(db, recording, versionUpdate.changes)
        throwInjectedApplyFailure('after-version-update')

        if (plan.operation.kind === 'rename') {
          const tagUpdate = plan.displayOnly
            ? db.prepare(`
                UPDATE tags
                SET name = ?
                WHERE id = ?
              `).run(plan.requestedDestination!.displayName, plan.sourceTag.id)
            : db.prepare(`
                UPDATE tags
                SET name = ?, normalized_name = ?
                WHERE id = ?
              `).run(
                plan.requestedDestination!.displayName,
                plan.requestedDestination!.normalizedName,
                plan.sourceTag.id,
              )
          if (tagUpdate.changes !== 1) throw transactionFailed()
        } else if (plan.operation.kind === 'merge') {
          const insertAssociations = db.prepare(`
            INSERT INTO document_tags (document_id, tag_id)
            SELECT document_id, ?
            FROM document_tags
            WHERE tag_id = ?
            ON CONFLICT(document_id, tag_id) DO NOTHING
          `).run(plan.operation.destinationTagId, plan.operation.sourceTagId)
          if (insertAssociations.changes !== plan.associationAdds) throw transactionFailed()
          captureTagUndoCreatedDestinationDeltas(db, recording)
          const deleteAssociations = db.prepare('DELETE FROM document_tags WHERE tag_id = ?')
            .run(plan.operation.sourceTagId)
          if (deleteAssociations.changes !== plan.associationRemoves) throw transactionFailed()
          throwInjectedApplyFailure('after-association-mutation')
          const deleteSource = db.prepare('DELETE FROM tags WHERE id = ?').run(plan.operation.sourceTagId)
          if (deleteSource.changes !== 1) throw transactionFailed()
        } else {
          const deleteAssociations = db.prepare('DELETE FROM document_tags WHERE tag_id = ?')
            .run(plan.operation.sourceTagId)
          if (deleteAssociations.changes !== plan.associationRemoves) throw transactionFailed()
          throwInjectedApplyFailure('after-association-mutation')
          const deleteSource = db.prepare('DELETE FROM tags WHERE id = ?').run(plan.operation.sourceTagId)
          if (deleteSource.changes !== 1) throw transactionFailed()
        }
        throwInjectedApplyFailure('after-tag-row-mutation')
        applyTestHooks?.beforePostcondition?.(db, plan)
        throwInjectedApplyFailure('before-postcondition')
        assertApplyPostconditions(
          db,
          plan,
          beforeDestinationAssociationCount,
        )
        finalizeTagUndoRecording(db, recording)
        const finalSourceTag = plan.operation.kind === 'merge' || plan.operation.kind === 'remove'
          ? null
          : readApplyTag(db, plan.sourceTag.id)
        const finalDestinationTag = plan.operation.kind === 'merge'
          ? readApplyTag(db, plan.operation.destinationTagId)
          : null
        const result = buildApplyResult(
          operationId,
          plan,
          commitTimestamp,
          versionUpdate.changes,
          planFingerprint,
          finalSourceTag,
          finalDestinationTag,
        )
        db.exec(`DROP TABLE IF EXISTS temp.${APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE}`)
        throwInjectedApplyFailure('before-commit')
        return result
      })
      return mutation.immediate()
    })
    logAppliedTagOperation(result)
    try {
      applyTestHooks?.afterCommit?.(result)
    } catch {
      // A test observer is not transaction authority; the commit already
      // succeeded and the response must not claim that it was rolled back.
    }
    return result
  } catch (error) {
    if (error instanceof TagManagementError) throw error
    if (error instanceof TagUndoRecordingError) {
      throw new TagManagementError(error.code, error.message, error.details)
    }
    throw transactionFailed()
  }
}
