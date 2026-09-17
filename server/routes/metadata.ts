import { promises as fs } from 'node:fs'
import { Hono } from 'hono'
import {
  DocumentMetadataError,
  getDocumentMetadata,
  getDocumentMetadataById,
  patchDocumentMetadata,
  type DocumentMetadataChange,
} from '../documentMetadata.js'
import { withDocumentWriteLock } from '../documentWriteLock.js'
import {
  cleanDocumentFrontmatter,
  exportDocumentFrontmatter,
  previewFrontmatterCleanup,
  restoreDocumentFrontmatter,
} from '../frontmatterArchive.js'
import { getIndex as getLinkIndex } from '../linkIndex.js'
import {
  getMetadataMigrationSummary,
  listMetadataMigrationRecords,
  migrateVaultMetadata,
} from '../metadataMigration.js'
import { refreshTagIdentityHealth } from '../tagIdentityMigration.js'
import { CONTENT_DIR, filePathFor, normalizeLogicalContentPath } from '../paths.js'
import { classifyDiaryPath } from '../../shared/diaryProtocol.js'
import { isMoodId, type DiaryMoodId } from '../../shared/diaryMood.js'
import { isConfiguredDiaryMoodId } from '../diaryMoodIcons.js'
import { bad, ensureMetadata, exists, metadataDb } from './shared.js'
import {
  hasDiaryBodyAccess,
  hasManagedDiaryFiles,
  requireDiaryBodyAccess,
  rejectManagedDiaryPrivateMetadata,
  requireDiaryVaultBodyAccess,
} from '../diaryAccess/guard.js'
import { readDiaryAccessCapability } from '../diaryAccess/service.js'

const metadataRoutes = new Hono()

function managedDiaryMetadataIsUnlocked(c: any, path: string): boolean {
  if (classifyDiaryPath(path) !== 'managed') return true
  return hasDiaryBodyAccess(
    c.get('authSessionId'),
    readDiaryAccessCapability(c.req.raw.headers),
  )
}

function publicManagedDiaryMetadata(metadata: ReturnType<typeof getDocumentMetadataById>) {
  if (!metadata) return metadata
  return {
    ...metadata,
    title: metadata.path.split('/').pop() ?? metadata.path,
    summary: '',
    tags: [],
  }
}

let activeMetadataMigration: Promise<Awaited<ReturnType<typeof migrateVaultMetadata>>> | null = null

function runMetadataMigration() {
  if (activeMetadataMigration) return activeMetadataMigration
  activeMetadataMigration = migrateVaultMetadata(metadataDb(), CONTENT_DIR)
    .finally(() => { activeMetadataMigration = null })
  return activeMetadataMigration
}

metadataRoutes.get('/api/metadata/migration', (c) => {
  // Legacy managed-Diary migration rows may still exist for D8.4, but their
  // private backup/error payloads are not part of this generic projection.
  const records = listMetadataMigrationRecords(metadataDb())
    .filter((record) => classifyDiaryPath(record.path) !== 'managed')
  const counts = records.reduce<Record<string, number>>((acc, record) => {
    acc[record.status] = (acc[record.status] ?? 0) + 1
    return acc
  }, {})
  const summary = {
    total: records.length,
    legacy: counts.legacy ?? 0,
    imported: counts.imported ?? 0,
    verified: counts.verified ?? 0,
    cleaned: counts.cleaned ?? 0,
    failed: counts.failed ?? 0,
    orphaned: counts.orphaned ?? 0,
  }
  return c.json({
    running: activeMetadataMigration !== null,
    summary,
    failures: records.filter((record) => record.status === 'failed'),
    cleanedPaths: records.filter((record) => record.status === 'cleaned').map((record) => record.path),
  })
})

metadataRoutes.post('/api/metadata/migrate', async (c) => {
  if (await hasManagedDiaryFiles()) {
    const response = rejectManagedDiaryPrivateMetadata(c)
    if (response) return response
  }
  const bodyAccess = requireDiaryVaultBodyAccess(c)
  if (bodyAccess) return bodyAccess
  const report = await runMetadataMigration()
  const health = await refreshTagIdentityHealth(metadataDb(), CONTENT_DIR, report)
  return c.json({ report, summary: getMetadataMigrationSummary(metadataDb()), tagIdentityHealth: health })
})

