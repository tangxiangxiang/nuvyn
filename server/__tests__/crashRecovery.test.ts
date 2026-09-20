import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { deleteDocumentMetadataPrefix, getDocumentMetadata, saveDocumentMetadata, snapshotDocumentMetadataDatabase, snapshotDocumentMetadataMutation, snapshotDocumentMetadataPrefixMutation } from '../documentMetadata'
import {
  rewriteDurableJournal,
  sha256Hex,
  sha256HexBuffer,
  writeDurableJournal,
} from '../atomicTextWrite'
import { recoverInterruptedOperations } from '../crashRecovery'
import { prepareRenameReferenceJournal } from '../renameReferenceJournal'
import {
  createFolderMoveGateProof,
  FOLDER_MOVE_JOURNAL_VERSION,
  serializeMetadataSnapshot,
  type FolderMoveJournalV4,
} from '../folderMoveTransaction'
import { parseFolderMoveJournalV4Object } from '../folderMoveV4DurableJournal'
import { __setCreateOnlyMoveHooksForTesting, FOLDER_MOVE_STRATEGIES, platformDirectoryMoveStrategy } from '../documentFileLifecycle'
import {
  terminateProcessTree,
  waitForChildClose,
} from './helpers/crashProcessTree'
import { cleanupRecoveryTempDir } from './helpers/recoveryIntegration'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'))
const CRASH_CHILD = path.join(import.meta.dirname, 'fixtures', 'commit-crash-child.ts')
const RENAME_CRASH_CHILD = path.join(import.meta.dirname, 'fixtures', 'rename-crash-child.ts')
const RENAME_METADATA_CRASH_CHILD = path.join(import.meta.dirname, 'fixtures', 'rename-metadata-crash-child.ts')
const REFERENCE_JOURNAL_CRASH_CHILD = path.join(import.meta.dirname, 'fixtures', 'reference-journal-crash-child.ts')
const FOLDER_MOVE_CRASH_CHILD = path.join(import.meta.dirname, 'fixtures', 'folder-move-crash-child.ts')
const FOLDER_ROLLBACK_CRASH_CHILD = path.join(import.meta.dirname, 'fixtures', 'folder-rollback-crash-child.ts')
const FOLDER_DELETE_ROLLBACK_CRASH_CHILD = path.join(import.meta.dirname, 'fixtures', 'folder-delete-rollback-crash-child.ts')
const FOLDER_RECOVERY_REPLAY_CRASH_CHILD = path.join(import.meta.dirname, 'fixtures', 'folder-recovery-replay-crash-child.ts')
const PROCESS_TREE_LOCK_PARENT = path.join(import.meta.dirname, 'fixtures', 'process-tree-lock-parent.ts')

const REAL_CRASH_TEST_TIMEOUT = process.platform === 'win32' ? 30_000 : 15_000
const READY_TIMEOUT = process.platform === 'win32' ? 15_000 : 8_000
const TERMINATION_TIMEOUT = process.platform === 'win32' ? 10_000 : 5_000

let vault: string
let db: InstanceType<typeof Database>
const activeCrashChildren = new Set<ChildProcess>()

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-crash-'))
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
})

afterEach(async () => {
  __setCreateOnlyMoveHooksForTesting(null)
  await Promise.allSettled(
    [...activeCrashChildren].map((child) =>
      terminateProcessTree(child, { timeoutMs: 10_000 })),
  )
  activeCrashChildren.clear()
  db.close()
  await cleanupRecoveryTempDir(vault)
})

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vault, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
  }
}

function journalFor(staged: string, replacement: string, expectedRaw: string, replacementRaw: string): string {
  return JSON.stringify({
    version: 1,
    op: 'replace',
    staged,
    replacement,
    expectedHash: sha256Hex(expectedRaw),
    replacementHash: sha256Hex(replacementRaw),
  })
}

async function namesIn(rel = '.'): Promise<string[]> {
  return fs.readdir(path.join(vault, rel)).catch(() => [] as string[])
}

function runRecovery() {
  return recoverInterruptedOperations(vault, db)
}

function expectWeakLegacyFolderJournal(
  report: Awaited<ReturnType<typeof recoverInterruptedOperations>>,
  file = '.proj.nuvyn-journal-cccc',
): void {
  expect(report.actions).toContainEqual({
    file,
    action: 'quarantined',
    detail: 'legacy journal lacks sufficient durable ownership proof',
  })
}

