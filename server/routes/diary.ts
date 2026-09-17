import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { PostSummary } from '../../src/lib/api.js'
import { Hono } from 'hono'
import {
  diaryLogicalPathForDate,
  parseDiaryDate,
  type DiaryDate,
} from '../../shared/diaryProtocol.js'
import {
  AtomicTextWriteConflictError,
  prepareAtomicTextCreate,
} from '../atomicTextWrite.js'
import {
  createDocumentMetadata,
  deleteDocumentMetadata,
  getDocumentMetadata,
  restoreDocumentMetadataMutation,
  snapshotDocumentMetadataMutation,
} from '../documentMetadata.js'
import { withDocumentWriteLock, withVaultStructureLock } from '../documentWriteLock.js'
import { getIndex as getLinkIndex } from '../linkIndex.js'
import { filePathFor } from '../paths.js'
import {
  bad,
  ensureMetadata,
  metadataDb,
} from './shared.js'
import { requireDiaryBodyAccess, withDiaryBodyOperation } from '../diaryAccess/guard.js'
import { DiaryBodyCryptoError, isEncryptedDiaryBody } from '../diaryAccess/body.js'
import type { DiaryBodyOperation } from '../diaryAccess/service.js'

const diaryRoutes = new Hono()

function diaryBodyError(c: any, error: unknown): Response {
  if (!(error instanceof DiaryBodyCryptoError)) throw error
  const code = error.code === 'unsupported-envelope'
    ? 'diary-body-unsupported-envelope'
    : error.code === 'identity-mismatch'
      ? 'diary-body-identity-mismatch'
      : 'diary-body-invalid-envelope'
  c.header('Cache-Control', 'no-store')
  return c.json({ error: error.message, code }, 409)
}

class DiaryPathConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiaryPathConflictError'
  }
}

/** Validate the business timezone without ever using it as a filesystem value. */
export function parseDiaryTimeZone(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const timeZone = value.trim()
  if (!timeZone) return null
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
    return resolved ? timeZone : null
  } catch {
    return null
  }
}

/** Return the local civil date for an instant in a validated IANA timezone. */
export function localDiaryDateForTimeZone(now: Date, timeZone: string): DiaryDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  const date = parseDiaryDate(`${value('year')}-${value('month')}-${value('day')}`)
  if (!date) throw new Error('could not derive a valid local Diary date')
  return date
}

function metadataDate(value: number): string {
  // This is the existing PostSummary metadata convention. It is not used for
  // Diary identity or today/future comparison; those remain date-only values.
  return new Date(value).toISOString().slice(0, 10)
}

function postSummary(
  logicalPath: string,
  stat: { size: number | bigint; mtimeMs: number | bigint },
  metadata: ReturnType<typeof ensureMetadata>,
): PostSummary {
  return {
    path: logicalPath,
    title: metadata.title,
    created: metadataDate(metadata.createdAt),
    updated: metadataDate(metadata.updatedAt),
    tags: [...metadata.tags],
    summary: metadata.summary,
    size: Number(stat.size),
    mtime: Number(stat.mtimeMs),
    mood: metadata.mood,
    documentId: metadata.id,
    metadataUpdatedAt: metadata.updatedAt,
  }
}

async function readExistingDiary(
  logicalPath: string,
  absolutePath: string,
  operation: DiaryBodyOperation,
): Promise<PostSummary | null> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(absolutePath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'ENOTDIR') {
      throw new DiaryPathConflictError('diary root is occupied by a non-directory file')
    }
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DiaryPathConflictError('Diary date path is occupied by a non-file')
  }
  const bytes = await fs.readFile(absolutePath)
  const metadata = getDocumentMetadata(metadataDb(), logicalPath)
  if (!metadata && isEncryptedDiaryBody(bytes)) {
    throw new DiaryBodyCryptoError('identity-mismatch', 'Encrypted Diary metadata identity is unavailable')
  }
  const raw = metadata
    ? operation.decrypt(
        bytes,
        { documentId: metadata.id, logicalPath },
      ).raw
    : bytes.toString('utf8')
  const resolvedMetadata = metadata ?? ensureMetadata(logicalPath, raw, stat.mtimeMs)
  return postSummary(logicalPath, stat, resolvedMetadata)
}

async function ensureDiaryRoot(absolutePath: string): Promise<void> {
  const root = path.dirname(absolutePath)
  await fs.mkdir(root, { recursive: true })
  const stat = await fs.lstat(root)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DiaryPathConflictError('diary root is occupied by a non-directory file')
  }
}

function isExistenceConflict(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST'
}

