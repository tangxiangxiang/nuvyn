import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import matter from 'gray-matter'
import { Hono } from 'hono'
import { isInArchive } from '../../shared/archiveProtocol.js'
import { classifyDiaryPath } from '../../shared/diaryProtocol.js'
import type { PostDetail, PostSummary, SavePostResult } from '../../src/lib/api.js'
import {
  deleteDocumentMetadata,
  createDocumentMetadata,
  getDocumentMetadata,
  moveDocumentMetadataReplacingDestination,
  restoreDocumentMetadataMutation,
  snapshotDocumentMetadataMutation,
} from '../documentMetadata.js'
import {
  RenameDestinationOccupiedError,
  RenameSourceReusedError,
  renameDocumentWithMetadata,
} from '../documentFileLifecycle.js'
import {
  AtomicTextWriteConflictError,
  AtomicTextWriteTargetMissingError,
  AtomicTextWritePostCommitExternalMutationError,
  AtomicTextWriteCleanupError,
  atomicReplaceTextIfUnchanged,
  atomicRemoveTextIfUnchanged,
  prepareAtomicTextCreate,
  removeDurableJournal,
  syncParentDirectoryBestEffort,
  writeDurableJournal,
  prepareAtomicTextWrite,
  readStableTextSnapshot,
  UnstableTextSnapshotError,
  type StableTextSnapshot,
} from '../atomicTextWrite.js'
import { withDocumentWriteLock, withDocumentWriteLocks, withVaultStructureLock } from '../documentWriteLock.js'
import { getIndex as getLinkIndex } from '../linkIndex.js'
import { prepareRenameReferenceJournal, type PreparedRenameReferenceJournal } from '../renameReferenceJournal.js'
import { trackCleanedDocumentWrite } from '../metadataMigration.js'
import { CONTENT_DIR, filePathFor, isValidPathSyntax, isValidSegment } from '../paths.js'
import { rewriteDocumentReferences } from '../renameReferences.js'
import { validateDocumentMutation } from '../documentMutationPolicy.js'
import { listPostsFlat, readFrontmatter } from '../tree.js'
import { bad, ensureMetadata, exists, metadataDb, recordCommittedMetadata } from './shared.js'
import { rejectManagedDiaryReferenceFootprint, requireDiaryBodyAccess, withDiaryBodyOperation } from '../diaryAccess/guard.js'
import { DiaryBodyCryptoError } from '../diaryAccess/body.js'
import { DiaryAccessServiceError, type DiaryBodyOperation } from '../diaryAccess/service.js'
import { deleteManagedDiaryDocument, ManagedDiaryDeleteError } from '../diaryAccess/delete.js'
import { recoveryMarkerName } from '../technicalNamespace.js'

const postRoutes = new Hono()

function diaryBodyContext(logicalPath: string, documentId: string) {
  return { documentId, logicalPath }
}

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

function diaryPostSummary(
  logicalPath: string,
  stat: { size: number | bigint; mtimeMs: number | bigint },
  metadata: ReturnType<typeof ensureMetadata>,
): PostSummary {
  return {
    path: logicalPath,
    title: metadata.title,
    created: new Date(metadata.createdAt).toISOString().slice(0, 10),
    updated: new Date(metadata.updatedAt).toISOString().slice(0, 10),
    tags: [...metadata.tags],
    summary: metadata.summary,
    size: Number(stat.size),
    mtime: Number(stat.mtimeMs),
    ...moodSummaryFields(logicalPath, metadata),
  }
}

async function saveManagedDiary(
  c: any,
  logicalPath: string,
  abs: string,
  operation: DiaryBodyOperation,
  requestedRaw: string,
  baseRaw: string,
): Promise<Response> {
  return withDocumentWriteLock(logicalPath, async () => {
    if (!await exists(abs)) return bad(c, 'not found', 404)
    const metadata = getDocumentMetadata(metadataDb(), logicalPath)
    if (!metadata) return bad(c, 'Diary metadata is unavailable', 503, 'diary-metadata-unavailable')

    let current: Awaited<ReturnType<DiaryBodyOperation['read']>>
    try {
      current = await operation.read(abs, diaryBodyContext(logicalPath, metadata.id))
    } catch (error) {
      return diaryBodyError(c, error)
    }
    const conflict = () => {
      // A lease can be revoked while the read/compare work above is in
      // flight. Never return the managed plaintext conflict snapshot after
      // teardown; the 423 is the only safe response once ownership is lost.
      if (!operation.isCurrent()) return bad(c, 'Diary access is locked', 423, 'diary-locked')
      return c.json({
        error: 'document changed on disk',
        code: 'EDIT_CONFLICT' as const,
        current: {
          raw: current.raw,
          mtime: Number(current.stat.mtimeMs),
          size: Number(current.stat.size),
        },
      }, 409)
    }
    if (current.raw === requestedRaw) {
      operation.assertCurrent()
      return c.json({
        ok: true,
        raw: current.raw,
        post: diaryPostSummary(logicalPath, current.stat, metadata),
      } satisfies SavePostResult)
    }
    if (current.raw !== baseRaw) return conflict()

    const context = diaryBodyContext(logicalPath, metadata.id)
    const encryptedRaw = operation.encrypt(requestedRaw, context).toString('utf8')
    const currentPhysicalRaw = current.bytes.toString('utf8')
    const databaseSnapshot = snapshotDocumentMetadataMutation(metadataDb(), [logicalPath])
    let prepared: Awaited<ReturnType<typeof prepareAtomicTextWrite>> | null = null
    try {
      prepared = await prepareAtomicTextWrite(abs, encryptedRaw, { mode: Number(current.stat.mode) })
      operation.assertCurrent()
      await prepared.commit(currentPhysicalRaw)
    } catch (error) {
      await prepared?.rollback()
      restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot)
      if (error instanceof AtomicTextWriteConflictError) return conflict()
      if (error instanceof AtomicTextWriteTargetMissingError) return bad(c, 'not found', 404)
      if (error instanceof AtomicTextWritePostCommitExternalMutationError
        || error instanceof AtomicTextWriteCleanupError) {
        c.header('Cache-Control', 'no-store')
        return c.json({ error: error.message, code: error.code }, 409)
      }
      throw error
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>
    let committedMetadata: ReturnType<typeof ensureMetadata>
    try {
      stat = await fs.stat(abs)
      committedMetadata = recordCommittedMetadata(logicalPath, requestedRaw, stat.mtimeMs, Date.now())
      trackCleanedDocumentWrite(metadataDb(), logicalPath, requestedRaw)
    } catch (error) {
      const failures: unknown[] = [error]
      try {
        await atomicReplaceTextIfUnchanged(abs, encryptedRaw, currentPhysicalRaw, { mode: Number(current.stat.mode) })
      } catch (rollbackError) {
        if (!(rollbackError instanceof AtomicTextWriteConflictError)) failures.push(rollbackError)
      }
      try { restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot) }
      catch (rollbackError) { failures.push(rollbackError) }
      if (failures.length > 1) throw new AggregateError(failures, 'encrypted Diary metadata update failed and rollback was incomplete')
      throw error
    }
    operation.assertCurrent()
    try {
      const index = await getLinkIndex()
      // Keep only structural existence. Never pass the authorized plaintext
      // body into the process-wide LinkIndex.
      index.registerPath(logicalPath)
    } catch { /* best effort; next rebuild repairs structural state */ }
    return c.json({
      ok: true,
      raw: requestedRaw,
      post: diaryPostSummary(logicalPath, stat, committedMetadata),
    } satisfies SavePostResult)
  })
}