async function createLegacyV6JournalFixture(contentDir: string): Promise<{
  db: InstanceType<typeof Database>
  dbRoot: string
  journalAbs: string
  journalName: string
}> {
  const dbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-t21-v6-db-'))
  const dbPath = path.join(dbRoot, 'nuvyn.db')
  const legacyDb = new Database(dbPath)
  legacyDb.pragma('foreign_keys = ON')
  legacyDb.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (6);
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE document_tags (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, tag_id)
    );
    CREATE INDEX idx_document_tags_tag ON document_tags(tag_id, document_id);
    CREATE TABLE document_embeddings (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      embedding BLOB NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE TABLE metadata_migrations (
      path TEXT PRIMARY KEY,
      document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
      original_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('legacy', 'imported', 'verified', 'cleaned', 'failed', 'orphaned')),
      source_hash TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      frontmatter_backup TEXT NOT NULL DEFAULT '',
      cleaned_hash TEXT NOT NULL DEFAULT ''
    );
  `)
  legacyDb.exec(`
    INSERT INTO documents (id, path, title, summary, created_at, updated_at)
    VALUES
      ('doc-existing', 'gone/a', 'A', '', 1, 10),
      ('doc-missing', 'gone/b', 'B', '', 2, 20);
    INSERT INTO tags (id, name, normalized_name) VALUES (1, 'Backend', 'backend');
    INSERT INTO document_tags (document_id, tag_id)
    VALUES ('doc-existing', 1), ('doc-missing', 1);
  `)

  const serialized = serializeMetadataSnapshot(
    snapshotDocumentMetadataMutation(legacyDb, ['gone/a', 'gone/b']),
  )
  const { documentTagsVersion: _legacyMarker, ...legacySnapshot } = serialized
  const stageRel = '.gone.nuvyn-delete-inflight-abcdef012345'
  const stageAbs = path.join(contentDir, stageRel)
  await fs.mkdir(stageAbs, { recursive: true })
  await fs.writeFile(path.join(stageAbs, 'a.md'), '# A\n', 'utf8')
  await fs.writeFile(path.join(stageAbs, 'b.md'), '# B\n', 'utf8')
  const [sourceStat, aStat, bStat] = await Promise.all([
    fs.stat(stageAbs, { bigint: true }),
    fs.stat(path.join(stageAbs, 'a.md'), { bigint: true }),
    fs.stat(path.join(stageAbs, 'b.md'), { bigint: true }),
  ])
  const gateProof = createFolderMoveGateProof()
  const journalName = `.${stageRel}.nuvyn-journal-abcdef012345`
  const journalAbs = path.join(contentDir, journalName)
  const journal: FolderMoveJournalV4 = {
    version: FOLDER_MOVE_JOURNAL_VERSION,
    op: 'folder-move',
    phase: 'prepared',
    srcRel: stageRel,
    destRel: 'gone',
    strategy: 'replayable-move',
    sourceDev: sourceStat.dev.toString(),
    sourceIno: sourceStat.ino.toString(),
    sourceBirthtimeNs: sourceStat.birthtimeNs.toString(),
    gateProof,
    entries: [
      {
        relativeFilePath: 'a.md',
        sourceHash: sha256Hex('# A\n'),
        sourceDev: aStat.dev.toString(),
        sourceIno: aStat.ino.toString(),
        documentId: 'doc-existing',
        documentPath: 'gone/a',
      },
      {
        relativeFilePath: 'b.md',
        sourceHash: sha256Hex('# B\n'),
        sourceDev: bStat.dev.toString(),
        sourceIno: bStat.ino.toString(),
        documentId: 'doc-missing',
        documentPath: 'gone/b',
      },
    ],
    directories: [],
    directoryGenerations: [],
    metadataDisposition: {
      kind: 'snapshot-restore',
      snapshot: legacySnapshot,
    },
  }
  await writeDurableJournal(journalAbs, journal)

  // The delete rollback journal is durable before the interrupted metadata
  // delete.  Reproduce the post-crash state, then let the real migration
  // runner upgrade the on-disk v6 database before recovery sees the journal.
  deleteDocumentMetadataPrefix(legacyDb, 'gone', 30)
  applyMigrations(legacyDb)
  return { db: legacyDb, dbRoot, journalAbs, journalName }
}

async function closeLegacyV6JournalFixture(
  fixture: Awaited<ReturnType<typeof createLegacyV6JournalFixture>>,
): Promise<void> {
  fixture.db.close()
  await fs.rm(fixture.dbRoot, { recursive: true, force: true })
}

describe('T2.1-0 real v6 durable-journal upgrade recovery', () => {
  it('migrates a v6 journal and recovers it through recoverInterruptedOperations', async () => {
    const fixture = await createLegacyV6JournalFixture(vault)
    try {
      expect((fixture.db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(35)

      // A logically proven live v7 row keeps its current physical ID.  The
      // missing v6 row is recreated as a new v7 association.
      fixture.db.prepare(`
        INSERT INTO documents (id, path, title, summary, created_at, updated_at)
        VALUES ('doc-existing', 'gone/a', 'A', '', 1, 10)
      `).run()
      fixture.db.prepare(`
        INSERT INTO document_tags (association_id, document_id, tag_id)
        VALUES (700, 'doc-existing', 1)
      `).run()

      const report = await recoverInterruptedOperations(vault, fixture.db)

      expect(report.actions.some((action) => action.action === 'completed-rename')).toBe(true)
      expect(await fs.stat(path.join(vault, 'gone', 'a.md'))).toBeDefined()
      expect(await fs.stat(path.join(vault, 'gone', 'b.md'))).toBeDefined()
      await expect(fs.stat(fixture.journalAbs)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(fixture.db.prepare(`
        SELECT document_id, tag_id, association_id
        FROM document_tags
        ORDER BY document_id
      `).all()).toEqual([
        { document_id: 'doc-existing', tag_id: 1, association_id: 700 },
        { document_id: 'doc-missing', tag_id: 1, association_id: 701 },
      ])
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get()).toEqual({ count: 0 })
      expect(fixture.db.prepare('SELECT current_record_id FROM tag_undo_state').get()).toEqual({ current_record_id: null })
      expect(fixture.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect((fixture.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    } finally {
      await closeLegacyV6JournalFixture(fixture)
    }
  })

  it('fails closed on unsafe live drift without overwriting the external owner', async () => {
    const fixture = await createLegacyV6JournalFixture(vault)
    try {
      fixture.db.prepare(`
        INSERT INTO documents (id, path, title, summary, created_at, updated_at)
        VALUES ('external-owner', 'gone/a', 'External', 'do not overwrite', 9, 99)
      `).run()

      const report = await recoverInterruptedOperations(vault, fixture.db)

      expect(report.actions.some((action) =>
        action.action === 'quarantined'
        && action.detail?.includes('snapshot metadata CAS failed'))).toBe(true)
      expect(await fs.stat(fixture.journalAbs)).toBeDefined()
      expect(fixture.db.prepare(`
        SELECT id, path, title, summary, created_at, updated_at
        FROM documents
        WHERE path = 'gone/a'
      `).get()).toEqual({
        id: 'external-owner',
        path: 'gone/a',
        title: 'External',
        summary: 'do not overwrite',
        created_at: 9,
        updated_at: 99,
      })
      expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM tag_undo_records').get()).toEqual({ count: 0 })
      expect(fixture.db.prepare('SELECT current_record_id FROM tag_undo_state').get()).toEqual({ current_record_id: null })
      expect(fixture.db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect((fixture.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok')
    } finally {
      await closeLegacyV6JournalFixture(fixture)
    }
  })
})

describe('recoverInterruptedOperations (journaled replace)', () => {
  it('completes an interrupted save when both generations verify (nested dir)', async () => {
    // The exact state a kill -9 between takeover and link leaves behind:
    // formal path missing, staged old generation, save temp, durable
    // journal. Recovery must publish the new generation, not lose the
    // note, and leave zero artifacts.
    await seed({
      'inbox/.note.md.nuvyn-staged-aaaa': '# base\n',
      'inbox/.note.md.nuvyn-save-bbbb': '# replacement\n',
      'inbox/.note.md.nuvyn-journal-cccc': journalFor(
        '.note.md.nuvyn-staged-aaaa',
        '.note.md.nuvyn-save-bbbb',
        '# base\n',
        '# replacement\n',
      ),
    })
    saveDocumentMetadata(db, { id: 'crash-survivor-id', path: 'inbox/note', title: 'Survivor', updatedAt: 1 })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'inbox/note.md'), 'utf8')).toBe('# replacement\n')
    expect(report.actions.some((a) => a.action === 'completed-save')).toBe(true)
    expect(report.actions.some((a) => a.action === 'failed')).toBe(false)
    // The replace protocol never touches metadata: the identity must
    // survive the crash + recovery untouched.
    expect(getDocumentMetadata(db, 'inbox/note')?.id).toBe('crash-survivor-id')
    expect(await namesIn('inbox')).toEqual(['note.md'])
  })

  it('restores the old generation when the staged bytes fail hash verification', async () => {
    await seed({
      '.note.md.nuvyn-staged-aaaa': '# tampered staged\n',
      '.note.md.nuvyn-save-bbbb': '# replacement\n',
      '.note.md.nuvyn-journal-cccc': journalFor(
        '.note.md.nuvyn-staged-aaaa',
        '.note.md.nuvyn-save-bbbb',
        '# base\n',
        '# replacement\n',
      ),
    })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# tampered staged\n')
    expect(report.actions.some((a) => a.action === 'restored')).toBe(true)
    const quarantineSave = (await namesIn()).find((name) => name.startsWith('.note.md.nuvyn-quarantine-save-'))!
    expect(quarantineSave).toBeTruthy()
    expect(await namesIn()).toContain('.note.md.nuvyn-journal-cccc')
    expect(await namesIn()).toContain('note.md')
    await runRecovery()
    await runRecovery()
    expect(await fs.readFile(path.join(vault, quarantineSave), 'utf8')).toBe('# replacement\n')
    expect(await fs.readFile(path.join(vault, '.note.md.nuvyn-journal-cccc'), 'utf8'))
      .toContain('manual-recovery-required')
  })

  it('restores the old generation when the save temp is missing', async () => {
    await seed({
      '.note.md.nuvyn-staged-aaaa': '# base\n',
      '.note.md.nuvyn-journal-cccc': journalFor(
        '.note.md.nuvyn-staged-aaaa',
        '.note.md.nuvyn-save-bbbb',
        '# base\n',
        '# replacement\n',
      ),
    })

    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# base\n')
    expect(await namesIn()).toEqual(['note.md'])
  })

  it('completes a crash-interrupted save quarantine transition from either payload name', async () => {
    await seed({
      'note.md': '# restored\n',
      '.note.md.nuvyn-save-bbbb': '# replacement\n',
      '.note.md.nuvyn-journal-cccc': JSON.stringify({
        version: 1,
        op: 'replace',
        staged: '.note.md.nuvyn-staged-aaaa',
        replacement: '.note.md.nuvyn-save-bbbb',
        pendingReplacement: '.note.md.nuvyn-quarantine-save-dddd',
        expectedHash: sha256Hex('# restored\n'),
        replacementHash: sha256Hex('# replacement\n'),
        phase: 'quarantine-save-pending',
      }),
    })

    await runRecovery()
    await runRecovery()

    expect(await fs.readFile(path.join(vault, '.note.md.nuvyn-quarantine-save-dddd'), 'utf8')).toBe('# replacement\n')
    expect(await fs.readFile(path.join(vault, '.note.md.nuvyn-journal-cccc'), 'utf8')).toContain('manual-recovery-required')
  })

  it('retains both recoverable generations when an external version owns the target', async () => {
    await seed({
      'note.md': '# landed\n',
      '.note.md.nuvyn-staged-aaaa': '# base\n',
      '.note.md.nuvyn-save-bbbb': '# replacement\n',
      '.note.md.nuvyn-journal-cccc': journalFor(
        '.note.md.nuvyn-staged-aaaa',
        '.note.md.nuvyn-save-bbbb',
        '# base\n',
        '# replacement\n',
      ),
    })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# landed\n')
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    expect((await namesIn()).some((name) => name.startsWith('.note.md.nuvyn-quarantine-save-'))).toBe(true)
    expect(await namesIn()).toContain('.note.md.nuvyn-journal-cccc')
    expect(await namesIn()).toContain('.note.md.nuvyn-staged-aaaa')
    expect(await namesIn()).toContain('note.md')
  })

  it('never deletes a changed staged generation after a replacement commit', async () => {
    await seed({
      'note.md': '# replacement\n',
      '.note.md.nuvyn-staged-bbbb': 'external through old fd\n',
      '.note.md.nuvyn-save-cccc': '# replacement\n',
      '.note.md.nuvyn-journal-dddd': JSON.stringify({
        version: 1,
        op: 'replace',
        staged: '.note.md.nuvyn-staged-bbbb',
        replacement: '.note.md.nuvyn-save-cccc',
        expectedHash: sha256Hex('# base\n'),
        replacementHash: sha256Hex('# replacement\n'),
        observedStagedHash: sha256Hex('external through old fd\n'),
        phase: 'post-commit-external-mutation',
      }),
    })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# replacement\n')
    expect(await fs.readFile(path.join(vault, '.note.md.nuvyn-staged-bbbb'), 'utf8'))
      .toBe('external through old fd\n')
    expect(await fs.readFile(path.join(vault, '.note.md.nuvyn-journal-dddd'), 'utf8'))
      .toContain('post-commit-external-mutation')
    expect(report.actions).toContainEqual(expect.objectContaining({ action: 'quarantined' }))
  })

  it('removes a stale journal whose takeover never happened', async () => {
    await seed({
      'note.md': '# untouched\n',
      '.note.md.nuvyn-save-bbbb': '# replacement\n',
      '.note.md.nuvyn-journal-cccc': journalFor(
        '.note.md.nuvyn-staged-aaaa',
        '.note.md.nuvyn-save-bbbb',
        '# base\n',
        '# replacement\n',
      ),
    })

    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# untouched\n')
    // Uncommitted save temp with a live target is provably stale.
    expect(await namesIn()).toEqual(['note.md'])
  })

  it('keeps a save temp whose target is gone (intent cannot be guessed)', async () => {
    await seed({
      '.note.md.nuvyn-save-bbbb': '# replacement\n',
      '.note.md.nuvyn-journal-cccc': journalFor(
        '.note.md.nuvyn-staged-aaaa',
        '.note.md.nuvyn-save-bbbb',
        '# base\n',
        '# replacement\n',
      ),
    })

    const report = await runRecovery()

    expect(await namesIn()).toEqual(['.note.md.nuvyn-save-bbbb'])
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('leaves an unrecognized journal in place and reports it', async () => {
    await seed({ '.note.md.nuvyn-journal-cccc': '{not json' })

    const report = await runRecovery()

    expect(await namesIn()).toEqual(['.note.md.nuvyn-journal-cccc'])
    expect(report.actions.some((a) => a.action === 'quarantined' && /unrecognized/.test(a.detail ?? ''))).toBe(true)
  })

  it('never follows malicious replace journal paths outside the vault', async () => {
    const sentinel = path.join(path.dirname(vault), `${path.basename(vault)}-sentinel.txt`)
    const replacement = path.join(path.dirname(vault), `${path.basename(vault)}-replacement.txt`)
    await fs.writeFile(sentinel, 'keep old', 'utf8')
    await fs.writeFile(replacement, 'keep new', 'utf8')
    try {
      await seed({
        'note.md': '# live\n',
        '.note.md.nuvyn-journal-aaaa': JSON.stringify({
          version: 1,
          op: 'replace',
          staged: `../${path.basename(sentinel)}`,
          replacement: `../${path.basename(replacement)}`,
          expectedHash: 'x',
          replacementHash: 'y',
        }),
      })
      const report = await runRecovery()
      expect(await fs.readFile(sentinel, 'utf8')).toBe('keep old')
      expect(await fs.readFile(replacement, 'utf8')).toBe('keep new')
      expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
      expect(await namesIn()).toContain('.note.md.nuvyn-journal-aaaa')
    } finally {
      await fs.rm(sentinel, { force: true })
      await fs.rm(replacement, { force: true })
    }
  })

  it('quarantines a replace journal with malformed hashes without deleting its artifacts', async () => {
    await seed({
      'note.md': '# live\n',
      '.note.md.nuvyn-save-bbbb': '# replacement\n',
      '.note.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1, op: 'replace', staged: '.note.md.nuvyn-staged-cccc',
        replacement: '.note.md.nuvyn-save-bbbb', expectedHash: 'x', replacementHash: 'y',
      }),
    })
    const before = await namesIn()

    const report = await runRecovery()

    expect(await namesIn()).toEqual(before)
    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# live\n')
    expect(report.actions.some((action) => action.action === 'quarantined')).toBe(true)
  })
})

describe('recoverInterruptedOperations (journal-less orphans)', () => {
  it('restores an orphaned staged generation when the path is empty', async () => {
    await seed({ '.note.md.nuvyn-staged-aaaa': '# base\n' })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# base\n')
    expect(report.actions.some((a) => a.action === 'restored')).toBe(true)
    expect(await namesIn()).toEqual(['note.md'])
  })

  it('quarantines an orphaned staged generation when the target exists', async () => {
    await seed({
      'note.md': '# external\n',
      '.note.md.nuvyn-staged-aaaa': '# base\n',
    })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# external\n')
    expect(await namesIn()).toContain('.note.md.nuvyn-staged-aaaa')
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('restores an interrupted conditional removal (conservative)', async () => {
    await seed({ '.note.md.nuvyn-remove-aaaa': '# base\n' })

    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# base\n')
    expect(await namesIn()).toEqual(['note.md'])
  })

  it('removes removal staging when the target was recreated externally', async () => {
    await seed({
      'note.md': '# recreated\n',
      '.note.md.nuvyn-remove-aaaa': '# base\n',
    })

    await runRecovery()

    expect(await namesIn()).toEqual(['note.md'])
  })

  it('removes an uncommitted save temp when the target exists', async () => {
    await seed({
      'note.md': '# current\n',
      '.note.md.nuvyn-save-bbbb': '# replacement\n',
    })

    await runRecovery()

    expect(await namesIn()).toEqual(['note.md'])
  })

  it('keeps a save temp whose target is gone and reports it', async () => {
    await seed({ '.note.md.nuvyn-save-bbbb': '# replacement\n' })

    const report = await runRecovery()

    expect(await namesIn()).toEqual(['.note.md.nuvyn-save-bbbb'])
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })
})

describe('recoverInterruptedOperations (delete quarantine)', () => {
  it('recovers a managed delete intent without detaching a fresh path identity', async () => {
    const target = path.join(vault, 'diary', '2026-08-28.md')
    const inflight = path.join(vault, 'diary', '2026-08-28.md.nuvyn-delete-inflight-aaaa')
    const quarantine = path.join(vault, 'diary', '2026-08-28.md.nuvyn-quarantine-reuse-aaaa')
    const manifest = path.join(vault, 'diary', '.2026-08-28.md.nuvyn-delete-manifest-aaaa')
    await seed({
      'diary/2026-08-28.md': 'fresh external generation\n',
      'diary/2026-08-28.md.nuvyn-delete-inflight-aaaa': 'old opaque generation\n',
    })
    saveDocumentMetadata(db, { id: 'fresh-id', path: 'diary/2026-08-28', title: 'Fresh', updatedAt: 2 })
    const [stagedStat, parentStat] = await Promise.all([
      fs.lstat(inflight, { bigint: true }),
      fs.lstat(path.dirname(inflight), { bigint: true }),
    ])
    await fs.writeFile(manifest, JSON.stringify({
      version: 1,
      op: 'delete-path-reuse',
      phase: 'managed-delete-intent',
      kind: 'file',
      path: 'diary/2026-08-28',
      inflight: path.basename(inflight),
      quarantine: path.basename(quarantine),
      identities: [{ path: 'diary/2026-08-28', id: 'old-id' }],
      documentId: 'old-id',
      source: {
        dev: stagedStat.dev.toString(),
        ino: stagedStat.ino.toString(),
        parentDev: parentStat.dev.toString(),
        parentIno: parentStat.ino.toString(),
      },
    }), 'utf8')

    await runRecovery()

    expect(await fs.readFile(target, 'utf8')).toBe('fresh external generation\n')
    expect(getDocumentMetadata(db, 'diary/2026-08-28')?.id).toBe('fresh-id')
    expect(await fs.readFile(quarantine, 'utf8')).toBe('old opaque generation\n')
    await expect(fs.stat(manifest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('completes a managed delete intent only for the original staged generation', async () => {
    const inflight = path.join(vault, 'diary', '2026-08-29.md.nuvyn-delete-inflight-aaaa')
    const quarantine = path.join(vault, 'diary', '2026-08-29.md.nuvyn-quarantine-reuse-aaaa')
    const manifest = path.join(vault, 'diary', '.2026-08-29.md.nuvyn-delete-manifest-aaaa')
    await seed({ 'diary/2026-08-29.md.nuvyn-delete-inflight-aaaa': 'old opaque generation\n' })
    saveDocumentMetadata(db, { id: 'old-id', path: 'diary/2026-08-29', title: 'Old', updatedAt: 1 })
    const [stagedStat, parentStat] = await Promise.all([
      fs.lstat(inflight, { bigint: true }),
      fs.lstat(path.dirname(inflight), { bigint: true }),
    ])
    await fs.writeFile(manifest, JSON.stringify({
      version: 1,
      op: 'delete-path-reuse',
      phase: 'managed-delete-intent',
      kind: 'file',
      path: 'diary/2026-08-29',
      inflight: path.basename(inflight),
      quarantine: path.basename(quarantine),
      identities: [{ path: 'diary/2026-08-29', id: 'old-id' }],
      documentId: 'old-id',
      source: {
        dev: stagedStat.dev.toString(),
        ino: stagedStat.ino.toString(),
        parentDev: parentStat.dev.toString(),
        parentIno: parentStat.ino.toString(),
      },
    }), 'utf8')

    const report = await runRecovery()

    await expect(fs.stat(inflight)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(manifest)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getDocumentMetadata(db, 'diary/2026-08-29')).toBeNull()
    expect(report.actions.some((action) => action.action === 'completed-delete')).toBe(true)
  })

  it('quarantines an empty-identity delete manifest without promoting or deleting artifacts', async () => {
    await seed({
      'gone.md.nuvyn-delete-inflight-aaaa': '# old\n',
      '.gone.md.nuvyn-delete-manifest-bbbb': JSON.stringify({
        version: 1, op: 'delete-path-reuse', kind: 'file', path: 'gone',
        inflight: 'gone.md.nuvyn-delete-inflight-aaaa',
        quarantine: 'gone.md.nuvyn-quarantine-reuse-aaaa', identities: [],
      }),
    })
    const before = await namesIn()

    const report = await runRecovery()

    expect(await namesIn()).toEqual(before)
    expect(report.actions.some((action) => action.action === 'quarantined')).toBe(true)
  })

  it('replays a persisted legacy quarantine manifest after a crash before detach', async () => {
    await seed({
      'gone.md.nuvyn-quarantine-reuse-aaaa': '# old\n',
      '.gone.md.nuvyn-quarantine-manifest-bbbb': JSON.stringify({
        version: 1,
        op: 'legacy-delete-quarantine',
        path: 'gone',
        quarantine: 'gone.md.nuvyn-quarantine-reuse-aaaa',
        identities: [{ path: 'gone', id: 'legacy-id' }],
      }),
    })
    saveDocumentMetadata(db, { id: 'legacy-id', path: 'gone', title: 'Gone', updatedAt: 1 })

    await runRecovery()

    expect(getDocumentMetadata(db, 'gone')).toBeNull()
    expect(await namesIn()).toContain('.gone.md.nuvyn-quarantine-manifest-bbbb')
    expect(await namesIn()).toContain('gone.md.nuvyn-quarantine-reuse-aaaa')
  })

  it('replays identity detachment after a crash between quarantine fsync and metadata update', async () => {
    await seed({
      'gone.md': '# external\n',
      'gone.md.nuvyn-quarantine-reuse-aaaa': '# old\n',
      '.gone.md.nuvyn-delete-manifest-bbbb': JSON.stringify({
        version: 1,
        op: 'delete-path-reuse',
        kind: 'file',
        path: 'gone',
        inflight: 'gone.md.nuvyn-delete-inflight-aaaa',
        quarantine: 'gone.md.nuvyn-quarantine-reuse-aaaa',
        identities: [{ path: 'gone', id: 'old-id' }],
      }),
    })
    saveDocumentMetadata(db, { id: 'old-id', path: 'gone', title: 'Old', updatedAt: 1 })

    await runRecovery()

    expect(getDocumentMetadata(db, 'gone')).toBeNull()
    expect(await namesIn()).not.toContain('.gone.md.nuvyn-delete-manifest-bbbb')
    expect(await namesIn()).toContain('gone.md.nuvyn-quarantine-reuse-aaaa')
  })

  it('does not detach a fresh identity when replaying a stale delete manifest', async () => {
    await seed({
      'gone.md': '# external\n',
      'gone.md.nuvyn-quarantine-reuse-aaaa': '# old\n',
      '.gone.md.nuvyn-delete-manifest-bbbb': JSON.stringify({
        version: 1,
        op: 'delete-path-reuse',
        kind: 'file',
        path: 'gone',
        inflight: 'gone.md.nuvyn-delete-inflight-aaaa',
        quarantine: 'gone.md.nuvyn-quarantine-reuse-aaaa',
        identities: [{ path: 'gone', id: 'old-id' }],
      }),
    })
    saveDocumentMetadata(db, { id: 'fresh-id', path: 'gone', title: 'Fresh', updatedAt: 2 })

    await runRecovery()

    expect(getDocumentMetadata(db, 'gone')?.id).toBe('fresh-id')
  })

  it('never auto-deletes an explicit path-reuse quarantine after the public path disappears', async () => {
    await seed({ 'gone.md.nuvyn-quarantine-reuse-aaaa': '# recoverable old generation\n' })
    saveDocumentMetadata(db, { id: 'new-id', path: 'gone', title: 'New', updatedAt: 1 })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'gone.md.nuvyn-quarantine-reuse-aaaa'), 'utf8'))
      .toBe('# recoverable old generation\n')
    expect(getDocumentMetadata(db, 'gone')?.id).toBe('new-id')
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('conservatively promotes a legacy file delete artifact instead of auto-deleting it', async () => {
    await seed({ 'gone.md.nuvyn-delete-123': '# old\n' })
    saveDocumentMetadata(db, { id: 'gone-id', path: 'gone', title: 'Gone', updatedAt: 1 })

    const report = await runRecovery()

    expect((await namesIn()).some((name) => name.startsWith('gone.md.nuvyn-quarantine-reuse-'))).toBe(true)
    expect(getDocumentMetadata(db, 'gone')).toBeNull()
    expect((await namesIn()).some((name) => name.startsWith('.gone.md.nuvyn-quarantine-manifest-'))).toBe(true)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('conservatively promotes a legacy folder delete artifact', async () => {
    await seed({ 'gone.nuvyn-delete-123/a.md': '# a\n' })
    saveDocumentMetadata(db, { id: 'gone-a-id', path: 'gone/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expect((await namesIn()).some((name) => name.startsWith('gone.nuvyn-quarantine-reuse-'))).toBe(true)
    expect(getDocumentMetadata(db, 'gone/a')).toBeNull()
    expect((await namesIn()).some((name) => name.startsWith('.gone.nuvyn-quarantine-manifest-'))).toBe(true)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('never writes an empty manifest for a metadata-less legacy delete artifact', async () => {
    // A metadata-less legacy artifact used to write an
    // {identities: []} manifest — which the parser (rightly) rejects,
    // so the unparseable manifest stayed "authoritative" and blocked
    // every orphan rule for this basename on every future startup.
    // The promotion must skip the manifest entirely while still
    // preserving the bytes under the permanent quarantine name.
    await seed({ 'gone.md.nuvyn-delete-123': '# old\n' })

    const report = await runRecovery()

    expect((await namesIn()).some((name) => name.startsWith('gone.md.nuvyn-quarantine-reuse-'))).toBe(true)
    expect((await namesIn()).some((name) => name.startsWith('.gone.md.nuvyn-quarantine-manifest-'))).toBe(false)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)

    // Second startup: the permanent quarantine is stable and no
    // invalid-manifest note appears for this basename.
    const second = await runRecovery()
    expect(second.actions.some((a) => a.detail?.includes('invalid legacy delete quarantine manifest'))).toBe(false)
    expect((await namesIn()).some((name) => name.startsWith('gone.md.nuvyn-quarantine-reuse-'))).toBe(true)
  })

  it('replays the generated legacy manifest on a second startup', async () => {
    // The real generation path end to end (not a hand-crafted
    // manifest): the first startup writes the manifest and detaches
    // the identity; the second startup parses it cleanly and replays
    // the detachment.
    await seed({ 'gone.md.nuvyn-delete-123': '# old\n' })
    saveDocumentMetadata(db, { id: 'gone-id', path: 'gone', title: 'Gone', updatedAt: 1 })

    await runRecovery()
    expect((await namesIn()).some((name) => name.startsWith('.gone.md.nuvyn-quarantine-manifest-'))).toBe(true)
    expect(getDocumentMetadata(db, 'gone')).toBeNull()

    const second = await runRecovery()
    expect(second.actions.some((a) => a.detail?.includes('legacy quarantine identity detachment replayed'))).toBe(true)
    expect(second.actions.some((a) => a.detail?.includes('invalid legacy delete quarantine manifest'))).toBe(false)
  })

  it('leaves quarantine in place when the path was re-used', async () => {
    await seed({
      'gone.md': '# new generation\n',
      'gone.md.nuvyn-delete-123': '# old\n',
    })
    saveDocumentMetadata(db, { id: 'fresh-id', path: 'gone', title: 'Fresh', updatedAt: 1 })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'gone.md'), 'utf8')).toBe('# new generation\n')
    expect((await namesIn()).some((name) => name.startsWith('gone.md.nuvyn-quarantine-reuse-'))).toBe(true)
    // Recovery drops the ambiguous old binding before migration gives
    // the public target a fresh identity.
    expect(getDocumentMetadata(db, 'gone')).toBeNull()
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('completes only an explicit in-flight delete when the target is absent', async () => {
    await seed({ 'gone.md.nuvyn-delete-inflight-aaaa': '# old\n' })
    saveDocumentMetadata(db, { id: 'gone-id', path: 'gone', title: 'Gone', updatedAt: 1 })

    const report = await runRecovery()

    expect(await namesIn()).toEqual([])
    expect(getDocumentMetadata(db, 'gone')).toBeNull()
    expect(report.actions.some((a) => a.action === 'completed-delete')).toBe(true)
  })

  it('durably promotes in-flight delete staging when the target was re-used', async () => {
    await seed({
      'gone.md': '# external\n',
      'gone.md.nuvyn-delete-inflight-aaaa': '# old\n',
    })
    saveDocumentMetadata(db, { id: 'old-id', path: 'gone', title: 'Old', updatedAt: 1 })

    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'gone.md'), 'utf8')).toBe('# external\n')
    expect(getDocumentMetadata(db, 'gone')).toBeNull()
    expect((await namesIn()).some((name) => name.startsWith('gone.md.nuvyn-quarantine-reuse-'))).toBe(true)
  })
})

type CrashChildResult = {
  code: number | null
  signal: NodeJS.Signals | null
  readyPoints: string[]
  stderr: string
}

/** Spawn a crash child under the READY handshake: the child runs the
 * real protocol and, at its exact crash seam, prints `READY:<point>`
 * and hangs; the parent force-kills it only AFTER receiving that
 * line. READY receipt is the proof the hook was reached and the disk
 * holds exactly that point's state. A child that exits on its own —
 * hook never fired, missing env, a fixture bug — never prints READY,
 * and waitReady rejects with its exit code and stderr. This replaces
 * the old self-SIGKILL children, whose "any non-zero exit counts as
 * a hard kill" judgment produced false positives on Windows. */
function spawnCrashChild(env: Record<string, string>, fixture: string) {
    const child = spawn(process.execPath, [TSX_CLI, fixture], {
      env: { ...process.env, ...env },
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    activeCrashChildren.add(child)
    const readyPoints: string[] = []
    let stderr = ''
    let stdoutBuffer = ''
    const readyResolvers = new Map<string, Set<() => void>>()
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      let newlineIndex = stdoutBuffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        const match = /^READY:(.+)$/.exec(line)
        if (match) {
          readyPoints.push(match[1])
          for (const resolve of readyResolvers.get(match[1]) ?? []) resolve()
          readyResolvers.delete(match[1])
        }
        newlineIndex = stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const closePromise = waitForChildClose(child).finally(() => {
      activeCrashChildren.delete(child)
    })
    void closePromise.catch(() => {})
    const waitReady = (expectedPoint: string): Promise<void> => {
      if (readyPoints.includes(expectedPoint)) return Promise.resolve()
      return new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const resolvers = readyResolvers.get(expectedPoint)
          resolvers?.delete(onReady)
          if (resolvers?.size === 0) readyResolvers.delete(expectedPoint)
          if (error) reject(error)
          else resolve()
        }
        const onReady = (): void => finish()
        const resolvers = readyResolvers.get(expectedPoint) ?? new Set()
        resolvers.add(onReady)
        readyResolvers.set(expectedPoint, resolvers)
        const timer = setTimeout(() => {
          finish(new Error(
            `crash child did not reach READY:${expectedPoint} within ${READY_TIMEOUT}ms `
            + `(ready: ${readyPoints.join(',') || 'none'}; stderr: ${stderr.slice(0, 500)})`,
          ))
        }, READY_TIMEOUT)
        void closePromise.then((result) => {
          if (!readyPoints.includes(expectedPoint)) {
            finish(new Error(
              `crash child closed (code=${result.code}, signal=${result.signal}) before `
              + `READY:${expectedPoint}; stderr: ${stderr.slice(0, 500)}`,
            ))
          }
        }, (error) => finish(error as Error))
      })
    }
    return {
      /** Wait for the child to reach its crash seam, terminate its
       * complete process tree, and wait for stdio closure. */
      async killAfterReady(expectedPoint: string): Promise<CrashChildResult> {
        try {
          await waitReady(expectedPoint)
          const result = await terminateProcessTree(child, {
            timeoutMs: TERMINATION_TIMEOUT,
          })
          return { ...result, readyPoints: [...readyPoints], stderr }
        } catch (error) {
          await terminateProcessTree(child, { timeoutMs: 10_000 }).catch(() => {})
          throw error
        }
      },
      async dispose(): Promise<void> {
        await terminateProcessTree(child, { timeoutMs: 10_000 }).catch(() => {})
      },
    }
  }

  /** A true hard kill is proven by the handshake, never by a non-zero
   * exit code alone: the child reached its crash seam (READY received),
   * the PARENT initiated SIGKILL, and the child exited — on POSIX that
   * surfaces as signal SIGKILL or code 137 (128 + 9); on Windows
   * kill() maps to TerminateProcess, so READY receipt plus a
   * parent-initiated termination is the evidence there. */
function expectParentKilled(result: CrashChildResult, expectedPoint: string): void {
  expect(result.readyPoints).toContain(expectedPoint)
  if (process.platform === 'win32') {
    expect(result.code !== null || result.signal !== null).toBe(true)
  } else {
    expect(result.signal === 'SIGKILL' || result.code === 137).toBe(true)
  }
}

describe('Round-17 orphan folder gate marker cleanup', () => {
  it('removes only an unreferenced regular marker with a strict name', async () => {
    await fs.mkdir(path.join(vault, 'orphan'))
    const markerName = '.nuvyn-folder-gate-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const markerAbs = path.join(vault, 'orphan', markerName)
    await fs.writeFile(markerAbs, 'orphan secret', 'utf8')
    await fs.writeFile(path.join(vault, 'orphan', '.nuvyn-folder-gate-not-a-uuid'), 'keep', 'utf8')

    const report = await runRecovery()

    await expect(fs.stat(markerAbs)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(
      path.join(vault, 'orphan', '.nuvyn-folder-gate-not-a-uuid'),
      'utf8',
    )).toBe('keep')
    expect(report.actions).toContainEqual(expect.objectContaining({
      action: 'cleaned',
      detail: 'orphan folder gate marker removed',
    }))
  })

  it('retains and reports a non-file marker instead of following it', async () => {
    const markerAbs = path.join(
      vault,
      '.nuvyn-folder-gate-11111111-2222-4333-8444-555555555555',
    )
    await fs.mkdir(markerAbs)

    const report = await runRecovery()

    expect((await fs.lstat(markerAbs)).isDirectory()).toBe(true)
    expect(report.actions).toContainEqual(expect.objectContaining({
      action: 'quarantined',
      detail: 'orphan folder gate marker is not a regular file',
    }))
  })
})

describe('real subprocess crash + startup recovery', () => {
  it('terminates the entire crash child tree before deleting a locked SQLite database', async () => {
    const dbPath = path.join(vault, 'tree-lock.sqlite')
    const child = spawnCrashChild({
      NUVYN_PROCESS_TREE_DB: dbPath,
    }, PROCESS_TREE_LOCK_PARENT)

    const result = await child.killAfterReady('grandchild-lock')
    expectParentKilled(result, 'grandchild-lock')

    await fs.rm(dbPath, {
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
    await expect(fs.stat(dbPath)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }, REAL_CRASH_TEST_TIMEOUT)

  // Exact on-disk state of the reference transaction at each crash
  // point — asserted BEFORE recovery runs, so the recovery tests prove
  // they handle the real crash state, not whatever the child happened
  // to leave behind.
  const REFERENCE_PAYLOADS_BY_POINT: Record<string, string[]> = {
    'preparing': [],
    'payload-0-before': ['before-0'],
    'payload-0-after': ['before-0', 'after-0'],
    'payload-1-before': ['before-0', 'after-0', 'before-1'],
    'payload-1-after': ['before-0', 'after-0', 'before-1', 'after-1'],
    'roll-forward': ['before-0', 'after-0', 'before-1', 'after-1'],
    'roll-back': ['before-0', 'after-0', 'before-1', 'after-1'],
    'cleanup': ['before-0', 'after-0', 'before-1', 'after-1'],
    'cleanup-payload-0': ['after-0', 'before-1', 'after-1'],
  }
  const REFERENCE_PHASE_BY_POINT: Record<string, string> = {
    'preparing': 'preparing',
    'payload-0-before': 'preparing',
    'payload-0-after': 'preparing',
    'payload-1-before': 'preparing',
    'payload-1-after': 'preparing',
    'roll-forward': 'roll-forward',
    'roll-back': 'roll-back',
    'cleanup': 'cleanup',
    'cleanup-payload-0': 'cleanup',
  }

  it.each([
    'preparing',
    'payload-0-before',
    'payload-0-after',
    'payload-1-before',
    'payload-1-after',
    'roll-forward',
    'roll-back',
    'cleanup',
    'cleanup-payload-0',
  ])('replays an exact reference-journal SIGKILL point idempotently: %s', async (point) => {
    await seed({ 'old.md': '# owned\n', 'ref-a.md': '[[old]]\n', 'ref-b.md': '[[old]]\n' })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    const child = spawnCrashChild({
      NUVYN_REFERENCE_VAULT: vault,
      NUVYN_REFERENCE_CRASH_POINT: point,
    }, REFERENCE_JOURNAL_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    // Pre-recovery proof of the exact crash state: journal phase and
    // the precise payload set written at this point — nothing more,
    // nothing less — with the live documents untouched.
    const crashState = await namesIn()
    const journalName = crashState.find((name) => name.includes('.nuvyn-journal-'))
    expect(journalName).toBeDefined()
    const journal = JSON.parse(await fs.readFile(path.join(vault, journalName!), 'utf8')) as { op: string; phase: string }
    expect(journal.op).toBe('document-rename-references')
    expect(journal.phase).toBe(REFERENCE_PHASE_BY_POINT[point])
    const payloadSuffixes = crashState
      .filter((name) => name.includes('.nuvyn-ref-'))
      .map((name) => {
        const match = /\.(?:nuvyn|nuvyn)-ref-(before|after)-[0-9a-f-]+-(\d+)$/.exec(name)
        expect(match).not.toBeNull()
        return `${match![1]}-${match![2]}`
      })
      .sort()
    expect(payloadSuffixes).toEqual([...REFERENCE_PAYLOADS_BY_POINT[point]].sort())
    expect(crashState).toContain('old.md')
    expect(crashState).toContain('ref-a.md')
    expect(crashState).toContain('ref-b.md')
    expect(await fs.readFile(path.join(vault, 'old.md'), 'utf8')).toBe('# owned\n')
    expect(crashState).not.toContain('unexpected-completion')

    await runRecovery()
    const once = await namesIn()
    await runRecovery()
    await runRecovery()

    expect(await namesIn()).toEqual(once)
    expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('[[old]]\n')
    expect(await fs.readFile(path.join(vault, 'ref-b.md'), 'utf8')).toBe('[[old]]\n')
    expect(once).not.toContain('unexpected-completion')
    const journals = once.filter((name) => name.includes('.nuvyn-journal-'))
    const payloads = once.filter((name) => name.includes('.nuvyn-ref-'))
    if (payloads.length) {
      expect(journals).toHaveLength(1)
      const journal = JSON.parse(await fs.readFile(path.join(vault, journals[0]), 'utf8')) as {
        references: Array<{ beforePayload: string; afterPayload: string }>
      }
      const declared = journal.references.flatMap((reference) => [reference.beforePayload, reference.afterPayload])
      expect(payloads.every((payload) => declared.includes(payload))).toBe(true)
    }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('recovers the formal path after a kill -9 inside the commit window', async () => {
    // The reviewer scenario: the child runs the REAL commit protocol
    // and dies (SIGKILL, no handlers) right after the takeover rename.
    const abs = path.join(vault, 'note.md')
    await seed({ 'note.md': '# base\n' })
    saveDocumentMetadata(db, { id: 'pre-crash-id', path: 'note', title: 'Note', updatedAt: 1 })

    const child = spawnCrashChild({
      NUVYN_CRASH_TARGET: abs,
      NUVYN_CRASH_EXPECTED: '# base\n',
      NUVYN_CRASH_REPLACEMENT: '# replacement\n',
      NUVYN_CRASH_POINT: 'takeover',
    }, CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('takeover'), 'takeover')

    // The formal path is missing and only hidden staging files remain
    // — exactly the "note vanished" disk state the recovery fixes.
    const namesBefore = await namesIn()
    expect(namesBefore).not.toContain('note.md')
    expect(namesBefore.some((n) => n.startsWith('.note.md.nuvyn-staged-'))).toBe(true)
    expect(namesBefore.some((n) => n.startsWith('.note.md.nuvyn-save-'))).toBe(true)
    expect(namesBefore.some((n) => n.startsWith('.note.md.nuvyn-journal-'))).toBe(true)

    const report = await runRecovery()

    // Both generations verify against the journal hashes, so the
    // interrupted save completes: the new content lands.
    expect(await fs.readFile(abs, 'utf8')).toBe('# replacement\n')
    expect(report.actions.some((a) => a.action === 'completed-save')).toBe(true)
    expect(report.actions.some((a) => a.action === 'failed')).toBe(false)
    // No documentId lost: metadata was never part of the replace
    // protocol and survives the crash + recovery byte-for-byte.
    expect(getDocumentMetadata(db, 'note')?.id).toBe('pre-crash-id')
    expect(await namesIn()).toEqual(['note.md'])
  }, REAL_CRASH_TEST_TIMEOUT)

  it('recovers when the process dies after the journal write but before takeover', async () => {
    const abs = path.join(vault, 'note.md')
    await seed({ 'note.md': '# base\n' })

    const child = spawnCrashChild({
      NUVYN_CRASH_TARGET: abs,
      NUVYN_CRASH_EXPECTED: '# base\n',
      NUVYN_CRASH_REPLACEMENT: '# replacement\n',
      NUVYN_CRASH_POINT: 'journal',
    }, CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('journal'), 'journal')

    // Pre-recovery proof of the exact crash state: the journal and the
    // save temp exist, the takeover never happened — the target still
    // holds the base generation and no staging name exists.
    const crashState = await namesIn()
    expect(crashState).toContain('note.md')
    expect(await fs.readFile(abs, 'utf8')).toBe('# base\n')
    expect(crashState.some((name) => name.startsWith('.note.md.nuvyn-journal-'))).toBe(true)
    expect(crashState.some((name) => name.startsWith('.note.md.nuvyn-save-'))).toBe(true)
    expect(crashState.some((name) => name.startsWith('.note.md.nuvyn-staged-'))).toBe(false)

    const report = await runRecovery()

    // Takeover never happened: the target is untouched and the stale
    // journal + uncommitted temp are cleaned.
    expect(await fs.readFile(abs, 'utf8')).toBe('# base\n')
    expect(report.actions.some((a) => a.action === 'failed')).toBe(false)
    expect(await namesIn()).toEqual(['note.md'])
  }, REAL_CRASH_TEST_TIMEOUT)

  it('auto-recovers on a real service restart (prod entry, HTTP probe)', async () => {
    // Full "restart the service" evidence: a temp vault holds the
    // crashed-commit state; the real production entry (server/prod.ts)
    // is spawned, runs recovery before listening, and the recovered
    // content is then served over HTTP.
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-restart-'))
    const restartVault = path.join(workdir, 'vault')
    try {
      await fs.mkdir(restartVault, { recursive: true })
      // Hand-craft the crashed state: target missing + staged old
      // generation + save temp + journal with matching hashes.
      const staged = '.crash-note.md.nuvyn-staged-aaaa'
      const save = '.crash-note.md.nuvyn-save-bbbb'
      await fs.writeFile(path.join(restartVault, staged), '# base\n', 'utf8')
      await fs.writeFile(path.join(restartVault, save), '# replacement\n', 'utf8')
      await fs.writeFile(
        path.join(restartVault, '.crash-note.md.nuvyn-journal-cccc'),
        journalFor(staged, save, '# base\n', '# replacement\n'),
        'utf8',
      )

      const server = spawn(process.execPath, [TSX_CLI, path.join(REPO_ROOT, 'server', 'prod.ts')], {
        cwd: workdir,
        env: {
          ...process.env,
          VAULT_DIR: restartVault,
          PORT: '0',
          HOST: '127.0.0.1',
          // The production entry now enforces the application boundary. Keep
          // this restart probe on the real setup/session path rather than
          // weakening the middleware for a crash-recovery test.
          NUVYN_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
          NUVYN_SETUP_TOKEN: 'restart-test-bootstrap-token-0123456789',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
      activeCrashChildren.add(server)
      const serverClosePromise = waitForChildClose(server).finally(() => {
        activeCrashChildren.delete(server)
      })
      void serverClosePromise.catch(() => {})
      try {
        const port = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('server did not start listening')), 20000)
          let buffer = ''
          server.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8')
            const match = /listening on http:\/\/[^:\s]+:(\d+)/.exec(buffer)
            if (match) {
              clearTimeout(timer)
              resolve(Number(match[1]))
            }
          })
          server.on('exit', (code) => {
            clearTimeout(timer)
            reject(new Error(`server exited early (code ${code}):\n${buffer}`))
          })
        })

        const setup = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
          method: 'POST',
          headers: {
            Origin: 'http://127.0.0.1:3000',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            bootstrapToken: 'restart-test-bootstrap-token-0123456789',
            username: 'restart-owner',
            password: 'restart-owner-password-123456789',
          }),
        })
        expect(setup.status).toBe(201)
        const setCookie = setup.headers.get('set-cookie')
        expect(setCookie).toBeTruthy()
        const sessionCookie = setCookie!.split(';', 1)[0]
        const response = await fetch(`http://127.0.0.1:${port}/api/posts/crash-note`, {
          headers: { Cookie: sessionCookie },
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { raw: string }
        expect(body.raw).toBe('# replacement\n')
      } finally {
        await terminateProcessTree(server, {
          timeoutMs: TERMINATION_TIMEOUT,
        })
      }
    } finally {
      await fs.rm(workdir, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 10 : 3,
        retryDelay: 100,
      })
    }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('completes an interrupted rename after a kill -9 inside the link window, without losing the documentId', async () => {
    // The reviewer scenario applied to rename: the child runs the REAL
    // create-only move and dies (SIGKILL) right after the destination
    // link lands, before the staging name is removed. The vault is
    // left with the source MISSING and two names on one inode;
    // recovery must complete the rename and keep the documentId.
    const fromAbs = path.join(vault, 'old.md')
    const toAbs = path.join(vault, 'new.md')
    await seed({ 'old.md': '# doc\n' })
    saveDocumentMetadata(db, { id: 'pre-rename-id', path: 'old', title: 'Doc', updatedAt: 1 })

    const child = spawnCrashChild({ NUVYN_CRASH_FROM: fromAbs, NUVYN_CRASH_TO: toAbs }, RENAME_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('linked'), 'linked')

    // Crash state: source gone, staging + destination both name the
    // same inode.
    const namesBefore = await namesIn()
    expect(namesBefore).not.toContain('old.md')
    expect(namesBefore).toContain('new.md')
    const stagingName = namesBefore.find((n) => n.startsWith('.old.md.nuvyn-rename-'))
    expect(stagingName).toBeDefined()
    const stagingStat = await fs.stat(path.join(vault, stagingName!))
    const destStat = await fs.stat(toAbs)
    expect(stagingStat.ino).toBe(destStat.ino)

    const report = await runRecovery()

    expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
    expect(report.actions.some((a) => a.action === 'failed')).toBe(false)
    expect(await fs.readFile(toAbs, 'utf8')).toBe('# doc\n')
    // The identity followed the bytes — no documentId lost.
    expect(getDocumentMetadata(db, 'new')?.id).toBe('pre-rename-id')
    expect(getDocumentMetadata(db, 'old')).toBeNull()
    expect((await namesIn()).some((n) => n.includes('.nuvyn-rename-'))).toBe(false)
    expect(await namesIn()).toEqual(['new.md'])
  }, REAL_CRASH_TEST_TIMEOUT)

  it('recovers documentId after kill -9 when staging is gone but metadata has not moved', async () => {
    const from = path.join(vault, 'old.md')
    const to = path.join(vault, 'new.md')
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seed({ 'old.md': '# original\n' })

    const child = spawnCrashChild({
      NUVYN_RENAME_FROM: from,
      NUVYN_RENAME_TO: to,
      NUVYN_RENAME_DB: dbPath,
    }, RENAME_METADATA_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('finalized'), 'finalized')

    expect(await fs.stat(from).then(() => true, () => false)).toBe(false)
    expect(await fs.readFile(to, 'utf8')).toBe('# original\n')
    expect((await namesIn()).some((name) => name.includes('.nuvyn-rename-'))).toBe(false)
    expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(true)

    const persistedDb = new Database(dbPath)
    try {
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(getDocumentMetadata(persistedDb, 'old')).toBeNull()
      expect(getDocumentMetadata(persistedDb, 'new')?.id).toBe('post-staging-crash-id')
      expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('restores the source after kill -9 between rename takeover and destination link', async () => {
    const from = path.join(vault, 'old.md')
    const to = path.join(vault, 'new.md')
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seed({ 'old.md': '# original\n' })

    const child = spawnCrashChild({
      NUVYN_RENAME_FROM: from,
      NUVYN_RENAME_TO: to,
      NUVYN_RENAME_DB: dbPath,
      NUVYN_RENAME_CRASH_POINT: 'takeover',
    }, RENAME_METADATA_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('takeover'), 'takeover')
    // Pre-recovery proof of the exact crash state: the source was
    // taken aside (staging + durable journal exist) but the destination
    // link never happened.
    const crashState = await namesIn()
    expect(await fs.stat(from).then(() => true, () => false)).toBe(false)
    expect(await fs.stat(to).then(() => true, () => false)).toBe(false)
    expect(crashState.some((name) => name.startsWith('.old.md.nuvyn-rename-'))).toBe(true)
    expect(crashState.some((name) => name.startsWith('.old.md.nuvyn-journal-'))).toBe(true)

    const persistedDb = new Database(dbPath)
    try {
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(await fs.readFile(from, 'utf8')).toBe('# original\n')
      expect(getDocumentMetadata(persistedDb, 'old')?.id).toBe('post-staging-crash-id')
      expect(getDocumentMetadata(persistedDb, 'new')).toBeNull()
      expect(report.actions.some((a) => a.action === 'restored')).toBe(true)
      expect((await namesIn()).some((name) => name.includes('.nuvyn-rename-') || name.includes('.nuvyn-journal-'))).toBe(false)
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  // Binary attachment bytes: the journal must cover EVERY physical
  // file the mover touches, not just markdown.
  const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff])
  const seedFolderMoveVault = async (): Promise<void> => {
    await seed({ 'proj/a.md': '# a\n', 'proj/nested/b.md': '# b\n' })
    await fs.writeFile(path.join(vault, 'proj', 'image.bin'), IMAGE_BYTES)
    // A nested EMPTY directory: visible vault state the move must
    // preserve (round-8 P1).
    await fs.mkdir(path.join(vault, 'proj', 'empty', 'deeper'), { recursive: true })
  }
  const readFolderMoveJournal = async (): Promise<Record<string, any>> => {
    const journalName = (await namesIn()).find((name) => name.startsWith('.proj.nuvyn-journal-'))
    expect(journalName, 'the route must leave its durable journal behind on crash').toBeDefined()
    return JSON.parse(await fs.readFile(path.join(vault, journalName!), 'utf8'))
  }

  it('cleans the stale journal when the replayable folder move was killed right after its mkdir gate', async () => {
    // The real HTTP route killed at its first seam: the child drove
    // PATCH /api/folders/proj, the route wrote the REAL durable
    // journal (schema v4 — four-state phase machine with destination
    // directory generation proof), created the destination gate, and
    // died before the first file moved. The gate is provably ours
    // (file-free, verified by destDev/destIno) — recovery prunes it
    // and removes the stale journal.
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedFolderMoveVault()

    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: 'gate',
    }, FOLDER_MOVE_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('gate'), 'gate')

    // The REAL journal JSON: v4 phase-machine format with a durable,
    // unpredictable marker proof persisted before gate creation.
    const journal = await readFolderMoveJournal()
    expect(journal.version).toBe(4)
    expect(journal.op).toBe('folder-rename')
    expect(journal.strategy).toBe('replayable-move')
    expect(journal.srcRel).toBe('proj')
    expect(journal.destRel).toBe('ren')
    expect(journal.phase).toBe('gate-created')
    expect(typeof journal.destDev).toBe('string')
    expect(/^\d+$/.test(journal.destDev)).toBe(true)
    expect(typeof journal.destIno).toBe('string')
    expect(/^[1-9]\d*$/.test(journal.destIno)).toBe(true)
    expect(journal.gateProof).toEqual({
      markerName: expect.stringMatching(/^\.nuvyn-folder-gate-[0-9a-f-]{36}$/),
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(journal.entries.map((entry: any) => entry.relativeFilePath).sort()).toEqual(['a.md', 'image.bin', 'nested/b.md'])
    for (const entry of journal.entries) {
      expect(entry.sourceHash).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.sourceDev).toMatch(/^\d+$/)
      expect(entry.sourceIno).toMatch(/^[1-9]\d*$/)
      if (entry.relativeFilePath.endsWith('.md')) {
        expect(typeof entry.documentId).toBe('string')
        expect(entry.documentId.length).toBeGreaterThan(0)
        expect(entry.documentPath).toBe(`proj/${entry.relativeFilePath.slice(0, -'.md'.length)}`)
      } else {
        expect(entry.documentId).toBeUndefined()
        expect(entry.documentPath).toBeUndefined()
      }
    }

    // Pre-recovery proof of the exact crash state: the gate the mover
    // created, its exact marker proof, every file still at the source,
    // and the durable journal.
    const crashState = await namesIn()
    expect(crashState).toContain('proj')
    expect(crashState).toContain('ren')
    const renContents = await fs.readdir(path.join(vault, 'ren'))
    expect(renContents).toEqual([journal.gateProof.markerName])
    expect(await fs.readFile(
      path.join(vault, 'ren', journal.gateProof.markerName),
      'utf8',
    )).toBe(journal.gateProof.secret)
    expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe('# a\n')
    expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe('# b\n')

    const persistedDb = new Database(dbPath)
    try {
      // v4 gate-created recovery: all entries still at source, dest
      // is provably ours by destDev/destIno. Recovery replays the
      // entire move forward (not a stale cleanup).
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
      expect(report.actions.some((a) => a.action === 'quarantined' && a.detail?.includes('unrecognized'))).toBe(false)
      // Tree fully landed at destination.
      expect(await namesIn()).not.toContain('proj')
      expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# a\n')
      expect(await fs.readFile(path.join(vault, 'ren/image.bin'))).toEqual(IMAGE_BYTES)
      expect(getDocumentMetadata(persistedDb, 'ren/a')).not.toBeNull()
      expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(false)
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('does not trust a recreated destination gate even when its directory generation is reused', async () => {
    // Directory generations are vulnerable to inode ABA. Recreate the
    // destination without the journaled marker, then deliberately set
    // the journal generation to the replacement's real generation.
    // Recovery must still reject the foreign directory.
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedFolderMoveVault()
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: 'gate',
    }, FOLDER_MOVE_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('gate'), 'gate')

    // The journal was written with the original dest directory's (dev,ino).
    // Now recreate the destination directory — same path, different inode.
    const journalName = (await namesIn()).find((name) => name.startsWith('.proj.nuvyn-journal-'))!
    const journal = JSON.parse(await fs.readFile(path.join(vault, journalName!), 'utf8'))
    expect(journal.version).toBe(4)
    expect(journal.phase).toBe('gate-created')
    expect(journal.gateProof).toBeDefined()

    // Delete and recreate the destination directory without its marker.
    await fs.rm(path.join(vault, 'ren'), { recursive: true, force: true })
    await fs.mkdir(path.join(vault, 'ren'))
    const replacementStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })
    journal.destDev = replacementStat.dev.toString()
    journal.destIno = replacementStat.ino.toString()
    await fs.writeFile(
      path.join(vault, journalName),
      JSON.stringify(journal),
      'utf8',
    )

    const persistedDb = new Database(dbPath)
    try {
      const sourceMetadataId = getDocumentMetadata(persistedDb, 'proj/a')?.id
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions).toContainEqual(expect.objectContaining({
        action: 'quarantined',
        detail: 'replayable destination gate proof is missing or mismatched',
      }))
      // The recreated empty dir stays on disk (external property).
      expect(await fs.stat(path.join(vault, 'ren')).then(() => true, () => false)).toBe(true)
      expect(await fs.readdir(path.join(vault, 'ren'))).toEqual([])
      expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe('# a\n')
      expect(await fs.readFile(path.join(vault, 'proj/image.bin'))).toEqual(IMAGE_BYTES)
      expect(getDocumentMetadata(persistedDb, 'proj/a')?.id).toBe(sourceMetadataId)
      expect(getDocumentMetadata(persistedDb, 'ren/a')).toBeNull()
      // Journal retained for inspection.
      expect((await namesIn()).some((name) => name.startsWith('.proj.nuvyn-journal-'))).toBe(true)
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('replays the route journal of a folder move killed between per-file entries, attachment included', async () => {
    // The defining replayable crash through the REAL route: a.md
    // already landed at the destination, image.bin and nested/b.md
    // still at the source — the tree is SPLIT and only the journaled
    // entry hashes can decide it. Recovery parses the route's own
    // v4 journal and completes the move FORWARD.
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedFolderMoveVault()

    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: 'entry:a.md',
    }, FOLDER_MOVE_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('entry:a.md'), 'entry:a.md')

    // Pre-recovery proof of the exact split state + the real v4 journal.
    const journal = await readFolderMoveJournal()
    expect(journal.version).toBe(4)
    expect(journal.phase).toBe('gate-created')
    expect(journal.strategy).toBe('replayable-move')
    expect(journal.entries.map((entry: any) => entry.relativeFilePath).sort()).toEqual(['a.md', 'image.bin', 'nested/b.md'])
    expect([...(journal.directories as string[])].sort()).toEqual(['empty', 'empty/deeper', 'nested'])
    expect(typeof journal.destDev).toBe('string')
    expect(typeof journal.destIno).toBe('string')
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# a\n')
    expect(await fs.stat(path.join(vault, 'proj/a.md')).then(() => true, () => false)).toBe(false)
    expect(await fs.readFile(path.join(vault, 'proj/image.bin'))).toEqual(IMAGE_BYTES)
    expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe('# b\n')
    expect((await namesIn()).some((name) => name.includes('.nuvyn-rename-'))).toBe(false)

    const persistedDb = new Database(dbPath)
    try {
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
      expect(report.actions.some((a) => a.action === 'failed')).toBe(false)
      expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# a\n')
      expect(await fs.readFile(path.join(vault, 'ren/image.bin'))).toEqual(IMAGE_BYTES)
      expect(await fs.readFile(path.join(vault, 'ren/nested/b.md'), 'utf8')).toBe('# b\n')
      expect((await fs.stat(path.join(vault, 'ren/empty/deeper'))).isDirectory()).toBe(true)
      expect(await fs.readdir(path.join(vault, 'ren/empty/deeper'))).toEqual([])
      expect(await namesIn()).not.toContain('proj')
      const aId = getDocumentMetadata(persistedDb, 'ren/a')?.id
      const bId = getDocumentMetadata(persistedDb, 'ren/nested/b')?.id
      expect(aId).toBeTruthy()
      expect(bId).toBeTruthy()
      expect(getDocumentMetadata(persistedDb, 'proj/a')).toBeNull()
      expect(getDocumentMetadata(persistedDb, 'ren/image')).toBeNull()
      expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(false)
      // Idempotent across repeated startups.
      await recoverInterruptedOperations(vault, persistedDb)
      expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# a\n')
      expect(getDocumentMetadata(persistedDb, 'ren/a')?.id).toBe(aId)
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('recovers a hard kill after shared final parity but before metadata', async () => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedFolderMoveVault()
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: 'parity',
    }, FOLDER_MOVE_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('parity'), 'parity')

    const journal = await readFolderMoveJournal()
    // round-11 v4: the route persists v4 phase-machine journals. The
    // fixture kills the child at the parity seam (afterFilesLanded),
    // so the on-disk journal carries phase=gate-created (or, if a
    // later test runs after a successful forward, phase=metadata-committed
    // — but this test is mid-forward, so gate-created).
    expect(journal.version).toBe(4)
    expect(['prepared', 'gate-created', 'files-landed', 'metadata-committed']).toContain(journal.phase)
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# a\n')
    expect(await fs.readFile(path.join(vault, 'ren/image.bin'))).toEqual(IMAGE_BYTES)
    expect(await fs.readFile(path.join(vault, 'ren/nested/b.md'), 'utf8')).toBe('# b\n')
    // The replayable protocol retains the source directory shell until
    // files-landed is durable and metadata finalization owns cleanup.
    expect(await namesIn()).toContain('proj')
    expect(await fs.readdir(path.join(vault, 'proj'))).toEqual(['empty', 'nested'])
    expect(await fs.readdir(path.join(vault, 'proj/empty'))).toEqual(['deeper'])
    expect(await fs.readdir(path.join(vault, 'proj/empty/deeper'))).toEqual([])
    expect(await fs.readdir(path.join(vault, 'proj/nested'))).toEqual([])
    // Replayable markers remain until the shared final verifier removes
    // the journal and then the marker.
    const marker = (await fs.readdir(path.join(vault, 'ren'))).find((name) => name.startsWith('.nuvyn-folder-gate-'))
    expect(marker).toBe(journal.gateProof.markerName)
    expect(await fs.readFile(path.join(vault, 'ren', marker!), 'utf8'))
      .toBe(journal.gateProof.secret)

    const persistedDb = new Database(dbPath)
    try {
      // The READY seam is immediately before metadata: identities still
      // carry the source prefix even though exact physical parity passed.
      expect(getDocumentMetadata(persistedDb, 'proj/a')).not.toBeNull()
      expect(getDocumentMetadata(persistedDb, 'ren/a')).toBeNull()
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((action) => action.action === 'completed-rename')).toBe(true)
      expect(getDocumentMetadata(persistedDb, 'ren/a')).not.toBeNull()
      expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(false)
      expect((await fs.readdir(path.join(vault, 'ren'))).some((name) => name.startsWith('.nuvyn-folder-gate-'))).toBe(false)
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('quarantines identical replacement bytes that do not preserve the landed hard-link identity', async () => {
    // v4: generation proof is (dev, ino, hash) — a byte-identical
    // external replacement gets a fresh inode and is detected.
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedFolderMoveVault()
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: 'entry:a.md',
    }, FOLDER_MOVE_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('entry:a.md'), 'entry:a.md')

    // Pre-create a distinct inode before unlinking the owned landing, then
    // publish it at the same pathname with byte-identical content.
    const replacement = path.join(vault, 'same-bytes-replacement')
    await fs.writeFile(replacement, '# a\n', 'utf8')
    const originalIdentity = await fs.stat(path.join(vault, 'ren/a.md'), { bigint: true })
    const replacementIdentity = await fs.stat(replacement, { bigint: true })
    expect(`${replacementIdentity.dev}:${replacementIdentity.ino}`).not.toBe(`${originalIdentity.dev}:${originalIdentity.ino}`)
    await fs.rm(path.join(vault, 'ren/a.md'))
    await fs.rename(replacement, path.join(vault, 'ren/a.md'))

    const persistedDb = new Database(dbPath)
    try {
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((action) => action.action === 'quarantined' && /identity|generation/.test(action.detail ?? ''))).toBe(true)
      expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# a\n')
      expect(await fs.readFile(path.join(vault, 'proj/image.bin'))).toEqual(IMAGE_BYTES)
      expect((await namesIn()).some((name) => name.startsWith('.proj.nuvyn-journal-'))).toBe(true)
      expect(getDocumentMetadata(persistedDb, 'ren/a')).toBeNull()
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('runs shared exact parity again after recovery replay and before metadata', async () => {
    // v4: recovery re-verifies exact parity (destDev/destIno + per-entry
    // generation) before committing metadata. An external file planted
    // mid-recovery is caught by the parity check.
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedFolderMoveVault()
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: 'entry:a.md',
    }, FOLDER_MOVE_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('entry:a.md'), 'entry:a.md')
    __setCreateOnlyMoveHooksForTesting({
      afterReplayableMovedEntry: async (entryRel) => {
        if (entryRel === 'nested/b.md') {
          await fs.writeFile(path.join(vault, 'ren', 'external-after-replay.md'), '# external\n', 'utf8')
        }
      },
    })

    const persistedDb = new Database(dbPath)
    try {
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((action) => action.action === 'quarantined' && action.detail?.includes('parity'))).toBe(true)
      expect(await fs.readFile(path.join(vault, 'ren/external-after-replay.md'), 'utf8')).toBe('# external\n')
      expect((await namesIn()).some((name) => name.startsWith('.proj.nuvyn-journal-'))).toBe(true)
      expect(getDocumentMetadata(persistedDb, 'ren/a')).toBeNull()
      expect(getDocumentMetadata(persistedDb, 'proj/a')).not.toBeNull()
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)
})

describe('real subprocess crash + startup recovery (folder reverse moves)', () => {
  // Round-7 P1: every replayable REVERSE move (rename rollback,
  // reference rollback run by recovery itself, delete rollback) runs
  // under a durable journal — these children kill the real route / the
  // real recovery mid-rollback and prove the next startup finishes it.
  const A_RAW = '# a\n'
  const B_RAW = '# b\n'
  const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10])

  async function seedOwnerBindingCrashState(dbPath: string): Promise<void> {
    await seed({
      'proj/a.md': A_RAW,
      'ref-a.md': 'see [[proj/a]]\n',
    })
    const setupDb = new Database(dbPath)
    applyMigrations(setupDb)
    saveDocumentMetadata(setupDb, {
      id: 'round17-owner-a',
      path: 'proj/a',
      title: 'A',
      updatedAt: 1,
    })
    saveDocumentMetadata(setupDb, {
      id: 'round17-owner-ref',
      path: 'ref-a',
      title: 'Reference',
      updatedAt: 2,
    })
    setupDb.close()
  }

  it('F1 aborts owner-pending durably after a real crash before the owner journal is durable', async () => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedOwnerBindingCrashState(dbPath)
    const point = 'bind-owner-pending'
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: point,
    }, FOLDER_ROLLBACK_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    const journalNames = (await namesIn())
      .filter(name => name.includes('.nuvyn-journal-'))
    expect(journalNames).toHaveLength(1)
    const companionPath = path.join(vault, journalNames[0])
    const companionBefore = await fs.readFile(companionPath, 'utf8')
    expect(JSON.parse(companionBefore).metadataDisposition).toMatchObject({
      kind: 'folder-snapshot-owner-pending',
      previousDirection: 'roll-back',
    })
    expect(journalNames.some(name =>
      JSON.parse(companionBefore).metadataDisposition.ownerJournal
        === name)).toBe(false)
    const referenceBefore = await fs.readFile(
      path.join(vault, 'ref-a.md'),
      'utf8',
    )
    const payloadsBefore = new Map<string, Buffer>()
    for (const name of (await namesIn()).filter(item =>
      item.includes('.nuvyn-ref-before-')
      || item.includes('.nuvyn-ref-after-')
      || item.includes('.nuvyn-ref-before-')
      || item.includes('.nuvyn-ref-after-'))) {
      payloadsBefore.set(name, await fs.readFile(path.join(vault, name)))
    }
    const dbBefore = new Database(dbPath)
    const graphBefore = snapshotDocumentMetadataDatabase(dbBefore)
    dbBefore.close()

    const recoveredDb = new Database(dbPath)
    try {
      const first = await recoverInterruptedOperations(vault, recoveredDb)
      const second = await recoverInterruptedOperations(vault, recoveredDb)
      expect(first.actions).toContainEqual(expect.objectContaining({
        file: journalNames[0],
        action: 'quarantined',
        detail: expect.stringContaining('owner-binding aborted'),
      }))
      expect(second.actions).toEqual(first.actions)
      const companionAfterFirst = await fs.readFile(companionPath, 'utf8')
      expect(companionAfterFirst).not.toBe(companionBefore)
      expect(JSON.parse(companionAfterFirst)).toMatchObject({
        phase: 'roll-back',
        metadataDisposition: {
          kind: 'folder-snapshot-owner-aborted',
          previousDirection: 'roll-back',
          reason: 'owner-journal-absent',
        },
      })
      expect(await fs.readFile(companionPath, 'utf8'))
        .toBe(companionAfterFirst)
      expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8'))
        .toBe(referenceBefore)
      for (const [name, bytes] of payloadsBefore) {
        expect(await fs.readFile(path.join(vault, name))).toEqual(bytes)
      }
      expect(snapshotDocumentMetadataDatabase(recoveredDb)).toEqual(graphBefore)
      expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8'))
        .toBe(A_RAW)
      await expect(fs.stat(path.join(vault, 'proj')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      recoveredDb.close()
    }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('F2 promotes an exact pending binding and completes owner handoff in the same startup', async () => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedOwnerBindingCrashState(dbPath)
    const point = 'v4-owner-durable'
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: point,
    }, FOLDER_ROLLBACK_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    const durableArtifacts = await Promise.all(
      (await namesIn())
        .filter(name => name.includes('.nuvyn-journal-'))
        .map(async name => ({
          name,
          entry: JSON.parse(await fs.readFile(path.join(vault, name), 'utf8')),
        })),
    )
    const companion = durableArtifacts.find(({ entry }) =>
      entry.op === 'folder-rename-references')
    const owner = durableArtifacts.find(({ entry }) => entry.version === 4)
    expect(
      parseFolderMoveJournalV4Object(owner?.entry),
      JSON.stringify(owner?.entry),
    ).not.toBeNull()
    expect(companion?.entry.metadataDisposition).toMatchObject({
      kind: 'folder-snapshot-owner-pending',
      ownerJournal: owner?.name,
    })
    expect(owner?.entry.metadataDisposition.referenceJournal).toMatchObject({
      relativePath: companion?.name,
      transactionId: companion?.name
        .split(/\.(?:nuvyn|nuvyn)-journal-/).at(-1),
      journalHash: companion?.entry.metadataDisposition.ownerDescriptorHash,
      srcRel: 'proj',
      destRel: 'ren',
    })

    const recoveredDb = new Database(dbPath)
    try {
      const first = await recoverInterruptedOperations(vault, recoveredDb)
      expect(first.actions.map(action => action.action))
        .toContain('completed-rename')
      expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8'))
        .toBe(A_RAW)
      expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8'))
        .toBe('see [[proj/a]]\n')
      expect(getDocumentMetadata(recoveredDb, 'proj/a')?.id)
        .toBe('round17-owner-a')
      expect(getDocumentMetadata(recoveredDb, 'ren/a')).toBeNull()
      expect((await namesIn()).some(name =>
        name.includes('.nuvyn-journal-')
        || name.includes('.nuvyn-ref-before-')
        || name.includes('.nuvyn-ref-after-')
        || name.includes('.nuvyn-journal-')
        || name.includes('.nuvyn-ref-before-')
        || name.includes('.nuvyn-ref-after-'))).toBe(false)
      expect((await recoverInterruptedOperations(vault, recoveredDb)).actions)
        .toEqual([])
    } finally {
      recoveredDb.close()
    }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('F3 quarantines a pending owner mismatch without filesystem or SQLite mutation', async () => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seedOwnerBindingCrashState(dbPath)
    const point = 'v4-owner-durable'
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: point,
    }, FOLDER_ROLLBACK_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    const artifactNames = (await namesIn())
      .filter(name => name.includes('.nuvyn-journal-'))
    const ownerArtifacts = await Promise.all(artifactNames.map(async name => ({
      name,
      entry: JSON.parse(await fs.readFile(path.join(vault, name), 'utf8')),
    })))
    const owner = ownerArtifacts.find(({ entry }) => entry.version === 4)
    expect(owner).toBeDefined()
    owner!.entry.metadataDisposition.referenceJournal.journalHash =
      '0'.repeat(64)
    await rewriteDurableJournal(
      path.join(vault, owner!.name),
      owner!.entry,
    )
    const beforeFiles = new Map<string, Buffer>()
    for (const name of await namesIn()) {
      const absolute = path.join(vault, name)
      const stat = await fs.lstat(absolute)
      if (stat.isFile() && name !== 'metadata.sqlite'
        && !name.startsWith('metadata.sqlite-')) {
        beforeFiles.set(name, await fs.readFile(absolute))
      }
    }
    const recoveredDb = new Database(dbPath)
    try {
      const graphBefore = snapshotDocumentMetadataDatabase(recoveredDb)
      const first = await recoverInterruptedOperations(vault, recoveredDb)
      const second = await recoverInterruptedOperations(vault, recoveredDb)
      expect(first.actions
        .filter(action => action.action === 'quarantined')
        .map(action => action.detail))
        .toContainEqual(expect.stringContaining(
          'owner-binding companion proof mismatch',
        ))
      expect(second.actions).toEqual(first.actions)
      expect(snapshotDocumentMetadataDatabase(recoveredDb)).toEqual(graphBefore)
      for (const [name, bytes] of beforeFiles) {
        expect(await fs.readFile(path.join(vault, name))).toEqual(bytes)
      }
      expect((await namesIn()).filter(name =>
        name.includes('.nuvyn-journal-'))).toEqual(
        expect.arrayContaining(artifactNames),
      )
    } finally {
      recoveredDb.close()
    }
  }, REAL_CRASH_TEST_TIMEOUT)

  it.each([
    ['reverse-prepared'],
    ['rollback-entry:a.md'],
    ['rollback-entry:image.bin'],
    ['rollback-after-tree'],
    ['reverse-metadata'],
  ])('completes a rename rollback killed at %s from the flipped journal', async (point) => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seed({ 'proj/a.md': A_RAW, 'proj/nested/b.md': B_RAW, 'ref-a.md': 'see [[proj/a]]\n' })
    await fs.writeFile(path.join(vault, 'proj', 'image.bin'), IMAGE_BYTES)
    const setupDb = new Database(dbPath)
    applyMigrations(setupDb)
    saveDocumentMetadata(setupDb, {
      id: 'round17-proj-a',
      path: 'proj/a',
      title: 'A',
      tags: ['round17'],
      updatedAt: 1,
    })
    saveDocumentMetadata(setupDb, {
      id: 'round17-proj-b',
      path: 'proj/nested/b',
      title: 'B',
      updatedAt: 2,
    })
    saveDocumentMetadata(setupDb, {
      id: 'round17-ref',
      path: 'ref-a',
      title: 'Reference',
      summary: 'original reference metadata',
      updatedAt: 3,
    })
    saveDocumentMetadata(setupDb, {
      id: 'round17-destination-orphan',
      path: 'ren/orphan',
      title: 'Destination orphan',
      updatedAt: 4,
    })
    setupDb.prepare(`
      INSERT INTO document_embeddings (
        document_id,
        content_hash,
        model,
        embedding,
        indexed_at
      ) VALUES ('round17-proj-a', 'round17-hash', 'test', ?, 5)
    `).run(Buffer.from([1, 2, 3]))
    setupDb.prepare(`
      INSERT INTO metadata_migrations (
        path,
        document_id,
        original_path,
        status,
        source_hash,
        error,
        updated_at
      ) VALUES (
        'proj/missing',
        NULL,
        'proj/missing',
        'legacy',
        'round17-migration',
        '',
        6
      )
    `).run()
    setupDb.close()

    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: point,
    }, FOLDER_ROLLBACK_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    // Pre-recovery proof: the journal was DURABLY FLIPPED to describe
    // the rollback (srcRel 'ren' → destRel 'proj') before the first
    // reverse file moved. v4 format with phase machine.
    const journalNames = (await namesIn()).filter((name) => name.startsWith('.proj.nuvyn-journal-'))
    const journals = await Promise.all(journalNames.map(async (name) => JSON.parse(await fs.readFile(path.join(vault, name), 'utf8'))))
    const journal = journals.find((entry) => entry.op === 'folder-rename')
    expect(journal, 'the route must leave its durable folder-move journal behind on crash').toBeDefined()
    expect(journal.version).toBe(4)
    expect(journal.srcRel).toBe('ren')
    expect(journal.destRel).toBe('proj')
    expect(journal.strategy).toBe('replayable-move')
    expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('# externally changed\n')
    const atProj = (rel: string) => fs.stat(path.join(vault, 'proj', rel)).then(() => true, () => false)
    const atRen = (rel: string) => fs.stat(path.join(vault, 'ren', rel)).then(() => true, () => false)
    if (point === 'reverse-prepared') {
      expect(journal.phase).toBe('prepared')
      const reverseSource = await fs.lstat(path.join(vault, 'ren'), {
        bigint: true,
      })
      expect(`${journal.sourceDev}:${journal.sourceIno}`).toBe(
        `${reverseSource.dev}:${reverseSource.ino}`,
      )
      expect(await atRen('a.md')).toBe(true)
      expect(await atRen('image.bin')).toBe(true)
      expect(await atRen('nested/b.md')).toBe(true)
      expect(await namesIn()).not.toContain('proj')
    } else if (point === 'rollback-entry:a.md') {
      expect(await atProj('a.md')).toBe(true)
      expect(await atRen('image.bin')).toBe(true)
      expect(await atRen('nested/b.md')).toBe(true)
    } else if (point === 'rollback-entry:image.bin') {
      expect(await atProj('a.md')).toBe(true)
      expect(await atProj('image.bin')).toBe(true)
      expect(await atRen('nested/b.md')).toBe(true)
    } else {
      expect(await atProj('a.md')).toBe(true)
      expect(await atProj('image.bin')).toBe(true)
      expect(await atProj('nested/b.md')).toBe(true)
      // Source shells stay generation-bound until metadata finalization.
      expect(await namesIn()).toContain('ren')
    }

    const persistedDb = new Database(dbPath)
    try {
      // At reverse-metadata the CAS is committed while the durable phase
      // is still files-landed. Every earlier seam still has the forward
      // graph at ren/.
      const metadataPrefix = point === 'reverse-metadata' ? 'proj' : 'ren'
      const aId = getDocumentMetadata(
        persistedDb,
        `${metadataPrefix}/a`,
      )?.id
      const bId = getDocumentMetadata(
        persistedDb,
        `${metadataPrefix}/nested/b`,
      )?.id
      expect(aId).toBeTruthy()
      expect(bId).toBeTruthy()

      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
      // The whole tree is back at the source, attachment included.
      expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe(A_RAW)
      expect(await fs.readFile(path.join(vault, 'proj/image.bin'))).toEqual(IMAGE_BYTES)
      expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe(B_RAW)
      // Identity followed the bytes back.
      expect(getDocumentMetadata(persistedDb, 'proj/a')?.id).toBe(aId)
      expect(getDocumentMetadata(persistedDb, 'proj/nested/b')?.id).toBe(bId)
      expect(getDocumentMetadata(persistedDb, 'ren/a')).toBeNull()
      expect(getDocumentMetadata(persistedDb, 'ref-a')).toMatchObject({
        id: 'round17-ref',
        summary: 'original reference metadata',
      })
      expect(getDocumentMetadata(persistedDb, 'ren/orphan')?.id)
        .toBe('round17-destination-orphan')
      expect(persistedDb.prepare(`
        SELECT path, original_path, document_id
        FROM metadata_migrations
        WHERE path = 'proj/missing'
      `).get()).toEqual({
        path: 'proj/missing',
        original_path: 'proj/missing',
        document_id: null,
      })
      expect(persistedDb.prepare(`
        SELECT content_hash, embedding
        FROM document_embeddings
        WHERE document_id = 'round17-proj-a'
      `).get()).toEqual({
        content_hash: 'round17-hash',
        embedding: Buffer.from([1, 2, 3]),
      })
      expect(getDocumentMetadata(persistedDb, 'proj/a')?.tags)
        .toEqual(['round17'])
      // The flipped main journal is gone; the reference journal stays
      // quarantined — ref-a.md changed externally and wins.
      const remaining = (await namesIn()).filter((name) => name.includes('.nuvyn-journal-'))
      expect(remaining).toHaveLength(1)
      expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('# externally changed\n')
      // Idempotent.
      const recoveredGraph = snapshotDocumentMetadataDatabase(persistedDb)
      await recoverInterruptedOperations(vault, persistedDb)
      expect(getDocumentMetadata(persistedDb, 'proj/a')?.id).toBe(aId)
      expect(snapshotDocumentMetadataDatabase(persistedDb))
        .toEqual(recoveredGraph)
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('finishes reference-only cleanup after a hard kill at the durable folder handoff', async () => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seed({
      'proj/a.md': A_RAW,
      'ref-a.md': 'see [[proj/a]]\n',
    })
    const setupDb = new Database(dbPath)
    applyMigrations(setupDb)
    saveDocumentMetadata(setupDb, {
      id: 'round17-handoff-a',
      path: 'proj/a',
      title: 'A',
      updatedAt: 1,
    })
    saveDocumentMetadata(setupDb, {
      id: 'round17-handoff-ref',
      path: 'ref-a',
      title: 'Reference',
      updatedAt: 2,
    })
    saveDocumentMetadata(setupDb, {
      id: 'round17-handoff-orphan',
      path: 'ren/orphan',
      title: 'Destination orphan',
      updatedAt: 3,
    })
    setupDb.close()

    const point = 'reverse-handoff'
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: point,
    }, FOLDER_ROLLBACK_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    const durableArtifacts = await Promise.all(
      (await namesIn())
        .filter(name => name.includes('.nuvyn-journal-'))
        .map(async name => ({
          name,
          entry: JSON.parse(await fs.readFile(path.join(vault, name), 'utf8')),
        })),
    )
    expect(durableArtifacts.some(({ entry }) => entry.version === 4)).toBe(false)
    const reference = durableArtifacts.find(({ entry }) =>
      entry.op === 'folder-rename-references')
    expect(reference?.entry.metadataDisposition).toMatchObject({
      kind: 'folder-snapshot-owned',
      metadataHandled: true,
    })
    const payloadNames = reference!.entry.references.flatMap(
      (operation: { beforePayload: string; afterPayload: string }) => [
        operation.beforePayload,
        operation.afterPayload,
      ],
    )
    for (const payload of payloadNames) {
      expect(await fs.stat(path.join(vault, payload))).toBeDefined()
    }
    expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8'))
      .toBe('see [[proj/a]]\n')

    const persistedDb = new Database(dbPath)
    try {
      expect(getDocumentMetadata(persistedDb, 'proj/a')?.id)
        .toBe('round17-handoff-a')
      expect(getDocumentMetadata(persistedDb, 'ren/orphan')?.id)
        .toBe('round17-handoff-orphan')

      const first = await recoverInterruptedOperations(vault, persistedDb)
      expect(first.actions).toContainEqual(expect.objectContaining({
        action: 'completed-rename',
        detail: 'rename reference transaction rolled back',
      }))
      expect(getDocumentMetadata(persistedDb, 'ren/orphan')?.id)
        .toBe('round17-handoff-orphan')
      expect(getDocumentMetadata(persistedDb, 'proj/orphan')).toBeNull()
      expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8'))
        .toBe('see [[proj/a]]\n')
      expect((await namesIn()).some(name =>
        (name.includes('.nuvyn-journal-')
          || name.includes('.nuvyn-ref-')
          || name.includes('.nuvyn-journal-')
          || name.includes('.nuvyn-ref-')))).toBe(false)

      const second = await recoverInterruptedOperations(vault, persistedDb)
      expect(second.actions).toEqual([])
    } finally {
      persistedDb.close()
    }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('fails closed on path-discovered relation drift after a real route crash before reverse CAS', async () => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    const taggedMarkdown = [
      '---',
      'title: Created during rename',
      'tags:',
      '  - rollback-created',
      '---',
      '# a',
      '',
    ].join('\n')
    await seed({
      'proj/a.md': taggedMarkdown,
      'proj/nested/b.md': B_RAW,
      'ref-a.md': 'see [[proj/a]]\n',
    })
    await fs.writeFile(path.join(vault, 'proj', 'image.bin'), IMAGE_BYTES)
    const setupDb = new Database(dbPath)
    applyMigrations(setupDb)
    setupDb.close()

    const point = 'reverse-before-metadata'
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: point,
    }, FOLDER_ROLLBACK_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    const journalCandidates = await Promise.all(
      (await namesIn())
        .filter(name => name.startsWith('.proj.nuvyn-journal-'))
        .map(async (name) => ({
          name,
          journal: JSON.parse(
            await fs.readFile(path.join(vault, name), 'utf8'),
          ),
        })),
    )
    const persistedMove = journalCandidates.find(({ journal }) =>
      journal.version === 4 && journal.op === 'folder-rename')
    expect(persistedMove).toBeDefined()
    const journalName = persistedMove!.name
    const journalAbs = path.join(vault, journalName)
    const journal = persistedMove!.journal
    expect(journal).toMatchObject({
      srcRel: 'ren',
      destRel: 'proj',
      phase: 'files-landed',
      metadataDisposition: {
        kind: 'snapshot-restore',
        ownershipFootprint: expect.any(Object),
        metadataOnlyDocumentProofs: expect.any(Array),
        createdMetadataIds: expect.any(Object),
      },
    })

    const persistedDb = new Database(dbPath)
    try {
      const created = getDocumentMetadata(persistedDb, 'ren/a')
      expect(created?.id).toBeTruthy()
      persistedDb.prepare(`
        INSERT INTO document_embeddings (
          document_id, content_hash, model, embedding, indexed_at
        ) VALUES (?, 'external-after-crash', 'test', ?, 100)
      `).run(created!.id, Buffer.from([9, 8, 7]))

      const first = await recoverInterruptedOperations(vault, persistedDb)
      expect(first.actions.filter(action =>
        action.file === journalName)).toEqual([{
        file: journalName,
        action: 'quarantined',
        detail: 'snapshot metadata CAS failed: live metadata graph matches neither expected-current nor restore snapshot',
      }])
      expect(persistedDb.prepare(`
        SELECT content_hash, embedding
        FROM document_embeddings
        WHERE document_id = ?
      `).get(created!.id)).toEqual({
        content_hash: 'external-after-crash',
        embedding: Buffer.from([9, 8, 7]),
      })
      expect(await fs.stat(journalAbs)).toBeDefined()

      const second = await recoverInterruptedOperations(vault, persistedDb)
      expect(second.actions.filter(action =>
        action.file === journalName)).toEqual([{
        file: journalName,
        action: 'quarantined',
        detail: 'snapshot metadata CAS failed: live metadata graph matches neither expected-current nor restore snapshot',
      }])
      expect(persistedDb.prepare(`
        SELECT content_hash
        FROM document_embeddings
        WHERE document_id = ?
      `).get(created!.id)).toEqual({
        content_hash: 'external-after-crash',
      })
    } finally {
      persistedDb.close()
    }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('completes a delete rollback killed mid restore from its snapshot journal', async () => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seed({ 'gone/a.md': A_RAW })
    await fs.writeFile(path.join(vault, 'gone', 'image.bin'), IMAGE_BYTES)
    const setupDb = new Database(dbPath)
    applyMigrations(setupDb)
    saveDocumentMetadata(setupDb, { id: 'gone-a-id', path: 'gone/a', title: 'A', updatedAt: 1 })
    setupDb.close()

    const point = 'entry:a.md'
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: point,
    }, FOLDER_DELETE_ROLLBACK_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    // Pre-recovery proof: a.md back at the public path, image.bin
    // still staged, metadata detached, and the rollback journal with
    // the persisted snapshot beside the staging directory.
    const stagedName = (await namesIn()).find((name) => name.startsWith('gone.nuvyn-delete-inflight-'))
    expect(stagedName).toBeDefined()
    expect(await fs.readFile(path.join(vault, 'gone', 'a.md'), 'utf8')).toBe(A_RAW)
    expect(await fs.readFile(path.join(vault, stagedName!, 'image.bin'))).toEqual(IMAGE_BYTES)
    const journalName = (await namesIn()).find((name) => name.startsWith(`.${stagedName}.nuvyn-journal-`))
    expect(journalName).toBeDefined()
    const journal = JSON.parse(await fs.readFile(path.join(vault, journalName!), 'utf8'))
    expect(journal.op).toBe('folder-move')
    expect(journal.srcRel).toBe(stagedName)
    expect(journal.destRel).toBe('gone')
    expect(journal.metadataDisposition.kind).toBe('snapshot-restore')
    expect(journal.metadataDisposition.snapshot.documents[0].id).toBe('gone-a-id')

    const persistedDb = new Database(dbPath)
    try {
      expect(getDocumentMetadata(persistedDb, 'gone/a')).toBeNull()
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
      expect(await fs.readFile(path.join(vault, 'gone/image.bin'))).toEqual(IMAGE_BYTES)
      // The full metadata graph re-installed from the journal — same id.
      expect(getDocumentMetadata(persistedDb, 'gone/a')?.id).toBe('gone-a-id')
      expect(await namesIn()).not.toContain(stagedName)
      expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(false)
      expect((await namesIn()).some((name) => name.includes('.nuvyn-quarantine-'))).toBe(false)
      await recoverInterruptedOperations(vault, persistedDb)
      expect(getDocumentMetadata(persistedDb, 'gone/a')?.id).toBe('gone-a-id')
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('preserves a fresh live DB owner instead of restoring a stale delete snapshot over it', async () => {
    const dbPath = path.join(vault, 'metadata.sqlite')
    await seed({ 'gone/a.md': A_RAW })
    await fs.writeFile(path.join(vault, 'gone', 'image.bin'), IMAGE_BYTES)
    const setupDb = new Database(dbPath)
    applyMigrations(setupDb)
    saveDocumentMetadata(setupDb, { id: 'gone-old-id', path: 'gone/a', title: 'Old', updatedAt: 1 })
    setupDb.close()

    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: 'entry:a.md',
    }, FOLDER_DELETE_ROLLBACK_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady('entry:a.md'), 'entry:a.md')

    const persistedDb = new Database(dbPath)
    try {
      saveDocumentMetadata(persistedDb, { id: 'fresh-owner-id', path: 'gone/a', title: 'Fresh', updatedAt: 2 })
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((action) => action.action === 'quarantined' && action.detail?.includes('metadata ownership'))).toBe(true)
      expect(getDocumentMetadata(persistedDb, 'gone/a')?.id).toBe('fresh-owner-id')
      expect(getDocumentMetadata(persistedDb, 'gone/a')?.title).toBe('Fresh')
      expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(true)
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)

  it('completes recovery when recovery ITSELF is killed mid folder rollback replay', async () => {
    // The reference journal's roll-back branch writes its OWN
    // folder-move journal before reversing the tree; killing recovery
    // at the first replayed entry leaves that journal in charge, and
    // the next startup finishes tree + metadata + reference undo.
    const dbPath = path.join(vault, 'metadata.sqlite')
    const point = 'replay:a.md'
    const child = spawnCrashChild({
      NUVYN_FOLDER_VAULT: vault,
      NUVYN_FOLDER_DB: dbPath,
      NUVYN_FOLDER_CRASH_POINT: point,
    }, FOLDER_RECOVERY_REPLAY_CRASH_CHILD)
    expectParentKilled(await child.killAfterReady(point), point)

    // Pre-recovery proof: recovery's move journal exists, the tree is
    // split by exactly the one replayed entry.
      const moveJournal = (await namesIn()).find((name) => name.startsWith('.ren.nuvyn-journal-'))
    expect(moveJournal).toBeDefined()
    const moveJournalJson = JSON.parse(await fs.readFile(path.join(vault, moveJournal!), 'utf8'))
    expect(moveJournalJson.srcRel).toBe('ren')
    expect(moveJournalJson.destRel).toBe('proj')
    expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe('# a\n')
    expect(await fs.readFile(path.join(vault, 'ren/nested/b.md'), 'utf8')).toBe('# b\n')
    expect((await namesIn()).some((name) => name.startsWith('.proj.nuvyn-journal-'))).toBe(true)

    const persistedDb = new Database(dbPath)
    try {
      const report = await recoverInterruptedOperations(vault, persistedDb)
      expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
      expect(report.actions.some((a) => a.action === 'failed')).toBe(false)
      // Tree whole at proj, metadata with it, backlink rewrite undone.
      expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe('# a\n')
      expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe('# b\n')
      expect(await namesIn()).not.toContain('ren')
      expect(getDocumentMetadata(persistedDb, 'proj/a')?.id).toBe('rec-a-id')
      expect(getDocumentMetadata(persistedDb, 'proj/nested/b')?.id).toBe('rec-b-id')
      expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('[[old]]\n')
      expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-') || name.includes('.nuvyn-ref-'))).toBe(false)
      await recoverInterruptedOperations(vault, persistedDb)
      expect(getDocumentMetadata(persistedDb, 'proj/a')?.id).toBe('rec-a-id')
    } finally { persistedDb.close() }
  }, REAL_CRASH_TEST_TIMEOUT)
})