metadataRoutes.get('/api/metadata/cleanup/preview', async (c) => {
  if (await hasManagedDiaryFiles()) {
    const response = rejectManagedDiaryPrivateMetadata(c)
    if (response) return response
  }
  const bodyAccess = requireDiaryVaultBodyAccess(c)
  if (bodyAccess) return bodyAccess
  return c.json(await previewFrontmatterCleanup(metadataDb()))
})

metadataRoutes.get('/api/metadata/export', (c) => {
  const documentPath = c.req.query('path')
  const mode = c.req.query('mode') ?? 'canonical'
  if (!documentPath) return bad(c, 'path required')
  const privateMetadataError = rejectManagedDiaryPrivateMetadata(c, documentPath)
  if (privateMetadataError) return privateMetadataError
  const bodyAccess = requireDiaryBodyAccess(c, documentPath)
  if (bodyAccess) return bodyAccess
  if (mode !== 'canonical' && mode !== 'original') return bad(c, 'invalid export mode')
  const frontmatter = exportDocumentFrontmatter(metadataDb(), documentPath, mode)
  if (frontmatter === null) return bad(c, 'frontmatter export not available', 404)
  return c.json({ path: documentPath, mode, frontmatter })
})

function confirmedPaths(body: unknown, confirmation: string): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as { paths?: unknown; confirm?: unknown }
  if (value.confirm !== confirmation || !Array.isArray(value.paths)
      || value.paths.length === 0 || value.paths.length > 1000
      || value.paths.some((item) => typeof item !== 'string')) return null
  return value.paths as string[]
}

metadataRoutes.post('/api/metadata/cleanup', async (c) => {
  const paths = confirmedPaths(await c.req.json().catch(() => null), 'REMOVE_FRONTMATTER')
  if (!paths) return bad(c, 'explicit confirmation and paths are required')
  for (const documentPath of paths) {
    const privateMetadataError = rejectManagedDiaryPrivateMetadata(c, documentPath)
    if (privateMetadataError) return privateMetadataError
    const bodyAccess = requireDiaryBodyAccess(c, documentPath)
    if (bodyAccess) return bodyAccess
  }
  return c.json(await cleanDocumentFrontmatter(metadataDb(), paths))
})

metadataRoutes.post('/api/metadata/restore', async (c) => {
  const body = await c.req.json().catch(() => null) as { paths?: unknown; confirm?: unknown; mode?: unknown } | null
  const paths = confirmedPaths(body, 'RESTORE_FRONTMATTER')
  const mode = body?.mode ?? 'original'
  if (!paths) return bad(c, 'explicit confirmation and paths are required')
  if (mode !== 'original' && mode !== 'canonical') return bad(c, 'invalid restore mode')
  for (const documentPath of paths) {
    const privateMetadataError = rejectManagedDiaryPrivateMetadata(c, documentPath)
    if (privateMetadataError) return privateMetadataError
    const bodyAccess = requireDiaryBodyAccess(c, documentPath)
    if (bodyAccess) return bodyAccess
  }
  return c.json(await restoreDocumentFrontmatter(metadataDb(), paths, mode))
})

// Current metadata by STABLE document id (single-segment UUID) —
// method-disambiguated from the path-splat PATCH below. Draft
// recovery's path resolver queries this: after an emptied-family
// probe, only a by-identity server lookup can certify where the
// document lives now. `updatedAt` travels as the version token.
metadataRoutes.get('/api/metadata/documents/:id', (c) => {
  const metadata = getDocumentMetadataById(metadataDb(), c.req.param('id'))
  if (!metadata) return bad(c, 'not found', 404)
  return c.json(managedDiaryMetadataIsUnlocked(c, metadata.path)
    ? metadata
    : publicManagedDiaryMetadata(metadata))
})

