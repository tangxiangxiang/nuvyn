import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { getDocumentMetadata, saveDocumentMetadata } from '../documentMetadata'
import {
  getMetadataMigrationRecord,
  getMetadataMigrationSummary,
  migrateVaultMetadata,
} from '../metadataMigration'
import { withDocumentWriteLock } from '../documentWriteLock'

let db: Database.Database
let root: string

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-metadata-migration-'))
})

afterEach(async () => {
  db.close()
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, raw: string) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, raw, 'utf8')
}

describe('vault metadata migration', () => {
  it('imports legacy metadata, verifies it, and leaves Markdown untouched', async () => {
    const raw = '---\ntitle: Legacy\nsummary: Keep me\ntags: [RAG, notes]\naliases: [Old name]\n---\n\n# Body\n'
    await write('inbox/legacy.md', raw)

    const report = await migrateVaultMetadata(db, root)

    expect(report).toMatchObject({ scanned: 1, imported: 1, verified: 1, failed: 0 })
    expect(getDocumentMetadata(db, 'inbox/legacy')).toMatchObject({
      title: 'Legacy', summary: 'Keep me', tags: ['notes', 'RAG'],
    })
    expect(getMetadataMigrationRecord(db, 'inbox/legacy')).toMatchObject({
      status: 'verified', error: '', frontmatterBackup: expect.stringContaining('title: Legacy'),
    })
    expect(await fs.readFile(path.join(root, 'inbox/legacy.md'), 'utf8')).toBe(raw)
  })

  it('backfills an exact Frontmatter backup before treating a verified hash as skippable', async () => {
    const raw = '---\n# keep this comment\ntitle: Backup\ncustom: yes\n---\n\nbody\n'
    await write('note.md', raw)
    await migrateVaultMetadata(db, root)
    db.prepare("UPDATE metadata_migrations SET frontmatter_backup = '' WHERE path = 'note'").run()
    const report = await migrateVaultMetadata(db, root)
    expect(report.verified).toBe(1)
    expect(report.skipped).toBe(0)
    expect(getMetadataMigrationRecord(db, 'note')?.frontmatterBackup).toBe(
      '---\n# keep this comment\ntitle: Backup\ncustom: yes\n---\n\n',
    )
  })

  it('is idempotent when the source hash is unchanged', async () => {
    await write('note.md', '# Note\n')
    await migrateVaultMetadata(db, root)
    const second = await migrateVaultMetadata(db, root)
    expect(second).toMatchObject({ scanned: 1, imported: 0, verified: 0, skipped: 1, failed: 0 })
  })

  it('keeps database-owned metadata when legacy Frontmatter changes', async () => {
    await write('note.md', '---\ntitle: Legacy\n---\n\nbody\n')
    saveDocumentMetadata(db, { path: 'note', title: 'Database title', tags: ['db'] })
    const report = await migrateVaultMetadata(db, root)
    expect(report.verified).toBe(1)
    expect(getDocumentMetadata(db, 'note')).toMatchObject({ title: 'Database title', tags: ['db'] })
  })

  it('reprocesses changed files and prunes records for removed files', async () => {
    await write('a.md', '# A\n')
    await write('b.md', '# B\n')
    await migrateVaultMetadata(db, root)
    await fs.writeFile(path.join(root, 'a.md'), '# A changed\n', 'utf8')
    await fs.rm(path.join(root, 'b.md'))

    const report = await migrateVaultMetadata(db, root)
    expect(report).toMatchObject({ scanned: 1, verified: 1, skipped: 0, pruned: 1 })
    expect(getMetadataMigrationRecord(db, 'b')).toBeNull()
    expect(getMetadataMigrationSummary(db)).toMatchObject({ total: 2, verified: 1, orphaned: 1, failed: 0 })
  })

  it('does not prune a migration row when the file becomes live while waiting for its lock', async () => {
    db.prepare(`INSERT INTO metadata_migrations
      (path, status, source_hash, error, updated_at)
      VALUES ('recovered', 'legacy', 'old', '', 1)`).run()

    let migration!: Promise<Awaited<ReturnType<typeof migrateVaultMetadata>>>
    await withDocumentWriteLock('recovered', async () => {
      migration = migrateVaultMetadata(db, root)
      await new Promise((resolve) => setTimeout(resolve, 10))
      await write('recovered.md', '# Recovered\n')
    })

    const report = await migration
    expect(report.pruned).toBe(0)
    expect(getMetadataMigrationRecord(db, 'recovered')?.status).toBe('legacy')
  })

  it('walks into dot-prefixed directories other than .git, matching tree.ts', async () => {
    // The migration walker used to skip every entry whose name started
    // with a dot, while tree.ts skipped only `.git`. Files under
    // `.obsidian/` etc. would appear in the file tree but never get a
    // migration record. Mirror tree.ts so the two walkers agree.
    await write('.obsidian/notes/secret.md', '---\ntitle: Secret\n---\n\nbody\n')
    await write('plain.md', '---\ntitle: Plain\n---\n\nbody\n')
    const report = await migrateVaultMetadata(db, root)
    expect(report.scanned).toBe(2)
    expect(getMetadataMigrationRecord(db, '.obsidian/notes/secret')?.status).toBe('verified')
  })
})