describe('recoverInterruptedOperations (rename staging, journal-less)', () => {
  it('restores an orphaned rename staging when the source path is empty', async () => {
    await seed({ '.note.md.nuvyn-rename-aaaa': '# ours\n' })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# ours\n')
    expect(report.actions.some((a) => a.action === 'restored')).toBe(true)
    expect(await namesIn()).toEqual(['note.md'])
  })

  it('quarantines rename staging when the source path was re-used externally', async () => {
    await seed({
      'note.md': '# external\n',
      '.note.md.nuvyn-rename-aaaa': '# ours\n',
    })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'note.md'), 'utf8')).toBe('# external\n')
    expect(await namesIn()).toContain('.note.md.nuvyn-rename-aaaa')
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('completes the metadata move when an inode partner proves the link landed', async () => {
    // Crash between link(2) and the staging unlink: staging and the
    // destination name the same inode. Recovery identifies the
    // partner by inode, removes the staging name, and completes the
    // metadata move the process died before running.
    await seed({ '.old.md.nuvyn-rename-aaaa': '# doc\n' })
    await fs.link(path.join(vault, '.old.md.nuvyn-rename-aaaa'), path.join(vault, 'moved.md'))
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Doc', updatedAt: 1 })

    const report = await runRecovery()

    expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
    expect(await fs.readFile(path.join(vault, 'moved.md'), 'utf8')).toBe('# doc\n')
    expect(getDocumentMetadata(db, 'moved')?.id).toBe('rename-id')
    expect(getDocumentMetadata(db, 'old')).toBeNull()
    expect((await namesIn()).some((n) => n.includes('.nuvyn-rename-'))).toBe(false)
  })
})