// Resolve one Diary date. The request identity is deliberately only `date`;
// the server derives the exact logical/physical path and owns future checks.
diaryRoutes.post('/api/diary/dates', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    date?: unknown
    timeZone?: unknown
  } | null
  const date = parseDiaryDate(body?.date)
  if (!date) return bad(c, 'invalid Diary date; expected YYYY-MM-DD', 400, 'invalid-diary-date')
  const bodyAccess = requireDiaryBodyAccess(c, `diary/${date}`)
  if (bodyAccess) return bodyAccess
  const timeZone = parseDiaryTimeZone(body?.timeZone)
  if (!timeZone) return bad(c, 'invalid IANA timezone', 400, 'invalid-timezone')
  const bodyOperation = await withDiaryBodyOperation(c, async (operation) => {

  const logicalPath = diaryLogicalPathForDate(date)
  let absolutePath: string
  try {
    absolutePath = filePathFor(logicalPath)
  } catch (error) {
    return bad(c, (error as Error).message)
  }

  return withVaultStructureLock(() => withDocumentWriteLock(logicalPath, async () => {
    try {
      const existing = await readExistingDiary(logicalPath, absolutePath, operation)
      if (existing) return c.json({ date, path: logicalPath, created: false, post: existing }, 200)
    } catch (error) {
      if (error instanceof DiaryPathConflictError) return bad(c, error.message, 409)
      if (error instanceof DiaryBodyCryptoError) return diaryBodyError(c, error)
      throw error
    }

    // Compare canonical YYYY-MM-DD strings only. No UTC-midnight Date or
    // ISO-string slicing is involved in the local today/future decision.
    const today = localDiaryDateForTimeZone(new Date(), timeZone)
    if (date > today) {
      return bad(c, 'future Diary dates cannot be created', 422, 'future-diary-date')
    }

    try {
      await ensureDiaryRoot(absolutePath)
    } catch (error) {
      if (error instanceof DiaryPathConflictError) return bad(c, error.message, 409)
      throw error
    }

    const raw = `# ${date}\n`
    const databaseSnapshot = snapshotDocumentMetadataMutation(metadataDb(), [logicalPath])
    const documentId = randomUUID()
    // A new physical generation must not inherit a stale row from a prior
    // delete/recreate cycle; the snapshot above restores it on failure.
    let metadata: ReturnType<typeof createDocumentMetadata>
    let physicalRaw: string
    let prepared: Awaited<ReturnType<typeof prepareAtomicTextCreate>> | null = null
    try {
      deleteDocumentMetadata(metadataDb(), logicalPath)
      metadata = createDocumentMetadata(metadataDb(), {
        id: documentId,
        path: logicalPath,
        title: String(date),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      physicalRaw = operation.encrypt(
        raw,
        { documentId: metadata.id, logicalPath },
      ).toString('utf8')
      prepared = await prepareAtomicTextCreate(absolutePath, physicalRaw)
      operation.assertCurrent()
      await prepared.commit()
      const stat = await fs.stat(absolutePath)
      operation.assertCurrent()
      const post = postSummary(logicalPath, stat, metadata)
      try {
        const index = await getLinkIndex()
        // Managed Diary contributes structural existence only. The plaintext
        // body remains inside the adapter operation and never enters the
        // process-wide LinkIndex.
        index.registerPath(logicalPath)
      } catch { /* best effort; next rebuild repairs structural state */ }
      return c.json({ date, path: logicalPath, created: true, post }, 201)
    } catch (error) {
      const failures: unknown[] = [error]
      try {
        const rolledBack = await prepared?.rollbackCreatedGenerationIfStillOwned()
        if (rolledBack === null || rolledBack === undefined) await prepared?.rollback()
      } catch (rollbackError) { failures.push(rollbackError) }
      try { restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot) }
      catch (rollbackError) { failures.push(rollbackError) }
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Diary creation failed and rollback was incomplete')
      }
      if (isExistenceConflict(error)) {
        try {
          const existing = await readExistingDiary(logicalPath, absolutePath, operation)
          if (existing) return c.json({ date, path: logicalPath, created: false, post: existing }, 200)
        } catch (readError) {
          if (readError instanceof DiaryPathConflictError) return bad(c, readError.message, 409)
          if (readError instanceof DiaryBodyCryptoError) return diaryBodyError(c, readError)
          throw readError
        }
        return bad(c, 'Diary date was claimed but could not be resolved', 409, 'diary-create-conflict')
      }
      if (error instanceof AtomicTextWriteConflictError) {
        return bad(c, 'Diary date changed on disk; retry', 409, 'diary-create-conflict')
      }
      throw error
    }
  })
  )
  })
  return bodyOperation ?? bad(c, 'Diary access is locked', 423, 'diary-locked')
})

export default diaryRoutes
