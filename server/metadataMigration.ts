import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database as DatabaseT } from 'better-sqlite3'
import { withDocumentWriteLock } from './documentWriteLock.js'
import {
  ensureDocumentMetadata,
  getDocumentMetadata,
} from './documentMetadata.js'
import { isManagedDiaryPath } from '../shared/diaryProtocol.js'

export type MetadataMigrationStatus = 'legacy' | 'imported' | 'verified' | 'cleaned' | 'failed' | 'orphaned'

export interface MetadataMigrationRecord {
  path: string
  status: MetadataMigrationStatus
  sourceHash: string
  error: string
  updatedAt: number
  frontmatterBackup: string
  cleanedHash: string
  documentId: string | null
  originalPath: string
}

export interface MetadataMigrationReport {
  scanned: number
  imported: number
  verified: number
  skipped: number
  failed: number
  pruned: number
}

type MigrationRow = {
  path: string
  status: MetadataMigrationStatus
  source_hash: string
  error: string
  updated_at: number
  frontmatter_backup: string
  cleaned_hash: string
  document_id: string | null
  original_path: string
}

function hydrate(row: MigrationRow): MetadataMigrationRecord {
  return {
    path: row.path,
    status: row.status,
    sourceHash: row.source_hash,
    error: row.error,
    updatedAt: row.updated_at,
    frontmatterBackup: row.frontmatter_backup,
    cleanedHash: row.cleaned_hash,
    documentId: row.document_id,
    originalPath: row.original_path,
  }
}

function saveRecord(
  db: DatabaseT,
  path: string,
  status: MetadataMigrationStatus,
  sourceHash: string,
  error = '',
  frontmatterBackup = '',
): void {
  const document = db.prepare('SELECT id FROM documents WHERE path = ?').get(path) as { id: string } | undefined
  db.prepare(`
    INSERT INTO metadata_migrations (
      path, document_id, status, source_hash, error, updated_at, frontmatter_backup
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      status = excluded.status,
      source_hash = excluded.source_hash,
      error = excluded.error,
      updated_at = excluded.updated_at,
      document_id = COALESCE(excluded.document_id, metadata_migrations.document_id),
      frontmatter_backup = CASE
        WHEN excluded.frontmatter_backup = '' THEN metadata_migrations.frontmatter_backup
        ELSE excluded.frontmatter_backup
      END
  `).run(path, document?.id ?? null, status, sourceHash, error, Date.now(), frontmatterBackup)
}

export function getMetadataMigrationRecord(db: DatabaseT, path: string): MetadataMigrationRecord | null {
  const row = db.prepare(`
    SELECT path, document_id, original_path, status, source_hash, error, updated_at, frontmatter_backup, cleaned_hash
    FROM metadata_migrations WHERE path = ?
  `).get(path) as MigrationRow | undefined
  return row ? hydrate(row) : null
}

export function listMetadataMigrationRecords(db: DatabaseT): MetadataMigrationRecord[] {
  const rows = db.prepare(`
    SELECT path, document_id, original_path, status, source_hash, error, updated_at, frontmatter_backup, cleaned_hash
    FROM metadata_migrations ORDER BY path
  `).all() as MigrationRow[]
  return rows.map(hydrate)
}

