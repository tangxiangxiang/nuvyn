import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database as DatabaseT } from 'better-sqlite3'
import {
  TAG_IDENTITY_CONTRACT_VERSION,
  validatePersistentTag,
} from '../shared/tagNormalization.js'
import { MetadataVersionError, nextMetadataUpdatedAt } from './metadataVersion.js'
import type { MetadataMigrationReport } from './metadataMigration.js'
import { NUVYN_VAULT_DIRECTORY } from './technicalNamespace.js'

export const TAG_IDENTITY_MIGRATION_KEY = 'internal.tags.identity.tag-identity-v1'
const MAX_MARKER_BYTES = 4096
const MAX_ERROR_REASON_LENGTH = 256
const UNSAFE_ERROR_REASON_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u
const UNSAFE_ERROR_REASON_CHARACTERS_GLOBAL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu

export type TagIdentityHealthState = 'checking' | 'healthy' | 'unavailable'

export type TagIdentityHealth = {
  state: TagIdentityHealthState
  code?: string
  reason?: string
  migrationComplete: boolean
  checkedAt: number
}

export type TagIdentityMigrationReport = {
  rowsScanned: number
  logicalGroups: number
  collisionGroups: number
  survivors: number
  associationsMoved: number
  associationsCollapsed: number
  tagRowsDeleted: number
  displayRowsChanged: number
  identityRowsChanged: number
  documentsVersioned: number
}

type TagRow = {
  id: number
  name: string
  normalized_name: string
}

type TagGroup = {
  identity: string
  rows: TagRow[]
}

type Marker = {
  contractVersion: typeof TAG_IDENTITY_CONTRACT_VERSION
  status: 'complete' | 'failed'
  attemptedAt: number
  completedAt?: number
  report: TagIdentityMigrationReport
  errorCode?: string
  errorReason?: string
}

const EMPTY_REPORT: TagIdentityMigrationReport = {
  rowsScanned: 0,
  logicalGroups: 0,
  collisionGroups: 0,
  survivors: 0,
  associationsMoved: 0,
  associationsCollapsed: 0,
  tagRowsDeleted: 0,
  displayRowsChanged: 0,
  identityRowsChanged: 0,
  documentsVersioned: 0,
}

function copyReport(report: TagIdentityMigrationReport): TagIdentityMigrationReport {
  return { ...report }
}

function sanitizeMigrationFailureReason(reason: unknown): string {
  const raw = reason instanceof Error
    ? reason.message
    : typeof reason === 'string'
      ? reason
      : 'tag identity migration failed'
  const normalized = raw
    .replace(UNSAFE_ERROR_REASON_CHARACTERS_GLOBAL, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return (normalized || 'tag identity migration failed').slice(0, MAX_ERROR_REASON_LENGTH)
}

class TagIdentityMigrationError extends Error {
  readonly code: string
  readonly report?: TagIdentityMigrationReport

  constructor(code: string, message: string, report?: TagIdentityMigrationReport) {
    super(message)
    this.name = 'TagIdentityMigrationError'
    this.code = code
    this.report = report ? copyReport(report) : undefined
  }
}

function migrationFailure(
  code: string,
  reason: string,
  report?: TagIdentityMigrationReport,
): TagIdentityMigrationError {
  return new TagIdentityMigrationError(code, sanitizeMigrationFailureReason(reason), report)
}

const healthByDb = new WeakMap<object, TagIdentityHealth>()
type MigrationFailureStage =
  | 'after-staging'
  | 'after-association-repoint'
  | 'after-association-collapse'
  | 'after-tag-deletion'
  | 'after-tag-update'
  | 'after-document-version-update'
  | 'before-complete-marker'

type MigrationFailureInjection = {
  stage: MigrationFailureStage
  reason?: string
}

let failureInjection: MigrationFailureStage | MigrationFailureInjection | null = null

function now(): number {
  return Date.now()
}

function unavailable(code: string, reason: string, migrationComplete = false): TagIdentityHealth {
  return { state: 'unavailable', code, reason, migrationComplete, checkedAt: now() }
}

function readMarker(db: DatabaseT): Marker | null | 'invalid' {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TAG_IDENTITY_MIGRATION_KEY) as
    | { value: string }
    | undefined
  if (!row) return null
  if (Buffer.byteLength(row.value, 'utf8') > MAX_MARKER_BYTES) return 'invalid'
  try {
    const parsed = JSON.parse(row.value) as Partial<Marker>
    const report = parsed.report as Partial<TagIdentityMigrationReport> | undefined
    const reportFields: Array<keyof TagIdentityMigrationReport> = [
      'rowsScanned', 'logicalGroups', 'collisionGroups', 'survivors',
      'associationsMoved', 'associationsCollapsed', 'tagRowsDeleted',
      'displayRowsChanged', 'identityRowsChanged', 'documentsVersioned',
    ]
    if (parsed.contractVersion !== TAG_IDENTITY_CONTRACT_VERSION
      || (parsed.status !== 'complete' && parsed.status !== 'failed')
      || !Number.isSafeInteger(parsed.attemptedAt) || parsed.attemptedAt! < 0
      || (parsed.status === 'complete' && (!Number.isSafeInteger(parsed.completedAt) || parsed.completedAt! < 0))
      || !report || typeof report !== 'object'
      || reportFields.some((field) => !Number.isSafeInteger(report[field]) || (report[field] as number) < 0)
      || (parsed.errorCode !== undefined && (typeof parsed.errorCode !== 'string' || parsed.errorCode.length > 128))
      || (parsed.errorReason !== undefined && (
        typeof parsed.errorReason !== 'string'
        || parsed.errorReason.length > MAX_ERROR_REASON_LENGTH
        || UNSAFE_ERROR_REASON_CHARACTERS.test(parsed.errorReason)
      ))) {
      return 'invalid'
    }
    return parsed as Marker
  } catch {
    return 'invalid'
  }
}

