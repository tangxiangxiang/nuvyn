import { createHash, randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import type {
  TagOperationPlan,
  TagOperationRequest,
  TagRowView,
} from './tagManagement.js'
import { withDocumentWriteLocks } from './documentWriteLock.js'
import { MetadataVersionError, nextMetadataUpdatedAt } from './metadataVersion.js'
import {
  initializeTagUndoFoundationHealth,
  TAG_UNDO_FOUNDATION_SCHEMA_VERSION,
  TAG_UNDO_RECORD_CONTRACT_VERSION,
  UNDO_FINGERPRINT_CONTRACT_VERSION,
} from './tagUndoHealth.js'
import {
  TAG_IDENTITY_CONTRACT_VERSION,
  validatePersistentTag,
} from '../shared/tagNormalization.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'

export type TagUndoRecordingFailureStage =
  | 'parent-insert'
  | 'removed-source-capture'
  | 'merge-source-staging'
  | 'created-destination-capture'
  | 'state-current-record'
  | 'state-last-superseded'
  | 'old-target-delete'
  | 'final-postcondition'

export type TagUndoRecordingFailureInjector = (stage: TagUndoRecordingFailureStage) => void

export type TagUndoRecordingErrorCode =
  | 'TAG_MANAGEMENT_UNAVAILABLE'
  | 'TRANSACTION_FAILED'

export class TagUndoRecordingError extends Error {
  readonly code: TagUndoRecordingErrorCode
  readonly details: Record<string, string | number | null>

  constructor(
    code: TagUndoRecordingErrorCode,
    message: string,
    details: Record<string, string | number | null> = {},
  ) {
    super(message)
    this.name = 'TagUndoRecordingError'
    this.code = code
    this.details = details
  }
}

type FoundationStateRow = {
  database_generation: string
  current_record_id: string | null
  last_superseded_record_id: string | null
}

export type TagUndoRecordingContext = {
  recordId: string
  originalOperationId: string
  originalResultId: string
  databaseGeneration: string
  previousRecordId: string | null
  operation: TagOperationRequest
  plan: TagOperationPlan
  committedAt: number
  fail?: TagUndoRecordingFailureInjector
}

const MERGE_SOURCE_DOCUMENTS_TEMP_TABLE = 'tag_undo_merge_source_documents'

function transactionFailed(message: string): never {
  throw new TagUndoRecordingError('TRANSACTION_FAILED', message)
}

function assertChanges(changes: number, expected: number, message: string): void {
  if (changes !== expected) transactionFailed(message)
}

function readFoundationState(db: DatabaseT): FoundationStateRow {
  const state = db.prepare(`
    SELECT database_generation, current_record_id, last_superseded_record_id
    FROM tag_undo_state
    WHERE state_id = 1
  `).get() as FoundationStateRow | undefined
  if (!state) transactionFailed('tag Undo foundation state is missing')
  return state
}

function canonicalOperationJson(operation: TagOperationRequest): string {
  if (operation.kind === 'rename') {
    return JSON.stringify({
      kind: 'rename',
      sourceTagId: operation.sourceTagId,
      destinationName: operation.destinationName,
    })
  }
  if (operation.kind === 'merge') {
    return JSON.stringify({
      kind: 'merge',
      sourceTagId: operation.sourceTagId,
      destinationTagId: operation.destinationTagId,
    })
  }
  return JSON.stringify({
    kind: 'remove',
    sourceTagId: operation.sourceTagId,
  })
}

function assertRecordingHealth(db: DatabaseT): FoundationStateRow {
  const health = initializeTagUndoFoundationHealth(db)
  if (health.state !== 'healthy') {
    throw new TagUndoRecordingError(
      'TAG_MANAGEMENT_UNAVAILABLE',
      'tag management reversible-record health is unavailable',
      { healthCode: health.code ?? 'TAG_UNDO_FOUNDATION_UNHEALTHY' },
    )
  }
  return readFoundationState(db)
}

function parentFields(
  operation: TagOperationRequest,
  plan: TagOperationPlan,
): {
  sourceAfterExists: number
  sourceAfterName: string | null
  sourceAfterNormalizedName: string | null
  destinationBeforeName: string | null
  destinationBeforeNormalizedName: string | null
  destinationAfterName: string | null
  destinationAfterNormalizedName: string | null
} {
  const sourceAfter = operation.kind === 'rename'
    ? plan.requestedDestination
    : null
  const destination = operation.kind === 'merge' ? plan.destinationTag : null
  return {
    sourceAfterExists: sourceAfter ? 1 : 0,
    sourceAfterName: sourceAfter?.displayName ?? null,
    sourceAfterNormalizedName: sourceAfter?.normalizedName ?? null,
    destinationBeforeName: destination?.displayName ?? null,
    destinationBeforeNormalizedName: destination?.normalizedName ?? null,
    destinationAfterName: destination?.displayName ?? null,
    destinationAfterNormalizedName: destination?.normalizedName ?? null,
  }
}

/**
 * Begin the durable record inside the existing Apply transaction. The health
 * check is deliberately fresh: startup health is not sufficient protection
 * against a later database drift.
 */
export function beginTagUndoRecording(
  db: DatabaseT,
  operation: TagOperationRequest,
  plan: TagOperationPlan,
  operationId: string,
  committedAt: number,
  fail?: TagUndoRecordingFailureInjector,
): TagUndoRecordingContext {
  const state = assertRecordingHealth(db)
  const recordId = randomUUID()
  const fields = parentFields(operation, plan)
  const inserted = db.prepare(`
    INSERT INTO tag_undo_records (
      record_id,
      original_operation_id,
      original_result_id,
      kind,
      display_only,
      identity_contract_version,
      record_contract_version,
      database_generation,
      operation_json,
      committed_at,
      source_tag_id,
      source_before_name,
      source_before_normalized_name,
      source_after_exists,
      source_after_name,
      source_after_normalized_name,
      destination_tag_id,
      destination_before_name,
      destination_before_normalized_name,
      destination_after_name,
      destination_after_normalized_name,
      lifecycle,
      terminal_code,
      undo_operation_id,
      undo_result_id,
      consumed_at,
      association_remove_count,
      association_add_count,
      version_update_count
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'latest', NULL, NULL, NULL, NULL, ?, ?, ?
    )
  `).run(
    recordId,
    operationId,
    operationId,
    operation.kind,
    plan.displayOnly ? 1 : 0,
    TAG_IDENTITY_CONTRACT_VERSION,
    TAG_UNDO_RECORD_CONTRACT_VERSION,
    state.database_generation,
    canonicalOperationJson(operation),
    committedAt,
    plan.sourceTag.id,
    plan.sourceTag.displayName,
    plan.sourceTag.normalizedName,
    fields.sourceAfterExists,
    fields.sourceAfterName,
    fields.sourceAfterNormalizedName,
    operation.kind === 'merge' ? operation.destinationTagId : null,
    fields.destinationBeforeName,
    fields.destinationBeforeNormalizedName,
    fields.destinationAfterName,
    fields.destinationAfterNormalizedName,
    plan.associationRemoves,
    plan.associationAdds,
    plan.affectedCount,
  )
  assertChanges(inserted.changes, 1, 'reversible parent record was not created')
  fail?.('parent-insert')
  return {
    recordId,
    originalOperationId: operationId,
    originalResultId: operationId,
    databaseGeneration: state.database_generation,
    previousRecordId: state.current_record_id,
    operation,
    plan,
    committedAt,
    fail,
  }
}

export function captureTagUndoRemovedSourceDeltas(
  db: DatabaseT,
  context: TagUndoRecordingContext,
): void {
  if (context.operation.kind === 'rename') return
  const inserted = db.prepare(`
    INSERT INTO tag_undo_association_deltas (
      record_id, effect, association_id, document_id, tag_id
    )
    SELECT ?, 'removed-source', association_id, document_id, tag_id
    FROM document_tags
    WHERE tag_id = ?
    ORDER BY association_id
  `).run(context.recordId, context.operation.sourceTagId)
  assertChanges(
    inserted.changes,
    context.plan.associationRemoves,
    'removed-source reversible delta count mismatched',
  )
  context.fail?.('removed-source-capture')
}

export function stageTagUndoMergeSourceOnlyDocuments(
  db: DatabaseT,
  context: TagUndoRecordingContext,
): void {
  if (context.operation.kind !== 'merge') return
  db.exec(`
    DROP TABLE IF EXISTS temp.${MERGE_SOURCE_DOCUMENTS_TEMP_TABLE};
    CREATE TEMP TABLE ${MERGE_SOURCE_DOCUMENTS_TEMP_TABLE} (
      document_id TEXT PRIMARY KEY
    ) WITHOUT ROWID;
  `)
  const staged = db.prepare(`
    INSERT INTO temp.${MERGE_SOURCE_DOCUMENTS_TEMP_TABLE} (document_id)
    SELECT source.document_id
    FROM document_tags source
    WHERE source.tag_id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM document_tags destination
        WHERE destination.document_id = source.document_id
          AND destination.tag_id = ?
      )
    ORDER BY source.document_id COLLATE BINARY
  `).run(context.operation.sourceTagId, context.operation.destinationTagId)
  assertChanges(staged.changes, context.plan.associationAdds, 'Merge source-only staging count mismatched')
  context.fail?.('merge-source-staging')
}

export function captureTagUndoCreatedDestinationDeltas(
  db: DatabaseT,
  context: TagUndoRecordingContext,
): void {
  if (context.operation.kind !== 'merge') return
  const inserted = db.prepare(`
    INSERT INTO tag_undo_association_deltas (
      record_id, effect, association_id, document_id, tag_id
    )
    SELECT ?, 'created-destination', destination.association_id,
           destination.document_id, destination.tag_id
    FROM document_tags destination
    JOIN temp.${MERGE_SOURCE_DOCUMENTS_TEMP_TABLE} source_only
      ON source_only.document_id = destination.document_id
    WHERE destination.tag_id = ?
    ORDER BY destination.association_id
  `).run(context.recordId, context.operation.destinationTagId)
  assertChanges(
    inserted.changes,
    context.plan.associationAdds,
    'created-destination reversible delta count mismatched',
  )
  context.fail?.('created-destination-capture')
}

export function updateTagUndoVersionCount(
  db: DatabaseT,
  context: TagUndoRecordingContext,
  versionUpdateCount: number,
): void {
  if (!Number.isSafeInteger(versionUpdateCount) || versionUpdateCount < 0
    || versionUpdateCount !== context.plan.affectedCount) {
    transactionFailed('reversible version count mismatched')
  }
  const updated = db.prepare(`
    UPDATE tag_undo_records
    SET version_update_count = ?
    WHERE record_id = ?
  `).run(versionUpdateCount, context.recordId)
  assertChanges(updated.changes, 1, 'reversible version count was not persisted')
}

function assertTagUndoDeltaCounts(db: DatabaseT, context: TagUndoRecordingContext): void {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tag_undo_association_deltas
       WHERE record_id = ? AND effect = 'removed-source') AS removed_count,
      (SELECT COUNT(*) FROM tag_undo_association_deltas
       WHERE record_id = ? AND effect = 'created-destination') AS added_count
  `).get(context.recordId, context.recordId) as { removed_count: number; added_count: number }
  if (row.removed_count !== context.plan.associationRemoves
    || row.added_count !== context.plan.associationAdds) {
    transactionFailed('reversible association delta counts mismatched')
  }
}

function assertCurrentRecordPostcondition(db: DatabaseT, context: TagUndoRecordingContext): void {
  const state = readFoundationState(db)
  const parentCount = (db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get() as { count: number }).count
  const parent = db.prepare(`
    SELECT record_id, original_operation_id, original_result_id,
           database_generation, kind, display_only, lifecycle,
           association_remove_count, association_add_count,
           version_update_count
    FROM tag_undo_records
    WHERE record_id = ?
  `).get(context.recordId) as {
    record_id: string
    original_operation_id: string
    original_result_id: string
    database_generation: string
    kind: string
    display_only: number
    lifecycle: string
    association_remove_count: number
    association_add_count: number
    version_update_count: number
  } | undefined
  if (parentCount !== 1 || !parent
    || state.current_record_id !== context.recordId
    || state.database_generation !== context.databaseGeneration
    || parent.original_operation_id !== context.originalOperationId
    || parent.original_result_id !== context.originalResultId
    || parent.database_generation !== context.databaseGeneration
    || parent.kind !== context.operation.kind
    || parent.display_only !== (context.plan.displayOnly ? 1 : 0)
    || parent.lifecycle !== 'latest'
    || parent.association_remove_count !== context.plan.associationRemoves
    || parent.association_add_count !== context.plan.associationAdds
    || parent.version_update_count !== context.plan.affectedCount) {
    transactionFailed('reversible record postcondition failed')
  }
  assertTagUndoDeltaCounts(db, context)
}

/**
 * Atomically make the new record current and retire the previous heavy target.
 * The pointer is moved before the old parent is deleted so foreign keys remain
 * valid throughout the transaction.
 */
export function finalizeTagUndoRecording(
  db: DatabaseT,
  context: TagUndoRecordingContext,
): void {
  assertTagUndoDeltaCounts(db, context)
  const currentState = readFoundationState(db)
  if (currentState.database_generation !== context.databaseGeneration
    || currentState.current_record_id !== context.previousRecordId) {
    transactionFailed('tag Undo state changed during Apply')
  }

  const currentUpdate = currentState.current_record_id === null
    ? db.prepare(`
        UPDATE tag_undo_state
        SET current_record_id = ?
        WHERE state_id = 1
          AND database_generation = ?
          AND current_record_id IS NULL
      `).run(context.recordId, context.databaseGeneration)
    : db.prepare(`
        UPDATE tag_undo_state
        SET current_record_id = ?
        WHERE state_id = 1
          AND database_generation = ?
          AND current_record_id = ?
      `).run(context.recordId, context.databaseGeneration, context.previousRecordId)
  assertChanges(currentUpdate.changes, 1, 'current reversible target transition failed')
  context.fail?.('state-current-record')

  const lastSupersededUpdate = db.prepare(`
    UPDATE tag_undo_state
    SET last_superseded_record_id = ?, updated_at = ?
    WHERE state_id = 1
      AND database_generation = ?
      AND current_record_id = ?
  `).run(
    context.previousRecordId,
    context.committedAt,
    context.databaseGeneration,
    context.recordId,
  )
  assertChanges(lastSupersededUpdate.changes, 1, 'last superseded target transition failed')
  context.fail?.('state-last-superseded')

  if (context.previousRecordId !== null) {
    const deleted = db.prepare('DELETE FROM tag_undo_records WHERE record_id = ?')
      .run(context.previousRecordId)
    assertChanges(deleted.changes, 1, 'previous reversible target deletion failed')
    context.fail?.('old-target-delete')
  }

  db.exec(`DROP TABLE IF EXISTS temp.${MERGE_SOURCE_DOCUMENTS_TEMP_TABLE}`)
  const finalHealth = initializeTagUndoFoundationHealth(db)
  if (finalHealth.state !== 'healthy') {
    transactionFailed('final reversible-record state is unhealthy')
  }
  assertCurrentRecordPostcondition(db, context)
  context.fail?.('final-postcondition')
}

export { TAG_UNDO_FOUNDATION_SCHEMA_VERSION, UNDO_FINGERPRINT_CONTRACT_VERSION }

/** The initial Preview sample is deliberately smaller than a page. */
export const TAG_UNDO_PREVIEW_SAMPLE_LIMIT = 20
export const TAG_UNDO_PREVIEW_PAGE_MAX_LIMIT = 100

export type TagUndoAvailabilityState =
  | 'unavailable'
  | 'available'
  | 'consumed'
  | 'superseded'
  | 'terminal-unavailable'

export type TagUndoValidation =
  | 'safe'
  | 'conflict'
  | 'temporary-unavailable'
  | 'stale'
  | 'terminal-unavailable'

export type TagUndoWarningCode = 'DESTRUCTIVE' | 'HIGH_IMPACT' | 'DYNAMIC_CONFLICT'

export type TagUndoPreviewDocument = {
  id: string
  path: string
  title: string
}

export type TagUndoAssociationScope = {
  associationId: number
  documentId: string
  tagId: number
}

export type TagUndoAvailability = {
  supported: true
  state: TagUndoAvailabilityState
  validation: TagUndoValidation
  recordId: string | null
  originalOperationId: string | null
  originalResultId: string | null
  kind: TagOperationRequest['kind'] | null
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

export type TagUndoPreview = TagUndoAvailability & {
  warnings: TagUndoWarningCode[]
  sample: TagUndoPreviewDocument[]
  nextCursor: string | null
  /** Kept named like the existing Tag Management preview continuation. */
  nextAfterDocumentId: string | null
  undoFingerprint: string | null
  undoContractVersion: typeof UNDO_FINGERPRINT_CONTRACT_VERSION
  allowedToApply: boolean
}

/**
 * This is intentionally not wire-shaped.  The complete document and
 * association scope is retained only in this server-internal plan so a
 * future Apply implementation can re-use the same authoritative discovery.
 */
export type TagUndoPlan = TagUndoPreview & {
  requiredDocumentIds: string[]
  requiredDocuments: TagUndoPreviewDocument[]
  affectedDocumentIds: string[]
  affectedDocuments: TagUndoPreviewDocument[]
  operationOwnedAssociations: TagUndoAssociationScope[]
  requiredAssociations: TagUndoAssociationScope[]
  currentRequiredTagRows: TagRowView[]
  currentCreatedDestinationAssociations: TagUndoAssociationScope[]
  conflictCodes: string[]
}

export type TagUndoPreviewOptions = {
  recordId?: string | null
  limit?: number
}

export type TagUndoPreviewPageRequest = {
  recordId?: string | null
  undoFingerprint: string
  afterDocumentId?: string | null
  limit?: number
}

export type TagUndoPlannerErrorCode =
  | 'INVALID_PREVIEW'
  | 'UNDO_STALE'
  | 'UNDO_CONFLICT'
  | 'UNDO_TARGET_UNAVAILABLE'
  | 'UNDO_UNAVAILABLE'
  | 'UNDO_SUPERSEDED'
  | 'UNDO_ALREADY_APPLIED'
  | 'UNDO_RECORD_CORRUPT'
  | 'TAG_MANAGEMENT_UNAVAILABLE'
  | 'diary-private-metadata-unsupported'
  | 'TRANSACTION_FAILED'

export class TagUndoPlannerError extends Error {
  readonly code: TagUndoPlannerErrorCode
  readonly details: Record<string, string | number | null>

  constructor(
    code: TagUndoPlannerErrorCode,
    message: string,
    details: Record<string, string | number | null> = {},
  ) {
    super(message)
    this.name = 'TagUndoPlannerError'
    this.code = code
    this.details = details
  }
}

export type TagUndoApplyInput = {
  recordId: string
  undoFingerprint: string
}

export type TagUndoApplyResult = {
  undoOperationId: string
  undoResultId: string
  recordId: string
  originalOperationId: string
  originalResultId: string
  kind: TagOperationRequest['kind']
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

export type TagUndoApplyFailureStage =
  | 'after-transactional-replan'
  | 'after-version-staging'
  | 'after-source-row-restore'
  | 'after-created-destination-delete'
  | 'after-source-association-restore'
  | 'after-version-update'
  | 'after-inverse-postcondition'
  | 'after-consumed-parent-update'
  | 'after-child-delta-purge'
  | 'after-final-postcondition'
  | 'before-commit'

export type TagUndoApplyTestHooks = {
  afterDiscovery?: (plan: TagUndoPlan) => void
  afterLocks?: (paths: readonly string[]) => void | Promise<void>
  failureStage?: TagUndoApplyFailureStage | null
}

let undoApplyTestHooks: TagUndoApplyTestHooks | null = null

/** Test-only seams for proving the T2.1-3 transaction and lock contract. */
export function __setTagUndoApplyHooksForTesting(
  hooks: TagUndoApplyTestHooks | null,
): void {
  undoApplyTestHooks = hooks
}

type TagUndoRecordRow = {
  record_id: string
  original_operation_id: string
  original_result_id: string
  kind: string
  display_only: number
  identity_contract_version: string
  record_contract_version: string
  database_generation: string
  operation_json: string
  committed_at: number
  source_tag_id: number
  source_before_name: string
  source_before_normalized_name: string
  source_after_exists: number
  source_after_name: string | null
  source_after_normalized_name: string | null
  destination_tag_id: number | null
  destination_before_name: string | null
  destination_before_normalized_name: string | null
  destination_after_name: string | null
  destination_after_normalized_name: string | null
  lifecycle: string
  terminal_code: string | null
  undo_operation_id: string | null
  undo_result_id: string | null
  consumed_at: number | null
  association_remove_count: number
  association_add_count: number
  version_update_count: number
}

type TagUndoStateRead = {
  database_generation: string
  current_record_id: string | null
  last_superseded_record_id: string | null
}

type TagUndoDeltaRow = {
  effect: string
  association_id: number
  document_id: string
  tag_id: number
}

type TagUndoDocumentRow = TagUndoPreviewDocument

type TagUndoDbTagRow = {
  id: number
  name: string
  normalized_name: string
}

type TagRead = {
  row: TagRowView | null
  malformed: boolean
}

type TagUndoRecordViews = {
  sourceBefore: TagRowView
  sourceAfter: TagRowView | null
  destinationBefore: TagRowView | null
  destinationAfter: TagRowView | null
}

type CreatedAssociationEvidence = TagUndoAssociationScope & {
  exactPresent: boolean
  logicalAssociationId: number | null
  exactDocumentId: string | null
  exactTagId: number | null
}

const EMPTY_TAG_UNDO_WARNINGS: TagUndoWarningCode[] = []

function plannerInvalid(message: string): never {
  throw new TagUndoPlannerError('INVALID_PREVIEW', message)
}

function assertPreviewLimit(limit: unknown, max: number, label: string): number {
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0 || limit > max) {
    plannerInvalid(`${label} must be an integer from 1 to ${max}`)
  }
  return limit
}

function assertOptionalRecordId(recordId: unknown): string | undefined {
  if (recordId === undefined || recordId === null) return undefined
  if (typeof recordId !== 'string' || recordId.length < 1 || recordId.length > 128) {
    plannerInvalid('recordId must be a bounded non-empty string')
  }
  return recordId
}

function normalizePreviewOptions(
  value: TagUndoPreviewOptions | string | number | undefined,
  legacyLimit?: number,
): { recordId?: string; limit: number } {
  if (typeof value === 'number') {
    return { limit: assertPreviewLimit(value, TAG_UNDO_PREVIEW_SAMPLE_LIMIT, 'limit') }
  }
  if (typeof value === 'string') {
    return {
      recordId: assertOptionalRecordId(value),
      limit: legacyLimit === undefined
        ? TAG_UNDO_PREVIEW_SAMPLE_LIMIT
        : assertPreviewLimit(legacyLimit, TAG_UNDO_PREVIEW_SAMPLE_LIMIT, 'limit'),
    }
  }
  const recordId = assertOptionalRecordId(value?.recordId)
  const limit = value?.limit === undefined
    ? TAG_UNDO_PREVIEW_SAMPLE_LIMIT
    : assertPreviewLimit(value.limit, TAG_UNDO_PREVIEW_SAMPLE_LIMIT, 'limit')
  return { ...(recordId === undefined ? {} : { recordId }), limit }
}

function normalizePageRequest(
  value: TagUndoPreviewPageRequest | string,
  legacyFingerprint?: string,
  legacyAfterDocumentId?: string | null,
  legacyLimit?: number,
): TagUndoPreviewPageRequest {
  if (typeof value === 'string') {
    const recordId = assertOptionalRecordId(value)
    if (typeof legacyFingerprint !== 'string') plannerInvalid('undoFingerprint is required')
    return {
      ...(recordId === undefined ? {} : { recordId }),
      undoFingerprint: legacyFingerprint,
      ...(legacyAfterDocumentId === undefined ? {} : { afterDocumentId: legacyAfterDocumentId }),
      limit: legacyLimit,
    }
  }
  return value
}

function compareUndoDocumentIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isSha256Fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function tagViewFromDbRow(row: TagUndoDbTagRow): TagRead {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) return { row: null, malformed: true }
  const validation = validatePersistentTag(row.name)
  if (!validation.ok || validation.displayName !== row.name || validation.normalizedName !== row.normalized_name) {
    return { row: null, malformed: true }
  }
  return {
    row: {
      id: row.id,
      displayName: row.name,
      normalizedName: row.normalized_name,
    },
    malformed: false,
  }
}

function readTagById(db: DatabaseT, id: number): TagRead {
  const row = db.prepare(`
    SELECT id, name, normalized_name
    FROM tags
    WHERE id = ?
  `).get(id) as TagUndoDbTagRow | undefined
  return row ? tagViewFromDbRow(row) : { row: null, malformed: false }
}

function readTagByNormalizedName(db: DatabaseT, normalizedName: string): TagRead {
  const rows = db.prepare(`
    SELECT id, name, normalized_name
    FROM tags
    WHERE normalized_name = ? COLLATE BINARY
    ORDER BY id
  `).all(normalizedName) as TagUndoDbTagRow[]
  if (rows.length > 1) return { row: null, malformed: true }
  return rows[0] ? tagViewFromDbRow(rows[0]) : { row: null, malformed: false }
}

function sameTagView(left: TagRowView | null, right: TagRowView | null): boolean {
  return left?.id === right?.id
    && left?.displayName === right?.displayName
    && left?.normalizedName === right?.normalizedName
}

function storedTagView(
  id: number,
  displayName: string | null,
  normalizedName: string | null,
): TagRowView | null {
  if (displayName === null || normalizedName === null) return null
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const validation = validatePersistentTag(displayName)
  if (!validation.ok || validation.displayName !== displayName || validation.normalizedName !== normalizedName) {
    return null
  }
  return { id, displayName, normalizedName }
}

function readRecordViews(record: TagUndoRecordRow): TagUndoRecordViews | null {
  const sourceBefore = storedTagView(
    record.source_tag_id,
    record.source_before_name,
    record.source_before_normalized_name,
  )
  if (!sourceBefore) return null
  const sourceAfter = record.source_after_exists === 1
    ? storedTagView(record.source_tag_id, record.source_after_name, record.source_after_normalized_name)
    : record.source_after_exists === 0
      && record.source_after_name === null
      && record.source_after_normalized_name === null
      ? null
      : undefined
  if (sourceAfter === undefined) return null
  if (record.kind === 'merge') {
    const destinationTagId = record.destination_tag_id
    if (typeof destinationTagId !== 'number' || !Number.isSafeInteger(destinationTagId) || destinationTagId <= 0) return null
    const destinationBefore = storedTagView(
      destinationTagId,
      record.destination_before_name,
      record.destination_before_normalized_name,
    )
    const destinationAfter = storedTagView(
      destinationTagId,
      record.destination_after_name,
      record.destination_after_normalized_name,
    )
    if (!destinationBefore || !destinationAfter || !sameTagView(destinationBefore, destinationAfter)) return null
    return { sourceBefore, sourceAfter, destinationBefore, destinationAfter }
  }
  if (record.destination_tag_id !== null
    || record.destination_before_name !== null
    || record.destination_before_normalized_name !== null
    || record.destination_after_name !== null
    || record.destination_after_normalized_name !== null) return null
  return { sourceBefore, sourceAfter, destinationBefore: null, destinationAfter: null }
}

function parsedOperationIsCanonical(record: TagUndoRecordRow, views: TagUndoRecordViews): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(record.operation_json)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const value = parsed as Record<string, unknown>
  const keys = Object.keys(value).sort().join('\0')
  if (record.kind === 'rename') {
    if (keys !== ['destinationName', 'kind', 'sourceTagId'].join('\0')
      || value.kind !== 'rename'
      || value.sourceTagId !== record.source_tag_id
      || typeof value.destinationName !== 'string') return false
    const destination = validatePersistentTag(value.destinationName)
    return destination.ok
      && views.sourceAfter !== null
      && destination.displayName === views.sourceAfter.displayName
      && destination.normalizedName === views.sourceAfter.normalizedName
  }
  if (record.kind === 'merge') {
    return keys === ['destinationTagId', 'kind', 'sourceTagId'].join('\0')
      && value.kind === 'merge'
      && value.sourceTagId === record.source_tag_id
      && value.destinationTagId === record.destination_tag_id
      && Number.isSafeInteger(value.destinationTagId)
      && Number(value.destinationTagId) > 0
  }
  return keys === ['kind', 'sourceTagId'].join('\0')
    && value.kind === 'remove'
    && value.sourceTagId === record.source_tag_id
}

function recordStructureIsSupported(record: TagUndoRecordRow, views: TagUndoRecordViews): boolean {
  if (record.kind !== 'rename' && record.kind !== 'merge' && record.kind !== 'remove') return false
  if (record.kind === 'rename') {
    if (record.display_only !== 0 && record.display_only !== 1
      || record.association_remove_count !== 0
      || record.association_add_count !== 0
      || views.sourceAfter === null) return false
    if (record.display_only === 1 && views.sourceBefore.normalizedName !== views.sourceAfter.normalizedName) return false
  } else if (record.display_only !== 0 || views.sourceAfter !== null) {
    return false
  }
  if (record.kind === 'remove'
    && (record.destination_tag_id !== null || record.association_add_count !== 0)) return false
  return parsedOperationIsCanonical(record, views)
}

function readUndoState(db: DatabaseT): TagUndoStateRead | null {
  const state = db.prepare(`
    SELECT database_generation, current_record_id, last_superseded_record_id
    FROM tag_undo_state
    WHERE state_id = 1
  `).get() as TagUndoStateRead | undefined
  return state ?? null
}

function readCurrentRecord(db: DatabaseT, recordId: string): TagUndoRecordRow | null {
  return (db.prepare(`
    SELECT record_id, original_operation_id, original_result_id, kind,
           display_only, identity_contract_version, record_contract_version,
           database_generation, operation_json, committed_at, source_tag_id,
           source_before_name, source_before_normalized_name,
           source_after_exists, source_after_name,
           source_after_normalized_name, destination_tag_id,
           destination_before_name, destination_before_normalized_name,
           destination_after_name, destination_after_normalized_name,
           lifecycle, terminal_code, undo_operation_id, undo_result_id,
           consumed_at, association_remove_count, association_add_count,
           version_update_count
    FROM tag_undo_records
    WHERE record_id = ?
  `).get(recordId) as TagUndoRecordRow | undefined) ?? null
}

function readCurrentRecordDeltas(db: DatabaseT, recordId: string): TagUndoDeltaRow[] {
  return db.prepare(`
    SELECT effect, association_id, document_id, tag_id
    FROM tag_undo_association_deltas
    WHERE record_id = ?
    ORDER BY effect COLLATE BINARY, association_id
  `).all(recordId) as TagUndoDeltaRow[]
}

function readRenameDocuments(db: DatabaseT, tagId: number): TagUndoDocumentRow[] {
  return db.prepare(`
    SELECT DISTINCT d.id, d.path, d.title
    FROM documents d
    JOIN document_tags dt ON dt.document_id = d.id
    WHERE dt.tag_id = ?
    ORDER BY d.id COLLATE BINARY
  `).all(tagId) as TagUndoDocumentRow[]
}

function assertNoManagedUndoDocuments(documents: readonly TagUndoDocumentRow[]): void {
  if (documents.some((document) => isManagedDiaryPath(document.path))) {
    throw new TagUndoPlannerError(
      'diary-private-metadata-unsupported',
      'tag Undo is unavailable for managed Diary metadata',
    )
  }
}

function readDeltaDocuments(
  db: DatabaseT,
  recordId: string,
  deltas: readonly TagUndoDeltaRow[],
): { ids: string[]; documents: TagUndoDocumentRow[]; missing: string[] } {
  const ids = [...new Set(deltas.map((delta) => delta.document_id))]
    .sort(compareUndoDocumentIds)
  if (ids.length === 0) return { ids, documents: [], missing: [] }
  const rows = db.prepare(`
    WITH required AS (
      SELECT DISTINCT document_id
      FROM tag_undo_association_deltas
      WHERE record_id = ?
    )
    SELECT required.document_id AS required_document_id,
           d.id, d.path, d.title
    FROM required
    LEFT JOIN documents d ON d.id = required.document_id
    ORDER BY required.document_id COLLATE BINARY
  `).all(recordId) as Array<{
    required_document_id: string
    id: string | null
    path: string | null
    title: string | null
  }>
  const documents: TagUndoDocumentRow[] = []
  const missing: string[] = []
  for (const row of rows) {
    if (row.id === null || row.path === null || row.title === null) {
      missing.push(row.required_document_id)
    } else {
      documents.push({ id: row.id, path: row.path, title: row.title })
    }
  }
  return { ids, documents, missing }
}

function readCreatedAssociationEvidence(
  db: DatabaseT,
  recordId: string,
): CreatedAssociationEvidence[] {
  return db.prepare(`
    SELECT
      d.association_id,
      d.document_id,
      d.tag_id,
      exact.association_id IS NOT NULL AS exact_present,
      exact.document_id AS exact_document_id,
      exact.tag_id AS exact_tag_id,
      logical.association_id AS logical_association_id
    FROM tag_undo_association_deltas d
    LEFT JOIN document_tags exact
      ON exact.association_id = d.association_id
    LEFT JOIN document_tags logical
      ON logical.document_id = d.document_id
     AND logical.tag_id = d.tag_id
    WHERE d.record_id = ?
      AND d.effect = 'created-destination'
    ORDER BY d.association_id
  `).all(recordId).map((row) => {
    const value = row as {
      association_id: number
      document_id: string
      tag_id: number
      exact_present: number
      exact_document_id: string | null
      exact_tag_id: number | null
      logical_association_id: number | null
    }
    return {
      associationId: value.association_id,
      documentId: value.document_id,
      tagId: value.tag_id,
      exactPresent: value.exact_present === 1,
      exactDocumentId: value.exact_document_id,
      exactTagId: value.exact_tag_id,
      logicalAssociationId: value.logical_association_id,
    }
  })
}

function inverseCounts(
  record: TagUndoRecordRow,
  deltaRows: readonly TagUndoDeltaRow[],
  affectedCount: number,
): { associationAdds: number; associationRemoves: number; versionUpdateCount: number } {
  const removed = deltaRows.filter((delta) => delta.effect === 'removed-source').length
  const created = deltaRows.filter((delta) => delta.effect === 'created-destination').length
  if (record.kind === 'merge') {
    return { associationAdds: removed, associationRemoves: created, versionUpdateCount: affectedCount }
  }
  if (record.kind === 'remove') {
    return { associationAdds: removed, associationRemoves: 0, versionUpdateCount: affectedCount }
  }
  return { associationAdds: 0, associationRemoves: 0, versionUpdateCount: affectedCount }
}

/**
 * Derive the bounded inverse diagnostic counts directly from the durable parent
 * summary. This is the only correct source for a `consumed` record, because
 * successful Undo legally purges its heavy child deltas in the same transaction.
 * Without this helper Merge/Remove consumed availability would report zero
 * association adds/removes, hiding the historical scope from the post-Undo read
 * model. Latest planner state must still validate child rows.
 */
function inverseCountsFromRecordSummary(
  record: TagUndoRecordRow,
): { associationAdds: number; associationRemoves: number; versionUpdateCount: number } {
  const versionUpdateCount = record.version_update_count
  if (record.kind === 'merge') {
    return {
      associationAdds: record.association_remove_count,
      associationRemoves: record.association_add_count,
      versionUpdateCount,
    }
  }
  if (record.kind === 'remove') {
    return {
      associationAdds: record.association_remove_count,
      associationRemoves: 0,
      versionUpdateCount,
    }
  }
  return { associationAdds: 0, associationRemoves: 0, versionUpdateCount }
}

function warningCodes(
  kind: string | null,
  affectedCount: number,
  validation: TagUndoValidation,
): TagUndoWarningCode[] {
  const warnings: TagUndoWarningCode[] = []
  if (kind === 'merge' || kind === 'remove') warnings.push('DESTRUCTIVE')
  if (affectedCount >= 1000) warnings.push('HIGH_IMPACT')
  if (validation === 'conflict') warnings.push('DYNAMIC_CONFLICT')
  return warnings
}

function baseAvailability(
  state: TagUndoAvailabilityState,
  validation: TagUndoValidation,
  reasonCode: string | null,
  record: TagUndoRecordRow | null = null,
  views: TagUndoRecordViews | null = null,
  counts: { affectedCount?: number; associationAdds?: number; associationRemoves?: number; versionUpdateCount?: number } = {},
): TagUndoAvailability {
  return {
    supported: true,
    state,
    validation,
    recordId: record?.record_id ?? null,
    originalOperationId: record?.original_operation_id ?? null,
    originalResultId: record?.original_result_id ?? null,
    kind: record && (record.kind === 'rename' || record.kind === 'merge' || record.kind === 'remove')
      ? record.kind
      : null,
    displayOnly: record?.display_only === 1,
    committedAt: record?.committed_at ?? null,
    sourceBefore: views?.sourceBefore ?? null,
    sourceAfter: views?.sourceAfter ?? null,
    destinationBefore: views?.destinationBefore ?? null,
    destinationAfter: views?.destinationAfter ?? null,
    affectedCount: counts.affectedCount ?? 0,
    associationAdds: counts.associationAdds ?? 0,
    associationRemoves: counts.associationRemoves ?? 0,
    versionUpdateCount: counts.versionUpdateCount ?? 0,
    reasonCode,
  }
}

function emptyPlan(
  availability: TagUndoAvailability,
  warnings: TagUndoWarningCode[] = EMPTY_TAG_UNDO_WARNINGS,
): TagUndoPlan {
  return {
    ...availability,
    warnings: [...warnings],
    sample: [],
    nextCursor: null,
    nextAfterDocumentId: null,
    undoFingerprint: null,
    undoContractVersion: UNDO_FINGERPRINT_CONTRACT_VERSION,
    allowedToApply: false,
    requiredDocumentIds: [],
    requiredDocuments: [],
    affectedDocumentIds: [],
    affectedDocuments: [],
    operationOwnedAssociations: [],
    requiredAssociations: [],
    currentRequiredTagRows: [],
    currentCreatedDestinationAssociations: [],
    conflictCodes: [],
  }
}

function healthFailurePlan(
  health: ReturnType<typeof initializeTagUndoFoundationHealth>,
): TagUndoPlan {
  const terminal = health.category === 'terminal'
  const availability = baseAvailability(
    terminal ? 'terminal-unavailable' : 'unavailable',
    terminal ? 'terminal-unavailable' : 'temporary-unavailable',
    terminal ? 'UNDO_RECORD_CORRUPT' : 'TAG_MANAGEMENT_UNAVAILABLE',
  )
  return emptyPlan(availability)
}

function boundedTerminalReasonCode(value: string | null): string {
  return value && /^[A-Z0-9][A-Z0-9._:-]{0,127}$/.test(value)
    ? value
    : 'UNDO_RECORD_CORRUPT'
}

function readCanonicalCurrentTag(
  db: DatabaseT,
  id: number,
  addConflict: (code: string) => void,
): TagRowView | null {
  const result = readTagById(db, id)
  if (result.malformed) addConflict('UNDO_MALFORMED_TAG')
  return result.row
}

function addIdentityConflict(
  db: DatabaseT,
  normalizedName: string,
  expectedId: number | null,
  addConflict: (code: string) => void,
): TagRowView | null {
  const result = readTagByNormalizedName(db, normalizedName)
  if (result.malformed) addConflict('UNDO_MALFORMED_TAG')
  if (result.row && (expectedId === null || result.row.id !== expectedId)) {
    addConflict('UNDO_SOURCE_IDENTITY_OCCUPIED')
  }
  return result.row
}

function buildUndoFingerprintInput(
  record: TagUndoRecordRow,
  views: TagUndoRecordViews,
  currentRequiredTagRows: readonly TagRowView[],
  requiredDocuments: readonly TagUndoDocumentRow[],
  createdEvidence: readonly CreatedAssociationEvidence[],
  markers: Record<string, unknown>,
  counts: { affectedCount: number; associationAdds: number; associationRemoves: number; versionUpdateCount: number },
  validation: TagUndoValidation,
  conflictCodes: readonly string[],
  warnings: readonly TagUndoWarningCode[],
): unknown[] {
  return [
    UNDO_FINGERPRINT_CONTRACT_VERSION,
    TAG_IDENTITY_CONTRACT_VERSION,
    record.database_generation,
    record.record_id,
    record.original_operation_id,
    record.original_result_id,
    record.lifecycle,
    record.kind,
    record.display_only === 1,
    record.source_tag_id,
    record.destination_tag_id,
    [views.sourceBefore, views.sourceAfter, views.destinationBefore, views.destinationAfter],
    [...currentRequiredTagRows]
      .sort((left, right) => left.id - right.id)
      .map((row) => [row.id, row.displayName, row.normalizedName]),
    [...requiredDocuments]
      .sort((left, right) => compareUndoDocumentIds(left.id, right.id))
      .map((document) => [document.id, document.path]),
    [...createdEvidence]
      .sort((left, right) => left.associationId - right.associationId)
      .map((association) => [
        association.associationId,
        association.documentId,
        association.tagId,
        association.exactPresent,
        association.exactDocumentId,
        association.exactTagId,
        association.logicalAssociationId,
      ]),
    markers,
    [counts.affectedCount, counts.associationAdds, counts.associationRemoves, counts.versionUpdateCount],
    validation,
    [...conflictCodes],
    [...warnings],
  ]
}

function undoFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex')
}

function withPreviewWindow(
  plan: TagUndoPlan,
  limit: number,
  afterDocumentId?: string | null,
): TagUndoPlan {
  const start = afterDocumentId === undefined || afterDocumentId === null
    ? 0
    : plan.requiredDocuments.findIndex((document) => document.id === afterDocumentId) + 1
  if (afterDocumentId !== undefined && afterDocumentId !== null && start === 0) {
    throw new TagUndoPlannerError('INVALID_PREVIEW', 'afterDocumentId is not in the current Undo scope')
  }
  const sample = plan.requiredDocuments.slice(start, start + limit)
  const nextCursor = sample.length > 0 && start + sample.length < plan.requiredDocuments.length
    ? sample[sample.length - 1]!.id
    : null
  return {
    ...plan,
    sample,
    nextCursor,
    nextAfterDocumentId: nextCursor,
  }
}

function publicPreview(plan: TagUndoPlan): TagUndoPreview {
  const {
    requiredDocumentIds: _requiredDocumentIds,
    requiredDocuments: _requiredDocuments,
    affectedDocumentIds: _affectedDocumentIds,
    affectedDocuments: _affectedDocuments,
    operationOwnedAssociations: _operationOwnedAssociations,
    requiredAssociations: _requiredAssociations,
    currentRequiredTagRows: _currentRequiredTagRows,
    currentCreatedDestinationAssociations: _currentCreatedDestinationAssociations,
    conflictCodes: _conflictCodes,
    ...preview
  } = plan
  return preview
}

function publicAvailability(plan: TagUndoPlan): TagUndoAvailability {
  return {
    supported: true,
    state: plan.state,
    validation: plan.validation,
    recordId: plan.recordId,
    originalOperationId: plan.originalOperationId,
    originalResultId: plan.originalResultId,
    kind: plan.kind,
    displayOnly: plan.displayOnly,
    committedAt: plan.committedAt,
    sourceBefore: plan.sourceBefore,
    sourceAfter: plan.sourceAfter,
    destinationBefore: plan.destinationBefore,
    destinationAfter: plan.destinationAfter,
    affectedCount: plan.affectedCount,
    associationAdds: plan.associationAdds,
    associationRemoves: plan.associationRemoves,
    versionUpdateCount: plan.versionUpdateCount,
    reasonCode: plan.reasonCode,
  }
}

function buildUndoPlanInTransaction(
  db: DatabaseT,
  requestedRecordId: string | undefined,
  sampleLimit: number,
): TagUndoPlan {
  const health = initializeTagUndoFoundationHealth(db)
  if (health.state !== 'healthy') {
    return healthFailurePlan(health)
  }
  const state = readUndoState(db)
  if (!state) {
    return emptyPlan(baseAvailability('unavailable', 'temporary-unavailable', 'TAG_UNDO_FOUNDATION_UNHEALTHY'))
  }
  if (requestedRecordId !== undefined && requestedRecordId !== state.current_record_id) {
    const superseded = requestedRecordId === state.last_superseded_record_id
    return emptyPlan(baseAvailability(
      superseded ? 'superseded' : 'unavailable',
      superseded ? 'terminal-unavailable' : 'temporary-unavailable',
      superseded ? 'UNDO_SUPERSEDED' : 'UNDO_TARGET_UNAVAILABLE',
    ))
  }
  if (state.current_record_id === null) {
    return emptyPlan(baseAvailability('unavailable', 'temporary-unavailable', 'UNDO_UNAVAILABLE'))
  }
  const record = readCurrentRecord(db, state.current_record_id)
  if (!record) {
    return emptyPlan(baseAvailability('terminal-unavailable', 'terminal-unavailable', 'UNDO_RECORD_CORRUPT'))
  }
  const views = readRecordViews(record)
  if (!views || !recordStructureIsSupported(record, views)) {
    return emptyPlan(baseAvailability('terminal-unavailable', 'terminal-unavailable', 'UNDO_RECORD_CORRUPT', record, views))
  }
  const deltas = readCurrentRecordDeltas(db, record.record_id)
  const conflictCodes: string[] = []
  const addConflict = (code: string) => {
    if (!conflictCodes.includes(code)) conflictCodes.push(code)
  }
  // A consumed or terminal record has no child deltas — they are purged at the
  // moment of successful Apply. Use the durable parent summary as the bounded
  // historical inverse counter so consumed availability still reports Merge
  // and Remove scope correctly.
  const inverse = (record.lifecycle === 'consumed' || record.lifecycle === 'terminal')
    ? inverseCountsFromRecordSummary(record)
    : inverseCounts(record, deltas, record.version_update_count)
  const retainedCounts = {
    affectedCount: record.version_update_count,
    ...inverse,
  }

  if (record.lifecycle === 'consumed') {
    return emptyPlan(baseAvailability(
      'consumed',
      'terminal-unavailable',
      'UNDO_ALREADY_APPLIED',
      record,
      views,
      retainedCounts,
    ), warningCodes(record.kind, record.version_update_count, 'terminal-unavailable'))
  }
  if (record.lifecycle === 'terminal') {
    return emptyPlan(baseAvailability(
      'terminal-unavailable',
      'terminal-unavailable',
      boundedTerminalReasonCode(record.terminal_code),
      record,
      views,
      retainedCounts,
    ), warningCodes(record.kind, record.version_update_count, 'terminal-unavailable'))
  }
  if (record.lifecycle !== 'latest') {
    return emptyPlan(baseAvailability('terminal-unavailable', 'terminal-unavailable', 'UNDO_RECORD_CORRUPT', record, views))
  }

  const currentRequiredTagRows: TagRowView[] = []
  const operationOwnedAssociations = deltas.map((delta) => ({
    associationId: delta.association_id,
    documentId: delta.document_id,
    tagId: delta.tag_id,
  }))
  let requiredDocumentIds: string[] = []
  let requiredDocuments: TagUndoDocumentRow[] = []
  let createdEvidence: CreatedAssociationEvidence[] = []
  let sourceCurrent: TagRowView | null = null
  let sourceIdentityOwner: TagRowView | null = null
  let destinationCurrent: TagRowView | null = null

  if (record.kind === 'rename') {
    sourceCurrent = readCanonicalCurrentTag(db, record.source_tag_id, addConflict)
    if (sourceCurrent) currentRequiredTagRows.push(sourceCurrent)
    if (!sourceCurrent) addConflict('UNDO_SOURCE_POST_STATE_MISSING')
    else if (!sameTagView(sourceCurrent, views.sourceAfter)) addConflict('UNDO_SOURCE_POST_STATE_CHANGED')
    const sourceIdentity = readTagByNormalizedName(db, views.sourceBefore.normalizedName)
    if (sourceIdentity.malformed) addConflict('UNDO_MALFORMED_TAG')
    sourceIdentityOwner = sourceIdentity.row
    if (sourceIdentityOwner && (record.display_only !== 1 || sourceIdentityOwner.id !== record.source_tag_id)) {
      addConflict('UNDO_SOURCE_IDENTITY_OCCUPIED')
    }
    requiredDocuments = readRenameDocuments(db, record.source_tag_id)
    assertNoManagedUndoDocuments(requiredDocuments)
    requiredDocumentIds = requiredDocuments.map((document) => document.id)
  } else {
    sourceCurrent = readCanonicalCurrentTag(db, record.source_tag_id, addConflict)
    if (sourceCurrent) addConflict('UNDO_SOURCE_ID_OCCUPIED')
    sourceIdentityOwner = addIdentityConflict(db, views.sourceBefore.normalizedName, null, addConflict)

    const seenDeltaDocuments = new Set<string>()
    const deltaKindsValid = deltas.every((delta) => {
      if (!Number.isSafeInteger(delta.association_id) || delta.association_id <= 0
        || typeof delta.document_id !== 'string' || delta.document_id.length < 1 || delta.document_id.length > 512
        || !Number.isSafeInteger(delta.tag_id) || delta.tag_id <= 0) return false
      const documentKey = JSON.stringify([delta.effect, delta.document_id])
      if (seenDeltaDocuments.has(documentKey)) return false
      seenDeltaDocuments.add(documentKey)
      if (record.kind === 'remove') return delta.effect === 'removed-source' && delta.tag_id === record.source_tag_id
      return (delta.effect === 'removed-source' && delta.tag_id === record.source_tag_id)
        || (delta.effect === 'created-destination' && delta.tag_id === record.destination_tag_id)
    })
    if (!deltaKindsValid) addConflict('UNDO_MALFORMED_OWNERSHIP')

    const deltaDocuments = readDeltaDocuments(db, record.record_id, deltas)
    requiredDocumentIds = deltaDocuments.ids
    requiredDocuments = deltaDocuments.documents
    assertNoManagedUndoDocuments(requiredDocuments)
    if (deltaDocuments.missing.length > 0) addConflict('UNDO_MISSING_DOCUMENT')

    if (record.kind === 'merge') {
      destinationCurrent = readCanonicalCurrentTag(db, record.destination_tag_id!, addConflict)
      if (destinationCurrent) currentRequiredTagRows.push(destinationCurrent)
      if (!destinationCurrent) addConflict('UNDO_DESTINATION_POST_STATE_MISSING')
      else if (!sameTagView(destinationCurrent, views.destinationAfter)) addConflict('UNDO_DESTINATION_POST_STATE_CHANGED')
      const destinationIdentity = readTagByNormalizedName(db, views.destinationAfter!.normalizedName)
      if (destinationIdentity.malformed) addConflict('UNDO_MALFORMED_TAG')
      if (destinationIdentity.row && destinationIdentity.row.id !== record.destination_tag_id) {
        addConflict('UNDO_DESTINATION_IDENTITY_OCCUPIED')
      }

      const removedDocumentIds = new Set(
        deltas.filter((delta) => delta.effect === 'removed-source').map((delta) => delta.document_id),
      )
      if (deltas.some((delta) => delta.effect === 'created-destination' && !removedDocumentIds.has(delta.document_id))) {
        addConflict('UNDO_MALFORMED_OWNERSHIP')
      }
      createdEvidence = readCreatedAssociationEvidence(db, record.record_id)
      for (const evidence of createdEvidence) {
        if (!evidence.exactPresent
          || evidence.exactDocumentId !== evidence.documentId
          || evidence.exactTagId !== evidence.tagId) {
          addConflict('UNDO_ASSOCIATION_CONFLICT')
        }
        if (!evidence.exactPresent
          && evidence.logicalAssociationId !== null
          && evidence.logicalAssociationId !== evidence.associationId) {
          addConflict('UNDO_ASSOCIATION_CONFLICT')
        }
      }
    }
  }

  const affectedCount = requiredDocumentIds.length
  const counts = { affectedCount, ...inverseCounts(record, deltas, affectedCount) }
  if (record.association_remove_count !== deltas.filter((delta) => delta.effect === 'removed-source').length
    || record.association_add_count !== deltas.filter((delta) => delta.effect === 'created-destination').length) {
    addConflict('UNDO_MALFORMED_OWNERSHIP')
  }
  const validation: TagUndoValidation = conflictCodes.length > 0 ? 'conflict' : 'safe'
  const warnings = warningCodes(record.kind, affectedCount, validation)
  const foundDocumentIds = new Set(requiredDocuments.map((document) => document.id))
  const markers = {
    sourceStableId: sourceCurrent ? [true, sourceCurrent.id, sourceCurrent.displayName, sourceCurrent.normalizedName] : [false],
    sourceNormalizedIdentity: sourceIdentityOwner
      ? [true, sourceIdentityOwner.id, sourceIdentityOwner.displayName, sourceIdentityOwner.normalizedName]
      : [false],
    destinationStableId: destinationCurrent
      ? [true, destinationCurrent.id, destinationCurrent.displayName, destinationCurrent.normalizedName]
      : [false],
    requiredDocuments: requiredDocumentIds.map((id) => [id, foundDocumentIds.has(id)]),
    createdAssociations: createdEvidence.map((evidence) => [
      evidence.associationId,
      evidence.exactPresent,
      evidence.logicalAssociationId,
    ]),
  }
  const fingerprint = undoFingerprint(buildUndoFingerprintInput(
    record,
    views,
    currentRequiredTagRows,
    requiredDocuments,
    createdEvidence,
    markers,
    counts,
    validation,
    conflictCodes,
    warnings,
  ))
  const availability = baseAvailability(
    'available',
    validation,
    conflictCodes[0] ?? null,
    record,
    views,
    counts,
  )
  const plan: TagUndoPlan = {
    ...availability,
    warnings,
    sample: [],
    nextCursor: null,
    nextAfterDocumentId: null,
    undoFingerprint: fingerprint,
    undoContractVersion: UNDO_FINGERPRINT_CONTRACT_VERSION,
    allowedToApply: validation === 'safe',
    requiredDocumentIds,
    requiredDocuments,
    affectedDocumentIds: requiredDocumentIds,
    affectedDocuments: requiredDocuments,
    operationOwnedAssociations,
    requiredAssociations: operationOwnedAssociations,
    currentRequiredTagRows,
    currentCreatedDestinationAssociations: createdEvidence
      .filter((evidence) => evidence.exactPresent)
      .map(({ associationId, documentId, tagId }) => ({ associationId, documentId, tagId })),
    conflictCodes,
  }
  return withPreviewWindow(plan, sampleLimit)
}

function assertPreviewPageTargetIsCurrent(plan: TagUndoPlan): void {
  let code: TagUndoPlannerErrorCode | null = null
  if (plan.state === 'superseded' || plan.reasonCode === 'UNDO_SUPERSEDED') {
    code = 'UNDO_SUPERSEDED'
  } else if (plan.state === 'consumed' || plan.reasonCode === 'UNDO_ALREADY_APPLIED') {
    code = 'UNDO_ALREADY_APPLIED'
  } else if (plan.state === 'terminal-unavailable') {
    code = 'UNDO_RECORD_CORRUPT'
  } else if (plan.reasonCode === 'TAG_MANAGEMENT_UNAVAILABLE') {
    code = 'TAG_MANAGEMENT_UNAVAILABLE'
  } else if (plan.reasonCode === 'UNDO_UNAVAILABLE') {
    code = 'UNDO_UNAVAILABLE'
  } else if (plan.reasonCode === 'UNDO_TARGET_UNAVAILABLE') {
    code = 'UNDO_TARGET_UNAVAILABLE'
  } else if (!plan.undoFingerprint) {
    code = 'UNDO_UNAVAILABLE'
  }

  if (code) {
    throw new TagUndoPlannerError(code, 'Undo target is not currently pageable', {
      recordId: plan.recordId,
    })
  }
}

/** Build the full server-only inverse plan from one deferred SQLite snapshot. */
export function buildTagUndoPlan(
  db: DatabaseT,
  options?: TagUndoPreviewOptions | string | number,
  legacyLimit?: number,
): TagUndoPlan {
  const normalized = normalizePreviewOptions(options, legacyLimit)
  const transaction = db.transaction(() => buildUndoPlanInTransaction(db, normalized.recordId, normalized.limit))
  return transaction()
}

/** Return only the bounded availability read model; child scope never escapes. */
export function getTagUndoAvailability(
  db: DatabaseT,
  recordId?: string | null,
): TagUndoAvailability {
  return publicAvailability(buildTagUndoPlan(db, { recordId, limit: TAG_UNDO_PREVIEW_SAMPLE_LIMIT }))
}

/** Build the bounded initial Undo Preview without performing any mutation. */
export function previewTagUndo(
  db: DatabaseT,
  options?: TagUndoPreviewOptions | string | number,
  legacyLimit?: number,
): TagUndoPreview {
  return publicPreview(buildTagUndoPlan(db, options, legacyLimit))
}

/**
 * Continue a reviewed Preview with a bounded keyset-style document page.  A
 * different current fingerprint is rejected before a page is returned.
 */
export function getTagUndoPreviewPage(
  db: DatabaseT,
  request: TagUndoPreviewPageRequest | string,
  legacyFingerprint?: string,
  legacyAfterDocumentId?: string | null,
  legacyLimit?: number,
): TagUndoPreview {
  const normalized = normalizePageRequest(
    request,
    legacyFingerprint,
    legacyAfterDocumentId,
    legacyLimit,
  )
  if (!isSha256Fingerprint(normalized.undoFingerprint)) plannerInvalid('undoFingerprint must be 64 lowercase hexadecimal characters')
  const recordId = assertOptionalRecordId(normalized.recordId)
  const afterDocumentId = normalized.afterDocumentId
  if (afterDocumentId !== undefined && afterDocumentId !== null
    && (typeof afterDocumentId !== 'string' || afterDocumentId.length < 1 || afterDocumentId.length > 512)) {
    plannerInvalid('afterDocumentId must be a bounded non-empty string')
  }
  const limit = normalized.limit === undefined
    ? TAG_UNDO_PREVIEW_PAGE_MAX_LIMIT
    : assertPreviewLimit(normalized.limit, TAG_UNDO_PREVIEW_PAGE_MAX_LIMIT, 'limit')
  const transaction = db.transaction(() => {
    const plan = buildUndoPlanInTransaction(db, recordId, limit)
    assertPreviewPageTargetIsCurrent(plan)
    if (plan.undoFingerprint !== normalized.undoFingerprint) {
      throw new TagUndoPlannerError('UNDO_STALE', 'Undo Preview fingerprint is stale', {
        recordId: plan.recordId,
      })
    }
    return publicPreview(withPreviewWindow(plan, limit, afterDocumentId))
  })
  return transaction()
}

const UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE = 'tag_undo_apply_affected_documents'
const UNDO_APPLY_RENAME_ASSOCIATIONS_TEMP_TABLE = 'tag_undo_apply_rename_associations'
const SQLITE_MAX_SAFE_INTEGER = 9007199254740991

function applyTransactionFailed(message = 'tag Undo Apply transaction failed'): never {
  throw new TagUndoPlannerError('TRANSACTION_FAILED', message)
}

function throwUndoApplyFailure(stage: TagUndoApplyFailureStage): void {
  if (undoApplyTestHooks?.failureStage === stage) {
    applyTransactionFailed(`tag Undo Apply failure injected at ${stage}`)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the internal domain input; no inverse scope is accepted from callers. */
export function parseTagUndoApplyRequest(value: unknown): TagUndoApplyInput {
  if (!isPlainRecord(value)
    || Object.keys(value).sort().join('\0') !== 'recordId\0undoFingerprint'
    || typeof value.recordId !== 'string'
    || value.recordId.length < 1
    || value.recordId.length > 128
    || !isSha256Fingerprint(value.undoFingerprint)) {
    plannerInvalid('Undo Apply requires exactly recordId and undoFingerprint')
  }
  return {
    recordId: value.recordId,
    undoFingerprint: value.undoFingerprint,
  }
}

function throwCurrentTargetClassification(plan: TagUndoPlan): void {
  if (plan.reasonCode === 'TAG_MANAGEMENT_UNAVAILABLE'
    || plan.reasonCode === 'TAG_UNDO_FOUNDATION_UNHEALTHY') {
    throw new TagUndoPlannerError('TAG_MANAGEMENT_UNAVAILABLE', 'tag management is temporarily unavailable', {
      recordId: plan.recordId,
    })
  }
  if (plan.state === 'superseded' || plan.reasonCode === 'UNDO_SUPERSEDED') {
    throw new TagUndoPlannerError('UNDO_SUPERSEDED', 'Undo target was superseded', {
      recordId: plan.recordId,
    })
  }
  if (plan.state === 'consumed' || plan.reasonCode === 'UNDO_ALREADY_APPLIED') {
    throw new TagUndoPlannerError('UNDO_ALREADY_APPLIED', 'Undo target was already applied', {
      recordId: plan.recordId,
    })
  }
  if (plan.state === 'terminal-unavailable'
    || plan.reasonCode === 'UNDO_RECORD_CORRUPT'
    || plan.validation === 'terminal-unavailable') {
    throw new TagUndoPlannerError('UNDO_RECORD_CORRUPT', 'Undo target is permanently unavailable', {
      recordId: plan.recordId,
    })
  }
  if (plan.reasonCode === 'UNDO_TARGET_UNAVAILABLE' || plan.reasonCode === 'UNDO_UNAVAILABLE'
    || plan.state === 'unavailable') {
    throw new TagUndoPlannerError(
      plan.reasonCode === 'UNDO_TARGET_UNAVAILABLE' ? 'UNDO_TARGET_UNAVAILABLE' : 'UNDO_UNAVAILABLE',
      'Undo target is unavailable',
      { recordId: plan.recordId },
    )
  }
}

function assertReviewedUndoPlan(
  plan: TagUndoPlan,
  input: TagUndoApplyInput,
): asserts plan is TagUndoPlan & {
  recordId: string
  kind: TagOperationRequest['kind']
  sourceBefore: TagRowView
  undoFingerprint: string
} {
  throwCurrentTargetClassification(plan)
  if (plan.recordId !== input.recordId || plan.state !== 'available') {
    throw new TagUndoPlannerError('UNDO_TARGET_UNAVAILABLE', 'Undo target is unavailable', {
      recordId: plan.recordId,
    })
  }
  if (!plan.undoFingerprint) {
    throw new TagUndoPlannerError('UNDO_UNAVAILABLE', 'Undo target has no current fingerprint', {
      recordId: plan.recordId,
    })
  }
  if (plan.undoFingerprint !== input.undoFingerprint) {
    throw new TagUndoPlannerError('UNDO_STALE', 'Undo Preview fingerprint is stale', {
      recordId: plan.recordId,
    })
  }
  if (!plan.allowedToApply || plan.validation !== 'safe') {
    throw new TagUndoPlannerError('UNDO_CONFLICT', 'Undo current-state preconditions are unsafe', {
      recordId: plan.recordId,
      reasonCode: plan.reasonCode,
    })
  }
  if (!plan.kind || !plan.sourceBefore) {
    throw new TagUndoPlannerError('UNDO_RECORD_CORRUPT', 'Undo record contract is invalid', {
      recordId: plan.recordId,
    })
  }
}

function dropUndoApplyTempTables(db: DatabaseT): void {
  db.exec(`
    DROP TABLE IF EXISTS temp.${UNDO_APPLY_RENAME_ASSOCIATIONS_TEMP_TABLE};
    DROP TABLE IF EXISTS temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE};
  `)
}

type StagedUndoDocument = {
  document_id: string
  previous_updated_at: number
  next_updated_at: number
}

function stageUndoAffectedDocuments(
  db: DatabaseT,
  plan: TagUndoPlan & { recordId: string; kind: TagOperationRequest['kind']; sourceBefore: TagRowView },
  commitTimestamp: number,
): StagedUndoDocument[] {
  dropUndoApplyTempTables(db)
  db.exec(`
    CREATE TEMP TABLE ${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} (
      document_id TEXT PRIMARY KEY,
      previous_updated_at INTEGER NOT NULL,
      next_updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
  `)

  const nextVersionSql = `
    CASE
      WHEN d.updated_at < 0 OR d.updated_at >= ${SQLITE_MAX_SAFE_INTEGER} THEN NULL
      WHEN d.updated_at + 1 > ? THEN d.updated_at + 1
      ELSE ?
    END
  `
  if (plan.kind === 'rename') {
    db.prepare(`
      INSERT INTO temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} (
        document_id, previous_updated_at, next_updated_at
      )
      SELECT DISTINCT d.id, d.updated_at, ${nextVersionSql}
      FROM documents d
      JOIN document_tags dt ON dt.document_id = d.id
      WHERE dt.tag_id = ?
      ORDER BY d.id COLLATE BINARY
    `).run(commitTimestamp, commitTimestamp, plan.sourceBefore.id)

    db.exec(`
      CREATE TEMP TABLE ${UNDO_APPLY_RENAME_ASSOCIATIONS_TEMP_TABLE} (
        association_id INTEGER PRIMARY KEY,
        document_id TEXT NOT NULL,
        tag_id INTEGER NOT NULL
      ) WITHOUT ROWID;
    `)
    db.prepare(`
      INSERT INTO temp.${UNDO_APPLY_RENAME_ASSOCIATIONS_TEMP_TABLE} (
        association_id, document_id, tag_id
      )
      SELECT association_id, document_id, tag_id
      FROM document_tags
      WHERE tag_id = ?
      ORDER BY association_id
    `).run(plan.sourceBefore.id)
  } else {
    db.prepare(`
      INSERT INTO temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} (
        document_id, previous_updated_at, next_updated_at
      )
      SELECT DISTINCT d.id, d.updated_at, ${nextVersionSql}
      FROM documents d
      JOIN (
        SELECT DISTINCT document_id
        FROM tag_undo_association_deltas
        WHERE record_id = ?
      ) required ON required.document_id = d.id
      ORDER BY d.id COLLATE BINARY
    `).run(commitTimestamp, commitTimestamp, plan.recordId)
  }

  const staged = db.prepare(`
    SELECT document_id, previous_updated_at, next_updated_at
    FROM temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE}
    ORDER BY document_id COLLATE BINARY
  `).all() as StagedUndoDocument[]
  const expectedIds = new Set(plan.affectedDocumentIds)
  if (staged.length !== plan.affectedCount || staged.length !== expectedIds.size
    || staged.some((row) => !expectedIds.has(row.document_id))) {
    applyTransactionFailed('Undo affected-document scope changed during Apply')
  }
  for (const row of staged) {
    try {
      if (nextMetadataUpdatedAt(row.previous_updated_at, commitTimestamp) !== row.next_updated_at) {
        applyTransactionFailed('Undo metadata version staging is inconsistent')
      }
    } catch (error) {
      if (error instanceof MetadataVersionError) applyTransactionFailed('Undo metadata version cannot advance')
      throw error
    }
  }
  if (plan.kind === 'rename') {
    const associationCount = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM temp.${UNDO_APPLY_RENAME_ASSOCIATIONS_TEMP_TABLE}
    `).get() as { count: number }).count
    if (associationCount !== plan.affectedCount) {
      applyTransactionFailed('Undo Rename association scope changed during Apply')
    }
  }
  return staged
}