metadataRoutes.patch('/api/metadata/documents/*', async (c) => {
  const documentPath = c.req.path.replace(/^\/api\/metadata\/documents\//, '')
  let abs: string
  try { abs = filePathFor(documentPath) } catch (error: any) { return bad(c, error.message) }
  return withDocumentWriteLock(documentPath, async () => {
  if (!await exists(abs)) return bad(c, 'not found', 404)
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || Array.isArray(body)) return bad(c, 'body required')

  const logicalPath = normalizeLogicalContentPath(documentPath)
  const isManagedDiary = logicalPath !== null && classifyDiaryPath(logicalPath) === 'managed'
  const hasPrivateChange = Object.hasOwn(body, 'title')
    || Object.hasOwn(body, 'summary')
    || Object.hasOwn(body, 'tags')
  if (isManagedDiary && hasPrivateChange) {
    const privateMetadataError = rejectManagedDiaryPrivateMetadata(c, documentPath)
    if (privateMetadataError) return privateMetadataError
  }

  // Validate the Diary-only field before ensureMetadata() can create a live
  // row for an otherwise legacy file. A rejected Mood request must not leave
  // behind metadata on an ordinary or unmanaged Diary path.
  let requestedMood: DiaryMoodId | null | undefined
  let hasMoodChange = false
  if (Object.hasOwn(body, 'mood')) {
    hasMoodChange = true
    if (logicalPath === null || classifyDiaryPath(logicalPath) !== 'managed') {
      return bad(c, 'mood is only available for canonical managed Diary dates', 400, 'INVALID_MOOD')
    }
    if (body.mood === null) {
      requestedMood = null
    } else if (isMoodId(body.mood) || isConfiguredDiaryMoodId(metadataDb(), body.mood)) {
      requestedMood = body.mood
    } else {
      return bad(c, 'mood must be one of the configured mood icons or null', 400, 'INVALID_MOOD')
    }
  }

  const currentMetadata = getDocumentMetadata(metadataDb(), documentPath)
  if (!currentMetadata) {
    // A canonical encrypted Diary without its identity row cannot be safely
    // reconstructed by this generic metadata route: doing so would require
    // reading/parsing the opaque envelope outside the Diary adapter and could
    // mint a mismatched stable document id. Keep Mood fail-closed for this
    // malformed/legacy state rather than materializing ciphertext through
    // ensureMetadata().
    if (isManagedDiary) {
      const bodyAccess = requireDiaryBodyAccess(c, documentPath)
      if (bodyAccess) return bodyAccess
      return bad(c, 'Diary metadata identity is unavailable', 422, 'diary-private-metadata-unsupported')
    }
    const bodyAccess = requireDiaryBodyAccess(c, documentPath)
    if (bodyAccess) return bodyAccess
    const [raw, nextStat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)])
    ensureMetadata(documentPath, raw, nextStat.mtimeMs)
  }
  const changes: DocumentMetadataChange[] = []
  if (Object.hasOwn(body, 'title')) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) {
      return bad(c, 'title must be a non-empty string of at most 200 characters')
    }
    changes.push({ field: 'title', value: body.title })
  }
  if (Object.hasOwn(body, 'summary')) {
    if (typeof body.summary !== 'string' || body.summary.length > 2000) {
      return bad(c, 'summary must be a string of at most 2000 characters')
    }
    changes.push({ field: 'summary', value: body.summary })
  }
  if (Object.hasOwn(body, 'tags')) {
    if (!Array.isArray(body.tags)) return bad(c, 'tags must be an array of at most 50 strings')
    changes.push({ field: 'tags', values: body.tags as string[] })
  }
  if (hasMoodChange) {
    changes.push({ field: 'mood', value: requestedMood! })
  }
  if (changes.length === 0) return bad(c, 'at least one metadata field is required')

  let saved: ReturnType<typeof patchDocumentMetadata>
  try {
    saved = patchDocumentMetadata(metadataDb(), {
      path: documentPath,
      changes,
      ...((Object.hasOwn(body, 'tags') || hasMoodChange)
        ? { expectedUpdatedAt: body.expectedUpdatedAt as number }
        : {}),
    })
  } catch (error) {
    if (error instanceof DocumentMetadataError) {
      const status = error.code === 'METADATA_VERSION_CONFLICT' ? 409
        : error.code === 'METADATA_NOT_FOUND' ? 404
          : 400
      return bad(c, error.message, status, error.code)
    }
    throw error
  }
  if (Object.hasOwn(body, 'title')) {
    try {
      const idx = await getLinkIndex()
      idx.setTitle(documentPath, saved.title)
    } catch { /* next rebuild repairs a stale display title */ }
  }
  return c.json(isManagedDiary && !managedDiaryMetadataIsUnlocked(c, documentPath)
    ? publicManagedDiaryMetadata(saved)
    : saved)
  })
})

export default metadataRoutes