function writeMarker(db: DatabaseT, marker: Marker): void {
  const value = JSON.stringify(marker)
  if (Buffer.byteLength(value, 'utf8') > MAX_MARKER_BYTES) {
    throw migrationFailure('TAG_IDENTITY_MIGRATION_FAILED', 'tag identity marker is too large')
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(TAG_IDENTITY_MIGRATION_KEY, value)
}

function injectFailureIfRequested(stage: MigrationFailureStage, report: TagIdentityMigrationReport): void {
  const injection = typeof failureInjection === 'string'
    ? { stage: failureInjection }
    : failureInjection
  if (!injection || injection.stage !== stage) return
  throw migrationFailure(
    'TAG_IDENTITY_MIGRATION_FAILED',
    injection.reason ?? `injected migration failure at ${stage}`,
    report,
  )
}

function readTagRows(db: DatabaseT): TagRow[] {
  return db.prepare('SELECT id, name, normalized_name FROM tags ORDER BY id').all() as TagRow[]
}

function canonicalTag(row: TagRow): { displayName: string; normalizedName: string } {
  const validation = validatePersistentTag(row.name)
  if (!validation.ok) throw migrationFailure('TAG_IDENTITY_INVALID', validation.message)
  return { displayName: validation.displayName, normalizedName: validation.normalizedName }
}

function logicalMemberships(db: DatabaseT, tags = readTagRows(db)): Set<string> {
  const byId = new Map<number, string>()
  for (const tag of tags) byId.set(tag.id, canonicalTag(tag).normalizedName)
  const memberships = new Set<string>()
  const rows = db.prepare('SELECT document_id, tag_id FROM document_tags ORDER BY document_id, tag_id')
    .all() as Array<{ document_id: string; tag_id: number }>
  for (const row of rows) {
    const identity = byId.get(row.tag_id)
    if (identity === undefined) throw migrationFailure('TAG_IDENTITY_ASSOCIATION_INVALID', 'association references an unknown tag')
    memberships.add(`${row.document_id}\u0000${identity}`)
  }
  return memberships
}

function verifySetsEqual(before: Set<string>, after: Set<string>): void {
  if (before.size !== after.size) throw migrationFailure('TAG_IDENTITY_MEMBERSHIP_LOSS', 'logical tag membership changed during migration')
  for (const value of before) if (!after.has(value)) throw migrationFailure('TAG_IDENTITY_MEMBERSHIP_LOSS', 'logical tag membership changed during migration')
}

function verifyCanonicalState(db: DatabaseT): void {
  const rows = readTagRows(db)
  const identities = new Set<string>()
  for (const row of rows) {
    const canonical = canonicalTag(row)
    if (row.normalized_name !== canonical.normalizedName) {
      throw migrationFailure('TAG_IDENTITY_UNHEALTHY', 'stored tag identity is not canonical')
    }
    if (identities.has(canonical.normalizedName)) {
      throw migrationFailure('TAG_IDENTITY_CONFLICT', 'duplicate canonical tag identity remains')
    }
    identities.add(canonical.normalizedName)
  }
  const duplicateAssociation = db.prepare(`
    SELECT document_id, tag_id, COUNT(*) AS count
    FROM document_tags GROUP BY document_id, tag_id HAVING count > 1 LIMIT 1
  `).get()
  if (duplicateAssociation) throw migrationFailure('TAG_IDENTITY_UNHEALTHY', 'duplicate document-tag association remains')
  const foreignKeyFailure = db.prepare('PRAGMA foreign_key_check').get()
  if (foreignKeyFailure) throw migrationFailure('TAG_IDENTITY_UNHEALTHY', 'foreign key check failed')
}

function stageNamespace(db: DatabaseT, group: TagGroup): string {
  const namespace = `__nuvyn_t20_stage_${randomUUID()}_`
  for (const row of group.rows) {
    const staged = `${namespace}${row.id}`
    if (db.prepare('SELECT 1 FROM tags WHERE normalized_name = ?').get(staged)) {
      throw migrationFailure('TAG_IDENTITY_MIGRATION_FAILED', 'temporary identity namespace collided')
    }
    db.prepare('UPDATE tags SET normalized_name = ? WHERE id = ?').run(staged, row.id)
  }
  return namespace
}

function writeMigration(db: DatabaseT, attemptedAt: number): TagIdentityMigrationReport {
  const tags = readTagRows(db)
  const report: TagIdentityMigrationReport = {
    ...EMPTY_REPORT,
    rowsScanned: tags.length,
  }
  try {
    const beforeMembership = logicalMemberships(db, tags)
    const groupsByIdentity = new Map<string, TagRow[]>()
    for (const row of tags) {
      const canonical = canonicalTag(row)
      const group = groupsByIdentity.get(canonical.normalizedName) ?? []
      group.push(row)
      groupsByIdentity.set(canonical.normalizedName, group)
    }
    const groups: TagGroup[] = [...groupsByIdentity.entries()]
      .map(([identity, rows]) => ({ identity, rows: rows.sort((a, b) => a.id - b.id) }))
      .sort((a, b) => a.rows[0].id - b.rows[0].id)
    report.logicalGroups = groups.length
    report.collisionGroups = groups.filter((group) => group.rows.length > 1).length
    report.survivors = groups.length

    const affectedDocuments = new Set<string>()
    const associationCount = db.prepare('SELECT document_id, tag_id FROM document_tags')
      .all() as Array<{ document_id: string; tag_id: number }>
    const docsByTag = new Map<number, string[]>()
    for (const association of associationCount) {
      const docs = docsByTag.get(association.tag_id) ?? []
      docs.push(association.document_id)
      docsByTag.set(association.tag_id, docs)
    }

    // A document is versioned only when its physical membership changes or its
    // hydrated display changes. Staging is an internal implementation detail;
    // it must not make survivor-only documents look affected.
    for (const group of groups) {
      const survivor = group.rows[0]
      const survivorCanonical = canonicalTag(survivor)
      const displayChanges = survivor.name !== survivorCanonical.displayName
      const affectedRows = displayChanges ? group.rows : group.rows.slice(1)
      for (const row of affectedRows) {
        for (const documentId of docsByTag.get(row.id) ?? []) affectedDocuments.add(documentId)
      }
    }

    const stageGroups = groups.filter((group) => group.rows.length > 1
      || group.rows.some((row) => {
        const canonical = canonicalTag(row)
        return canonical.normalizedName !== row.normalized_name || canonical.displayName !== row.name
      }))
    for (const group of stageGroups) {
      stageNamespace(db, group)
      injectFailureIfRequested('after-staging', report)
    }

    const deleteAssociations = db.prepare('DELETE FROM document_tags WHERE tag_id = ?')
    const deleteTag = db.prepare('DELETE FROM tags WHERE id = ?')
    const updateSurvivor = db.prepare('UPDATE tags SET name = ?, normalized_name = ? WHERE id = ?')
    for (const group of groups) {
      const survivor = group.rows[0]
      const canonical = canonicalTag(survivor)
      const displayChanges = survivor.name !== canonical.displayName
      const identityChanges = survivor.normalized_name !== canonical.normalizedName
      if (group.rows.length > 1) {
        const losingIds = group.rows.slice(1).map((row) => row.id)
        const beforeAssociations = db.prepare(`SELECT COUNT(*) AS count FROM document_tags WHERE tag_id IN (${losingIds.map(() => '?').join(', ')})`).get(...losingIds) as { count: number }
        const repoint = db.prepare(`
          INSERT OR IGNORE INTO document_tags (document_id, tag_id)
          SELECT document_id, ? FROM document_tags
          WHERE tag_id IN (${group.rows.map(() => '?').join(', ')})
        `).run(survivor.id, ...group.rows.map((row) => row.id))
        report.associationsMoved += Number(repoint.changes)
        injectFailureIfRequested('after-association-repoint', report)
        deleteAssociations.run(losingIds[0])
        for (const losingId of losingIds.slice(1)) deleteAssociations.run(losingId)
        report.associationsCollapsed += Number(beforeAssociations.count) - Number(repoint.changes)
        injectFailureIfRequested('after-association-collapse', report)
        for (const losingId of losingIds) deleteTag.run(losingId)
        report.tagRowsDeleted += losingIds.length
        injectFailureIfRequested('after-tag-deletion', report)
      }
      if (group.rows.length > 1 || displayChanges || identityChanges) {
        updateSurvivor.run(canonical.displayName, canonical.normalizedName, survivor.id)
        if (displayChanges) report.displayRowsChanged++
        if (identityChanges) report.identityRowsChanged++
        injectFailureIfRequested('after-tag-update', report)
      }
    }

    const candidateNow = now()
    let versionRows: Array<{ id: string; updated_at: number }> = []
    if (affectedDocuments.size > 0) {
      versionRows = db.prepare(
        `SELECT id, updated_at FROM documents WHERE id IN (${[...affectedDocuments].map(() => '?').join(', ')}) ORDER BY id`,
      ).all(...affectedDocuments) as Array<{ id: string; updated_at: number }>
    }
    const updateVersion = db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?')
    for (const row of versionRows) {
      let next: number
      try { next = nextMetadataUpdatedAt(row.updated_at, candidateNow) }
      catch (error) {
        if (error instanceof MetadataVersionError) throw migrationFailure('METADATA_VERSION_OVERFLOW', error.message)
        throw error
      }
      updateVersion.run(next, row.id)
      report.documentsVersioned++
      injectFailureIfRequested('after-document-version-update', report)
    }
    verifyCanonicalState(db)
    verifySetsEqual(beforeMembership, logicalMemberships(db))
    injectFailureIfRequested('before-complete-marker', report)
    const marker: Marker = {
      contractVersion: TAG_IDENTITY_CONTRACT_VERSION,
      status: 'complete',
      attemptedAt,
      completedAt: now(),
      report,
    }
    // Marker-last: no write follows this settings update before COMMIT.
    writeMarker(db, marker)
    return report
  } catch (error) {
    if (error instanceof TagIdentityMigrationError) {
      // Failed-marker reports describe attempt progress before rollback, not
      // mutations that were durably committed.
      throw migrationFailure(error.code, error.message, report)
    }
    // Unexpected SQLite/runtime failures still get the safely available
    // attempt snapshot, but never expose raw driver text in the marker.
    throw migrationFailure('TAG_IDENTITY_MIGRATION_FAILED', 'tag identity migration failed', report)
  }
}

function failedReport(): TagIdentityMigrationReport {
  return { ...EMPTY_REPORT }
}

function runTagIdentityMigrationAtStartup(db: DatabaseT): { report: TagIdentityMigrationReport; complete: boolean; code?: string } {
  const marker = readMarker(db)
  if (marker === 'invalid') return { report: failedReport(), complete: false, code: 'TAG_IDENTITY_CONFLICT' }
  if (marker?.status === 'complete') {
    try {
      verifyCanonicalState(db)
      return { report: marker.report, complete: true }
    } catch (error) {
      // A completed marker is historical evidence, not permission to repair
      // a later out-of-band mutation. Keep management unavailable and force
      // the operator-facing conflict diagnosis instead of silently rewriting
      // the database on every startup.
      return { report: marker.report, complete: false, code: 'TAG_IDENTITY_CONFLICT' }
    }
  }

  const attemptedAt = now()
  try {
    const tx = db.transaction(() => writeMigration(db, attemptedAt))
    return { report: tx.immediate(), complete: true }
  } catch (error) {
    const migrationError = error instanceof TagIdentityMigrationError ? error : undefined
    const code = migrationError
      ? migrationError.code
      : error instanceof Error && error.name === 'SqliteError'
        ? 'TAG_IDENTITY_MIGRATION_FAILED'
        : 'TAG_IDENTITY_MIGRATION_FAILED'
    const report = migrationError?.report ?? failedReport()
    try {
      writeMarker(db, {
        contractVersion: TAG_IDENTITY_CONTRACT_VERSION,
        status: 'failed',
        attemptedAt,
        // This is diagnostic attempt progress; the surrounding transaction
        // has already rolled back and none of these mutations were committed.
        report,
        errorCode: code,
        errorReason: sanitizeMigrationFailureReason(migrationError?.message ?? 'tag identity migration failed'),
      })
    } catch {
      // The process health cache below remains unavailable and the missing
      // marker makes a future startup retry the migration.
    }
    return { report, complete: false, code }
  }
}

/** Test seam for the startup-only destructive identity migration. */
export function runTagIdentityMigrationForTesting(db: DatabaseT): { report: TagIdentityMigrationReport; complete: boolean; code?: string } {
  return runTagIdentityMigrationAtStartup(db)
}

async function liveMarkdownPaths(rootDir: string): Promise<string[]> {
  const result: string[] = []
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git'
        || entry.name === NUVYN_VAULT_DIRECTORY
        || entry.name === NUVYN_VAULT_DIRECTORY) continue
      const absolute = path.join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(absolute, relative)
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(relative.slice(0, -3))
    }
  }
  await walk(rootDir, '')
  return result.sort()
}

