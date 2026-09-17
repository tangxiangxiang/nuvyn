import type { Database as DatabaseT } from 'better-sqlite3'
import { TAG_IDENTITY_CONTRACT_VERSION } from '../shared/tagNormalization.js'

export const TAG_UNDO_RECORD_CONTRACT_VERSION = 'tag-undo-record-v1'
export const UNDO_FINGERPRINT_CONTRACT_VERSION = 'tag-undo-fingerprint-v1'
export const TAG_UNDO_FOUNDATION_SCHEMA_VERSION = 8

export type TagUndoFoundationHealthState = 'checking' | 'healthy' | 'unavailable'
export type TagUndoFoundationHealthCategory = 'temporary' | 'terminal'

export type TagUndoFoundationHealth = {
  state: TagUndoFoundationHealthState
  /** Stable machine-readable retryability classification for unavailable health. */
  category?: TagUndoFoundationHealthCategory
  code?: string
  reason?: string
  schemaVersion: number
  checkedAt: number
}

type FoundationHealthFailure = {
  category: TagUndoFoundationHealthCategory
  reason: string
}

const healthByDb = new WeakMap<object, TagUndoFoundationHealth>()

function now(): number {
  return Date.now()
}

function unavailable(
  code: string,
  reason: string,
  schemaVersion = 0,
  category: TagUndoFoundationHealthCategory = 'temporary',
): TagUndoFoundationHealth {
  return { state: 'unavailable', category, code, reason, schemaVersion, checkedAt: now() }
}

function temporaryFailure(reason: string): FoundationHealthFailure {
  return { category: 'temporary', reason }
}

function terminalFailure(reason: string): FoundationHealthFailure {
  return { category: 'terminal', reason }
}

function tableExists(db: DatabaseT, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name))
}

function indexExists(db: DatabaseT, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(name))
}

function tableColumns(db: DatabaseT, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name)
}

function hasExactTableColumns(db: DatabaseT, table: string, columns: readonly string[]): boolean {
  return tableColumns(db, table).join('\0') === columns.join('\0')
}

function hasUniqueDocumentTagConstraint(db: DatabaseT): boolean {
  const indexes = db.prepare('PRAGMA index_list(document_tags)').all() as Array<{
    name: string
    unique: number
  }>
  return indexes.some((index) => {
    if (index.unique !== 1) return false
    const columns = db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>
    return columns.map((column) => column.name).join('\0') === 'document_id\0tag_id'
  })
}

type FoundationRecord = {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function isBoundedName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200
}

function isValidNormalizedOperation(record: FoundationRecord): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(record.operation_json)
  } catch {
    return false
  }
  if (!isPlainObject(parsed) || typeof parsed.kind !== 'string'
    || parsed.sourceTagId !== record.source_tag_id) return false

  if (record.kind === 'rename') {
    return parsed.kind === 'rename'
      && hasKeys(parsed, ['kind', 'sourceTagId', 'destinationName'])
      && isBoundedName(parsed.destinationName)
  }
  if (record.kind === 'merge') {
    return parsed.kind === 'merge'
      && hasKeys(parsed, ['kind', 'sourceTagId', 'destinationTagId'])
      && Number.isSafeInteger(parsed.destinationTagId)
      && parsed.destinationTagId === record.destination_tag_id
      && Number(parsed.destinationTagId) > 0
  }
  if (record.kind === 'remove') {
    return parsed.kind === 'remove'
      && hasKeys(parsed, ['kind', 'sourceTagId'])
  }
  return false
}

function hasNullDestination(record: FoundationRecord): boolean {
  return record.destination_tag_id === null
    && record.destination_before_name === null
    && record.destination_before_normalized_name === null
    && record.destination_after_name === null
    && record.destination_after_normalized_name === null
}

function hasAbsentSourceAfter(record: FoundationRecord): boolean {
  return record.source_after_exists === 0
    && record.source_after_name === null
    && record.source_after_normalized_name === null
}

function hasPresentSourceAfter(record: FoundationRecord): boolean {
  return record.source_after_exists === 1
    && isBoundedName(record.source_after_name)
    && isBoundedName(record.source_after_normalized_name)
}

function validateKindSpecificRecord(record: FoundationRecord): boolean {
  if (record.kind === 'rename') {
    return hasNullDestination(record)
      && hasPresentSourceAfter(record)
      && record.association_remove_count === 0
      && record.association_add_count === 0
  }
  if (record.kind === 'merge') {
    return record.display_only === 0
      && hasAbsentSourceAfter(record)
      && Number.isSafeInteger(record.destination_tag_id)
      && Number(record.destination_tag_id) > 0
      && isBoundedName(record.destination_before_name)
      && isBoundedName(record.destination_before_normalized_name)
      && isBoundedName(record.destination_after_name)
      && isBoundedName(record.destination_after_normalized_name)
  }
  if (record.kind === 'remove') {
    return record.display_only === 0
      && hasAbsentSourceAfter(record)
      && hasNullDestination(record)
      && record.association_add_count === 0
  }
  return false
}

