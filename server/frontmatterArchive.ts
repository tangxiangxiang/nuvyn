import { promises as fs } from 'node:fs'
import type { Database as DatabaseT } from 'better-sqlite3'
import YAML from 'yaml'
import { atomicReplaceTextIfUnchanged, readStableTextSnapshot } from './atomicTextWrite.js'
import {
  getDocumentMetadata,
  restoreDocumentMetadataMutation,
  snapshotDocumentMetadataMutation,
  touchDocumentMetadata,
  type DocumentMetadata,
} from './documentMetadata.js'
import { withDocumentWriteLock } from './documentWriteLock.js'
import {
  extractFrontmatterBackup,
  getMetadataMigrationRecord,
  listMetadataMigrationRecords,
  metadataSourceHash,
} from './metadataMigration.js'
import { filePathFor } from './paths.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'

export interface FrontmatterCleanupCandidate {
  path: string
  beforeBytes: number
  afterBytes: number
  removedBytes: number
  customFields: string[]
}

export interface FrontmatterCleanupPreview {
  candidates: FrontmatterCleanupCandidate[]
  blocked: Array<{ path: string; reason: string }>
}

export interface FrontmatterFileChange {
  path: string
  newRaw: string
  newMtime: number
}

export interface FrontmatterMutationResult {
  changed: FrontmatterFileChange[]
  failed: Array<{ path: string; reason: string }>
}

// `aliases` is deprecated, but remains recognized so cleanup can archive and remove
// it from legacy Frontmatter instead of treating it as an unknown custom field.
const STANDARD_FIELDS = new Set(['title', 'summary', 'tags', 'aliases', 'created', 'updated', 'date'])

export class ManagedDiaryPrivateMetadataUnsupportedError extends Error {
  readonly code = 'diary-private-metadata-unsupported'

  constructor(path: string) {
    super(`private managed Diary metadata is unsupported: ${path}`)
    this.name = 'ManagedDiaryPrivateMetadataUnsupportedError'
  }
}

function assertPrivateMetadataPath(documentPath: string): void {
  if (isManagedDiaryPath(documentPath.replace(/\.md$/, ''))) {
    throw new ManagedDiaryPrivateMetadataUnsupportedError(documentPath)
  }
}

function date(value: number): string {
  return new Date(value).toISOString().slice(0, 10)
}

export function renderCanonicalFrontmatter(metadata: DocumentMetadata): string {
  const data: Record<string, unknown> = {
    title: metadata.title,
    created: date(metadata.createdAt),
    updated: date(metadata.updatedAt),
    tags: metadata.tags,
  }
  if (metadata.summary) data.summary = metadata.summary
  return `---\n${YAML.stringify(data).trimEnd()}\n---\n\n`
}