function applyUndoVersions(
  db: DatabaseT,
  plan: TagUndoPlan,
  stagedCount: number,
): number {
  const updated = db.prepare(`
    UPDATE documents
    SET updated_at = (
      SELECT next_updated_at
      FROM temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} staged
      WHERE staged.document_id = documents.id
    )
    WHERE id IN (
      SELECT document_id
      FROM temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE}
    )
  `).run()
  if (updated.changes !== stagedCount || updated.changes !== plan.versionUpdateCount) {
    applyTransactionFailed('Undo metadata version update count mismatched')
  }
  const verified = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} staged
    JOIN documents d ON d.id = staged.document_id
    WHERE d.updated_at = staged.next_updated_at
  `).get() as { count: number }).count
  if (verified !== stagedCount) applyTransactionFailed('Undo metadata version postcondition failed')
  return updated.changes
}

function restoreUndoSourceTag(
  db: DatabaseT,
  plan: TagUndoPlan & { sourceBefore: TagRowView; kind: TagOperationRequest['kind'] },
): void {
  if (plan.kind === 'rename') {
    const updated = db.prepare(`
      UPDATE tags
      SET name = ?, normalized_name = ?
      WHERE id = ?
        AND name = ?
        AND normalized_name = ?
    `).run(
      plan.sourceBefore.displayName,
      plan.sourceBefore.normalizedName,
      plan.sourceBefore.id,
      plan.sourceAfter!.displayName,
      plan.sourceAfter!.normalizedName,
    )
    if (updated.changes !== 1) applyTransactionFailed('Undo source tag post-state changed')
    return
  }

  const inserted = db.prepare(`
    INSERT INTO tags (id, name, normalized_name)
    VALUES (?, ?, ?)
  `).run(
    plan.sourceBefore.id,
    plan.sourceBefore.displayName,
    plan.sourceBefore.normalizedName,
  )
  if (inserted.changes !== 1) applyTransactionFailed('Undo source tag could not be restored')
}

function deleteUndoCreatedDestinationAssociations(
  db: DatabaseT,
  plan: TagUndoPlan & { recordId: string; kind: TagOperationRequest['kind'] },
): number {
  if (plan.kind !== 'merge') return 0
  const deleted = db.prepare(`
    DELETE FROM document_tags
    WHERE association_id IN (
      SELECT association_id
      FROM tag_undo_association_deltas
      WHERE record_id = ?
        AND effect = 'created-destination'
    )
  `).run(plan.recordId)
  if (deleted.changes !== plan.associationRemoves) {
    applyTransactionFailed('Undo Merge destination provenance count mismatched')
  }
  return deleted.changes
}

function restoreUndoSourceAssociations(
  db: DatabaseT,
  plan: TagUndoPlan & { recordId: string; kind: TagOperationRequest['kind']; sourceBefore: TagRowView },
): number {
  if (plan.kind !== 'merge' && plan.kind !== 'remove') return 0
  const expected = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM tag_undo_association_deltas
    WHERE record_id = ?
      AND effect = 'removed-source'
  `).get(plan.recordId) as { count: number }).count
  const inserted = db.prepare(`
    INSERT INTO document_tags (document_id, tag_id)
    SELECT document_id, ?
    FROM tag_undo_association_deltas
    WHERE record_id = ?
      AND effect = 'removed-source'
    ORDER BY association_id
  `).run(plan.sourceBefore.id, plan.recordId)
  if (inserted.changes !== expected || inserted.changes !== plan.associationAdds) {
    applyTransactionFailed('Undo source association restore count mismatched')
  }
  return inserted.changes
}