function validateLifecycle(record: FoundationRecord): boolean {
  if (record.lifecycle === 'latest') {
    return record.terminal_code === null
      && record.undo_operation_id === null
      && record.undo_result_id === null
      && record.consumed_at === null
  }
  if (record.lifecycle === 'consumed') {
    return record.terminal_code === null
      && typeof record.undo_operation_id === 'string'
      && record.undo_operation_id.length > 0
      && typeof record.undo_result_id === 'string'
      && record.undo_result_id.length > 0
      && typeof record.consumed_at === 'number'
      && Number.isSafeInteger(record.consumed_at)
      && record.consumed_at >= 0
  }
  if (record.lifecycle === 'terminal') {
    return typeof record.terminal_code === 'string'
      && record.terminal_code.length > 0
      && record.undo_operation_id === null
      && record.undo_result_id === null
      && record.consumed_at === null
  }
  return false
}

function validateFoundationSchema(db: DatabaseT): FoundationHealthFailure | null {
  const version = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined
  if (!version || version.version < TAG_UNDO_FOUNDATION_SCHEMA_VERSION) {
    return temporaryFailure('tag Undo foundation migration is not the repaired current version')
  }

  for (const table of ['document_tags', 'tag_undo_records', 'tag_undo_association_deltas', 'tag_undo_state']) {
    if (!tableExists(db, table)) return temporaryFailure(`tag Undo foundation table is missing: ${table}`)
  }
  for (const index of ['idx_document_tags_tag', 'idx_document_tags_document', 'idx_tag_undo_records_lifecycle', 'idx_tag_undo_deltas_record_document', 'idx_tag_undo_deltas_record_effect_association']) {
    if (!indexExists(db, index)) return temporaryFailure(`tag Undo foundation index is missing: ${index}`)
  }
  if (!hasExactTableColumns(db, 'document_tags', ['association_id', 'document_id', 'tag_id'])
    || !hasExactTableColumns(db, 'tag_undo_records', [
      'record_id', 'original_operation_id', 'original_result_id', 'kind',
      'display_only', 'identity_contract_version', 'record_contract_version',
      'database_generation', 'operation_json', 'committed_at', 'source_tag_id',
      'source_before_name', 'source_before_normalized_name', 'source_after_exists',
      'source_after_name', 'source_after_normalized_name', 'destination_tag_id',
      'destination_before_name', 'destination_before_normalized_name',
      'destination_after_name', 'destination_after_normalized_name', 'lifecycle',
      'terminal_code', 'undo_operation_id', 'undo_result_id', 'consumed_at',
      'association_remove_count', 'association_add_count', 'version_update_count',
    ])
    || !hasExactTableColumns(db, 'tag_undo_association_deltas', [
      'record_id', 'effect', 'association_id', 'document_id', 'tag_id',
    ])
    || !hasExactTableColumns(db, 'tag_undo_state', [
      'state_id', 'database_generation', 'current_record_id',
      'last_superseded_record_id', 'updated_at',
    ])) {
    return temporaryFailure('document_tags association provenance schema is invalid')
  }
  if (!hasUniqueDocumentTagConstraint(db)) return temporaryFailure('document_tags logical uniqueness constraint is missing')

  const states = db.prepare('SELECT state_id, database_generation, current_record_id, last_superseded_record_id, updated_at FROM tag_undo_state').all() as Array<{
    state_id: number
    database_generation: string
    current_record_id: string | null
    last_superseded_record_id: string | null
    updated_at: number
  }>
  if (states.length !== 1 || states[0].state_id !== 1
    || !/^[0-9a-f]{32}$/.test(states[0].database_generation)
    || !Number.isSafeInteger(states[0].updated_at)
    || states[0].updated_at < 0
    || (states[0].last_superseded_record_id !== null
      && (typeof states[0].last_superseded_record_id !== 'string'
        || states[0].last_superseded_record_id.length < 1
        || states[0].last_superseded_record_id.length > 128))) {
    return terminalFailure('tag Undo foundation state singleton is invalid')
  }
  const records = db.prepare(`
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
  `).all() as Array<{
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
  }>
  if (records.length > 1) return terminalFailure('tag Undo foundation retains more than one parent record')
  if (records.length === 0 && states[0].current_record_id !== null) {
    return terminalFailure('tag Undo foundation state points at a missing record')
  }
  if (records.length === 1 && states[0].current_record_id !== records[0].record_id) {
    return terminalFailure('tag Undo foundation current pointer does not identify the sole retained record')
  }
  for (const record of records) {
    if (record.database_generation !== states[0].database_generation) {
      return terminalFailure('tag Undo foundation record generation does not match the state generation')
    }
    if (record.identity_contract_version !== TAG_IDENTITY_CONTRACT_VERSION
      || record.record_contract_version !== TAG_UNDO_RECORD_CONTRACT_VERSION
      || !['rename', 'merge', 'remove'].includes(record.kind)
      || (record.kind !== 'rename' && record.display_only !== 0)
      || !Number.isSafeInteger(record.display_only)
      || !Number.isSafeInteger(record.committed_at) || record.committed_at < 0
      || !Number.isSafeInteger(record.source_tag_id) || record.source_tag_id <= 0
      || ![record.association_remove_count, record.association_add_count, record.version_update_count]
        .every((value) => Number.isSafeInteger(value) && value >= 0)
      || !isValidNormalizedOperation(record)
      || !validateLifecycle(record)
      || !validateKindSpecificRecord(record)) {
      return terminalFailure('tag Undo foundation record contract is invalid')
    }
    const deltas = db.prepare(`
      SELECT effect, association_id, document_id, tag_id
      FROM tag_undo_association_deltas
      WHERE record_id = ?
      ORDER BY effect, association_id
    `).all(record.record_id) as Array<{
      effect: string
      association_id: number
      document_id: string
      tag_id: number
    }>
    if (deltas.some((delta) =>
      !['removed-source', 'created-destination'].includes(delta.effect)
      || !Number.isSafeInteger(delta.association_id) || delta.association_id <= 0
      || typeof delta.document_id !== 'string'
      || delta.document_id.length < 1 || delta.document_id.length > 512
      || !Number.isSafeInteger(delta.tag_id) || delta.tag_id <= 0
      || (record.kind === 'rename')
      || (record.kind === 'remove' && delta.effect !== 'removed-source'))) {
      return terminalFailure('tag Undo foundation association delta is invalid for its record kind')
    }
    const removedCount = deltas.filter((row) => row.effect === 'removed-source').length
    const addedCount = deltas.filter((row) => row.effect === 'created-destination').length
    if (record.lifecycle === 'consumed') {
      // Successful Undo compacts the consumed parent and purges its heavy
      // child rows in the same transaction.  The parent counts remain as
      // bounded diagnostics, so a consumed record is healthy only when its
      // child payload has been completely removed.
      if (deltas.length !== 0) {
        return terminalFailure('consumed tag Undo record still retains child deltas')
      }
    } else if (removedCount !== record.association_remove_count
      || addedCount !== record.association_add_count) {
      return terminalFailure('tag Undo foundation record/delta counts are inconsistent')
    }
  }
  const orphanDelta = db.prepare(`
    SELECT d.record_id
    FROM tag_undo_association_deltas d
    LEFT JOIN tag_undo_records r ON r.record_id = d.record_id
    WHERE r.record_id IS NULL
       OR d.association_id <= 0
       OR d.tag_id <= 0
    LIMIT 1
  `).get()
  if (orphanDelta) return terminalFailure('tag Undo foundation association delta is invalid')

  const duplicateAssociation = db.prepare(`
    SELECT document_id, tag_id, COUNT(*) AS count
    FROM document_tags
    GROUP BY document_id, tag_id
    HAVING count > 1
    LIMIT 1
  `).get()
  if (duplicateAssociation) return terminalFailure('duplicate logical document-tag association exists')
  const invalidAssociation = db.prepare(
    'SELECT association_id FROM document_tags WHERE association_id <= 0 OR association_id IS NULL LIMIT 1',
  ).get()
  if (invalidAssociation) return terminalFailure('document-tag association identity is invalid')
  if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length > 0) return terminalFailure('foreign-key check failed')
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
  if (integrity?.integrity_check !== 'ok') return terminalFailure('SQLite integrity check failed')
  return null
}