function moodSummaryFields(
  logicalPath: string,
  metadata: { id: string; mood: string | null; updatedAt: number } | null | undefined,
): Pick<PostSummary, 'mood' | 'documentId' | 'metadataUpdatedAt'> | Record<string, never> {
  if (classifyDiaryPath(logicalPath) !== 'managed') return {}
  return {
    mood: metadata?.mood ?? null,
    ...(metadata?.id ? { documentId: metadata.id } : {}),
    ...(metadata?.updatedAt !== undefined
      ? { metadataUpdatedAt: metadata.updatedAt }
      : {}),
  }
}

/**
 * Test-only seam for the REST rename race regressions. Both hooks fire
 * inside the rename's complete lock set; null in production (never set
 * outside tests):
 * - `afterPlanVerified` — right after the in-lock backlink plan has
 *   been verified against the planned footprint, before the reference
 *   snapshots are read (the late-backlink window).
 * - `afterRenamePlanBuilt` — after every reference snapshot (raw +
 *   rewrite) is built, immediately before the reference write loop —
 *   the exact window in which an EXTERNAL editor's save to a reference
 *   file must be detected by the ownership-verified reference writes.
 * - `afterRenameMoved` — after the file + metadata have moved to the
 *   destination, before the first reference write — the exact window
 *   in which an external writer re-using the now-empty SOURCE path
 *   must make the rollback fail closed (create-only) instead of
 *   overwriting the external file.
 */
export type PostRenameRaceHooks = {
  afterPlanVerified?: () => void | Promise<void>
  afterRenamePlanBuilt?: () => void | Promise<void>
  afterRenameMoved?: () => void | Promise<void>
}
let __postRenameRaceHooks: PostRenameRaceHooks | null = null
export function __setPostRenameRaceHooksForTesting(hooks: PostRenameRaceHooks | null): void {
  __postRenameRaceHooks = hooks
}

/**
 * A re-used path must never inherit the old documentId: drop any stale
 * identity row for the path and give the NEW generation now occupying
 * it a fresh identity. The old generation stays quarantined under its
 * `.nuvyn-delete-inflight-*` staging name (not listed — the name does not end
 * in .md — and never scanned by the link index). Returns the new
 * generation's raw so callers can refresh the process-level link index
 * (which never saw an applyDelete for the failed delete and would
 * otherwise keep the old file's outbound links and title until a
 * restart).
 */
async function reidentifyReusedPath(documentPath: string, abs: string): Promise<string> {
  deleteDocumentMetadata(metadataDb(), documentPath)
  const reusedRaw = await fs.readFile(abs, 'utf8')
  const reusedStat = await fs.stat(abs)
  ensureMetadata(documentPath, reusedRaw, reusedStat.mtimeMs, Date.now())
  return reusedRaw
}

async function uniqueMoveTarget(absPath: string, relPath: string): Promise<{ abs: string; rel: string }> {
  if (!await exists(absPath)) return { abs: absPath, rel: relPath }
  const ext = path.extname(absPath)
  const absBase = absPath.slice(0, -ext.length)
  const relBase = relPath
  for (let i = 2; i < 1000; i++) {
    const nextAbs = `${absBase}-${i}${ext}`
    if (!await exists(nextAbs)) return { abs: nextAbs, rel: `${relBase}-${i}` }
  }
  const suffix = Date.now()
  return { abs: `${absBase}-${suffix}${ext}`, rel: `${relBase}-${suffix}` }
}

postRoutes.get('/api/posts', async (c) => {
  const posts = await listPostsFlat(CONTENT_DIR, metadataDb())
  return c.json(posts)
})