describe('recoverInterruptedOperations (file-rename journal)', () => {
  it('quarantines a file-rename journal without documentId without touching the live source', async () => {
    await seed({
      'old.md': '# old\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1, op: 'file-rename', srcRel: 'old', destRel: 'new',
        sourceHash: sha256Hex('# old\n'),
      }),
    })
    const before = await namesIn()

    const report = await runRecovery()

    expect(await namesIn()).toEqual(before)
    expect(await fs.readFile(path.join(vault, 'old.md'), 'utf8')).toBe('# old\n')
    expect(report.actions.some((action) => action.action === 'quarantined')).toBe(true)
  })

  it('rejects a valid-looking journal that is not stored beside its declared source', async () => {
    await seed({
      'important-note.md': '# important\n',
      '.unrelated.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1,
        op: 'file-rename',
        srcRel: 'missing-old',
        destRel: 'important-note',
        staging: '.missing-old.md.nuvyn-rename-aaaa',
        documentId: 'missing-id',
        sourceHash: sha256Hex('# important\n'),
      }),
    })
    saveDocumentMetadata(db, { id: 'important-id', path: 'important-note', title: 'Important', updatedAt: 1 })

    const report = await runRecovery()

    expect(getDocumentMetadata(db, 'important-note')?.id).toBe('important-id')
    expect(await namesIn()).toContain('.unrelated.md.nuvyn-journal-aaaa')
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('does not move a newer source identity recorded after an ambiguous restart', async () => {
    await seed({
      'new.md': '# moved\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1,
        op: 'file-rename',
        srcRel: 'old',
        destRel: 'new',
        staging: '.old.md.nuvyn-rename-aaaa',
        documentId: 'old-generation-id',
        sourceHash: sha256Hex('# moved\n'),
      }),
    })
    saveDocumentMetadata(db, { id: 'external-source-id', path: 'old', title: 'External', updatedAt: 2 })
    saveDocumentMetadata(db, { id: 'old-generation-id', path: 'new', title: 'Moved', updatedAt: 1 })

    const report = await runRecovery()

    expect(getDocumentMetadata(db, 'old')?.id).toBe('external-source-id')
    expect(getDocumentMetadata(db, 'new')?.id).toBe('old-generation-id')
    expect(await namesIn()).not.toContain('.old.md.nuvyn-journal-aaaa')
    expect(report.actions.some((a) => a.detail?.includes('already committed'))).toBe(true)
  })

  it('quarantines rather than moving metadata when the source documentId changed', async () => {
    await seed({
      'new.md': '# moved\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1,
        op: 'file-rename',
        srcRel: 'old',
        destRel: 'new',
        staging: '.old.md.nuvyn-rename-aaaa',
        documentId: 'old-generation-id',
        sourceHash: sha256Hex('# moved\n'),
      }),
    })
    saveDocumentMetadata(db, { id: 'external-source-id', path: 'old', title: 'External', updatedAt: 2 })

    const report = await runRecovery()

    expect(getDocumentMetadata(db, 'old')?.id).toBe('external-source-id')
    expect(getDocumentMetadata(db, 'new')).toBeNull()
    expect(await namesIn()).toContain('.old.md.nuvyn-journal-aaaa')
    expect(report.actions.some((a) => a.detail?.includes('identity no longer matches'))).toBe(true)
  })

  it('moves document identity after a crash with destination landed and staging already removed', async () => {
    await seed({
      'new.md': '# moved\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1,
        op: 'file-rename',
        srcRel: 'old',
        destRel: 'new',
        staging: '.old.md.nuvyn-rename-aaaa',
        documentId: 'stable-id',
        sourceHash: sha256Hex('# moved\n'),
      }),
    })
    saveDocumentMetadata(db, { id: 'stable-id', path: 'old', title: 'Moved', updatedAt: 1 })

    const report = await runRecovery()

    expect(getDocumentMetadata(db, 'old')).toBeNull()
    expect(getDocumentMetadata(db, 'new')?.id).toBe('stable-id')
    expect(await namesIn()).toEqual(['new.md'])
    expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
  })

  it('quarantines a folder journal with traversal paths without touching the sentinel', async () => {
    const sentinel = path.join(path.dirname(vault), `${path.basename(vault)}-folder-sentinel`)
    await fs.mkdir(sentinel)
    try {
      await seed({
        '.notes.nuvyn-journal-aaaa': JSON.stringify({
          version: 1,
          op: 'folder-rename',
          srcRel: `../${path.basename(sentinel)}`,
          destRel: 'safe',
          sourceDev: 0,
          sourceIno: 0,
        }),
      })
      const report = await runRecovery()
      expect((await fs.stat(sentinel)).isDirectory()).toBe(true)
      expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    } finally { await fs.rm(sentinel, { recursive: true, force: true }) }
  })
})