async function verifyLiveMetadata(
  db: DatabaseT,
  contentDir: string,
  metadataReport?: MetadataMigrationReport,
): Promise<{ code?: string; reason?: string }> {
  if (metadataReport?.failed && metadataReport.failed > 0) {
    return { code: 'METADATA_MIGRATION_INCOMPLETE', reason: 'live metadata migration has failed documents' }
  }
  let paths: string[]
  try { paths = await liveMarkdownPaths(contentDir) }
  catch { return { code: 'METADATA_INVENTORY_UNAVAILABLE', reason: 'live Markdown inventory could not be read' } }
  const failedRows = new Set((db.prepare("SELECT path FROM metadata_migrations WHERE status = 'failed'").all() as Array<{ path: string }>).map((row) => row.path))
  for (const documentPath of paths) {
    if (!db.prepare('SELECT 1 FROM documents WHERE path = ?').get(documentPath)) {
      return { code: 'METADATA_OWNERSHIP_INCOMPLETE', reason: 'a live Markdown path has no database-owned metadata' }
    }
    if (failedRows.has(documentPath)) return { code: 'METADATA_MIGRATION_INCOMPLETE', reason: 'a live Markdown path has a failed metadata migration' }
  }
  return {}
}

/**
 * Re-run the management safety checks without retrying identity migration.
 *
 * Management requests must not rely on the startup cache: a Markdown file can
 * be added after startup and would otherwise be invisible to a global tag
 * operation. This function is deliberately read-only and is also the only
 * health seam used by the management routes.
 */