// Create a new post. Body: { path: string, title?: string }
postRoutes.post('/api/posts', async (c) => {
  const body = await c.req.json().catch(() => null) as { path?: unknown; title?: unknown } | null
  if (!body || typeof body.path !== 'string') return bad(c, 'path required')
  const documentPath = body.path
  if (!isValidPathSyntax(body.path)) {
    return bad(c, 'invalid path syntax')
  }
  const bodyAccess = requireDiaryBodyAccess(c, documentPath)
  if (bodyAccess) return bodyAccess
  if (classifyDiaryPath(documentPath) === 'managed') {
    return bad(c, 'use the canonical Diary date route to create managed Diary documents', 422, 'diary-create-route-required')
  }
  try { validateDocumentMutation({ operation: 'create', destinationPath: body.path }) }
  catch (error) { return bad(c, (error as Error).message, 422) }
  if (body.title !== undefined && typeof body.title !== 'string') {
    return bad(c, 'title must be a string', 400)
  }
  const rawTitle = body.title ?? body.path.split('/').pop() ?? ''
  const title = rawTitle.trim()
  if (!title) return bad(c, 'title must be a non-empty string', 400)
  if (title.length > 200) return bad(c, 'title must be at most 200 characters', 400)
  let abs: string
  try { abs = filePathFor(body.path) } catch (e: any) { return bad(c, e.message) }
  // Creating a file changes tree membership: structure lock first, so
  // a concurrent folder rename/delete can never swallow the new file.
  return withVaultStructureLock(() => withDocumentWriteLock(documentPath, async () => {
  if (await exists(abs)) return bad(c, 'file exists', 409)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const body_text = `# ${title}\n`
  const databaseSnapshot = snapshotDocumentMetadataMutation(metadataDb(), [documentPath])
  // Create-only: link(2) atomically fails with EEXIST, so a file an
  // external writer lands between the check and the commit is reported
  // as a conflict, never overwritten.
  const prepared = await prepareAtomicTextCreate(abs, body_text)
  let committed = false
  try {
    deleteDocumentMetadata(metadataDb(), documentPath)
    await prepared.commit()
    committed = true
    createDocumentMetadata(metadataDb(), { path: documentPath, title, createdAt: now, updatedAt: now })
  } catch (error) {
    const failures: unknown[] = [error]
    try {
      if (committed) {
        if (await exists(abs)) await atomicRemoveTextIfUnchanged(abs, body_text)
      } else {
        await prepared.rollback()
      }
    } catch (rollbackError) { failures.push(rollbackError) }
    try { restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot) } catch (rollbackError) { failures.push(rollbackError) }
    if (failures.length > 1) throw new AggregateError(failures, 'post creation failed and rollback was incomplete')
    if (!committed && (error as NodeJS.ErrnoException).code === 'EEXIST') return bad(c, 'file exists', 409)
    throw error
  }
  // Update the link index AFTER the disk write succeeds. Best-effort:
  // a failure here just leaves a stale entry; the next rebuild fixes it.
  try {
    const idx = await getLinkIndex()
    idx.applyWrite(documentPath, body_text)
    idx.setTitle(documentPath, title)
  } catch { /* ignore */ }
  const st = await fs.stat(abs)
  return c.json({
    path: documentPath,
    title,
    created: today,
    updated: today,
    tags: [],
    // Newly created files have no summary until metadata editing is added.
    summary: '',
    size: st.size,
    mtime: st.mtimeMs,
  } satisfies PostSummary, 201)
  }))
})

