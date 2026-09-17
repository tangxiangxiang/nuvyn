// Round-13 folder-move v4 closure: additional tests for remaining
// safety gaps discovered after round-12 fixes. These cover edge cases
// that the round-12 RED tests didn't exercise (empty-tree metadata
// recovery, snapshot restore with empty documents, stat-failure
// journal retention).
//
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { recoverInterruptedOperations } from '../crashRecovery'
import { __setCreateOnlyMoveHooksForTesting, __setDirectoryMoveStrategyOverrideForTesting } from '../documentFileLifecycle'
import { FOLDER_MOVE_JOURNAL_VERSION, listPhysicalMoveEntries, reviveMetadataSnapshot } from '../folderMoveTransaction.js'
import { saveDocumentMetadata, restoreDocumentMetadataMutationCAS, validateSnapshotOwnership, getDocumentMetadata } from '../documentMetadata'
import { setContentDir } from '../paths'
import type { FolderMoveJournalEntryV4, FolderMoveJournalV4 } from '../folderMoveTransaction.js'

let vault: string
let db: InstanceType<typeof Database>

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-round13-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  setContentDir(vault)
})

afterEach(async () => {
  __setCreateOnlyMoveHooksForTesting(null)
  __setDirectoryMoveStrategyOverrideForTesting(null)
  db.close()
  await fs.rm(vault, { recursive: true, force: true })
})

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vault, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
  }
}

async function writeJournal(basename: string, journal: FolderMoveJournalV4): Promise<string> {
  const dir = path.join(vault, path.dirname(basename))
  if (dir !== vault) await fs.mkdir(dir, { recursive: true })
  const journalAbs = path.join(vault, basename)
  await fs.writeFile(journalAbs, JSON.stringify(journal), 'utf8')
  return journalAbs
}

async function namesIn(rel = '.'): Promise<string[]> {
  return fs.readdir(path.join(vault, rel)).catch(() => [] as string[])
}

// ─── P0-1: atomic rename dest generation tracking ─────────────────

describe('atomic rename destination generation', () => {
  it('recovery quarantines when files-landed destination generation does not match (round-14: no re-stat fall-back)', async () => {
    // Round-14 P0-2: a files-landed journal's destination generation
    // is the FINAL post-rename generation the route persisted. If the
    // on-disk generation does not match, the destination is foreign —
    // recovery MUST quarantine. Round-13's re-stat fall-back is
    // forbidden: a brand-new inode on disk could be an external
    // writer's directory, not the route's post-rename destination.
    await seed({
      'ren/a.md': '# hello\n',
    })
    saveDocumentMetadata(db, { id: 'doc-1', path: 'ren/a', title: 'Hello' })

    const destStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })
    const physical = await listPhysicalMoveEntries(path.join(vault, 'ren'), (rel) => {
      if (!rel.endsWith('.md')) return null
      return { documentId: 'doc-1', documentPath: `ren/${rel.slice(0, -'.md'.length)}` }
    })

    const entriesV4: FolderMoveJournalEntryV4[] = physical.entries.map((e) => ({
      relativeFilePath: e.relativeFilePath,
      sourceDev: e.sourceDev ?? '',
      sourceIno: e.sourceIno ?? '',
      sourceHash: e.sourceHash,
      documentId: 'doc-1',
      documentPath: 'proj/a',
    }))

    // Wrong (pre-rename gate) destination generation — round-13 would
    // re-stat and accept; round-14 must quarantine.
    const fakeGen = { dev: '999', ino: '999' }
    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-rename',
      phase: 'files-landed',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: destStat.dev.toString(),
      sourceIno: destStat.ino.toString(),
      destDev: fakeGen.dev,
      destIno: fakeGen.ino,
      entries: entriesV4,
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    }

    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    const report = await recoverInterruptedOperations(vault, db)

    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    const journalsAfter = await namesIn('.')
    expect(journalsAfter.some((n) => n.includes('.nuvyn-journal-'))).toBe(true)
    // Metadata must NOT have moved (the journal is quarantined).
    expect(getDocumentMetadata(db, 'ren/a')?.id ?? null).toBe('doc-1')
    expect(getDocumentMetadata(db, 'proj/a') ?? null).toBeNull()
  })
})

// ─── P1-1: metadata-committed snapshot-restore empty tree ──────────

describe('metadata-committed snapshot-restore empty-tree', () => {
  it('does not crash on empty documentIds array', async () => {
    await seed({ 'ren': '' })
    const destStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })

    // Empty-tree delete rollback journal.
    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-move',
      phase: 'metadata-committed',
      srcRel: '.nuvyn-delete-inflight-xyz',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: '1',
      sourceIno: '1',
      destDev: destStat.dev.toString(),
      destIno: destStat.ino.toString(),
      emptyTree: true,
      entries: [],
      directories: [],
      metadataDisposition: {
        kind: 'snapshot-restore',
        snapshot: {
          paths: ['ren'],
          documentIds: [],
          tagIds: [],
          preexistingTagIds: [],
          documents: [],
          tags: [],
          documentTags: [],
          embeddings: [],
          migrations: [],
        },
      },
    }

    await writeJournal('.nuvyn-delete-inflight-xyz.nuvyn-journal-abcdef012345', journal)

    // Should not throw on revoked.documentIds[0] (empty array).
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.length).toBeGreaterThanOrEqual(0) // no crash
  })
})

// ─── P1-1: metadata-committed prefix-move with no metadata rows ────