describe('recoverInterruptedOperations (rename reference transaction)', () => {
  it('does not let a forged preparing journal delete another transaction payloads', async () => {
    const reference = {
      path: 'ref', beforeHash: sha256Hex('before\n'), afterHash: sha256Hex('after\n'),
      beforePayload: '.old.md.nuvyn-ref-before-aaaa-0',
      afterPayload: '.old.md.nuvyn-ref-after-aaaa-0',
    }
    const base = {
      version: 1, op: 'document-rename-references', srcRel: 'old', destRel: 'new',
      documentId: 'rename-id', sourceHash: sha256Hex('# old\n'), references: [reference],
    }
    await seed({
      'old.md': '# old\n', 'ref.md': 'before\n',
      [reference.beforePayload]: 'before\n', [reference.afterPayload]: 'after\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({ ...base, phase: 'roll-forward' }),
      '.old.md.nuvyn-journal-bbbb': JSON.stringify({ ...base, phase: 'preparing' }),
    })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, reference.beforePayload), 'utf8')).toBe('before\n')
    expect(await fs.readFile(path.join(vault, reference.afterPayload), 'utf8')).toBe('after\n')
    expect(await namesIn()).toContain('.old.md.nuvyn-journal-aaaa')
    expect(await namesIn()).toContain('.old.md.nuvyn-journal-bbbb')
    expect(report.actions.some((action) => action.file.includes('bbbb') && action.action === 'quarantined')).toBe(true)
  })

  it.each([
    ['empty references', (journal: any) => { journal.references = [] }],
    ['duplicate reference path', (journal: any) => { journal.references.push({ ...journal.references[0], beforePayload: '.old.md.nuvyn-ref-before-aaaa-1', afterPayload: '.old.md.nuvyn-ref-after-aaaa-1' }) }],
    ['invalid source hash', (journal: any) => { journal.sourceHash = 'not-a-sha256' }],
    ['invalid reference hash', (journal: any) => { journal.references[0].beforeHash = 'not-a-sha256' }],
  ])('quarantines malformed reference journals without touching declared artifacts: %s', async (_label, mutate) => {
    const journal: any = {
      version: 1, op: 'document-rename-references', phase: 'preparing',
      srcRel: 'old', destRel: 'new', documentId: 'rename-id', sourceHash: sha256Hex('# old\n'),
      references: [{
        path: 'victim', beforeHash: sha256Hex('safe\n'), afterHash: sha256Hex('changed\n'),
        beforePayload: '.old.md.nuvyn-ref-before-aaaa-0', afterPayload: '.old.md.nuvyn-ref-after-aaaa-0',
      }],
    }
    mutate(journal)
    await seed({
      'old.md': '# old\n', 'victim.md': 'safe\n',
      '.old.md.nuvyn-ref-before-aaaa-0': 'safe\n', '.old.md.nuvyn-ref-after-aaaa-0': 'changed\n',
      '.old.md.nuvyn-ref-before-aaaa-1': 'safe\n', '.old.md.nuvyn-ref-after-aaaa-1': 'changed\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify(journal),
    })

    const beforeNames = await namesIn()
    const report = await runRecovery()
    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'victim.md'), 'utf8')).toBe('safe\n')
    expect(await namesIn()).toEqual(beforeNames)
    expect(report.actions.some((action) => action.action === 'quarantined')).toBe(true)
  })

  it('rejects a document reference journal without a bound document identity', async () => {
    await seed({
      'new.md': '# moved\n',
      'victim.md': 'safe\n',
      '.old.md.nuvyn-ref-before-aaaa-0': 'safe\n',
      '.old.md.nuvyn-ref-after-aaaa-0': 'forged\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1, op: 'document-rename-references', phase: 'roll-forward',
        srcRel: 'old', destRel: 'new', sourceHash: sha256Hex('# moved\n'),
        references: [{ path: 'victim', beforeHash: sha256Hex('safe\n'), afterHash: sha256Hex('forged\n'), beforePayload: '.old.md.nuvyn-ref-before-aaaa-0', afterPayload: '.old.md.nuvyn-ref-after-aaaa-0' }],
      }),
    })
    await runRecovery()
    expect(await fs.readFile(path.join(vault, 'victim.md'), 'utf8')).toBe('safe\n')
    expect(await namesIn()).toContain('.old.md.nuvyn-journal-aaaa')
  })

  it('does not update backlinks when the destination generation was replaced externally', async () => {
    await seed({ 'old.md': '# owned\n', 'ref.md': '[[old]]\n' })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old.md'), op: 'document-rename-references',
      srcRel: 'old', destRel: 'new', documentId: 'rename-id',
      references: [{ path: 'ref', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' }],
    })
    await fs.rm(path.join(vault, 'old.md'))
    await fs.writeFile(path.join(vault, 'new.md'), '# external\n')
    db.prepare('UPDATE documents SET path = ? WHERE id = ?').run('new', 'rename-id')
    const report = await runRecovery()
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('[[old]]\n')
    expect(getDocumentMetadata(db, 'new')).toBeNull()
    expect(report.actions.some((action) => action.detail?.includes('destination generation'))).toBe(true)
  })

  it('quarantines an incomplete preparing bundle without deleting its evidence', async () => {
    await seed({
      'old.md': '# old\n',
      '.old.md.nuvyn-ref-before-aaaa-0': 'before',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1, op: 'document-rename-references', phase: 'preparing',
        srcRel: 'old', destRel: 'new', documentId: 'id', sourceHash: sha256Hex('# old\n'),
        references: [{ path: 'ref', beforeHash: sha256Hex('before'), afterHash: sha256Hex('after'), beforePayload: '.old.md.nuvyn-ref-before-aaaa-0', afterPayload: '.old.md.nuvyn-ref-after-aaaa-0' }],
      }),
    })
    const report = await runRecovery()
    expect(report.actions).toContainEqual(expect.objectContaining({
      action: 'quarantined',
      detail: 'invalid durable rename-reference bundle',
    }))
    expect((await namesIn()).filter((name) =>
      name.includes('.nuvyn-ref-')
      || name.includes('.nuvyn-journal-'))).toEqual([
      '.old.md.nuvyn-journal-aaaa',
      '.old.md.nuvyn-ref-before-aaaa-0',
    ])
  })

  it('retains the journal when cleanup cannot remove a declared payload', async () => {
    const beforePayload = '.old.md.nuvyn-ref-before-aaaa-0'
    const afterPayload = '.old.md.nuvyn-ref-after-aaaa-0'
    await seed({
      'old.md': '# old\n', [afterPayload]: 'after',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1, op: 'document-rename-references', phase: 'preparing',
        srcRel: 'old', destRel: 'new', documentId: 'id', sourceHash: sha256Hex('# old\n'),
        references: [{ path: 'ref', beforeHash: sha256Hex('before'), afterHash: sha256Hex('after'), beforePayload, afterPayload }],
      }),
    })
    await fs.mkdir(path.join(vault, beforePayload))

    const first = await runRecovery()
    const stable = await namesIn()
    await runRecovery()

    expect(await namesIn()).toEqual(stable)
    expect(stable).toContain('.old.md.nuvyn-journal-aaaa')
    expect(stable).toContain(beforePayload)
    expect(stable).toContain(afterPayload)
    expect(first.actions.some((action) =>
      action.action === 'quarantined'
      && action.detail === 'invalid durable rename-reference bundle')).toBe(true)
  })

  it('replays a durable reference rollback before deleting its evidence', async () => {
    await seed({ 'old.md': '# owned\n', 'ref.md': '[[old]]\n' })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    const prepared = await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old.md'), op: 'document-rename-references',
      srcRel: 'old', destRel: 'new', documentId: 'rename-id',
      references: [{ path: 'ref', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' }],
    })
    await prepared!.setDirection('roll-back')
    await fs.writeFile(path.join(vault, 'ref.md'), '[[new]]\n')
    await runRecovery()
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('[[old]]\n')
    expect((await namesIn()).some((name) => name.includes('.nuvyn-ref-') || name.includes('.nuvyn-journal-'))).toBe(false)
  })

  it('finishes rollback when the process dies before the main file is moved back', async () => {
    await seed({ 'old.md': '# owned\n', 'ref.md': '[[old]]\n' })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    const prepared = await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old.md'), op: 'document-rename-references',
      srcRel: 'old', destRel: 'new', documentId: 'rename-id',
      references: [{ path: 'ref', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' }],
    })
    await fs.rename(path.join(vault, 'old.md'), path.join(vault, 'new.md'))
    db.prepare('UPDATE documents SET path = ? WHERE id = ?').run('new', 'rename-id')
    await fs.writeFile(path.join(vault, 'ref.md'), '[[new]]\n')
    await prepared!.setDirection('roll-back')

    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'old.md'), 'utf8')).toBe('# owned\n')
    await expect(fs.stat(path.join(vault, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getDocumentMetadata(db, 'old')?.id).toBe('rename-id')
    expect(getDocumentMetadata(db, 'new')).toBeNull()
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('[[old]]\n')
    expect((await namesIn()).some((name) => name.includes('.nuvyn-ref-') || name.includes('.nuvyn-journal-'))).toBe(false)
  })

  it('switches an interrupted rollback to forward when an external source generation wins', async () => {
    await seed({ 'old.md': '# owned\n', 'ref.md': '[[old]]\n' })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    const prepared = await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old.md'), op: 'document-rename-references',
      srcRel: 'old', destRel: 'new', documentId: 'rename-id',
      references: [{ path: 'ref', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' }],
    })
    await fs.rename(path.join(vault, 'old.md'), path.join(vault, 'new.md'))
    db.prepare('UPDATE documents SET path = ? WHERE id = ?').run('new', 'rename-id')
    await fs.writeFile(path.join(vault, 'old.md'), '# external\n')
    await prepared!.setDirection('roll-back')

    await runRecovery()
    const stable = await namesIn()
    await runRecovery()
    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'old.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(vault, 'new.md'), 'utf8')).toBe('# owned\n')
    expect(getDocumentMetadata(db, 'new')?.id).toBe('rename-id')
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('[[new]]\n')
    expect(await namesIn()).toEqual(stable)
    expect(stable.some((name) => name.includes('.nuvyn-ref-') || name.includes('.nuvyn-journal-'))).toBe(false)
  })

  it('treats a byte-identical recreated source as a new generation', async () => {
    await seed({ 'old.md': '# owned\n', 'ref.md': '[[old]]\n' })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    const prepared = await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old.md'), op: 'document-rename-references',
      srcRel: 'old', destRel: 'new', documentId: 'rename-id',
      references: [{ path: 'ref', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' }],
    })
    await fs.rename(path.join(vault, 'old.md'), path.join(vault, 'new.md'))
    db.prepare('UPDATE documents SET path = ? WHERE id = ?').run('new', 'rename-id')
    await fs.writeFile(path.join(vault, 'old.md'), '# owned\n')
    await prepared!.setDirection('roll-back')

    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'old.md'), 'utf8')).toBe('# owned\n')
    expect(await fs.readFile(path.join(vault, 'new.md'), 'utf8')).toBe('# owned\n')
    expect(getDocumentMetadata(db, 'old')).toBeNull()
    expect(getDocumentMetadata(db, 'new')?.id).toBe('rename-id')
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('[[new]]\n')
  })

  it('settles the main rename before references regardless of journal filename order', async () => {
    await seed({ 'old.md': '# owned\n', 'ref.md': '[[old]]\n' })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    const prepared = await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old.md'), op: 'document-rename-references',
      srcRel: 'old', destRel: 'new', documentId: 'rename-id',
      references: [{ path: 'ref', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' }],
    })
    const earlyTransactionId = '00000000-0000-4000-8000-000000000000'
    const earlyReferenceJournal = path.join(
      vault,
      `.old.md.nuvyn-journal-${earlyTransactionId}`,
    )
    const referenceEntry = JSON.parse(await fs.readFile(prepared!.journalPath, 'utf8')) as {
      references: Array<{ beforePayload: string; afterPayload: string }>
    }
    const originalBefore = referenceEntry.references[0].beforePayload
    const originalAfter = referenceEntry.references[0].afterPayload
    referenceEntry.references[0].beforePayload
      = `.old.md.nuvyn-ref-before-${earlyTransactionId}-0`
    referenceEntry.references[0].afterPayload
      = `.old.md.nuvyn-ref-after-${earlyTransactionId}-0`
    await fs.rename(path.join(vault, originalBefore), path.join(vault, referenceEntry.references[0].beforePayload))
    await fs.rename(path.join(vault, originalAfter), path.join(vault, referenceEntry.references[0].afterPayload))
    await fs.writeFile(prepared!.journalPath, JSON.stringify(referenceEntry))
    await fs.rename(prepared!.journalPath, earlyReferenceJournal)
    await fs.writeFile(path.join(vault, '.old.md.nuvyn-journal-ffff'), JSON.stringify({
      version: 1, op: 'file-rename', srcRel: 'old', destRel: 'new',
      documentId: 'rename-id', sourceHash: sha256Hex('# owned\n'),
    }))
    await fs.rename(path.join(vault, 'old.md'), path.join(vault, 'new.md'))

    await runRecovery()

    expect(getDocumentMetadata(db, 'new')?.id).toBe('rename-id')
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('[[new]]\n')
    expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(false)
  })

  it('rolls forward a partially written backlink batch and cleans durable payloads', async () => {
    await seed({
      'old.md': '# moved\n',
      'ref-a.md': '[[old]]\n',
      'ref-b.md': '[[old]]\n',
    })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    const prepared = await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old.md'),
      op: 'document-rename-references',
      srcRel: 'old',
      destRel: 'new',
      documentId: 'rename-id',
      references: [
        { path: 'ref-a', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' },
        { path: 'ref-b', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' },
      ],
    })
    expect(prepared).not.toBeNull()
    await fs.rename(path.join(vault, 'old.md'), path.join(vault, 'new.md'))
    db.prepare('UPDATE documents SET path = ? WHERE id = ?').run('new', 'rename-id')
    await fs.writeFile(path.join(vault, 'ref-a.md'), '[[new]]\n', 'utf8')

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('[[new]]\n')
    expect(await fs.readFile(path.join(vault, 'ref-b.md'), 'utf8')).toBe('[[new]]\n')
    expect(report.actions.some((action) => action.detail?.includes('rolled forward'))).toBe(true)
    expect((await namesIn()).some((name) => name.includes('.nuvyn-ref-') || name.includes('.nuvyn-journal-'))).toBe(false)
  })

  it('stops without overwriting a backlink changed by an external editor', async () => {
    await seed({ 'old.md': '# moved\n', 'ref.md': '[[old]]\n' })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })
    await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old.md'),
      op: 'document-rename-references',
      srcRel: 'old',
      destRel: 'new',
      documentId: 'rename-id',
      references: [{ path: 'ref', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' }],
    })
    await fs.rename(path.join(vault, 'old.md'), path.join(vault, 'new.md'))
    db.prepare('UPDATE documents SET path = ? WHERE id = ?').run('new', 'rename-id')
    await fs.writeFile(path.join(vault, 'ref.md'), '# external\n', 'utf8')

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('# external\n')
    expect(report.actions.some((action) => action.detail?.includes('changed externally'))).toBe(true)
    expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(true)
  })

  it('does not bind a replaced external folder generation to the renamed subtree identities', async () => {
    await seed({ 'old/note.md': '# owned\n', 'ref.md': '[[old/note]]\n' })
    saveDocumentMetadata(db, { id: 'folder-note-id', path: 'old/note', title: 'Owned', updatedAt: 1 })
    await prepareRenameReferenceJournal({
      sourceAbs: path.join(vault, 'old'), op: 'folder-rename-references',
      srcRel: 'old', destRel: 'new',
      identities: [{ path: 'old/note', id: 'folder-note-id' }],
      references: [{ path: 'ref', beforeRaw: '[[old/note]]\n', afterRaw: '[[new/note]]\n' }],
    })
    await fs.rename(path.join(vault, 'old'), path.join(vault, 'new'))
    db.prepare('UPDATE documents SET path = ? WHERE id = ?').run('new/note', 'folder-note-id')
    await fs.rm(path.join(vault, 'new'), { recursive: true })
    await seed({ 'new/external.md': '# external\n' })

    const report = await runRecovery()

    expect(await fs.readFile(path.join(vault, 'new/external.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('[[old/note]]\n')
    expect(getDocumentMetadata(db, 'new/note')?.id).toBe('folder-note-id')
    expect(report.actions.some((action) =>
      action.detail === 'legacy journal lacks sufficient durable ownership proof')).toBe(true)
    expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-'))).toBe(true)
  })
})

describe('recoverInterruptedOperations (folder-rename journal)', () => {
  async function folderJournal(srcRel: string, destRel: string, evidenceRel = srcRel): Promise<string> {
    const stat = await fs.stat(path.join(vault, evidenceRel)).catch(() => ({ dev: 0, ino: 0 }))
    return JSON.stringify({ version: 1, op: 'folder-rename', srcRel, destRel, sourceDev: stat.dev, sourceIno: stat.ino })
  }

  it('never removes a real empty directory from a forged no-op journal', async () => {
    await fs.mkdir(path.join(vault, 'notes'))
    await seed({ '.notes.nuvyn-journal-aaaa': await folderJournal('notes', 'notes') })

    const report = await runRecovery()

    expect((await fs.stat(path.join(vault, 'notes'))).isDirectory()).toBe(true)
    expect(await namesIn()).toContain('.notes.nuvyn-journal-aaaa')
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('quarantines a landed weak legacy journal without moving metadata', async () => {
    await seed({ 'ren/a.md': '# a\n' })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await folderJournal('proj', 'ren', 'ren'), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('ren-a-id')
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('idempotently quarantines weak legacy state after metadata landed', async () => {
    await seed({ 'ren/a.md': '# a\n' })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await folderJournal('proj', 'ren', 'ren'), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'ren/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('ren-a-id')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('retains a stale weak legacy journal when the source is intact', async () => {
    await seed({ 'proj/a.md': '# a\n' })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await folderJournal('proj', 'ren'), 'utf8')
    saveDocumentMetadata(db, { id: 'proj-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('proj-a-id')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('does not move metadata for a weak legacy journal', async () => {
    await seed({ 'proj/a.md': '# a\n' })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await folderJournal('proj', 'ren'), 'utf8')
    saveDocumentMetadata(db, { id: 'proj-a-id', path: 'ren/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(getDocumentMetadata(db, 'proj/a')).toBeNull()
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('proj-a-id')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('never treats an empty destination as proof that the gate is ours', async () => {
    await seed({ 'proj/a.md': '# a\n' })
    await fs.mkdir(path.join(vault, 'ren'))
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await folderJournal('proj', 'ren'), 'utf8')

    await runRecovery()

    expect(await namesIn()).toContain('proj')
    expect(await namesIn()).toContain('ren')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('leaves an externally claimed destination untouched and quarantines the journal', async () => {
    // Both directories exist with the source tree intact: the move
    // never landed; the non-empty destination is external content.
    await seed({ 'proj/a.md': '# a\n', 'ren/external.md': '# external\n' })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await folderJournal('proj', 'ren'), 'utf8')

    await runRecovery()

    expect(await fs.readFile(path.join(vault, 'ren/external.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe('# a\n')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('reports and keeps the journal when neither path exists', async () => {
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await folderJournal('proj', 'ren'), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })
})

describe('recoverInterruptedOperations (replayable folder-rename journal)', () => {
  // Windows cannot replace a directory with rename(2), so the folder
  // move runs as journaled per-file create-only links: a crash can
  // leave the tree SPLIT between source and destination, and the
  // journal's per-entry content hashes are the proof that replays it.
  async function replayableJournal(entries: Array<{ rel: string; id: string; sourceHash: string }>): Promise<string> {
    const stat = await fs.stat(path.join(vault, 'proj')).catch(async () => fs.stat(path.join(vault, 'ren'))).catch(() => ({ dev: 0, ino: 0 }))
    // Every parent directory of a journaled file is a journaled
    // directory (the mover recreates the declared set, which preserves
    // nested dirs).
    const directories = [...new Set(
      entries.map((entry) => entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')) : null)
        .filter((dir): dir is string => dir !== null),
    )]
    return JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: stat.dev, sourceIno: stat.ino,
      entries: entries.map((entry) => ({
        relativeFilePath: `${entry.rel}.md`,
        sourceHash: entry.sourceHash,
        documentId: entry.id,
        documentPath: `proj/${entry.rel}`,
      })),
      directories,
      metadataDisposition: { kind: 'prefix-move' },
    })
  }
  const A_RAW = '# a\n'
  const B_RAW = '# b\n'
  const entries = (): Array<{ rel: string; id: string; sourceHash: string }> => [
    { rel: 'a', id: 'ren-a-id', sourceHash: sha256Hex(A_RAW) },
    { rel: 'nested/b', id: 'ren-b-id', sourceHash: sha256Hex(B_RAW) },
  ]

  it('quarantines a split weak legacy move without replaying it', async () => {
    // Exact mid-move crash state: entry a.md already landed at the
    // destination, nested/b.md still at the source, durable journal.
    await seed({ 'ren/a.md': A_RAW, 'proj/nested/b.md': B_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await replayableJournal(entries()), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })
    saveDocumentMetadata(db, { id: 'ren-b-id', path: 'proj/nested/b', title: 'B', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe(A_RAW)
    expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe(B_RAW)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('ren-a-id')
    expect(getDocumentMetadata(db, 'proj/nested/b')?.id).toBe('ren-b-id')
    // Idempotent across repeated startups.
    await runRecovery()
    await runRecovery()
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe(A_RAW)
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('ren-a-id')
  })

  it('does not infer completion from a fully-landed weak legacy tree', async () => {
    await seed({ 'ren/a.md': A_RAW, 'ren/nested/b.md': B_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await replayableJournal(entries()), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })
    saveDocumentMetadata(db, { id: 'ren-b-id', path: 'proj/nested/b', title: 'B', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('ren-a-id')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('does not prune an empty gate claimed only by a weak legacy journal', async () => {
    // A replayable move's destination gate is provably ours by its
    // hidden gate token (round-8: an empty directory alone is NOT
    // ownership proof): every entry is still at the source, so the
    // gate and its empty intermediates are pruned and the stale journal
    // removed.
    await seed({ 'proj/a.md': A_RAW, 'proj/nested/b.md': B_RAW })
    await fs.mkdir(path.join(vault, 'ren', 'nested'), { recursive: true })
    await fs.writeFile(path.join(vault, 'ren', '.nuvyn-folder-gate-cccc'), '', 'utf8')
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await replayableJournal(entries()), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await namesIn()).toContain('ren')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
    expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe(A_RAW)
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('ren-a-id')
  })

  it('quarantines when the source is intact but the destination holds external content', async () => {
    await seed({ 'proj/a.md': A_RAW, 'proj/nested/b.md': B_RAW, 'ren/external.md': '# external\n' })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await replayableJournal(entries()), 'utf8')

    const report = await runRecovery()

    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    expect(await fs.readFile(path.join(vault, 'ren/external.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe(A_RAW)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('never replays an entry onto an external generation at the destination', async () => {
    // An external writer owns ren/a.md with different bytes: replaying
    // would mean overwriting it. The destination inventory (round-8)
    // detects the undeclared/foreign file and quarantines the journal
    // BEFORE replaying anything — so the other entry never moves either.
    await seed({ 'ren/a.md': '# external\n', 'proj/nested/b.md': B_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), await replayableJournal(entries()), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })
    saveDocumentMetadata(db, { id: 'ren-b-id', path: 'proj/nested/b', title: 'B', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe(B_RAW)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
    // Metadata never moved onto the foreign generation.
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
    expect(getDocumentMetadata(db, 'proj/nested/b')?.id).toBe('ren-b-id')
  })

  it('leaves an unrecognized journal in place when a replayable journal lost its entries', async () => {
    // A forged/corrupted replayable journal without its entry list can
    // never be reconciled safely: it must NOT parse, and it must stay
    // on disk for inspection instead of being auto-removed.
    await seed({ 'proj/a.md': A_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 1, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable',
      sourceDev: 0, sourceIno: 0, entries: [],
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
    expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe(A_RAW)
  })

  it('quarantines a v2 journal that omitted its directory manifest', async () => {
    // v2 made directories optional even though replay can only prove an
    // exact tree when every nested/empty directory is declared. Missing
    // is not equivalent to an empty manifest; legacy ambiguity fails
    // closed instead of silently accepting an open directory set.
    await seed({ 'ren/a.md': A_RAW, 'proj/nested/b.md': B_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [
        { relativeFilePath: 'a.md', sourceHash: sha256Hex(A_RAW), documentId: 'ren-a-id', documentPath: 'proj/a' },
        { relativeFilePath: 'nested/b.md', sourceHash: sha256Hex(B_RAW), documentId: 'ren-b-id', documentPath: 'proj/nested/b' },
      ],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })
    saveDocumentMetadata(db, { id: 'ren-b-id', path: 'proj/nested/b', title: 'B', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe(B_RAW)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
  })

  it.each([
    ['missing', undefined, 'a.md'],
    ['unsorted', ['nested/deeper', 'nested'], 'nested/deeper/a.md'],
    ['not parent-closed', ['nested/deeper'], 'nested/deeper/a.md'],
    ['not closed over file parents', [], 'nested/a.md'],
  ])('quarantines a v3 directory manifest that is %s', async (_case, directories, relativeFilePath) => {
    const source = path.join(vault, 'proj', relativeFilePath)
    await fs.mkdir(path.dirname(source), { recursive: true })
    await fs.writeFile(source, A_RAW, 'utf8')
    const stat = await fs.stat(source, { bigint: true })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 3, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: '1', sourceIno: '1', gateToken: 'a'.repeat(64),
      entries: [{
        relativeFilePath, sourceHash: sha256Hex(A_RAW),
        sourceDev: stat.dev.toString(), sourceIno: stat.ino.toString(),
      }],
      ...(directories === undefined ? {} : { directories }),
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await fs.readFile(source, 'utf8')).toBe(A_RAW)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('quarantines legacy journals with unsafe numeric generations', async () => {
    // NTFS volumes with large file records and ReFS/Dev Drive report
    // file IDs beyond 2**53; JSON round-trips them as finite doubles.
    // Rejecting them as "unsafe integers" would orphan every production
    // folder journal on such volumes — the parser accepts any finite
    // number and the per-entry content hashes remain the strong proof.
    await seed({ 'ren/a.md': A_RAW, 'proj/nested/b.md': B_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 2 ** 60, sourceIno: 2 ** 61 + 2 ** 9,
      entries: entries().map((entry) => ({
        relativeFilePath: `${entry.rel}.md`,
        sourceHash: entry.sourceHash,
        documentId: entry.id,
        documentPath: `proj/${entry.rel}`,
      })),
      directories: ['nested'],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })
    saveDocumentMetadata(db, { id: 'ren-b-id', path: 'proj/nested/b', title: 'B', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe(B_RAW)
    expect(getDocumentMetadata(db, 'proj/nested/b')?.id).toBe('ren-b-id')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('parses but quarantines HEAD-era v1 journals with canonical strategy values', async () => {
    // Round-7 P0 regression, backwards direction: the pre-fix route
    // wrote strategy 'replayable-move'/'atomic-rename' into v1
    // journals while the parser only accepted 'replayable'/'atomic' —
    // every real journal was "unrecognized". Both spellings now parse;
    // legacy v1 entries normalize to the physical shape.
    await seed({ 'ren/a.md': A_RAW, 'proj/nested/b.md': B_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 1, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [
        { rel: 'a', id: 'ren-a-id', sourceHash: sha256Hex(A_RAW) },
        { rel: 'nested/b', id: 'ren-b-id', sourceHash: sha256Hex(B_RAW) },
      ],
    }), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })
    saveDocumentMetadata(db, { id: 'ren-b-id', path: 'proj/nested/b', title: 'B', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await fs.readFile(path.join(vault, 'proj/nested/b.md'), 'utf8')).toBe(B_RAW)
    expect(getDocumentMetadata(db, 'proj/nested/b')?.id).toBe('ren-b-id')
  })

  it('parses but quarantines legacy v1 journals with short strategy names', async () => {
    await seed({ 'ren/a.md': A_RAW, 'ren/nested/b.md': B_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 1, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable',
      sourceDev: 7, sourceIno: 11,
      entries: [
        { rel: 'a', id: 'ren-a-id', sourceHash: sha256Hex(A_RAW) },
        { rel: 'nested/b', id: 'ren-b-id', sourceHash: sha256Hex(B_RAW) },
      ],
    }), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(getDocumentMetadata(db, 'proj/a')?.id).toBe('ren-a-id')
  })

  it('accepts every strategy value the platform can persist (schema tying guard)', async () => {
    // The round-7 P0 was a drift between the persisted value and the
    // parser. This guard fails loudly if the shared enum and the
    // platform default ever diverge again: the platform strategy must
    // be one of the persisted values, and a journal carrying ANY
    // persisted value must parse and recover.
    expect(FOLDER_MOVE_STRATEGIES).toContain(platformDirectoryMoveStrategy)
    for (const strategy of FOLDER_MOVE_STRATEGIES) {
      await cleanupRecoveryTempDir(vault)
      await fs.mkdir(vault, { recursive: true })
      await seed({ 'ren/a.md': A_RAW, 'ren/nested/b.md': B_RAW })
      await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
        version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy,
        sourceDev: 7, sourceIno: 11,
        entries: [
          { relativeFilePath: 'a.md', sourceHash: sha256Hex(A_RAW), documentId: 'ren-a-id', documentPath: 'proj/a' },
          { relativeFilePath: 'nested/b.md', sourceHash: sha256Hex(B_RAW), documentId: 'ren-b-id', documentPath: 'proj/nested/b' },
        ],
        directories: ['nested'],
        metadataDisposition: { kind: 'prefix-move' },
      }), 'utf8')
      saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })

      const report = await runRecovery()

      expectWeakLegacyFolderJournal(report)
      db.exec('DELETE FROM documents')
    }
  })

  it('does not replay a binary attachment from a weak legacy journal', async () => {
    // Attachments are binary: a utf8 read would mangle the bytes and
    // the hash would never match. The journal hashes every physical
    // file with sha256HexBuffer and recovery replays by that proof.
    const imageBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x00])
    await seed({ 'ren/a.md': A_RAW })
    await fs.mkdir(path.join(vault, 'proj'), { recursive: true })
    await fs.writeFile(path.join(vault, 'proj', 'image.bin'), imageBytes)
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [
        { relativeFilePath: 'a.md', sourceHash: sha256Hex(A_RAW), documentId: 'ren-a-id', documentPath: 'proj/a' },
        { relativeFilePath: 'image.bin', sourceHash: sha256HexBuffer(imageBytes) },
      ],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await fs.readFile(path.join(vault, 'proj/image.bin'))).toEqual(imageBytes)
    expect(await namesIn()).toContain('proj')
  })

  it('retains a gate claimed only by a weak empty-tree journal', async () => {
    // An empty folder rename killed after the gate: entries [] with
    // emptyTree, source directory intact. Stale for a prefix-move
    // journal — the gate is ours (proven by its token, round-8) and is
    // pruned.
    await fs.mkdir(path.join(vault, 'proj'), { recursive: true })
    await fs.mkdir(path.join(vault, 'ren'), { recursive: true })
    await fs.writeFile(path.join(vault, 'ren', '.nuvyn-folder-gate-cccc'), '', 'utf8')
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11, emptyTree: true, entries: [],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await namesIn()).toContain('ren')
    expect(await namesIn()).toContain('proj')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('quarantines a stale empty-tree journal whose destination gate is not provably ours', async () => {
    // Round-8: an empty destination directory is NOT ownership proof.
    // With no gate token, recovery must not prune it (it could be an
    // externally-created directory) — the journal is quarantined.
    await fs.mkdir(path.join(vault, 'proj'), { recursive: true })
    await fs.mkdir(path.join(vault, 'ren'), { recursive: true })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11, emptyTree: true, entries: [],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await namesIn()).toContain('ren')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })

  it('does not recreate directories from a weak legacy manifest', async () => {
    // Round-8 P1: a replayable move records every subdirectory, so
    // nested EMPTY directories (visible vault tree nodes) survive the
    // move — a files-only replay would silently drop them on Windows.
    await seed({ 'ren/a.md': A_RAW })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [{ relativeFilePath: 'a.md', sourceHash: sha256Hex(A_RAW), documentId: 'ren-a-id', documentPath: 'proj/a' }],
      directories: ['empty', 'empty/nested'],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')
    saveDocumentMetadata(db, { id: 'ren-a-id', path: 'proj/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    await expect(fs.stat(path.join(vault, 'ren/empty')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the moved folder but retains a weak empty-tree journal', async () => {
    // The empty move completed before the crash (source gone, empty
    // destination present): forward completion KEEPS the destination
    // directory — pruning it would delete the moved folder.
    await fs.mkdir(path.join(vault, 'ren'), { recursive: true })
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-cccc'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11, emptyTree: true, entries: [],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report)
    expect(await namesIn()).toContain('ren')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-cccc')
  })
})

describe('recoverInterruptedOperations (weak legacy folder-move snapshot-restore journal)', () => {
  // Versions 1-3 lack the durable gate, file-generation, and directory-
  // generation ownership proof required to mutate either the tree or
  // metadata. Even historically plausible rollback states fail closed.
  const A_RAW = '# a\n'
  const IMAGE_BYTES = Buffer.from([0x01, 0x02, 0x03, 0xff])
  const STAGED = 'gone.nuvyn-delete-inflight-cccccccc'

  async function seedDeleteRollbackState(filesAtDest: { a?: boolean; image?: boolean }): Promise<void> {
    await fs.mkdir(path.join(vault, STAGED), { recursive: true })
    if (filesAtDest.a) {
      await fs.mkdir(path.join(vault, 'gone'), { recursive: true })
      await fs.writeFile(path.join(vault, 'gone', 'a.md'), A_RAW, 'utf8')
    } else {
      await fs.writeFile(path.join(vault, STAGED, 'a.md'), A_RAW, 'utf8')
    }
    if (filesAtDest.image) {
      await fs.mkdir(path.join(vault, 'gone'), { recursive: true })
      await fs.writeFile(path.join(vault, 'gone', 'image.bin'), IMAGE_BYTES)
    } else {
      await fs.writeFile(path.join(vault, STAGED, 'image.bin'), IMAGE_BYTES)
    }
    // The delete route detached the prefix before its rollback began;
    // the persisted snapshot is what recovery must re-install.
    saveDocumentMetadata(db, { id: 'gone-a-id', path: 'gone/a', title: 'A', updatedAt: 1 })
    const snapshot = snapshotDocumentMetadataPrefixMutation(db, ['gone'])
    deleteDocumentMetadataPrefix(db, 'gone')
    await fs.writeFile(path.join(vault, `.${STAGED}.nuvyn-journal-cccc`), JSON.stringify({
      version: 2, op: 'folder-move', srcRel: STAGED, destRel: 'gone', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [
        { relativeFilePath: 'a.md', sourceHash: sha256Hex(A_RAW), documentId: 'gone-a-id', documentPath: 'gone/a' },
        { relativeFilePath: 'image.bin', sourceHash: sha256HexBuffer(IMAGE_BYTES) },
      ],
      directories: [],
      metadataDisposition: { kind: 'snapshot-restore', snapshot: serializeMetadataSnapshot(snapshot) },
    }), 'utf8')
  }

  it('quarantines a delete rollback that crashed mid restore without mutating either side', async () => {
    await seedDeleteRollbackState({ a: true, image: false })
    expect(getDocumentMetadata(db, 'gone/a')).toBeNull()

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report, `.${STAGED}.nuvyn-journal-cccc`)
    expect(await fs.readFile(path.join(vault, 'gone/a.md'), 'utf8')).toBe(A_RAW)
    expect(await fs.readFile(path.join(vault, STAGED, 'image.bin'))).toEqual(IMAGE_BYTES)
    expect(await fs.stat(path.join(vault, 'gone/image.bin')).then(() => true, () => false)).toBe(false)
    expect(getDocumentMetadata(db, 'gone/a')).toBeNull()
    expect(await namesIn()).toContain(STAGED)
    expect(await namesIn()).toContain(`.${STAGED}.nuvyn-journal-cccc`)
    // Idempotent.
    await runRecovery()
    expect(getDocumentMetadata(db, 'gone/a')).toBeNull()
    expect(await fs.readFile(path.join(vault, STAGED, 'image.bin'))).toEqual(IMAGE_BYTES)
  })

  it('quarantines a delete rollback that crashed before its first file moved', async () => {
    await seedDeleteRollbackState({ a: false, image: false })

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report, `.${STAGED}.nuvyn-journal-cccc`)
    expect(await fs.readFile(path.join(vault, STAGED, 'a.md'), 'utf8')).toBe(A_RAW)
    expect(await fs.readFile(path.join(vault, STAGED, 'image.bin'))).toEqual(IMAGE_BYTES)
    expect(await fs.stat(path.join(vault, 'gone')).then(() => true, () => false)).toBe(false)
    expect(getDocumentMetadata(db, 'gone/a')).toBeNull()
  })

  it('rejects a snapshot document that has no corresponding physical Markdown entry', async () => {
    await fs.mkdir(path.join(vault, STAGED), { recursive: true })
    await fs.writeFile(path.join(vault, STAGED, 'a.md'), A_RAW, 'utf8')
    await fs.writeFile(path.join(vault, `.${STAGED}.nuvyn-journal-cccc`), JSON.stringify({
      version: 2, op: 'folder-move', srcRel: STAGED, destRel: 'gone', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [{
        relativeFilePath: 'a.md', sourceHash: sha256Hex(A_RAW),
        documentId: 'gone-a-id', documentPath: 'gone/a',
      }],
      directories: [],
      metadataDisposition: {
        kind: 'snapshot-restore',
        snapshot: {
          paths: ['gone/ghost'], documentIds: ['ghost-id'], tagIds: [], preexistingTagIds: [],
          documents: [{ id: 'ghost-id', path: 'gone/ghost', title: 'Ghost', summary: '', created_at: 1, updated_at: 1 }],
          tags: [], documentTags: [], embeddings: [], migrations: [],
        },
      },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report, `.${STAGED}.nuvyn-journal-cccc`)
    expect(getDocumentMetadata(db, 'gone/ghost')).toBeNull()
    expect(await fs.readFile(path.join(vault, STAGED, 'a.md'), 'utf8')).toBe(A_RAW)
    expect(await namesIn()).toContain(`.${STAGED}.nuvyn-journal-cccc`)
  })

  it('refuses a forged snapshot that targets metadata outside the restored folder', async () => {
    // Round-8 P0: restoreDocumentMetadataMutation deletes every row
    // matching the snapshot's paths/ids and re-inserts its rows
    // verbatim. A forged journal must NOT be able to delete or replace
    // metadata unrelated to the folder being restored — the snapshot is
    // scoped to the destRel subtree at parse time, so this journal is
    // unparseable and recovery never touches the DB.
    saveDocumentMetadata(db, { id: 'unrelated-id', path: 'unrelated/document', title: 'Original', updatedAt: 1 })
    await fs.mkdir(path.join(vault, STAGED), { recursive: true })
    await fs.writeFile(path.join(vault, STAGED, 'a.md'), A_RAW, 'utf8')
    await fs.writeFile(path.join(vault, `.${STAGED}.nuvyn-journal-cccc`), JSON.stringify({
      version: 2, op: 'folder-move', srcRel: STAGED, destRel: 'gone', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [{ relativeFilePath: 'a.md', sourceHash: sha256Hex(A_RAW) }],
      directories: [],
      metadataDisposition: {
        kind: 'snapshot-restore',
        snapshot: {
          paths: ['unrelated/document'],
          documentIds: ['unrelated-id'],
          tagIds: [], preexistingTagIds: [],
          documents: [{ id: 'unrelated-id', path: 'unrelated/document', title: 'Replaced', summary: '', created_at: 1, updated_at: 1 }],
          tags: [], documentTags: [], embeddings: [], migrations: [],
        },
      },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report, `.${STAGED}.nuvyn-journal-cccc`)
    expect(getDocumentMetadata(db, 'unrelated/document')?.title).toBe('Original')
    expect(getDocumentMetadata(db, 'unrelated/document')?.id).toBe('unrelated-id')
    expect(await namesIn()).toContain(`.${STAGED}.nuvyn-journal-cccc`)
  })

  it('quarantines rather than merging the restored tree into an externally-created destination', async () => {
    // Round-8 P1: all entries are still in staging, but the public
    // folder reappeared holding an external file. Recovery must NOT
    // replay the old generation into that foreign directory — it
    // quarantines, leaving both the external file and the staged tree
    // untouched.
    await seedDeleteRollbackState({ a: false, image: false })
    await fs.mkdir(path.join(vault, 'gone'), { recursive: true })
    await fs.writeFile(path.join(vault, 'gone', 'external.md'), '# external\n', 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report, `.${STAGED}.nuvyn-journal-cccc`)
    // External file untouched; staged tree NOT merged into it.
    expect(await fs.readFile(path.join(vault, 'gone/external.md'), 'utf8')).toBe('# external\n')
    expect(await fs.stat(path.join(vault, 'gone/a.md')).then(() => true, () => false)).toBe(false)
    expect(await fs.readFile(path.join(vault, STAGED, 'a.md'), 'utf8')).toBe(A_RAW)
    // Metadata was NOT re-installed onto the foreign directory.
    expect(getDocumentMetadata(db, 'gone/a')).toBeNull()
    expect(await namesIn()).toContain(`.${STAGED}.nuvyn-journal-cccc`)
  })
})

describe('recoverInterruptedOperations (symlink containment)', () => {
  // String-level containment is not enough: `vault/evil → /outside`
  // keeps every resolved-against-vault path STRING inside the vault
  // while the filesystem access lands outside — and an atomic rewrite
  // also creates its `.nuvyn-save-*` temp in the target's parent. The
  // recovery walk itself never descends symlinked directories (Dirent
  // isDirectory is false for links); these tests prove the journals it
  // DOES find cannot route any touch outside through a symlinked
  // ancestor. Junctions on Windows report isSymbolicLink under lstat,
  // so both platforms share one code path.
  let outside: string
  beforeEach(async () => {
    outside = path.join(path.dirname(vault), `${path.basename(vault)}-outside`)
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(vault, 'evil'), process.platform === 'win32' ? 'junction' : 'dir')
  })
  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true })
  })

  it('quarantines a roll-forward reference journal whose reference path escapes the vault through a symlink', async () => {
    // The reviewer's exact vector: the journal and payloads are
    // legitimately inside the vault; only reference.path points
    // through the symlink. Roll-forward would atomically rewrite
    // outside/victim.md (and drop its save temp outside).
    await fs.writeFile(path.join(outside, 'victim.md'), '# external\n', 'utf8')
    await seed({
      'old.md': '# owned\n',
      'ref-a.md': '[[old]]\n',
      '.old.md.nuvyn-ref-before-aaaa-0': '[[old]]\n',
      '.old.md.nuvyn-ref-after-aaaa-0': '[[new]]\n',
      '.old.md.nuvyn-ref-before-aaaa-1': '# external\n',
      '.old.md.nuvyn-ref-after-aaaa-1': '# rewritten\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1, op: 'document-rename-references', phase: 'roll-forward',
        srcRel: 'old', destRel: 'new', documentId: 'rename-id',
        sourceHash: sha256Hex('# owned\n'),
        references: [
          {
            path: 'ref-a', beforeHash: sha256Hex('[[old]]\n'), afterHash: sha256Hex('[[new]]\n'),
            beforePayload: '.old.md.nuvyn-ref-before-aaaa-0', afterPayload: '.old.md.nuvyn-ref-after-aaaa-0',
          },
          {
            path: 'evil/victim', beforeHash: sha256Hex('# external\n'), afterHash: sha256Hex('# rewritten\n'),
            beforePayload: '.old.md.nuvyn-ref-before-aaaa-1', afterPayload: '.old.md.nuvyn-ref-after-aaaa-1',
          },
        ],
      }),
    })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })

    const report = await runRecovery()

    expect(report.actions.some((a) =>
      a.action === 'quarantined'
      && a.detail?.includes('escapes the vault'))).toBe(true)
    // Nothing outside was touched — no rewrite, no save temp.
    expect(await fs.readFile(path.join(outside, 'victim.md'), 'utf8')).toBe('# external\n')
    expect((await fs.readdir(outside)).some((name) => name.includes('.nuvyn-'))).toBe(false)
    // All-or-nothing: the legitimate reference was not rewritten either,
    // and the journal stays authoritative for inspection.
    expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('[[old]]\n')
    expect(await namesIn()).toContain('.old.md.nuvyn-journal-aaaa')
  })

  it('quarantines a reference journal whose rename paths point through a vault symlink', async () => {
    await seed({
      'old.md': '# owned\n',
      '.old.md.nuvyn-journal-aaaa': JSON.stringify({
        version: 1, op: 'document-rename-references', phase: 'preparing',
        srcRel: 'old', destRel: 'evil/new-name', documentId: 'rename-id',
        sourceHash: sha256Hex('# owned\n'),
        references: [{
          path: 'ref-a', beforeHash: sha256Hex('[[old]]\n'), afterHash: sha256Hex('[[new]]\n'),
          beforePayload: '.old.md.nuvyn-ref-before-aaaa-0', afterPayload: '.old.md.nuvyn-ref-after-aaaa-0',
        }],
      }),
    })
    saveDocumentMetadata(db, { id: 'rename-id', path: 'old', title: 'Old', updatedAt: 1 })

    const report = await runRecovery()

    expect(report.actions.some((a) =>
      a.action === 'quarantined'
      && a.detail === 'invalid durable rename-reference bundle')).toBe(true)
    expect((await fs.readdir(outside)).some((name) => name.includes('.nuvyn-'))).toBe(false)
    expect(await fs.readFile(path.join(vault, 'old.md'), 'utf8')).toBe('# owned\n')
  })

  it('never descends symlinked directories while scanning for artifacts', async () => {
    // Defense in depth: a fully valid-looking journal planted INSIDE
    // the symlinked directory (on disk: outside the vault) is never
    // found by the walk, so nothing outside is ever read, replayed,
    // or removed.
    await fs.writeFile(path.join(outside, 'old2.md'), '# owned2\n', 'utf8')
    await fs.writeFile(path.join(outside, '.old2.md.nuvyn-journal-aaaa'), JSON.stringify({
      version: 1, op: 'file-rename', srcRel: 'old2', destRel: 'new2',
      staging: '.old2.md.nuvyn-rename-aaaa', documentId: 'id-2',
      sourceHash: sha256Hex('# owned2\n'),
    }), 'utf8')

    const report = await runRecovery()

    expect(report.actions.every((a) => !a.file.includes('old2'))).toBe(true)
    expect(await fs.readFile(path.join(outside, 'old2.md'), 'utf8')).toBe('# owned2\n')
    expect(await fs.stat(path.join(outside, '.old2.md.nuvyn-journal-aaaa')).then(() => true, () => false)).toBe(true)
  })

  it('quarantines a folder-move entry whose SOURCE path escapes through a nested symlink', async () => {
    // Round-8 P0/P1: `vault/proj/sub → outside` with a journaled entry
    // `sub/victim.bin`. Even though `proj` itself is a real directory,
    // replay would rename/hash/link OUTSIDE the vault. Every entry's
    // source and destination path is containment-checked before any
    // filesystem touch, so the journal quarantines and the sentinel
    // outside is never read, moved, or linked.
    const VICTIM = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    await fs.writeFile(path.join(outside, 'victim.bin'), VICTIM)
    await fs.mkdir(path.join(vault, 'proj'), { recursive: true })
    await fs.symlink(outside, path.join(vault, 'proj', 'sub'), process.platform === 'win32' ? 'junction' : 'dir')
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-aaaa'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [{ relativeFilePath: 'sub/victim.bin', sourceHash: sha256HexBuffer(VICTIM) }],
      directories: ['sub'],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report, '.proj.nuvyn-journal-aaaa')
    // Sentinel untouched and still outside; nothing linked into vault.
    expect(await fs.readFile(path.join(outside, 'victim.bin'))).toEqual(VICTIM)
    expect(await fs.stat(path.join(vault, 'ren', 'sub', 'victim.bin')).then(() => true, () => false)).toBe(false)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-aaaa')
  })

  it('quarantines a folder-move entry whose DESTINATION path escapes through a nested symlink', async () => {
    const VICTIM = Buffer.from([0xca, 0xfe, 0xf0, 0x0d])
    await fs.writeFile(path.join(outside, 'victim.bin'), VICTIM)
    // A real source file to move; the destination subdir is the symlink.
    await fs.mkdir(path.join(vault, 'proj', 'sub'), { recursive: true })
    await fs.writeFile(path.join(vault, 'proj', 'sub', 'victim.bin'), VICTIM)
    await fs.mkdir(path.join(vault, 'ren'), { recursive: true })
    await fs.symlink(outside, path.join(vault, 'ren', 'sub'), process.platform === 'win32' ? 'junction' : 'dir')
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-aaaa'), JSON.stringify({
      version: 2, op: 'folder-rename', srcRel: 'proj', destRel: 'ren', strategy: 'replayable-move',
      sourceDev: 7, sourceIno: 11,
      entries: [{ relativeFilePath: 'sub/victim.bin', sourceHash: sha256HexBuffer(VICTIM) }],
      directories: ['sub'],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')

    const report = await runRecovery()

    expectWeakLegacyFolderJournal(report, '.proj.nuvyn-journal-aaaa')
    expect(await fs.readFile(path.join(outside, 'victim.bin'))).toEqual(VICTIM)
    // Source never moved toward the symlinked destination.
    expect(await fs.readFile(path.join(vault, 'proj', 'sub', 'victim.bin'))).toEqual(VICTIM)
    expect(await namesIn()).toContain('.proj.nuvyn-journal-aaaa')
  })
})

describe('recoverInterruptedOperations (folder reference content proof)', () => {
  // Directory dev/ino is weak evidence: recycled after external
  // delete/recreate, unreliable on some Windows file systems, and a
  // replayable move's destination directory is brand new. A forged
  // journal carrying the destination's REAL dev/ino must still fail
  // when the destination files are an external recreation — every
  // journaled document has to hold its journaled content hash.
  async function folderReferenceJournal(dev: number, ino: number, identitySourceHash: string): Promise<string> {
    return JSON.stringify({
      version: 1, op: 'folder-rename-references', phase: 'roll-forward',
      srcRel: 'proj', destRel: 'ren',
      sourceDev: dev, sourceIno: ino,
      identities: [{ path: 'proj/a', id: 'a-id', sourceHash: identitySourceHash }],
      references: [{
        path: 'ref-a', beforeHash: sha256Hex('[[old]]\n'), afterHash: sha256Hex('[[new]]\n'),
        beforePayload: '.proj.nuvyn-ref-before-aaaa-0', afterPayload: '.proj.nuvyn-ref-after-aaaa-0',
      }],
    })
  }

  it('quarantines a roll-forward whose destination files are an external recreation even when the directory inode matches', async () => {
    await seed({
      'ren/a.md': '# external\n',
      'ref-a.md': '[[old]]\n',
      '.proj.nuvyn-ref-before-aaaa-0': '[[old]]\n',
      '.proj.nuvyn-ref-after-aaaa-0': '[[new]]\n',
    })
    // Forge the journal with the destination directory's REAL dev/ino:
    // the legacy inode+existence proof would pass; only the per-file
    // content hashes catch the external recreation.
    const destStat = await fs.stat(path.join(vault, 'ren'))
    await fs.writeFile(
      path.join(vault, '.proj.nuvyn-journal-aaaa'),
      await folderReferenceJournal(destStat.dev, destStat.ino, sha256Hex('# ours\n')),
      'utf8',
    )
    saveDocumentMetadata(db, { id: 'a-id', path: 'ren/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expect(report.actions.some((a) => a.action === 'quarantined' && a.detail?.includes('generation does not match'))).toBe(true)
    // The external file was never rewritten, the reference rewrite
    // never ran, and the journal stays authoritative.
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# external\n')
    expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('[[old]]\n')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-aaaa')
    expect(await namesIn()).toContain('.proj.nuvyn-ref-before-aaaa-0')
    // The stale identity binding to the foreign bytes is detached.
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
  })

  it('completes a roll-forward when every destination file matches its journaled content hash', async () => {
    await seed({
      'ren/a.md': '# ours\n',
      'ref-a.md': '[[old]]\n',
      '.proj.nuvyn-ref-before-aaaa-0': '[[old]]\n',
      '.proj.nuvyn-ref-after-aaaa-0': '[[new]]\n',
    })
    const destStat = await fs.stat(path.join(vault, 'ren'))
    await fs.writeFile(
      path.join(vault, '.proj.nuvyn-journal-aaaa'),
      await folderReferenceJournal(destStat.dev, destStat.ino, sha256Hex('# ours\n')),
      'utf8',
    )

    const report = await runRecovery()

    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(false)
    expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('[[new]]\n')
    expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-') || name.includes('.nuvyn-ref-'))).toBe(false)
  })

  it('enforces the content proof when the journal carries Windows large file IDs beyond MAX_SAFE_INTEGER', async () => {
    // The production route writes the real stat values: on volumes with
    // file IDs beyond 2**53 the journal must still parse — and the
    // per-file content hashes must still be the deciding proof.
    await seed({
      'ren/a.md': '# external\n',
      'ref-a.md': '[[old]]\n',
      '.proj.nuvyn-ref-before-aaaa-0': '[[old]]\n',
      '.proj.nuvyn-ref-after-aaaa-0': '[[new]]\n',
    })
    await fs.writeFile(
      path.join(vault, '.proj.nuvyn-journal-aaaa'),
      await folderReferenceJournal(2 ** 60, 2 ** 61, sha256Hex('# ours\n')),
      'utf8',
    )
    saveDocumentMetadata(db, { id: 'a-id', path: 'ren/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expect(report.actions.some((a) => a.action === 'quarantined' && a.detail?.includes('generation does not match'))).toBe(true)
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# external\n')
    expect(getDocumentMetadata(db, 'ren/a')).toBeNull()
  })

  it('rejects a journal with MIXED hash coverage instead of downgrading to the weak proof', async () => {
    // Round-7 P2: one stripped sourceHash must not silently downgrade
    // the WHOLE directory to dev/ino + existence — a forged or damaged
    // journal would turn off the content proof entirely. Mixed
    // coverage is unparseable: the journal stays for inspection and
    // nothing is touched.
    await seed({
      'ren/a.md': '# external\n',
      'ren/b.md': '# external too\n',
      'ref-a.md': '[[old]]\n',
      '.proj.nuvyn-ref-before-aaaa-0': '[[old]]\n',
      '.proj.nuvyn-ref-after-aaaa-0': '[[new]]\n',
    })
    const destStat = await fs.stat(path.join(vault, 'ren'))
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-aaaa'), JSON.stringify({
      version: 1, op: 'folder-rename-references', phase: 'roll-forward',
      srcRel: 'proj', destRel: 'ren',
      sourceDev: destStat.dev, sourceIno: destStat.ino,
      identities: [
        { path: 'proj/a', id: 'a-id', sourceHash: sha256Hex('# ours\n') },
        { path: 'proj/b', id: 'b-id' },
      ],
      references: [{
        path: 'ref-a', beforeHash: sha256Hex('[[old]]\n'), afterHash: sha256Hex('[[new]]\n'),
        beforePayload: '.proj.nuvyn-ref-before-aaaa-0', afterPayload: '.proj.nuvyn-ref-after-aaaa-0',
      }],
    }), 'utf8')
    saveDocumentMetadata(db, { id: 'a-id', path: 'ren/a', title: 'A', updatedAt: 1 })

    const report = await runRecovery()

    expect(report.actions.some((a) => a.action === 'quarantined' && a.detail?.includes('unrecognized'))).toBe(true)
    // Nothing was detached, rewritten, or removed.
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('a-id')
    expect(await fs.readFile(path.join(vault, 'ref-a.md'), 'utf8')).toBe('[[old]]\n')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-aaaa')
  })

  it('proves an internal backlink document by its DESTINATION reference path, not its source identity', async () => {
    // Round-7 P1: a document INSIDE the renamed folder that links into
    // the folder carries its reference under the DESTINATION path (the
    // route rewrites internal sources to their new home). When its
    // rewrite already landed before the crash, the file no longer
    // matches sourceHash — the after-rewrite proof must look the
    // identity up at destRel + suffix, or the legitimate destination
    // generation is misjudged as external and its identity detached.
    const internalBefore = '# a sees [[proj/b]]\n'
    const internalAfter = '# a sees [[ren/b]]\n'
    await seed({
      'ren/a.md': internalAfter,
      'ren/b.md': '# b\n',
      '.proj.nuvyn-ref-before-aaaa-0': internalBefore,
      '.proj.nuvyn-ref-after-aaaa-0': internalAfter,
    })
    const destStat = await fs.stat(path.join(vault, 'ren'))
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-aaaa'), JSON.stringify({
      version: 1, op: 'folder-rename-references', phase: 'roll-forward',
      srcRel: 'proj', destRel: 'ren',
      sourceDev: destStat.dev, sourceIno: destStat.ino,
      identities: [
        { path: 'proj/a', id: 'a-id', sourceHash: sha256Hex(internalBefore) },
        { path: 'proj/b', id: 'b-id', sourceHash: sha256Hex('# b\n') },
      ],
      references: [{
        path: 'ren/a', beforeHash: sha256Hex(internalBefore), afterHash: sha256Hex(internalAfter),
        beforePayload: '.proj.nuvyn-ref-before-aaaa-0', afterPayload: '.proj.nuvyn-ref-after-aaaa-0',
      }],
    }), 'utf8')
    saveDocumentMetadata(db, { id: 'a-id', path: 'ren/a', title: 'A', updatedAt: 1 })
    saveDocumentMetadata(db, { id: 'b-id', path: 'ren/b', title: 'B', updatedAt: 1 })

    const report = await runRecovery()

    // Completes — NOT quarantined — with both identities intact.
    expect(report.actions.some((a) => a.action === 'completed-rename')).toBe(true)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(false)
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('a-id')
    expect(getDocumentMetadata(db, 'ren/b')?.id).toBe('b-id')
    expect((await namesIn()).some((name) => name.includes('.nuvyn-journal-') || name.includes('.nuvyn-ref-'))).toBe(false)
  })
})

describe('recoverInterruptedOperations (multi-pass dependency chains)', () => {
  // Round-8 P1/P2: a single crash can leave a CHAIN of dependent
  // artifacts — an inner `.nuvyn-rename-*` staging that a companion
  // folder-move journal needs restored before IT can complete, which a
  // rename-reference journal in turn waits on. A fixed two-pass scan
  // cannot close arbitrarily deep chains in one startup, so recovery
  // loops until a pass makes no progress (capped by artifact count).
  it('restores the independently-owned inner staging but stops at a weak legacy folder journal', async () => {
    const A_RAW = '# a\n'
    const B_RAW = '# b\n'
    const internalBefore = '[[old]]\n'
    const internalAfter = '[[new]]\n'
    // Layer 3 (outermost): a folder rename-reference transaction in
    // roll-back, waiting for the tree to settle at the source.
    await fs.writeFile(path.join(vault, '.proj.nuvyn-journal-aaa'), JSON.stringify({
      version: 1, op: 'folder-rename-references', phase: 'roll-back',
      srcRel: 'proj', destRel: 'ren', sourceDev: 0, sourceIno: 0,
      identities: [
        { path: 'proj/a', id: 'a-id', sourceHash: sha256Hex(A_RAW) },
        { path: 'proj/b', id: 'b-id', sourceHash: sha256Hex(B_RAW) },
      ],
      references: [{
        path: 'ref', beforeHash: sha256Hex(internalBefore), afterHash: sha256Hex(internalAfter),
        beforePayload: '.proj.nuvyn-ref-before-aaa-0', afterPayload: '.proj.nuvyn-ref-after-aaa-0',
      }],
    }), 'utf8')
    await fs.writeFile(path.join(vault, '.proj.nuvyn-ref-before-aaa-0'), internalBefore, 'utf8')
    await fs.writeFile(path.join(vault, '.proj.nuvyn-ref-after-aaa-0'), internalAfter, 'utf8')
    await fs.writeFile(path.join(vault, 'ref.md'), internalAfter, 'utf8')
    // Layer 2: the companion folder-move journal (ren → proj) recovery
    // wrote before reversing the tree. One entry (b.md) already landed
    // at proj; the other (a.md) was mid-move when the process died.
    await fs.mkdir(path.join(vault, 'proj'), { recursive: true })
    await fs.writeFile(path.join(vault, 'proj', 'b.md'), B_RAW, 'utf8')
    await fs.writeFile(path.join(vault, '.ren.nuvyn-journal-bbb'), JSON.stringify({
      version: 2, op: 'folder-move', srcRel: 'ren', destRel: 'proj', strategy: 'replayable-move',
      sourceDev: 0, sourceIno: 0,
      entries: [
        { relativeFilePath: 'a.md', sourceHash: sha256Hex(A_RAW) },
        { relativeFilePath: 'b.md', sourceHash: sha256Hex(B_RAW) },
      ],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')
    // Layer 1 (innermost): a.md was taken aside to staging but the
    // destination link was never created (kill after takeover).
    await fs.mkdir(path.join(vault, 'ren'), { recursive: true })
    await fs.writeFile(path.join(vault, 'ren', '.a.md.nuvyn-rename-ccc'), A_RAW, 'utf8')
    // Metadata still sits at the source prefix (the move predates it).
    saveDocumentMetadata(db, { id: 'a-id', path: 'ren/a', title: 'A', updatedAt: 1 })
    saveDocumentMetadata(db, { id: 'b-id', path: 'ren/b', title: 'B', updatedAt: 1 })

    // The inner file staging has its own sufficient proof and can be
    // restored. The v2 companion cannot authorize the next mutation,
    // so recovery must stop the dependency chain there.
    const report = await runRecovery()

    expect(report.actions.some((a) => a.action === 'restored')).toBe(true)
    expectWeakLegacyFolderJournal(report, '.ren.nuvyn-journal-bbb')
    expect(report.actions.filter((a) => a.action === 'completed-rename')).toHaveLength(0)
    // The chain remains split exactly at the weak boundary.
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe(A_RAW)
    expect(await fs.readFile(path.join(vault, 'proj/b.md'), 'utf8')).toBe(B_RAW)
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('a-id')
    expect(getDocumentMetadata(db, 'ren/b')?.id).toBe('b-id')
    expect(getDocumentMetadata(db, 'proj/a')).toBeNull()
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe(internalAfter)
    expect(await namesIn()).toContain('.ren.nuvyn-journal-bbb')
    expect(await namesIn()).toContain('.proj.nuvyn-journal-aaa')
    expect((await namesIn('ren')).some((name) => name.includes('.nuvyn-rename-'))).toBe(false)
    // Idempotent.
    await runRecovery()
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('a-id')
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe(internalAfter)
  })
})