// PUT saves body bytes verbatim. Metadata timestamps live in SQLite;
// legacy Frontmatter is preserved but no longer mutated.
postRoutes.put('/api/posts/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/posts\//, '')
  const bodyAccess = requireDiaryBodyAccess(c, splat)
  if (bodyAccess) return bodyAccess
  let abs: string
  try { abs = filePathFor(splat) } catch (e: any) { return bad(c, e.message) }
  try { validateDocumentMutation({ operation: 'write', destinationPath: splat, destinationExists: true }) }
  catch (error) { return bad(c, (error as Error).message, 422) }
  const body = await c.req.json().catch(() => null) as {
    raw?: unknown
    baseRaw?: unknown
  } | null
  if (!body || typeof body.raw !== 'string' || typeof body.baseRaw !== 'string') {
    return bad(c, 'raw and baseRaw required')
  }
  const requestedRaw = body.raw
  const baseRaw = body.baseRaw

  if (classifyDiaryPath(splat) === 'managed') {
    const response = await withDiaryBodyOperation(c, (operation) => (
      saveManagedDiary(c, splat, abs, operation, requestedRaw, baseRaw)
    ))
    return response ?? bad(c, 'Diary access is locked', 423, 'diary-locked')
  }

  return withDocumentWriteLock(splat, async () => {
    if (!await exists(abs)) return bad(c, 'not found', 404)

    const conflict = (snapshot: StableTextSnapshot) => {
      c.header('Cache-Control', 'no-store')
      return c.json({
        error: 'document changed on disk',
        code: 'EDIT_CONFLICT' as const,
        current: {
          raw: snapshot.raw,
          mtime: Number(snapshot.stat.mtimeMs),
          size: Number(snapshot.stat.size),
        },
      }, 409)
    }
    let current: StableTextSnapshot
    try {
      current = await readStableTextSnapshot(abs)
    } catch (error) {
      if (error instanceof UnstableTextSnapshotError) {
        return conflict(error.latest)
      }
      throw error
    }
    const currentRaw = current.raw
    const currentStat = current.stat
    const result = (
      raw: string,
      stat: { size: number | bigint; mtimeMs: number | bigint },
      metadata: ReturnType<typeof ensureMetadata>,
    ) => ({
      ok: true,
      raw,
      post: {
        path: splat,
        title: metadata.title,
        created: new Date(metadata.createdAt).toISOString().slice(0, 10),
        updated: new Date(metadata.updatedAt).toISOString().slice(0, 10),
        tags: [...metadata.tags],
        summary: metadata.summary,
        size: Number(stat.size),
        mtime: Number(stat.mtimeMs),
        ...moodSummaryFields(splat, metadata),
      },
    } satisfies SavePostResult)

    // A retry whose first response was lost is already durably complete.
    if (currentRaw === requestedRaw) {
      const metadata = ensureMetadata(splat, currentRaw, currentStat.mtimeMs)
      try {
        const idx = await getLinkIndex()
        idx.applyWrite(splat, currentRaw)
      } catch { /* ignore */ }
      return c.json(result(currentRaw, currentStat, metadata))
    }

    if (currentRaw !== baseRaw) {
      return conflict(current)
    }

    const databaseSnapshot = snapshotDocumentMetadataMutation(metadataDb(), [splat])
    const prepared = await prepareAtomicTextWrite(abs, requestedRaw, { mode: currentStat.mode })
    try {
      // Import legacy metadata before the editor can remove its Frontmatter.
      ensureMetadata(splat, currentRaw, currentStat.mtimeMs)
      // Ownership-verified commit: the current generation is atomically
      // renamed aside, verified byte-for-byte against currentRaw, and the
      // new bytes are linked in create-only. There is NO check-to-rename
      // window — an external writer winning any race keeps its bytes and
      // this save fails closed with a conflict, never a silent overwrite.
      await prepared.commit(currentRaw)
    } catch (error) {
      await prepared.rollback()
      restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot)
      if (error instanceof UnstableTextSnapshotError) {
        return conflict(error.latest)
      }
      if (error instanceof AtomicTextWriteConflictError) {
        return conflict(error.current)
      }
      if (error instanceof AtomicTextWriteTargetMissingError) {
        return bad(c, 'not found', 404)
      }
      if (error instanceof AtomicTextWritePostCommitExternalMutationError
        || error instanceof AtomicTextWriteCleanupError) {
        c.header('Cache-Control', 'no-store')
        return c.json({ error: error.message, code: error.code }, 409)
      }
      throw error
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>
    let metadata: ReturnType<typeof ensureMetadata>
    try {
      stat = await fs.stat(abs)
      metadata = recordCommittedMetadata(splat, requestedRaw, stat.mtimeMs, Date.now())
      trackCleanedDocumentWrite(metadataDb(), splat, requestedRaw)
    } catch (error) {
      const failures: unknown[] = [error]
      try {
        await atomicReplaceTextIfUnchanged(
          abs,
          requestedRaw,
          currentRaw,
          { mode: currentStat.mode },
        )
      } catch (rollbackError) {
        // An external writer overwriting our commit makes the external
        // bytes authoritative — leaving them in place IS the correct
        // undo, not a rollback failure.
        if (!(rollbackError instanceof AtomicTextWriteConflictError)) failures.push(rollbackError)
      }
      try { restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot) }
      catch (rollbackError) { failures.push(rollbackError) }
      if (failures.length > 1) throw new AggregateError(failures, 'metadata update failed and document rollback was incomplete')
      throw error
    }
    try {
      const idx = await getLinkIndex()
      idx.applyWrite(splat, requestedRaw)
    } catch { /* ignore */ }
    return c.json(result(requestedRaw, stat, metadata))
  })
})

postRoutes.put('/api/recover/*', async (c) => {
  const documentPath = c.req.path.replace(/^\/api\/recover\//, '')
  const managedDiary = classifyDiaryPath(documentPath) === 'managed'
  if (managedDiary) return bad(c, 'Diary recovery requires a verified prior identity; use History Restore', 422, 'diary-recovery-identity-required')
  const bodyAccess = requireDiaryBodyAccess(c, documentPath)
  if (bodyAccess) return bodyAccess
  if (!isValidPathSyntax(documentPath)) return bad(c, 'invalid path')
  try { validateDocumentMutation({ operation: 'recover', destinationPath: documentPath }) }
  catch (error) { return bad(c, (error as Error).message, 422) }
  const body = await c.req.json().catch(() => null) as { raw?: unknown } | null
  if (!body || typeof body.raw !== 'string') return bad(c, 'raw required')
  const requestedRaw = body.raw
  // Generic recovery cannot prove the prior Diary identity. Keep the
  // document-mutation policy fail-closed; verified identity-preserving
  // recovery will integrate the encrypted adapter in its own owner.
  // Recovery creates the file: membership change, structure lock first.
  return withVaultStructureLock(() => withDocumentWriteLock(documentPath, async () => {
    const abs = filePathFor(documentPath)
    if (await exists(abs)) return bad(c, 'file already exists', 409)
    const databaseSnapshot = snapshotDocumentMetadataMutation(metadataDb(), [documentPath])
    const previousMetadata = getDocumentMetadata(metadataDb(), documentPath)
    const physicalRaw = requestedRaw
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const prepared = await prepareAtomicTextCreate(abs, physicalRaw)
    let committed = false
    let stat: Awaited<ReturnType<typeof fs.stat>>
    let metadata: ReturnType<typeof ensureMetadata>
    try {
      await prepared.commit()
      committed = true
      stat = await fs.stat(abs)
      metadata = previousMetadata
        ? recordCommittedMetadata(documentPath, requestedRaw, stat.mtimeMs, Date.now())
        : ensureMetadata(documentPath, requestedRaw, stat.mtimeMs, Date.now())
      trackCleanedDocumentWrite(metadataDb(), documentPath, requestedRaw)
    } catch (error) {
      const failures: unknown[] = [error]
      try {
        if (committed) {
          // Our commit landed but the metadata step failed: remove our
          // own write, and ONLY our write — the raw match is proof of
          // ownership because we hold the create-only commit.
          if (await exists(abs)) await atomicRemoveTextIfUnchanged(abs, physicalRaw)
        } else {
          // The commit itself failed (e.g. EEXIST: an external writer
          // landed the same path after our exists-check). We never
          // created the target, so it must not be touched — even when
          // its bytes happen to equal requestedRaw.
          await prepared.rollback()
        }
      } catch (rollbackError) {
        failures.push(rollbackError)
      }
      try {
        restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot)
      } catch (metadataRollbackError) {
        failures.push(metadataRollbackError)
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'metadata recovery failed and document rollback was incomplete',
        )
      }
      if (!committed && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        return bad(c, 'file already exists', 409)
      }
      throw error
    }
    if (!managedDiary) {
      try { (await getLinkIndex()).applyWrite(documentPath, requestedRaw) } catch { /* next rebuild repairs it */ }
    }
    const post: PostSummary = {
      path: documentPath,
      title: metadata.title,
      created: new Date(metadata.createdAt).toISOString().slice(0, 10),
      updated: new Date(metadata.updatedAt).toISOString().slice(0, 10),
      tags: [...metadata.tags],
      summary: metadata.summary,
      size: stat.size,
      mtime: stat.mtimeMs,
      ...moodSummaryFields(documentPath, metadata),
    }
    return c.json({ ok: true, raw: requestedRaw, mtime: stat.mtimeMs, post })
  }))
})