function assertUndoVersions(db: DatabaseT, plan: TagUndoPlan): void {
  const stagedCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE}
  `).get() as { count: number }).count
  if (stagedCount !== plan.versionUpdateCount) {
    applyTransactionFailed('Undo affected-document version count mismatched')
  }
  const updatedCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM temp.${UNDO_APPLY_AFFECTED_DOCUMENTS_TEMP_TABLE} staged
    JOIN documents d ON d.id = staged.document_id
    WHERE d.updated_at = staged.next_updated_at
  `).get() as { count: number }).count
  if (updatedCount !== stagedCount) applyTransactionFailed('Undo version set is incomplete')
}

function assertUndoInversePostconditions(
  db: DatabaseT,
  plan: TagUndoPlan & { recordId: string; kind: TagOperationRequest['kind']; sourceBefore: TagRowView },
): void {
  const source = readTagById(db, plan.sourceBefore.id)
  if (source.malformed || !source.row || !sameTagView(source.row, plan.sourceBefore)) {
    applyTransactionFailed('Undo source tag postcondition failed')
  }

  if (plan.kind === 'rename') {
    const expectedCount = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM temp.${UNDO_APPLY_RENAME_ASSOCIATIONS_TEMP_TABLE}
    `).get() as { count: number }).count
    const currentCount = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM document_tags
      WHERE tag_id = ?
    `).get(plan.sourceBefore.id) as { count: number }).count
    const retainedCount = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM temp.${UNDO_APPLY_RENAME_ASSOCIATIONS_TEMP_TABLE} expected
      JOIN document_tags current
        ON current.association_id = expected.association_id
       AND current.document_id = expected.document_id
       AND current.tag_id = expected.tag_id
    `).get() as { count: number }).count
    if (currentCount !== expectedCount || retainedCount !== expectedCount) {
      applyTransactionFailed('Undo Rename association postcondition failed')
    }
  } else if (plan.kind === 'merge') {
    const sourceAssociations = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM document_tags
      WHERE tag_id = ?
    `).get(plan.sourceBefore.id) as { count: number }).count
    const expectedSourceAssociations = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM tag_undo_association_deltas
      WHERE record_id = ?
        AND effect = 'removed-source'
    `).get(plan.recordId) as { count: number }).count
    const restoredSourceAssociations = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM tag_undo_association_deltas delta
      JOIN document_tags current
        ON current.document_id = delta.document_id
       AND current.tag_id = ?
      WHERE delta.record_id = ?
        AND delta.effect = 'removed-source'
    `).get(plan.sourceBefore.id, plan.recordId) as { count: number }).count
    const ownedDestinationRows = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM document_tags current
      JOIN tag_undo_association_deltas delta
        ON delta.association_id = current.association_id
      WHERE delta.record_id = ?
        AND delta.effect = 'created-destination'
    `).get(plan.recordId) as { count: number }).count
    if (sourceAssociations !== expectedSourceAssociations
      || restoredSourceAssociations !== expectedSourceAssociations
      || ownedDestinationRows !== 0
      || !plan.destinationAfter
      || !sameTagView(readTagById(db, plan.destinationAfter.id).row, plan.destinationAfter)) {
      applyTransactionFailed('Undo Merge inverse postcondition failed')
    }
  } else {
    const sourceAssociations = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM document_tags
      WHERE tag_id = ?
    `).get(plan.sourceBefore.id) as { count: number }).count
    const expectedSourceAssociations = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM tag_undo_association_deltas
      WHERE record_id = ?
        AND effect = 'removed-source'
    `).get(plan.recordId) as { count: number }).count
    const restoredSourceAssociations = (db.prepare(`
      SELECT COUNT(*) AS count
      FROM tag_undo_association_deltas delta
      JOIN document_tags current
        ON current.document_id = delta.document_id
       AND current.tag_id = ?
      WHERE delta.record_id = ?
        AND delta.effect = 'removed-source'
    `).get(plan.sourceBefore.id, plan.recordId) as { count: number }).count
    if (sourceAssociations !== expectedSourceAssociations
      || restoredSourceAssociations !== expectedSourceAssociations) {
      applyTransactionFailed('Undo Remove inverse postcondition failed')
    }
  }
  assertUndoVersions(db, plan)
}

function consumeUndoRecord(
  db: DatabaseT,
  plan: TagUndoPlan & { recordId: string },
  undoOperationId: string,
  undoResultId: string,
  committedAt: number,
): void {
  const state = readUndoState(db)
  if (!state || state.current_record_id !== plan.recordId) {
    applyTransactionFailed('Undo state changed before consumption')
  }
  const consumed = db.prepare(`
    UPDATE tag_undo_records
    SET lifecycle = 'consumed',
        terminal_code = NULL,
        undo_operation_id = ?,
        undo_result_id = ?,
        consumed_at = ?
    WHERE record_id = ?
      AND lifecycle = 'latest'
  `).run(undoOperationId, undoResultId, committedAt, plan.recordId)
  if (consumed.changes !== 1) applyTransactionFailed('Undo consumed lifecycle transition failed')
  throwUndoApplyFailure('after-consumed-parent-update')

  const purged = db.prepare(`
    DELETE FROM tag_undo_association_deltas
    WHERE record_id = ?
  `).run(plan.recordId)
  if (purged.changes !== plan.operationOwnedAssociations.length) {
    applyTransactionFailed('Undo child delta purge count mismatched')
  }
  throwUndoApplyFailure('after-child-delta-purge')

  const stateUpdated = db.prepare(`
    UPDATE tag_undo_state
    SET updated_at = ?
    WHERE state_id = 1
      AND database_generation = ?
      AND current_record_id = ?
  `).run(committedAt, state.database_generation, plan.recordId)
  if (stateUpdated.changes !== 1) applyTransactionFailed('Undo state postcondition failed')
}

function assertConsumedUndoPostconditions(
  db: DatabaseT,
  plan: TagUndoPlan & { recordId: string },
  undoOperationId: string,
  undoResultId: string,
  committedAt: number,
): void {
  const record = db.prepare(`
    SELECT lifecycle, terminal_code, undo_operation_id, undo_result_id, consumed_at
    FROM tag_undo_records
    WHERE record_id = ?
  `).get(plan.recordId) as {
    lifecycle: string
    terminal_code: string | null
    undo_operation_id: string | null
    undo_result_id: string | null
    consumed_at: number | null
  } | undefined
  const childCount = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM tag_undo_association_deltas
    WHERE record_id = ?
  `).get(plan.recordId) as { count: number }).count
  const state = readUndoState(db)
  if (!record
    || record.lifecycle !== 'consumed'
    || record.terminal_code !== null
    || record.undo_operation_id !== undoOperationId
    || record.undo_result_id !== undoResultId
    || record.consumed_at !== committedAt
    || childCount !== 0
    || !state
    || state.current_record_id !== plan.recordId) {
    applyTransactionFailed('Undo consumed-state postcondition failed')
  }
  const health = initializeTagUndoFoundationHealth(db)
  if (health.state !== 'healthy') applyTransactionFailed('Undo final foundation health is unavailable')
}

