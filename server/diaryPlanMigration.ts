import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  AtomicTextWriteConflictError, AtomicTextWriteTargetMissingError,
  AtomicTextWritePostCommitExternalMutationError, AtomicTextWriteCleanupError,
  prepareAtomicTextCreate, prepareAtomicTextWrite, sha256Hex,
} from './atomicTextWrite.js'
import { DIARY_BODY_MAX_ENVELOPE_BYTES, DiaryBodyCryptoError } from './diaryAccess/body.js'
import { DiaryPlanCryptoError } from './diaryAccess/planCrypto.js'
import type { DiaryBodyOperation } from './diaryAccess/service.js'
import { createDocumentMetadata, getDocumentMetadata, touchDocumentMetadata } from './documentMetadata.js'
import { withDocumentWriteLock, withVaultStructureLock } from './documentWriteLock.js'
import { getIndex as getLinkIndex } from './linkIndex.js'
import { CONTENT_DIR, filePathFor, readSafeRelativeFile, resolveSafeRelativePath } from './paths.js'
import { appendDiaryPlanItems } from './diaryPlanMarkdown.js'
import { compareDiaryPlanItems, type DiaryPlanMigrationStatus } from '../shared/diaryPlan.js'
import { diaryLogicalPathForDate, parseDiaryDate } from '../shared/diaryProtocol.js'
import type { Database } from 'better-sqlite3'

type Checkpoint = {
  document_id: string
  source_versions: string
  base_hash: string | null
  target_hash: string
}

