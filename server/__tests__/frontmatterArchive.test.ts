import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { deleteDocumentMetadata, getDocumentMetadata, saveDocumentMetadata } from '../documentMetadata'
import {
  cleanDocumentFrontmatter,
  exportDocumentFrontmatter,
  previewFrontmatterCleanup,
  renderCanonicalFrontmatter,
  restoreDocumentFrontmatter,
} from '../frontmatterArchive'
import { getMetadataMigrationRecord, migrateVaultMetadata, trackCleanedDocumentWrite } from '../metadataMigration'
import { CONTENT_DIR, setContentDir } from '../paths'
import { withDocumentWriteLock } from '../documentWriteLock'

let db: Database.Database
let root: string
const originalContentDir = CONTENT_DIR

beforeEach(async () => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-frontmatter-archive-'))
  setContentDir(root)
})

afterEach(async () => {
  setContentDir(originalContentDir)
  db.close()
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, raw: string) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, raw, 'utf8')
}

describe('Frontmatter archive and cleanup preview', () => {
  it('exports canonical database metadata in a stable field order', () => {
    const metadata = saveDocumentMetadata(db, {
      path: 'note', title: 'Title', summary: 'Summary', tags: ['a'],
      createdAt: Date.UTC(2025, 0, 2), updatedAt: Date.UTC(2026, 1, 3),
    })
    expect(renderCanonicalFrontmatter(metadata)).toBe([
      '---', 'title: Title', 'created: 2025-01-02', 'updated: 2026-02-03',
      'tags:', '  - a', 'summary: Summary', '---', '', '',
    ].join('\n'))
  })

  it('previews only verified, hash-matching files and reports custom fields', async () => {
    const raw = '---\ntitle: Legacy\nsource: inbox/original\ncustom: value\n---\n\n# Body\n'
    await write('note.md', raw)
    await migrateVaultMetadata(db, root)
    const preview = await previewFrontmatterCleanup(db)
    expect(preview.blocked).toEqual([])
    expect(preview.candidates).toEqual([expect.objectContaining({
      path: 'note', removedBytes: Buffer.byteLength('---\ntitle: Legacy\nsource: inbox/original\ncustom: value\n---\n\n'),
      customFields: ['custom', 'source'],
    })])
    expect(exportDocumentFrontmatter(db, 'note', 'original')).toContain('source: inbox/original')
    expect(exportDocumentFrontmatter(db, 'note', 'canonical')).toContain('title: Legacy')
  })

  it('blocks cleanup when the source changes after verification', async () => {
    await write('note.md', '---\ntitle: Note\n---\n\nbody\n')
    await migrateVaultMetadata(db, root)
    await fs.appendFile(path.join(root, 'note.md'), 'changed\n')
    const preview = await previewFrontmatterCleanup(db)
    expect(preview.candidates).toEqual([])
    expect(preview.blocked).toEqual([{ path: 'note', reason: 'source changed after verification' }])
  })

  it('waits for the document lock and revalidates bytes before cleanup', async () => {
    const original = '---\ntitle: Note\n---\n\nbody\n'
    const editorBody = '---\ntitle: Note\n---\n\neditor saved\n'
    await write('note.md', original)
    await migrateVaultMetadata(db, root)

    let cleanup!: Promise<Awaited<ReturnType<typeof cleanDocumentFrontmatter>>>
    await withDocumentWriteLock('note', async () => {
      cleanup = cleanDocumentFrontmatter(db, ['note'])
      await Promise.resolve()
      await fs.writeFile(path.join(root, 'note.md'), editorBody, 'utf8')
    })

    const result = await cleanup
    expect(result.changed).toEqual([])
    expect(result.failed[0]).toMatchObject({ path: 'note', reason: expect.stringMatching(/safe|changed/) })
    expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toBe(editorBody)
  })

  it('cleans verified Frontmatter and restores the exact original bytes', async () => {
    const raw = '---\n# comment\ntitle: Note\ncustom: yes\n---\n\n# Body\n'
    await write('note.md', raw)
    await migrateVaultMetadata(db, root)
    const beforeCleanup = getDocumentMetadata(db, 'note')!

    const cleaned = await cleanDocumentFrontmatter(db, ['note'])
    expect(cleaned.failed).toEqual([])
    expect(cleaned.changed[0].newRaw).toBe('# Body\n')
    expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toBe('# Body\n')
    expect(getMetadataMigrationRecord(db, 'note')?.status).toBe('cleaned')
    const afterCleanup = getDocumentMetadata(db, 'note')!
    expect(afterCleanup.updatedAt).toBeGreaterThan(beforeCleanup.updatedAt)

    const startupPass = await migrateVaultMetadata(db, root)
    expect(startupPass.skipped).toBe(1)
    expect(getMetadataMigrationRecord(db, 'note')?.status).toBe('cleaned')

    const restored = await restoreDocumentFrontmatter(db, ['note'], 'original')
    expect(restored.failed).toEqual([])
    expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toBe(raw)
    expect(getMetadataMigrationRecord(db, 'note')?.status).toBe('verified')
    expect(getDocumentMetadata(db, 'note')!.updatedAt).toBeGreaterThan(afterCleanup.updatedAt)
  })

  it('refuses restore when the cleaned body changed outside the tracked write flow', async () => {
    await write('note.md', '---\ntitle: Note\n---\n\nbody\n')
    await migrateVaultMetadata(db, root)
    await cleanDocumentFrontmatter(db, ['note'])
    await fs.appendFile(path.join(root, 'note.md'), 'changed\n')
    const restored = await restoreDocumentFrontmatter(db, ['note'], 'original')
    expect(restored.changed).toEqual([])
    expect(restored.failed[0]).toMatchObject({ path: 'note', reason: expect.stringContaining('body changed') })
  })

  it('allows restore after a tracked editor or AI body write', async () => {
    await write('note.md', '---\ntitle: Note\n---\n\nbody\n')
    await migrateVaultMetadata(db, root)
    await cleanDocumentFrontmatter(db, ['note'])
    await fs.writeFile(path.join(root, 'note.md'), 'edited body\n', 'utf8')
    expect(trackCleanedDocumentWrite(db, 'note', 'edited body\n')).toBe(true)
    const restored = await restoreDocumentFrontmatter(db, ['note'], 'original')
    expect(restored.failed).toEqual([])
    expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toContain('edited body\n')
  })

  it('never restores a deleted generation into a new document at the same path', async () => {
    const original = '---\ntitle: Old generation\n---\n\n# Same body\n'
    await write('note.md', original)
    await migrateVaultMetadata(db, root)
    await cleanDocumentFrontmatter(db, ['note'])
    const oldId = getDocumentMetadata(db, 'note')!.id
    deleteDocumentMetadata(db, 'note')
    await fs.rm(path.join(root, 'note.md'))

    await write('note.md', '# Same body\n')
    const next = saveDocumentMetadata(db, { path: 'note', title: 'New generation' })
    expect(next.id).not.toBe(oldId)
    const restored = await restoreDocumentFrontmatter(db, ['note'], 'original')
    expect(restored.changed).toEqual([])
    expect(restored.failed[0]).toMatchObject({ path: 'note' })
    expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toBe('# Same body\n')
    expect(db.prepare(
      "SELECT status, original_path AS originalPath FROM metadata_migrations WHERE status = 'orphaned'",
    ).get()).toEqual({ status: 'orphaned', originalPath: 'note' })
  })
})