export async function preflightTagIdentityHealth(
  db: DatabaseT,
  contentDir: string,
): Promise<TagIdentityHealth> {
  const marker = readMarker(db)
  if (marker === 'invalid') {
    return unavailable('TAG_IDENTITY_CONFLICT', 'tag identity marker is malformed or has an unknown version')
  }
  if (!marker) {
    return unavailable('TAG_IDENTITY_MIGRATION_REQUIRED', 'tag identity migration has not completed')
  }
  if (marker.status === 'failed') {
    return unavailable(marker.errorCode ?? 'TAG_IDENTITY_MIGRATION_FAILED', 'tag identity migration failed during startup')
  }

  try {
    verifyCanonicalState(db)
  } catch (error) {
    return unavailable(
      error instanceof TagIdentityMigrationError ? error.code : 'TAG_IDENTITY_UNHEALTHY',
      'tag identity invariant verification failed',
      true,
    )
  }
  const invalidTagId = (db.prepare('SELECT id FROM tags').all() as Array<{ id: number }>)
    .some((row) => !Number.isSafeInteger(row.id) || row.id <= 0)
  if (invalidTagId) {
    return unavailable('TAG_IDENTITY_UNHEALTHY', 'tag identity stable IDs are unavailable', true)
  }

  const live = await verifyLiveMetadata(db, contentDir)
  if (live.code) {
    return unavailable(live.code, live.reason ?? 'metadata health is unavailable', true)
  }

  return { state: 'healthy', migrationComplete: true, checkedAt: now() }
}