export function initializeTagUndoFoundationHealth(db: DatabaseT): TagUndoFoundationHealth {
  const checking: TagUndoFoundationHealth = {
    state: 'checking',
    schemaVersion: 0,
    checkedAt: now(),
  }
  healthByDb.set(db, checking)
  let schemaVersion = 0
  try {
    schemaVersion = Number((db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined)?.version ?? 0)
    const failure = validateFoundationSchema(db)
    const result = failure
      ? unavailable('TAG_UNDO_FOUNDATION_UNHEALTHY', failure.reason, schemaVersion, failure.category)
      : { state: 'healthy' as const, schemaVersion, checkedAt: now() }
    healthByDb.set(db, result)
    return result
  } catch {
    const result = unavailable('TAG_UNDO_FOUNDATION_UNHEALTHY', 'tag Undo foundation validation failed', schemaVersion)
    healthByDb.set(db, result)
    return result
  }
}

export function getTagUndoFoundationHealth(db: DatabaseT): TagUndoFoundationHealth {
  return healthByDb.get(db) ?? unavailable(
    'TAG_UNDO_FOUNDATION_NOT_INITIALIZED',
    'tag Undo foundation health has not been initialized',
  )
}

export function resetTagUndoFoundationHealthForTesting(db?: DatabaseT): void {
  if (db) healthByDb.delete(db)
}