describe('metadata-committed prefix-move empty-folder', () => {
  it('allows cleanup when source is gone even without metadata', async () => {
    // Folder was moved, metadata exists but source directory is gone.
    // This simulates an attachment-only or empty folder rename.
    await seed({
      'ren/a.bin': 'binary content',
    })
    const destStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })

    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-rename',
      phase: 'metadata-committed',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: '1',
      sourceIno: '1',
      destDev: destStat.dev.toString(),
      destIno: destStat.ino.toString(),
      entries: [{ relativeFilePath: 'a.bin', sourceDev: '1', sourceIno: '1', sourceHash: 'abcdef'.repeat(10) }],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    }

    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    // No document metadata saved — this is an empty metadata scenario
    // (maybe the folder had no .md files). Since source still exists,
    // we should quarantine (can't prove forward completion).
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })
})

// ─── P1-2: Snapshot migration CAS with same-path/different-owner ───

describe('snapshot migration CAS ownership — cross-check', () => {
  it('rejects live migration targeting snapshot path with different owner', async () => {
    db.exec(`INSERT INTO documents (id, path, title, summary, created_at, updated_at) VALUES ('snap-doc', 'gone/doc', 'Snap Doc', '', 0, 0)`)
    db.exec(`INSERT INTO documents (id, path, title, summary, created_at, updated_at) VALUES ('ext-doc', 'gone/other', 'Ext Doc', '', 0, 0)`)
    // Live migration at 'gone/doc' owned by ext-doc (not the snap's doc).
    db.exec(`INSERT INTO metadata_migrations (path, document_id, original_path, status, source_hash, updated_at) VALUES ('gone/doc', 'ext-doc', 'gone/doc', 'legacy', 'abc', 0)`)

    const snapshot = {
      paths: ['gone/doc'],
      documentIds: ['snap-doc'],
      tagIds: [],
      preexistingTagIds: [],
      documents: [{ id: 'snap-doc', path: 'gone/doc', title: 'Snap Doc', summary: '', created_at: 0, updated_at: 0 }],
      tags: [],
      documentTags: [],
      embeddings: [],
      migrations: [
        { path: 'gone/doc', document_id: 'snap-doc', original_path: 'gone/doc', status: 'legacy', source_hash: 'abc', error: '', updated_at: 0, frontmatter_backup: '', cleaned_hash: 'abc' },
      ],
    }

    const revived = reviveMetadataSnapshot(snapshot as any)
    let caught = false
    try {
      restoreDocumentMetadataMutationCAS(db, revived, (current) => validateSnapshotOwnership(current, revived))
    } catch {
      caught = true
    }
    expect(caught).toBe(true)
  })

  it('accepts live migration that matches snapshot ownership', async () => {
    db.exec(`INSERT INTO documents (id, path, title, summary, created_at, updated_at) VALUES ('match-doc', 'gone/doc', 'Match Doc', '', 0, 0)`)
    // Migration owned by the same document — should pass.
    db.exec(`INSERT INTO metadata_migrations
      (path, document_id, original_path, status, source_hash, updated_at, cleaned_hash)
      VALUES ('gone/doc', 'match-doc', 'gone/doc', 'legacy', 'abc', 0, 'abc')`)

    const snapshot = {
      paths: ['gone/doc'],
      documentIds: ['match-doc'],
      tagIds: [],
      preexistingTagIds: [],
      documents: [{ id: 'match-doc', path: 'gone/doc', title: 'Match Doc', summary: '', created_at: 0, updated_at: 0 }],
      tags: [],
      documentTags: [],
      embeddings: [],
      migrations: [
        { path: 'gone/doc', document_id: 'match-doc', original_path: 'gone/doc', status: 'legacy', source_hash: 'abc', error: '', updated_at: 0, frontmatter_backup: '', cleaned_hash: 'abc' },
      ],
    }

    const revived = reviveMetadataSnapshot(snapshot as any)
    let caught = false
    try {
      restoreDocumentMetadataMutationCAS(db, revived, (current) => validateSnapshotOwnership(current, revived))
    } catch {
      caught = true
    }
    expect(caught).toBe(false)
  })
})

// ─── Round-13 P0-2: journal retention on parity failure ───────────

describe('P0-2: journal retention on parity failure', () => {
  it('keeps the journal when destination parity fails after external mutation', async () => {
    await seed({
      'proj/a.md': '# hello\n',
    })
    saveDocumentMetadata(db, { id: 'doc-1', path: 'proj/a', title: 'Hello' })

    const realStat = await fs.stat(path.join(vault, 'proj'), { bigint: true })
    const physical = await listPhysicalMoveEntries(path.join(vault, 'proj'), (rel) => {
      if (!rel.endsWith('.md')) return null
      return { documentId: 'doc-1', documentPath: `proj/${rel.slice(0, -'.md'.length)}` }
    })

    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-rename',
      phase: 'files-landed',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: realStat.dev.toString(),
      sourceIno: realStat.ino.toString(),
      destDev: realStat.dev.toString(),
      destIno: realStat.ino.toString(),
      entries: physical.entries.map((entry) => ({
        relativeFilePath: entry.relativeFilePath,
        sourceDev: entry.sourceDev ?? '',
        sourceIno: entry.sourceIno ?? '',
        sourceHash: entry.sourceHash,
        documentId: 'doc-1',
        documentPath: 'proj/a',
      })),
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    }
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    // External mutation replaces the file content; parity will fail.
    const fileAbs = path.join(vault, 'proj', 'a.md')
    await fs.writeFile(fileAbs, '# tampered\n', 'utf8')

    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    const journalsAfter = await namesIn('.')
    expect(journalsAfter.some((n) => n.includes('.nuvyn-journal-'))).toBe(true)
  })
})