function applyUndoInTransaction(
  db: DatabaseT,
  input: TagUndoApplyInput,
): TagUndoApplyResult {
  const plan = buildUndoPlanInTransaction(db, input.recordId, TAG_UNDO_PREVIEW_SAMPLE_LIMIT)
  assertReviewedUndoPlan(plan, input)
  throwUndoApplyFailure('after-transactional-replan')

  const committedAt = Date.now()
  const staged = stageUndoAffectedDocuments(db, plan, committedAt)
  throwUndoApplyFailure('after-version-staging')

  restoreUndoSourceTag(db, plan)
  throwUndoApplyFailure('after-source-row-restore')

  deleteUndoCreatedDestinationAssociations(db, plan)
  if (plan.kind === 'merge') throwUndoApplyFailure('after-created-destination-delete')

  restoreUndoSourceAssociations(db, plan)
  if (plan.kind === 'merge' || plan.kind === 'remove') {
    throwUndoApplyFailure('after-source-association-restore')
  }

  const versionUpdateCount = applyUndoVersions(db, plan, staged.length)
  throwUndoApplyFailure('after-version-update')

  assertUndoInversePostconditions(db, plan)
  throwUndoApplyFailure('after-inverse-postcondition')

  const undoOperationId = randomUUID()
  const undoResultId = randomUUID()
  consumeUndoRecord(db, plan, undoOperationId, undoResultId, committedAt)
  dropUndoApplyTempTables(db)
  assertConsumedUndoPostconditions(db, plan, undoOperationId, undoResultId, committedAt)
  throwUndoApplyFailure('after-final-postcondition')
  throwUndoApplyFailure('before-commit')

  const sourceTag = readTagById(db, plan.sourceBefore.id)
  if (sourceTag.malformed || !sourceTag.row) applyTransactionFailed('Undo result source tag is unavailable')
  const destinationTag = plan.kind === 'merge' && plan.destinationAfter
    ? readTagById(db, plan.destinationAfter.id)
    : null
  if (plan.kind === 'merge' && (!destinationTag || destinationTag.malformed || !destinationTag.row)) {
    applyTransactionFailed('Undo result destination tag is unavailable')
  }
  return {
    undoOperationId,
    undoResultId,
    recordId: plan.recordId,
    originalOperationId: plan.originalOperationId!,
    originalResultId: plan.originalResultId!,
    kind: plan.kind,
    displayOnly: plan.displayOnly,
    sourceTag: sourceTag.row,
    destinationTag: destinationTag?.row ?? null,
    affectedCount: plan.affectedCount,
    associationAdds: plan.associationAdds,
    associationRemoves: plan.associationRemoves,
    versionUpdateCount,
    committedAt,
    appliedUndoFingerprint: input.undoFingerprint,
    lifecycle: 'consumed',
  }
}