// PATCH a file: rename within folder (name) or move (targetPath). Exactly one.
postRoutes.patch('/api/posts/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/posts\//, '')
  const srcPath = splat
  // Managed Diary identity is AAD-bound and has no generic rebind
  // transaction in D8.3. Reject before capability checks, path reads, or any
  // rename/reference planning.
  if (classifyDiaryPath(srcPath) === 'managed') {
    return bad(c, 'managed Diary encrypted-body rename is unavailable until an adapter-aware owner exists', 422, 'diary-encrypted-rename-unsupported')
  }
  const sourceBodyAccess = requireDiaryBodyAccess(c, srcPath)
  if (sourceBodyAccess) return sourceBodyAccess
  let src: string
  try { src = filePathFor(srcPath) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(src)) return bad(c, 'not found', 404)

  const body = await c.req.json().catch(() => null) as { name?: string; targetPath?: string; updateReferences?: boolean } | null
  if (!body || (body.name === undefined && body.targetPath === undefined)) {
    return bad(c, 'name or targetPath required')
  }
  if (body.name !== undefined && body.targetPath !== undefined) {
    return bad(c, 'pass exactly one of name / targetPath')
  }

  let dest: string
  let destPath: string
  if (body.name !== undefined) {
    if (!isValidSegment(body.name)) return bad(c, 'invalid name')
    // In-place rename within the same parent. Archive descendants are
    // ordinary documents; validateDocumentMutation still protects reserved
    // root paths for non-UI callers.
    const parent = path.dirname(src)
    dest = path.join(parent, body.name + '.md')
    const parentRel = path.dirname(srcPath)
    destPath = parentRel && parentRel !== '.' ? `${parentRel}/${body.name}` : body.name
  } else {
    try { dest = filePathFor(body.targetPath!) } catch (e: any) { return bad(c, e.message) }
    destPath = body.targetPath!
    // Cycle check: cannot move into own descendant.
    if (dest !== src && body.targetPath!.startsWith(srcPath + '/')) {
      return bad(c, 'cannot move into descendant', 422)
    }
  }
  if (classifyDiaryPath(destPath) === 'managed') {
    return bad(c, 'managed Diary encrypted-body rename is unavailable until an adapter-aware owner exists', 422, 'diary-encrypted-rename-unsupported')
  }
  try {
    validateDocumentMutation({ operation: 'rename', sourcePath: srcPath, destinationPath: destPath })
  } catch (error) {
    return bad(c, (error as Error).message, 422)
  }
  const destinationBodyAccess = requireDiaryBodyAccess(c, destPath)
  if (destinationBodyAccess) return destinationBodyAccess
  if (classifyDiaryPath(srcPath) === 'managed' || classifyDiaryPath(destPath) === 'managed') {
    return bad(c, 'managed Diary encrypted-body rename is unavailable until an adapter-aware owner exists', 422, 'diary-encrypted-rename-unsupported')
  }
  if (await exists(dest)) {
    if (body.targetPath !== undefined && isInArchive(destPath)) {
      const unique = await uniqueMoveTarget(dest, destPath)
      dest = unique.abs
      destPath = unique.rel
    } else {
      return bad(c, 'destination exists', 409)
    }
  }
  // Rename/move changes tree membership: structure lock first, with
  // the backlink plan computed under it (see folders PATCH note).
  return withVaultStructureLock(async () => {
  if (body.updateReferences !== false) {
    const referenceError = await rejectManagedDiaryReferenceFootprint(c)
    if (referenceError) return referenceError
  }
  const plannedReferencePaths = body.updateReferences
    ? (await getLinkIndex()).getBacklinks(srcPath).map((backlink) => backlink.source)
    : []
  for (const referencePath of plannedReferencePaths) {
    const bodyAccess = requireDiaryBodyAccess(c, referencePath)
    if (bodyAccess) return bodyAccess
  }
  if (plannedReferencePaths.some((referencePath) => classifyDiaryPath(referencePath) === 'managed')) {
    return bad(c, 'reference rewrite footprint contains an encrypted managed Diary body', 422, 'diary-encrypted-reference-unsupported')
  }
  return withDocumentWriteLocks([srcPath, destPath, ...plannedReferencePaths], async () => {
  if (!await exists(src)) return bad(c, 'not found', 404)
  if (await exists(dest)) return bad(c, 'destination exists', 409)
  const sourceRaw = await fs.readFile(src, 'utf8')
  const sourceStat = await fs.stat(src)
  const referenceSnapshots: Array<{
    sourcePath: string
    writePath: string
    abs: string
    raw: string
    updated: string
    mtime: number
  }> = []
  if (body.updateReferences) {
    // ONE authoritative in-lock backlink enumeration: the verified
    // candidate set AND the executed reference plan below are both
    // built from this single snapshot — the index is never re-queried
    // for the write set. A file that gains a link to the source AFTER
    // the footprint check (its own body PUT holds only its own
    // document lock, never this rename's lock set) is simply left
    // untouched: the rename can never write a document whose lock it
    // does not hold. Drift seen BY the check fails closed with a
    // retry, exactly as before.
    const idx = await getLinkIndex()
    const allPaths = idx.snapshot().paths
    const backlinks = idx.getBacklinks(srcPath)
    const planned = [...new Set(plannedReferencePaths)].sort()
    const candidate = [...new Set(backlinks.map((backlink) => backlink.source))].sort()
    if (planned.length !== candidate.length || planned.some((item, index) => item !== candidate[index])) {
      return bad(c, 'backlinks changed while rename was being prepared; retry', 409)
    }
    if (__postRenameRaceHooks?.afterPlanVerified) await __postRenameRaceHooks.afterPlanVerified()
    for (const backlink of backlinks) {
      const bodyAccess = requireDiaryBodyAccess(c, backlink.source)
      if (bodyAccess) return bodyAccess
      const raw = backlink.source === srcPath ? sourceRaw : await fs.readFile(filePathFor(backlink.source), 'utf8')
      const updated = rewriteDocumentReferences(raw, backlink.source, srcPath, destPath, allPaths)
      if (updated === raw) continue
      const writePath = backlink.source === srcPath ? destPath : backlink.source
      referenceSnapshots.push({
        sourcePath: backlink.source,
        writePath,
        abs: backlink.source === srcPath ? dest : filePathFor(backlink.source),
        raw,
        updated,
        mtime: 0,
      })
    }
    if (__postRenameRaceHooks?.afterRenamePlanBuilt) await __postRenameRaceHooks.afterRenamePlanBuilt()
  }
  const databaseSnapshot = snapshotDocumentMetadataMutation(metadataDb(), [srcPath, destPath, ...referenceSnapshots.map((item) => item.writePath)])
  const written: typeof referenceSnapshots = []
  let renamed = false
  let referenceJournal: PreparedRenameReferenceJournal | null = null
  try {
    ensureMetadata(srcPath, sourceRaw, sourceStat.mtimeMs)
    for (const reference of referenceSnapshots) {
      if (reference.sourcePath !== srcPath) {
        const stat = await fs.stat(filePathFor(reference.sourcePath))
        ensureMetadata(reference.sourcePath, reference.raw, stat.mtimeMs)
      }
    }
    const sourceDocumentId = getDocumentMetadata(metadataDb(), srcPath)?.id
    if (!sourceDocumentId) throw new Error('source document identity was not created')
    referenceJournal = await prepareRenameReferenceJournal({
      sourceAbs: src,
      op: 'document-rename-references',
      srcRel: srcPath,
      destRel: destPath,
      documentId: sourceDocumentId,
      references: referenceSnapshots.map((snapshot) => ({
        path: snapshot.writePath,
        beforeRaw: snapshot.raw,
        afterRaw: snapshot.updated,
      })),
    })
    await renameDocumentWithMetadata({ db: metadataDb(), fromPath: srcPath, toPath: destPath, fromAbs: src, toAbs: dest })
    renamed = true
    if (__postRenameRaceHooks?.afterRenameMoved) await __postRenameRaceHooks.afterRenameMoved()
    for (const snapshot of referenceSnapshots) {
      // External-writer-safe: the bytes on disk must still be exactly
      // what the in-lock plan read. In-process locks do not stop
      // Obsidian/vim/sync software; the ownership-verified commit
      // detects their saves and fails the rename closed instead of
      // silently overwriting them.
      await atomicReplaceTextIfUnchanged(snapshot.abs, snapshot.raw, snapshot.updated)
      written.push(snapshot)
      const stat = await fs.stat(snapshot.abs)
      snapshot.mtime = stat.mtimeMs
      recordCommittedMetadata(snapshot.writePath, snapshot.updated, stat.mtimeMs, Date.now())
    }
    await referenceJournal?.cleanup()
    referenceJournal = null
  } catch (error) {
    const rollbackErrors: unknown[] = []
    let rollbackSourceReused = false
    if (referenceJournal) {
      try { await referenceJournal.setDirection('roll-back') }
      catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    for (const snapshot of written.reverse()) {
      try {
        // Undo ONLY our rewrite: if the bytes on disk are no longer
        // exactly what we wrote (an external editor saved on top),
        // the external content wins and the undo leaves it untouched.
        await atomicReplaceTextIfUnchanged(snapshot.abs, snapshot.updated, snapshot.raw)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (renamed) {
      try {
        // Create-only: if an external writer re-used the source path
        // while the reference writes were failing, the rollback fails
        // closed with RenameDestinationOccupiedError and the bytes stay
        // at the destination — never overwriting the external file.
        await renameDocumentWithMetadata({ db: metadataDb(), fromPath: destPath, toPath: srcPath, fromAbs: dest, toAbs: src })
      } catch (rollbackError) {
        if (rollbackError instanceof RenameDestinationOccupiedError) {
          // The bytes are at destPath; the source path belongs to an
          // external writer. The metadata restore below puts the
          // identity back on srcPath — we then move it to destPath so
          // the identity follows the bytes.
          rollbackSourceReused = true
        } else {
          rollbackErrors.push(rollbackError)
        }
      }
    }
    try { restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot) }
    catch (rollbackError) { rollbackErrors.push(rollbackError) }
    if (error instanceof RenameSourceReusedError && error.survivingPath === 'staging') {
      // Forward move lost both public paths: the owned old generation is
      // quarantined in staging while source/destination are external.
      // Never restore its identity onto the new source generation.
      try {
        deleteDocumentMetadata(metadataDb(), srcPath)
        if (await exists(src)) {
          const [externalRaw, externalStat] = await Promise.all([fs.readFile(src, 'utf8'), fs.stat(src)])
          ensureMetadata(srcPath, externalRaw, externalStat.mtimeMs, Date.now())
          try { (await getLinkIndex()).applyWrite(srcPath, externalRaw) } catch { /* next rebuild repairs */ }
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (error instanceof RenameSourceReusedError && error.survivingPath === 'destination') {
      rollbackSourceReused = true
    }
    if (rollbackSourceReused) {
      // Identity follows the bytes, not the path: the document now
      // lives at destPath. If the destination somehow vanished too
      // (pathological double reuse; the bytes are quarantined under a
      // staging name), drop the row rather than bind it to foreign
      // bytes at either path.
      try {
        if (await exists(dest)) moveDocumentMetadataReplacingDestination(metadataDb(), srcPath, destPath)
        else deleteDocumentMetadata(metadataDb(), srcPath)
        const idx = await getLinkIndex()
        idx.applyRename(srcPath, destPath, sourceRaw)
        if (error instanceof RenameSourceReusedError && error.journalPath) {
          await removeDurableJournal(error.journalPath)
        }
      } catch { /* best effort: the next index rebuild re-derives paths */ }
    }
    if (referenceJournal) {
      try {
        if (rollbackSourceReused) await referenceJournal.setDirection('roll-forward')
        else if (!rollbackErrors.length) { await referenceJournal.cleanup(); referenceJournal = null }
      } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'reference update failed and rollback was incomplete')
    if (rollbackSourceReused) {
      return bad(c, 'the source path was re-used externally during rollback; the document was kept at the new path without overwriting the external file; reference updates were not applied', 409)
    }
    if (error instanceof RenameDestinationOccupiedError) {
      return bad(c, 'destination was claimed by an external writer during the move; retry', 409)
    }
    if (error instanceof RenameSourceReusedError) {
      return bad(c, 'rename failed: both paths were re-used externally; the document was preserved under a staging name', 409)
    }
    if (error instanceof AtomicTextWriteConflictError) {
      return bad(c, 'a referenced document changed on disk during rename; retry', 409)
    }
    throw error
  }
  // Update the link index AFTER the rename succeeds. Read the new
  // content so the new path's outbound links are extracted against
  // the post-rename state of the world.
  const st = await fs.stat(dest)
  const fm = readFrontmatter(dest)
  const movedMetadata = getDocumentMetadata(metadataDb(), destPath)
  try {
    const idx = await getLinkIndex()
    const newRaw = await fs.readFile(dest, 'utf8')
    idx.applyRename(srcPath, destPath, newRaw)
    for (const snapshot of referenceSnapshots) {
      if (snapshot.writePath !== destPath) idx.applyWrite(snapshot.writePath, snapshot.updated)
    }
    if (movedMetadata) idx.setTitle(destPath, movedMetadata.title)
  } catch { /* ignore */ }
  return c.json({
    path: destPath,
    title: movedMetadata?.title ?? destPath.split('/').pop()!,
    created: movedMetadata ? new Date(movedMetadata.createdAt).toISOString().slice(0, 10) : fm.created ?? '',
    // Rename doesn't touch content, so the frontmatter `updated` is
    // unchanged. Fall back to mtime for files that haven't been
    // saved through the API yet (and so don't have the field).
    updated: movedMetadata ? new Date(movedMetadata.updatedAt).toISOString().slice(0, 10) : fm.updated ?? new Date(st.mtimeMs).toISOString().slice(0, 10),
    tags: movedMetadata?.tags ?? fm.tags,
    // Rename/move preserves frontmatter verbatim, so the dest file's
    // summary (if any) is the same as the src's.
    summary: movedMetadata?.summary ?? fm.summary ?? '',
    size: st.size,
    mtime: st.mtimeMs,
    ...moodSummaryFields(destPath, movedMetadata),
    updatedReferences: referenceSnapshots.map((snapshot) => ({
      path: snapshot.writePath,
      raw: snapshot.updated,
      mtime: snapshot.mtime,
    })),
  } satisfies PostSummary)
  })
  })
})

// Delete a file. Archive descendants use the same lifecycle as other files;
// path validation and the reserved-root contract remain in force.
postRoutes.delete('/api/posts/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/posts\//, '')
  let abs: string
  try { abs = filePathFor(splat) } catch (e: any) { return bad(c, e.message) }
  try { validateDocumentMutation({ operation: 'delete', sourcePath: splat }) }
  catch (error) { return bad(c, (error as Error).message, 422) }

  if (classifyDiaryPath(splat) === 'managed') {
    // The encrypted-Diary owner deliberately receives only the existing
    // capability-scoped lease assertion. It never receives a DEK or body.
    return withVaultStructureLock(() => withDocumentWriteLock(splat, async () => {
      const result = await withDiaryBodyOperation(c, async (operation) => {
        try {
          await deleteManagedDiaryDocument({
            logicalPath: splat,
            absolutePath: abs,
            db: metadataDb(),
            assertCurrent: operation.assertCurrent,
          })
          return c.json({ ok: true })
        } catch (error) {
          if (error instanceof ManagedDiaryDeleteError) {
            return bad(c, error.message, error.status, error.code)
          }
          if (error instanceof DiaryAccessServiceError) {
            return bad(c, 'Diary access is locked', 423, 'diary-locked')
          }
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return bad(c, 'not found', 404)
          throw error
        }
      })
      return result ?? bad(c, 'Diary access is locked', 423, 'diary-locked')
    }))
  }

  const bodyAccess = requireDiaryBodyAccess(c, splat)
  if (bodyAccess) return bodyAccess
  // Deleting a file changes tree membership: structure lock first.
  return withVaultStructureLock(() => withDocumentWriteLock(splat, async () => {
  if (!await exists(abs)) return bad(c, 'not found', 404)
  const staged = path.join(
    path.dirname(abs),
    recoveryMarkerName('delete-inflight', path.basename(abs), randomUUID()),
  )
  const quarantine = path.join(
    path.dirname(abs),
    recoveryMarkerName('quarantine-reuse', path.basename(abs), randomUUID()),
  )
  const databaseSnapshot = snapshotDocumentMetadataMutation(metadataDb(), [splat])
  const reuseManifest = path.join(
    path.dirname(abs),
    recoveryMarkerName('delete-manifest', path.basename(abs), randomUUID()),
  )
  const persistReuseQuarantine = async (): Promise<void> => {
    const identities = databaseSnapshot.documents.map((row) => ({ path: String(row.path), id: String(row.id) }))
    if (identities.length) {
      await writeDurableJournal(reuseManifest, {
        version: 1, op: 'delete-path-reuse', kind: 'file', path: splat,
        inflight: path.basename(staged), quarantine: path.basename(quarantine), identities,
      })
    }
    await fs.rename(staged, quarantine)
    await syncParentDirectoryBestEffort(quarantine)
  }
  await fs.rename(abs, staged)
  await syncParentDirectoryBestEffort(staged)
  try {
    deleteDocumentMetadata(metadataDb(), splat)
    await fs.unlink(staged)
  } catch (error) {
    const failures: unknown[] = [error]
    try {
      if (await exists(staged)) {
        if (!await exists(abs)) {
          // The path is still empty: put our generation back. link(2)
          // is create-only, so an external file landing exactly here
          // between the check and the restore is detected as EEXIST
          // (path reuse, handled below) instead of being clobbered.
          let restored = false
          try {
            await fs.link(staged, abs)
            restored = true
          } catch (linkError) {
            if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError
          }
          if (restored) {
            await fs.unlink(staged)
            restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot)
          } else {
            await persistReuseQuarantine()
            const reusedRaw = await reidentifyReusedPath(splat, abs)
            await removeDurableJournal(reuseManifest)
            // The failed delete never ran applyDelete; the index still
            // carries the old file's outbound links/title for this
            // path. Re-apply against the NEW generation.
            try { (await getLinkIndex()).applyWrite(splat, reusedRaw) } catch { /* next rebuild repairs */ }
          }
        } else {
          // Path reuse: an external writer created a NEW generation at
          // this path while the delete was failing. The old documentId
          // must never bind to foreign bytes — drop the stale identity,
          // give the new file a fresh one, and leave the old generation
          // quarantined under its staging name.
          await persistReuseQuarantine()
          const reusedRaw = await reidentifyReusedPath(splat, abs)
          await removeDurableJournal(reuseManifest)
          try { (await getLinkIndex()).applyWrite(splat, reusedRaw) } catch { /* next rebuild repairs */ }
        }
      } else {
        restoreDocumentMetadataMutation(metadataDb(), databaseSnapshot)
      }
    } catch (rollbackError) { failures.push(rollbackError) }
    if (failures.length > 1) throw new AggregateError(failures, 'post deletion failed and rollback was incomplete')
    throw error
  }
  try {
    const idx = await getLinkIndex()
    idx.applyDelete(splat)
  } catch { /* ignore */ }
  return c.json({ ok: true })
  }))
})

// Read a single post (raw + frontmatter)
postRoutes.get('/api/posts/*', async (c) => {
  const splat = c.req.path.replace(/^\/api\/posts\//, '')
  const bodyAccess = requireDiaryBodyAccess(c, splat)
  if (bodyAccess) return bodyAccess
  let abs: string
  try { abs = filePathFor(splat) } catch (e: any) { return bad(c, e.message) }
  if (!await exists(abs)) return bad(c, 'not found', 404)
  const metadata = getDocumentMetadata(metadataDb(), splat)
  let raw: string
  let size: number
  let mtime: number
  if (classifyDiaryPath(splat) === 'managed') {
    if (!metadata) return bad(c, 'Diary metadata is unavailable', 503, 'diary-metadata-unavailable')
    const response = await withDiaryBodyOperation(c, async (operation) => {
      try {
        const read = await operation.read(abs, diaryBodyContext(splat, metadata.id))
        raw = read.raw
        size = Number(read.stat.size)
        mtime = Number(read.stat.mtimeMs)
      } catch (error) {
        return diaryBodyError(c, error)
      }
      operation.assertCurrent()
      const parsed = matter(raw)
      const compatibleFrontmatter = {
        ...parsed.data,
        title: metadata.title,
        summary: metadata.summary,
        tags: metadata.tags,
        created: new Date(metadata.createdAt).toISOString().slice(0, 10),
        updated: new Date(metadata.updatedAt).toISOString().slice(0, 10),
      }
      return c.json({ path: splat, raw, content: parsed.content, frontmatter: compatibleFrontmatter, metadata, size, mtime } satisfies PostDetail)
    })
    return response ?? bad(c, 'Diary access is locked', 423, 'diary-locked')
  } else {
    const st = await fs.stat(abs)
    raw = await fs.readFile(abs, 'utf8')
    size = Number(st.size)
    mtime = Number(st.mtimeMs)
  }
  const parsed = matter(raw)
  const compatibleFrontmatter = metadata
    ? {
        ...parsed.data,
        title: metadata.title,
        summary: metadata.summary,
        tags: metadata.tags,
        created: new Date(metadata.createdAt).toISOString().slice(0, 10),
        updated: new Date(metadata.updatedAt).toISOString().slice(0, 10),
      }
    : parsed.data
  return c.json({
    path: splat,
    raw,
    content: parsed.content,
    frontmatter: compatibleFrontmatter,
    metadata: metadata ?? undefined,
    size,
    mtime,
  } satisfies PostDetail)
})

export default postRoutes