export function getMetadataMigrationSummary(db: DatabaseT) {
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM metadata_migrations GROUP BY status
  `).all() as Array<{ status: MetadataMigrationStatus; count: number }>
  const summary: Record<MetadataMigrationStatus, number> = {
    legacy: 0,
    imported: 0,
    verified: 0,
    cleaned: 0,
    failed: 0,
    orphaned: 0,
  }
  for (const row of counts) summary[row.status] = row.count
  return { total: counts.reduce((total, row) => total + row.count, 0), ...summary }
}

async function listMarkdownFiles(rootDir: string): Promise<Array<{ path: string; abs: string }>> {
  const files: Array<{ path: string; abs: string }> = []
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      // Mirror server/tree.ts: skip only `.git`, not every dot-prefixed
      // directory. Without this, `.obsidian/`, `.vscode/`, `.trash/`
      // surface in the file tree but are invisible to migration, so the
      // Settings → "Document metadata" panel and the tree disagree about
      // which documents exist. See tree.ts for the rationale.
      if (entry.name === '.git') continue
      const abs = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(abs, rel)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const logicalPath = rel.slice(0, -3)
        // Managed Diary files are encrypted envelopes. D8.3 migration must
        // classify them structurally and skip the raw read/backup entirely;
        // legacy rows remain untouched for D8.4 cleanup/migration.
        if (!isManagedDiaryPath(logicalPath)) files.push({ path: logicalPath, abs })
      }
    }
  }
  await walk(rootDir, '')
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

export function metadataSourceHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function extractFrontmatterBackup(raw: string): string {
  return raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/)?.[0] ?? ''
}

/** Keep restore guards current after a normal body write to an already-cleaned document. */
export function trackCleanedDocumentWrite(db: DatabaseT, path: string, raw: string): boolean {
  const document = getDocumentMetadata(db, path)
  if (!document) return false
  const result = db.prepare(`
    UPDATE metadata_migrations SET cleaned_hash = ?, updated_at = ?
    WHERE path = ? AND document_id = ? AND status = 'cleaned'
  `).run(metadataSourceHash(raw), Date.now(), path, document.id)
  return result.changes > 0
}

function verifyStoredMetadata(
  db: DatabaseT,
  path: string,
  expected: NonNullable<ReturnType<typeof getDocumentMetadata>>,
): void {
  const stored = getDocumentMetadata(db, path)
  if (!stored || !stored.id || !stored.title.trim()
      || stored.id !== expected.id
      || stored.title !== expected.title
      || stored.summary !== expected.summary
      || stored.createdAt !== expected.createdAt
      || stored.updatedAt !== expected.updatedAt
      || JSON.stringify(stored.tags) !== JSON.stringify(expected.tags)) {
    throw new Error('metadata read-back verification failed')
  }
}

/** Import every Markdown document without modifying any file content. */
export async function migrateVaultMetadata(
  db: DatabaseT,
  rootDir: string,
): Promise<MetadataMigrationReport> {
  const report: MetadataMigrationReport = {
    scanned: 0,
    imported: 0,
    verified: 0,
    skipped: 0,
    failed: 0,
    pruned: 0,
  }
  const files = await listMarkdownFiles(rootDir)
  const livePaths = new Set(files.map((file) => file.path))

  for (const file of files) {
    report.scanned++
    let sourceHash = ''
    await withDocumentWriteLock(file.path, async () => {
    try {
      const [raw, stat] = await Promise.all([fs.readFile(file.abs, 'utf8'), fs.stat(file.abs)])
      sourceHash = metadataSourceHash(raw)
      const frontmatterBackup = extractFrontmatterBackup(raw)
      const record = getMetadataMigrationRecord(db, file.path)
      const currentDocument = getDocumentMetadata(db, file.path)
      const sameDocument = Boolean(currentDocument && record?.documentId === currentDocument.id)
      if (record?.status === 'cleaned' && sameDocument && !frontmatterBackup) {
        if (record.cleanedHash !== sourceHash) {
          db.prepare(`
            UPDATE metadata_migrations SET cleaned_hash = ?, updated_at = ? WHERE path = ?
          `).run(sourceHash, Date.now(), file.path)
        }
        report.skipped++
        return
      }
      const backupComplete = !frontmatterBackup || record?.frontmatterBackup === frontmatterBackup
      if (record?.status === 'verified' && record.sourceHash === sourceHash
          && backupComplete && sameDocument) {
        report.skipped++
        return
      }

      saveRecord(db, file.path, 'legacy', sourceHash, '', frontmatterBackup)
      const existing = getDocumentMetadata(db, file.path)
      const imported = existing
        ? existing
        : ensureDocumentMetadata(db, file.path, raw, stat.mtimeMs)
      saveRecord(db, file.path, 'imported', sourceHash, '', frontmatterBackup)
      verifyStoredMetadata(db, file.path, imported)
      saveRecord(db, file.path, 'verified', sourceHash, '', frontmatterBackup)
      if (!existing) report.imported++
      report.verified++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      saveRecord(db, file.path, 'failed', sourceHash, message)
      report.failed++
    }
    })
  }

  const stale = db.prepare("SELECT path FROM metadata_migrations WHERE status != 'orphaned'").all() as Array<{ path: string }>
  for (const row of stale) {
    // D8.4 owns legacy managed-Diary migration/cleanup. Never rewrite a
    // managed row into an orphan tombstone as a side effect of this scan.
    if (isManagedDiaryPath(row.path)) continue
    if (livePaths.has(row.path)) continue
    await withDocumentWriteLock(row.path, async () => {
    // It may have become live or changed status while this migration waited.
    const liveAbs = path.join(rootDir, `${row.path}.md`)
    if (await fs.stat(liveAbs).then((stat) => stat.isFile(), () => false)) return
    const current = getMetadataMigrationRecord(db, row.path)
    if (!current || current.status === 'orphaned') return
    const tombstone = `@deleted/${Date.now()}-${createHash('sha256').update(row.path).digest('hex').slice(0, 12)}`
    db.prepare(`
      UPDATE metadata_migrations
      SET path = ?, original_path = path, document_id = NULL, status = 'orphaned', updated_at = ?
      WHERE path = ?
    `).run(tombstone, Date.now(), row.path)
    report.pruned++
    })
  }
  return report
}