export async function initializeTagIdentityAndHealth(
  db: DatabaseT,
  contentDir: string,
  metadataReport: MetadataMigrationReport,
): Promise<TagIdentityHealth> {
  const checking: TagIdentityHealth = { state: 'checking', migrationComplete: false, checkedAt: now() }
  healthByDb.set(db, checking)
  const migration = runTagIdentityMigrationAtStartup(db)
  if (!migration.complete) {
    const result = unavailable(migration.code ?? 'TAG_IDENTITY_UNHEALTHY', 'tag identity migration or verification failed')
    healthByDb.set(db, result)
    return result
  }
  const live = await verifyLiveMetadata(db, contentDir, metadataReport)
  if (live.code) {
    const result = unavailable(live.code, live.reason ?? 'metadata health is unavailable', true)
    healthByDb.set(db, result)
    return result
  }
  try { verifyCanonicalState(db) }
  catch (error) {
    const result = unavailable(error instanceof TagIdentityMigrationError ? error.code : 'TAG_IDENTITY_UNHEALTHY', 'tag identity invariant verification failed', true)
    healthByDb.set(db, result)
    return result
  }
  const result: TagIdentityHealth = { state: 'healthy', migrationComplete: true, checkedAt: now() }
  healthByDb.set(db, result)
  return result
}