type SourceRow = {
  id: string
  version: number
  encrypted_fields: Buffer
  completed_at: number | null
  created_at: number
  updated_at: number
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const validTimestamp = (value: number) => Number.isSafeInteger(value) && value >= 0

export function diaryPlanMigrationStatus(db: Database, ownerId: number): DiaryPlanMigrationStatus {
  const counts = db.prepare(`
    SELECT COUNT(DISTINCT p.date) AS total,
      COUNT(DISTINCT CASE WHEN m.completed_at IS NOT NULL THEN p.date END) AS completed
    FROM diary_plan_items p
    LEFT JOIN diary_plan_markdown_migration m ON m.owner_user_id = p.owner_user_id AND m.date = p.date
    WHERE p.owner_user_id = ? AND p.encrypted_fields IS NOT NULL
  `).get(ownerId) as { total: number; completed: number }
  const rows = db.prepare(`
    SELECT date, code FROM diary_plan_migration_failures
    WHERE owner_user_id = ? ORDER BY date
  `).all(ownerId) as Array<{ date: string; code: string }>
  return {
    hasLegacyPlans: counts.total > 0,
    pending: counts.total - counts.completed,
    completed: counts.completed,
    failures: rows.map(({ date, code }) => ({ date: parseDiaryDate(date), code })),
    hasConflicts: rows.some(({ code }) => code !== 'diary-plan-migration-unavailable'),
  }
}

class MigrationConflict extends Error {}
class LegacyDiaryNeedsEncryption extends Error {}

function migrationErrorCode(error: unknown): string {
  if (error instanceof DiaryPlanCryptoError) return 'diary-plan-payload-invalid'
  if (error instanceof DiaryBodyCryptoError) return 'diary-plan-document-invalid'
  if (error instanceof LegacyDiaryNeedsEncryption) return 'diary-plan-document-needs-encryption'
  if (error instanceof MigrationConflict || error instanceof AtomicTextWriteConflictError
    || error instanceof AtomicTextWriteTargetMissingError
    || error instanceof AtomicTextWritePostCommitExternalMutationError
    || error instanceof AtomicTextWriteCleanupError
    || (error as NodeJS.ErrnoException)?.code === 'EEXIST') return 'diary-plan-migration-conflict'
  return 'diary-plan-migration-unavailable'
}

async function statIfPresent(absolute: string) {
  try {
    return await fs.lstat(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function migrateDiaryPlans(
  db: Database, ownerId: number, operation: DiaryBodyOperation, offset: number, signal: AbortSignal,
  canContinue: () => boolean,
) {
  const dates = db.prepare(`
    SELECT DISTINCT p.date FROM diary_plan_items p
    WHERE p.owner_user_id = ? AND p.encrypted_fields IS NOT NULL
    ORDER BY p.date LIMIT 13 OFFSET ?
  `).all(ownerId, offset) as Array<{ date: string }>
  const failures: Array<{ date: string; code: string }> = []
  const batch = dates.slice(0, 12)
  let migrated = 0
  for (const { date } of batch) {
    if (signal.aborted || !canContinue()) break
    operation.assertCurrent()
    try {
      if (await migrateDay(db, ownerId, operation, date, signal, canContinue)) migrated++
    } catch (error) {
      operation.assertCurrent()
      if (signal.aborted || !canContinue()) break
      const code = migrationErrorCode(error)
      db.prepare(`
        INSERT INTO diary_plan_migration_failures (owner_user_id, date, code)
        SELECT ?, ?, ? WHERE NOT EXISTS (
          SELECT 1 FROM diary_plan_markdown_migration
          WHERE owner_user_id = ? AND date = ? AND completed_at IS NOT NULL
        )
        ON CONFLICT (owner_user_id, date) DO UPDATE SET code = excluded.code
      `).run(ownerId, date, code, ownerId, date)
      failures.push({ date: parseDiaryDate(date) ?? '', code })
    }
  }
  const next = dates[batch.length]
  return { migrated, failures, next: next ? offset + batch.length : null }
}

async function migrateDay(
  db: Database, ownerId: number, operation: DiaryBodyOperation, value: string,
  signal: AbortSignal, canContinue: () => boolean,
) {
  const assertActive = () => {
    operation.assertCurrent()
    signal.throwIfAborted()
    // Existing body leases drain on lock. A migration can stop earlier
    // and leave its checkpoint for the next explicitly confirmed run.
    if (!canContinue()) throw new Error('Diary migration access ended')
  }
  const date = parseDiaryDate(value)
  if (!date) throw new DiaryPlanCryptoError()
  const logicalPath = diaryLogicalPathForDate(date)
  const absolute = filePathFor(logicalPath)
  const root = path.dirname(absolute)
  return withVaultStructureLock(() => withDocumentWriteLock(logicalPath, async () => {
    assertActive()
    const checkpoint = db.prepare('SELECT * FROM diary_plan_markdown_migration WHERE owner_user_id = ? AND date = ?')
      .get(ownerId, date) as (Checkpoint & { completed_at: number | null }) | undefined
    if (checkpoint && checkpoint.completed_at !== null) return false

    const source = db.prepare(`
      SELECT id, version, encrypted_fields, completed_at, created_at, updated_at
      FROM diary_plan_items WHERE owner_user_id = ? AND date = ?
        AND encrypted_fields IS NOT NULL ORDER BY id
    `)
    const rows = source.all(ownerId, date) as SourceRow[]
    if (!rows.length) return false
    const versions = (items: readonly Pick<SourceRow, 'id' | 'version'>[]) =>
      JSON.stringify(items.map(({ id, version }) => [id, version]))
    const sourceVersions = versions(rows)
    if (checkpoint && checkpoint.source_versions !== sourceVersions) throw new MigrationConflict()
    const assertStableSource = () => {
      const current = db.prepare(`
        SELECT id, version FROM diary_plan_items WHERE owner_user_id = ? AND date = ?
          AND encrypted_fields IS NOT NULL ORDER BY id
      `).all(ownerId, date) as Pick<SourceRow, 'id' | 'version'>[]
      if (versions(current) !== sourceVersions) throw new MigrationConflict()
    }

    // Each date is prepared only after all source rows authenticate.
    const crypto = operation.plan
    if (!crypto) throw new DiaryPlanCryptoError()
    const plans = rows.map((row) => {
      if (!idPattern.test(row.id) || !Number.isSafeInteger(row.version) || row.version < 1
        || !validTimestamp(row.created_at) || !validTimestamp(row.updated_at)
        || (row.completed_at !== null && !validTimestamp(row.completed_at))) throw new DiaryPlanCryptoError()
      return {
        ...crypto.decrypt(row.encrypted_fields, { ownerId, date, id: row.id }),
        id: row.id, date, version: row.version, createdAt: row.created_at,
        updatedAt: row.updated_at, completedAt: row.completed_at,
      }
    }).sort(compareDiaryPlanItems)

    if (!await statIfPresent(root)) await fs.mkdir(root)
    await resolveSafeRelativePath(CONTENT_DIR, `${logicalPath}.md`, { allowMissingFinal: true })
    const stat = await statIfPresent(absolute)
    if (stat && !stat.isFile()) throw new MigrationConflict()
    const metadata = getDocumentMetadata(db, logicalPath)
    if (checkpoint && metadata?.id !== checkpoint.document_id) throw new MigrationConflict()
    if (stat && !metadata) throw new MigrationConflict()
    if (!stat && metadata && !checkpoint) throw new MigrationConflict()
    const documentId = metadata?.id ?? randomUUID()
    const context = { documentId, logicalPath }
    const readBody = () => readSafeRelativeFile(CONTENT_DIR, `${logicalPath}.md`, undefined, {
      maxBytes: DIARY_BODY_MAX_ENVELOPE_BYTES,
    })
    const bytes = stat ? await readBody() : null
    if (stat && !Buffer.isBuffer(bytes)) throw new MigrationConflict()
    const current = Buffer.isBuffer(bytes) ? operation.decrypt(bytes, context) : null
    // The regular atomic replacement stages the old generation. Route a
    // plaintext legacy primary through the existing Diary encryption flow first.
    if (current && !current.encrypted) throw new LegacyDiaryNeedsEncryption()
    // Checkpoints and atomic CAS describe the physical encrypted generation.
    const baseEnvelope = current?.bytes.toString('utf8') ?? null
    const baseHash = baseEnvelope === null ? null : sha256Hex(baseEnvelope)

    const finish = async () => {
      db.transaction(() => {
        assertActive()
        assertStableSource()
        touchDocumentMetadata(db, logicalPath)
        db.prepare('UPDATE diary_plan_markdown_migration SET completed_at = ? WHERE owner_user_id = ? AND date = ?')
          .run(Date.now(), ownerId, date)
        db.prepare('DELETE FROM diary_plan_migration_failures WHERE owner_user_id = ? AND date = ?').run(ownerId, date)
      }).immediate()
      try {
        (await getLinkIndex()).registerPath(logicalPath)
      } catch { /* The next index rebuild can recover structural existence. */ }
      return true
    }

    if (checkpoint && current?.encrypted && checkpoint.target_hash === baseHash) {
      // The atomic write landed before SQLite confirmation. No second append.
      return finish()
    }
    if (checkpoint && checkpoint.base_hash !== baseHash) throw new MigrationConflict()

    const raw = appendDiaryPlanItems(current?.raw ?? `# ${date}\n`, plans)
    const encrypted = operation.encrypt(raw, context).toString('utf8')
    if (Buffer.byteLength(encrypted, 'utf8') > DIARY_BODY_MAX_ENVELOPE_BYTES) throw new MigrationConflict()
    const prepared = current
      ? await prepareAtomicTextWrite(absolute, encrypted, { mode: stat?.mode })
      : await prepareAtomicTextCreate(absolute, encrypted)
    try {
      // Preserve the document identity and exact encrypted generation proof
      // across a crash, before publishing any new file bytes.
      db.transaction(() => {
        assertActive()
        assertStableSource()
        if (!metadata) {
          const now = Date.now()
          createDocumentMetadata(db, { id: documentId, path: logicalPath, title: date, createdAt: now, updatedAt: now })
        }
        db.prepare(`
          INSERT INTO diary_plan_markdown_migration
            (owner_user_id, date, document_id, source_versions, base_hash, target_hash)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner_user_id, date) DO UPDATE SET target_hash = excluded.target_hash
        `).run(ownerId, date, documentId, sourceVersions, baseHash, sha256Hex(encrypted))
      }).immediate()
      await prepared.commit(baseEnvelope ?? '', () => {
        assertActive()
        assertStableSource()
      })
      const written = await readBody()
      if (!Buffer.isBuffer(written) || !written.equals(Buffer.from(encrypted, 'utf8'))) throw new MigrationConflict()
      return await finish()
    } finally {
      await prepared.rollback()
    }
  }))
}