function customFields(backup: string): string[] {
  if (!backup) return []
  try {
    const parsed = YAML.parse(backup.replace(/^---\r?\n/, '').replace(/\r?\n---(?:\r?\n)*$/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.keys(parsed).filter((key) => !STANDARD_FIELDS.has(key)).sort()
  } catch {
    return []
  }
}

export async function previewFrontmatterCleanup(
  db: DatabaseT,
): Promise<FrontmatterCleanupPreview> {
  const preview: FrontmatterCleanupPreview = { candidates: [], blocked: [] }
  for (const record of listMetadataMigrationRecords(db)) {
    // Managed Diary rows may contain legacy private backups. Keep them
    // classified for D8.4, but never open the encrypted envelope or expose
    // the backup through this generic archive surface.
    if (isManagedDiaryPath(record.path)) continue
    if (record.status === 'orphaned') continue
    let raw: string
    try {
      raw = await fs.readFile(filePathFor(record.path), 'utf8')
    } catch {
      preview.blocked.push({ path: record.path, reason: 'file missing or unreadable' })
      continue
    }
    const backup = extractFrontmatterBackup(raw)
    if (!backup) continue
    if (record.status !== 'verified') {
      preview.blocked.push({ path: record.path, reason: `migration status is ${record.status}` })
      continue
    }
    if (metadataSourceHash(raw) !== record.sourceHash) {
      preview.blocked.push({ path: record.path, reason: 'source changed after verification' })
      continue
    }
    if (!record.frontmatterBackup || record.frontmatterBackup !== backup) {
      preview.blocked.push({ path: record.path, reason: 'frontmatter backup is incomplete' })
      continue
    }
    const metadata = getDocumentMetadata(db, record.path)
    if (!metadata || record.documentId !== metadata.id) {
      preview.blocked.push({ path: record.path, reason: 'database metadata missing' })
      continue
    }
    preview.candidates.push({
      path: record.path,
      beforeBytes: Buffer.byteLength(raw),
      afterBytes: Buffer.byteLength(raw.slice(backup.length)),
      removedBytes: Buffer.byteLength(backup),
      customFields: customFields(backup),
    })
  }
  return preview
}

export function exportDocumentFrontmatter(
  db: DatabaseT,
  path: string,
  mode: 'canonical' | 'original',
): string | null {
  assertPrivateMetadataPath(path)
  if (mode === 'original') return getMetadataMigrationRecord(db, path)?.frontmatterBackup || null
  const metadata = getDocumentMetadata(db, path)
  return metadata ? renderCanonicalFrontmatter(metadata) : null
}

async function writeWithMetadataCompensation(
  db: DatabaseT,
  path: string,
  abs: string,
  previousRaw: string,
  nextRaw: string,
  mode: number,
  updateMetadata: () => void,
): Promise<number> {
  const databaseSnapshot = snapshotDocumentMetadataMutation(db, [path])
  await atomicReplaceTextIfUnchanged(abs, previousRaw, nextRaw, { mode })
  try {
    updateMetadata()
  } catch (error) {
    const failures: unknown[] = [error]
    try { await atomicReplaceTextIfUnchanged(abs, nextRaw, previousRaw, { mode }) }
    catch (rollbackError) { failures.push(rollbackError) }
    try { restoreDocumentMetadataMutation(db, databaseSnapshot) }
    catch (rollbackError) { failures.push(rollbackError) }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Frontmatter mutation failed and rollback was incomplete')
    }
    throw error
  }
  return (await fs.stat(abs)).mtimeMs
}

export async function cleanDocumentFrontmatter(
  db: DatabaseT,
  paths: string[],
): Promise<FrontmatterMutationResult> {
  const result: FrontmatterMutationResult = { changed: [], failed: [] }
  const candidates = new Map((await previewFrontmatterCleanup(db)).candidates.map((item) => [item.path, item]))
  for (const path of [...new Set(paths)]) {
    assertPrivateMetadataPath(path)
    if (!candidates.has(path)) {
      result.failed.push({ path, reason: 'document is not currently safe to clean' })
      continue
    }
    try {
      await withDocumentWriteLock(path, async () => {
      const abs = filePathFor(path)
      const snapshot = await readStableTextSnapshot(abs)
      const raw = snapshot.raw
      const record = getMetadataMigrationRecord(db, path)
      const metadata = getDocumentMetadata(db, path)
      const backup = extractFrontmatterBackup(raw)
      if (!record || record.status !== 'verified' || !backup
          || !metadata || record.documentId !== metadata.id
          || record.frontmatterBackup !== backup || metadataSourceHash(raw) !== record.sourceHash) {
        throw new Error('document changed after cleanup preview')
      }
      const cleaned = raw.slice(backup.length)
      const cleanedHash = metadataSourceHash(cleaned)
      const newMtime = await writeWithMetadataCompensation(db, path, abs, raw, cleaned, snapshot.stat.mode, () => {
        const updated = db.prepare(`
          UPDATE metadata_migrations
          SET status = 'cleaned', cleaned_hash = ?, error = '', updated_at = ?
          WHERE path = ? AND document_id = ? AND status = 'verified' AND source_hash = ?
        `).run(cleanedHash, Date.now(), path, metadata.id, record.sourceHash)
        if (updated.changes !== 1) throw new Error('migration state changed during cleanup')
        touchDocumentMetadata(db, path, Date.now())
      })
      result.changed.push({ path, newRaw: cleaned, newMtime })
      })
    } catch (error) {
      result.failed.push({ path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

export async function restoreDocumentFrontmatter(
  db: DatabaseT,
  paths: string[],
  mode: 'canonical' | 'original',
): Promise<FrontmatterMutationResult> {
  const result: FrontmatterMutationResult = { changed: [], failed: [] }
  for (const path of [...new Set(paths)]) {
    assertPrivateMetadataPath(path)
    try {
      await withDocumentWriteLock(path, async () => {
      const record = getMetadataMigrationRecord(db, path)
      const metadata = getDocumentMetadata(db, path)
      if (!record || record.status !== 'cleaned' || !record.cleanedHash
          || !metadata || record.documentId !== metadata.id) {
        throw new Error('document is not in cleaned state')
      }
      const abs = filePathFor(path)
      const snapshot = await readStableTextSnapshot(abs)
      const raw = snapshot.raw
      if (metadataSourceHash(raw) !== record.cleanedHash) {
        throw new Error('body changed after cleanup; run migration before restoring')
      }
      const frontmatter = exportDocumentFrontmatter(db, path, mode)
      if (!frontmatter) throw new Error(`${mode} Frontmatter export is unavailable`)
      const restored = frontmatter + raw
      const restoredHash = metadataSourceHash(restored)
      const newMtime = await writeWithMetadataCompensation(db, path, abs, raw, restored, snapshot.stat.mode, () => {
        const updated = db.prepare(`
          UPDATE metadata_migrations
          SET status = 'verified', source_hash = ?, cleaned_hash = '', error = '', updated_at = ?
          WHERE path = ? AND document_id = ? AND status = 'cleaned' AND cleaned_hash = ?
        `).run(restoredHash, Date.now(), path, metadata.id, record.cleanedHash)
        if (updated.changes !== 1) throw new Error('migration state changed during restore')
        touchDocumentMetadata(db, path, Date.now())
      })
      result.changed.push({ path, newRaw: restored, newMtime })
      })
    } catch (error) {
      result.failed.push({ path, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