/** Apply one reviewed Undo as a domain-only atomic forward SQLite mutation. */
export async function applyTagUndo(db: DatabaseT, value: unknown): Promise<TagUndoApplyResult> {
  const input = parseTagUndoApplyRequest(value)
  const discovery = buildTagUndoPlan(db, { recordId: input.recordId, limit: TAG_UNDO_PREVIEW_SAMPLE_LIMIT })
  undoApplyTestHooks?.afterDiscovery?.(discovery)
  assertReviewedUndoPlan(discovery, input)
  const paths = discovery.requiredDocuments.map((document) => document.path)

  try {
    return await withDocumentWriteLocks(paths, async () => {
      await undoApplyTestHooks?.afterLocks?.(paths)
      const mutation = db.transaction(() => applyUndoInTransaction(db, input))
      return mutation.immediate()
    })
  } catch (error) {
    try {
      dropUndoApplyTempTables(db)
    } catch {
      // The failed transaction is still the authority; cleanup is best effort.
    }
    if (error instanceof TagUndoPlannerError) throw error
    throw new TagUndoPlannerError('TRANSACTION_FAILED', 'tag Undo Apply transaction failed')
  }
}

/** Alias matching the existing Phase 2 Preview/page naming convention. */
export const previewTagUndoPage = getTagUndoPreviewPage

/** Approved-plan names retained as internal aliases for later T2.1-4 wiring. */
export const getUndoAvailability = getTagUndoAvailability
export const previewUndo = previewTagUndo
export const getUndoPreviewPage = getTagUndoPreviewPage
export const buildUndoPlan = buildTagUndoPlan