/**
 * Refresh the process-local management health after a runtime metadata
 * migration. This path is deliberately read-only for Tag identity: only the
 * startup initializer may retry an absent or failed identity migration.
 */
export async function refreshTagIdentityHealth(
  db: DatabaseT,
  contentDir: string,
  metadataReport: MetadataMigrationReport,
): Promise<TagIdentityHealth> {
  const checking: TagIdentityHealth = { state: 'checking', migrationComplete: false, checkedAt: now() }
  healthByDb.set(db, checking)

  const marker = readMarker(db)
  if (marker === 'invalid') {
    const result = unavailable('TAG_IDENTITY_CONFLICT', 'tag identity marker is malformed or has an unknown version')
    healthByDb.set(db, result)
    return result
  }
  if (!marker) {
    const result = unavailable('TAG_IDENTITY_MIGRATION_REQUIRED', 'tag identity migration has not completed')
    healthByDb.set(db, result)
    return result
  }
  if (marker.status === 'failed') {
    const result = unavailable('TAG_IDENTITY_MIGRATION_FAILED', 'tag identity migration failed during startup')
    healthByDb.set(db, result)
    return result
  }

  const live = await verifyLiveMetadata(db, contentDir, metadataReport)
  if (live.code) {
    const result = unavailable(live.code, live.reason ?? 'metadata health is unavailable', true)
    healthByDb.set(db, result)
    return result
  }
  try { verifyCanonicalState(db) }
  catch (error) {
    const result = unavailable(error instanceof TagIdentityMigrationError ? error.code : 'TAG_IDENTITY_UNHEALTHY', 'tag identity invariant verification failed', true)
    healthByDb.set(db, result)
    return result
  }
  const result: TagIdentityHealth = { state: 'healthy', migrationComplete: true, checkedAt: now() }
  healthByDb.set(db, result)
  return result
}

export function getTagIdentityHealth(db: DatabaseT): TagIdentityHealth {
  return healthByDb.get(db) ?? {
    state: 'unavailable',
    code: 'TAG_IDENTITY_NOT_INITIALIZED',
    reason: 'tag identity health has not been initialized',
    migrationComplete: false,
    checkedAt: now(),
  }
}

export function resetTagIdentityHealthForTesting(db?: DatabaseT): void {
  if (db) healthByDb.delete(db)
}

export function __setTagIdentityMigrationFailureForTesting(
  failure: MigrationFailureStage | MigrationFailureInjection | null,
): void {
  failureInjection = failure
}
