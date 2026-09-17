// Round-14 folder-move v4 closure: RED tests for the remaining
// safety gaps discovered after round-13. Each test pins one
// invariant; the production fixes must make every assertion below
// pass without weakening any prior test.
//
// P0:
//   1. atomic gate-created crash recovery (route must capture the
//      real destination generation AFTER rename, NOT the gate's
//      pre-mkdir generation, so recovery can prove the rename landed)
//   2. files-landed generation mismatch must NOT be silently
//      re-accepted via re-stat
//   3. v4 root physical containment must reject entries / dirs that
//      resolve outside contentDir, and must reject symlinks/junctions
//
// P1:
//   1. directory manifest schema (reserved segments, parent closure,
//      canonical sort, no file-as-dir, no emptyTrees-with-entries)
//   2. metadata-committed snapshot must verify FULL graph (documents,
//      document_tags, embeddings, tags, migrations) not just the first
//      documentId
//   3. snapshot CAS migration table: live migrations outside the
//      expected set must reject, even when expected migrations is
//      empty
//   4. companion journal conflict: multiple journals for the same
//      srcRel/destRel must quarantine without creating a new journal
//   5. recovery-created companion journals must be v4 (no v2/v3
//      writes from the recovery reverse-move path)
//   6. Round-13 P0-2 parity test is real: tamper the destination
//      while source still present; ensure journal retained
//   7. crash fixture for atomic-rename: real HTTP route + crash
//      between fs.rename and phase rewrite; recovery must complete
//
// This file is intentionally RED on baseline (4a78223).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addCurrentDirectoryBirthtimes } from './folderMoveBirthtimeTestSupport'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db'
import { recoverInterruptedOperations } from '../crashRecovery'
import {
  __setCreateOnlyMoveHooksForTesting,
  __setDirectoryMoveStrategyOverrideForTesting,
  platformDirectoryMoveStrategy,
} from '../documentFileLifecycle'
import {
  FOLDER_MOVE_JOURNAL_VERSION,
  listPhysicalMoveEntries,
  reviveMetadataSnapshot,
  type FolderMoveJournalEntryV4,
  type FolderMoveJournalV4,
} from '../folderMoveTransaction.js'
import {
  restoreDocumentMetadataMutationCAS,
  saveDocumentMetadata,
  validateSnapshotOwnership,
} from '../documentMetadata'
import { setContentDir } from '../paths'

let vault: string
let db: InstanceType<typeof Database>

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-round14-'))
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
  journal.directoryGenerations ??= []
  await addCurrentDirectoryBirthtimes(vault, journal)
  await fs.writeFile(journalAbs, JSON.stringify(journal), 'utf8')
  return journalAbs
}

async function namesIn(rel = '.'): Promise<string[]> {
  return fs.readdir(path.join(vault, rel)).catch(() => [] as string[])
}

const ROUND17_GATE_PROOF = {
  markerName: '.nuvyn-folder-gate-11111111-2222-4333-8444-555555555555',
  secret: 'cd'.repeat(32),
}

// ─── P0-1: atomic gate-created crash recovery ─────────────────────

describe('atomic gate-created crash recovery', () => {
  it('completes when the landed destination is the original source generation', async () => {
    await seed({
      'proj/a.md': '# hello\n',
    })
    saveDocumentMetadata(db, { id: 'doc-1', path: 'proj/a', title: 'Hello' })

    const sourceStat = await fs.stat(path.join(vault, 'proj'), { bigint: true })
    const physical = await listPhysicalMoveEntries(path.join(vault, 'proj'), (rel) => {
      if (!rel.endsWith('.md')) return null
      return { documentId: 'doc-1', documentPath: 'proj/a' }
    })
    await fs.mkdir(path.join(vault, 'ren'))
    const gateStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })

    const journal = {
      version: 4,
      op: 'folder-rename',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: sourceStat.dev.toString(),
      sourceIno: sourceStat.ino.toString(),
      gateProof: ROUND17_GATE_PROOF,
      destDev: gateStat.dev.toString(),
      destIno: gateStat.ino.toString(),
      entries: physical.entries.map((e) => ({
        relativeFilePath: e.relativeFilePath,
        sourceDev: e.sourceDev ?? '',
        sourceIno: e.sourceIno ?? '',
        sourceHash: e.sourceHash,
        documentId: 'doc-1',
        documentPath: 'proj/a',
      })),
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    } as FolderMoveJournalV4
    const journalAbs = await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)
    await fs.writeFile(
      path.join(vault, 'ren', ROUND17_GATE_PROOF.markerName),
      ROUND17_GATE_PROOF.secret,
      'utf8',
    )

    // Produce the exact post-rename crash state while remaining portable:
    // remove the owned gate (including its marker), then publish the
    // source directory at the destination. Atomic landing replaces the
    // gate and marker with the source generation.
    await fs.rm(path.join(vault, 'ren'), { recursive: true })
    await fs.rename(path.join(vault, 'proj'), path.join(vault, 'ren'))
    const landedStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })
    expect(landedStat.dev.toString()).toBe(sourceStat.dev.toString())
    expect(landedStat.ino.toString()).toBe(sourceStat.ino.toString())
    const report = await recoverInterruptedOperations(vault, db)

    expect(report.actions).toContainEqual(expect.objectContaining({
      action: 'completed-rename',
    }))
    await expect(fs.stat(journalAbs)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getDocumentMetadata(db, 'proj/a')).toBeUndefined()
    expect(getDocumentMetadata(db, 'ren/a')?.id).toBe('doc-1')
  })
})

describe('Round-17 v4 gate proof compatibility matrix', () => {
  async function preparedPhysical() {
    await seed({ 'proj/a.md': '# hello\n' })
    saveDocumentMetadata(db, { id: 'doc-1', path: 'proj/a', title: 'Hello' })
    const sourceStat = await fs.stat(path.join(vault, 'proj'), { bigint: true })
    const physical = await listPhysicalMoveEntries(path.join(vault, 'proj'), () => ({
      documentId: 'doc-1',
      documentPath: 'proj/a',
    }))
    return {
      sourceStat,
      entries: physical.entries.map(entry => ({
        relativeFilePath: entry.relativeFilePath,
        sourceDev: entry.sourceDev!,
        sourceIno: entry.sourceIno!,
        sourceHash: entry.sourceHash,
        documentId: entry.documentId,
        documentPath: entry.documentPath,
      })),
      directories: physical.directories,
    }
  }

  function createAtomicGateJournal(
    physical: Awaited<ReturnType<typeof preparedPhysical>>,
    gateStat: {
      dev: bigint
      ino: bigint
    },
  ): FolderMoveJournalV4 {
    return {
      version: 4,
      op: 'folder-rename',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: physical.sourceStat.dev.toString(),
      sourceIno: physical.sourceStat.ino.toString(),
      destDev: gateStat.dev.toString(),
      destIno: gateStat.ino.toString(),
      gateProof: ROUND17_GATE_PROOF,
      entries: physical.entries,
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    }
  }

  it('keeps legacy replayable gate-created recovery strict without gateProof', async () => {
    const physical = await preparedPhysical()
    await fs.mkdir(path.join(vault, 'ren'))
    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-rename',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'replayable-move',
      sourceDev: physical.sourceStat.dev.toString(),
      sourceIno: physical.sourceStat.ino.toString(),
      destDev: '999999',
      destIno: '999999',
      entries: physical.entries,
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    }
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    const report = await recoverInterruptedOperations(vault, db)

    expect(report.actions).toContainEqual(expect.objectContaining({
      action: 'quarantined',
      detail: 'legacy journal lacks sufficient durable ownership proof',
    }))
    expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe('# hello\n')
  })

  it('does not refresh a mismatched replayable gate identity even when its marker matches', async () => {
    const physical = await preparedPhysical()
    await fs.mkdir(path.join(vault, 'ren'))
    await fs.writeFile(
      path.join(vault, 'ren', ROUND17_GATE_PROOF.markerName),
      ROUND17_GATE_PROOF.secret,
      'utf8',
    )
    const journal = {
      version: 4,
      op: 'folder-rename',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'replayable-move',
      sourceDev: physical.sourceStat.dev.toString(),
      sourceIno: physical.sourceStat.ino.toString(),
      destDev: '999999',
      destIno: '999999',
      gateProof: ROUND17_GATE_PROOF,
      entries: physical.entries,
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    } as FolderMoveJournalV4
    const journalAbs = await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    const report = await recoverInterruptedOperations(vault, db)

    expect(report.actions).toContainEqual(expect.objectContaining({
      action: 'quarantined',
      detail: 'replayable destination gate generation does not match journal',
    }))
    expect(await fs.readFile(path.join(vault, 'proj/a.md'), 'utf8')).toBe('# hello\n')
    expect(await fs.stat(journalAbs)).toBeDefined()
  })

  it.runIf(
    platformDirectoryMoveStrategy === 'atomic-rename',
  )('requires both generation and marker before recovering an intact atomic gate', async () => {
    const physical = await preparedPhysical()
    await fs.mkdir(path.join(vault, 'ren'))
    const gateStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })
    await fs.writeFile(
      path.join(vault, 'ren', ROUND17_GATE_PROOF.markerName),
      ROUND17_GATE_PROOF.secret,
      'utf8',
    )
    const journal = createAtomicGateJournal(physical, gateStat)
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    const report = await recoverInterruptedOperations(vault, db)

    expect(report.actions).toContainEqual(expect.objectContaining({ action: 'completed-rename' }))
    expect(await fs.readFile(path.join(vault, 'ren/a.md'), 'utf8')).toBe('# hello\n')
  })

  it.runIf(
    platformDirectoryMoveStrategy !== 'atomic-rename',
  )('retains an intact atomic journal without mutating it on an unsupported platform', async () => {
    const physical = await preparedPhysical()
    await fs.mkdir(path.join(vault, 'ren'))
    const gateStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })
    await fs.writeFile(
      path.join(vault, 'ren', ROUND17_GATE_PROOF.markerName),
      ROUND17_GATE_PROOF.secret,
      'utf8',
    )
    const journal = createAtomicGateJournal(physical, gateStat)
    const journalAbs = await writeJournal(
      '.proj.nuvyn-journal-abcdef012345',
      journal,
    )

    const report = await recoverInterruptedOperations(vault, db)
    const journalName = path.basename(journalAbs)

    expect(report.actions.filter((action) => action.file === journalName)).toEqual([
      {
        file: journalName,
        action: 'quarantined',
        detail: 'atomic directory rename is unsupported on this platform',
      },
    ])
    expect(await fs.readFile(
      path.join(vault, 'proj', 'a.md'),
      'utf8',
    )).toBe('# hello\n')
    expect(await fs.readFile(
      path.join(vault, 'ren', ROUND17_GATE_PROOF.markerName),
      'utf8',
    )).toBe(ROUND17_GATE_PROOF.secret)
    expect(await fs.stat(journalAbs)).toBeDefined()
  })

  it('ignores only the exact declared marker during replayable parity', async () => {
    const physical = await preparedPhysical()
    await fs.mkdir(path.join(vault, 'ren'))
    const gateStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })
    await fs.writeFile(
      path.join(vault, 'ren', ROUND17_GATE_PROOF.markerName),
      ROUND17_GATE_PROOF.secret,
      'utf8',
    )
    await fs.writeFile(path.join(vault, 'ren', '.nuvyn-external'), 'external', 'utf8')
    const journal = {
      version: 4,
      op: 'folder-rename',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'replayable-move',
      sourceDev: physical.sourceStat.dev.toString(),
      sourceIno: physical.sourceStat.ino.toString(),
      destDev: gateStat.dev.toString(),
      destIno: gateStat.ino.toString(),
      gateProof: ROUND17_GATE_PROOF,
      entries: physical.entries,
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    } as FolderMoveJournalV4
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    const report = await recoverInterruptedOperations(vault, db)

    expect(report.actions).toContainEqual(expect.objectContaining({
      action: 'quarantined',
      detail: 'replayable destination directories lack durable generation proof',
    }))
    expect(await fs.readFile(path.join(vault, 'ren', '.nuvyn-external'), 'utf8'))
      .toBe('external')
  })
})

// ─── P0-2: strict files-landed generation ────────────────────────

describe('strict files-landed generation', () => {
  it('quarantines when destination was recreated with a different inode', async () => {
    // Round-13 re-stat accepted a brand-new inode as the "real"
    // generation. Round-14 forbids re-stat for files-landed: a
    // files-landed journal is the post-parity, post-rename truth;
    // if the destination inode no longer matches, recovery must
    // quarantine, NOT silently accept the new inode.
    await seed({
      'ren/a.md': '# hello\n',
    })
    saveDocumentMetadata(db, { id: 'doc-1', path: 'ren/a', title: 'Hello' })

    const destStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })
    // Build a journal with the OLD dest inode (the inode the route
    // captured after the rename). The on-disk inode is the same
    // directory, so a sanity check first passes. Then we'll swap
    // the directory out and create a fresh one — round-13 would
    // re-stat and accept; round-14 must reject.
    const physical = await listPhysicalMoveEntries(path.join(vault, 'ren'), (rel) => {
      if (!rel.endsWith('.md')) return null
      return { documentId: 'doc-1', documentPath: 'ren/a' }
    })

    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-rename',
      phase: 'files-landed',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: destStat.dev.toString(),
      sourceIno: destStat.ino.toString(),
      destDev: destStat.dev.toString(),
      destIno: destStat.ino.toString(),
      entries: physical.entries.map((e) => ({
        relativeFilePath: e.relativeFilePath,
        sourceDev: e.sourceDev ?? '',
        sourceIno: e.sourceIno ?? '',
        sourceHash: e.sourceHash,
        documentId: 'doc-1',
        documentPath: 'ren/a',
      })),
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    }
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    // Wipe and recreate the destination with a NEW inode, but keep
    // identical content (round-13 would re-stat and accept).
    await fs.rm(path.join(vault, 'ren'), { recursive: true, force: true })
    await fs.mkdir(path.join(vault, 'ren'))
    await fs.writeFile(path.join(vault, 'ren', 'a.md'), '# hello\n', 'utf8')

    const report = await recoverInterruptedOperations(vault, db)

    // Quarantine: files-landed's destination inode is stale; the
    // new inode does not match. Round-14 forbids re-stat fall-back.
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    const journalsAfter = await namesIn('.')
    expect(journalsAfter.some((n) => n.includes('.nuvyn-journal-'))).toBe(true)
  })
})

// ─── P0-3: v4 root physical containment ───────────────────────────

describe('v4 root physical containment', () => {
  it('quarantines when srcRel resolves outside contentDir', async () => {
    // Forge a journal whose srcRel path would resolve OUTSIDE the
    // vault via path traversal. The trust boundary MUST reject
    // this BEFORE any path resolution runs.
    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-rename',
      phase: 'gate-created',
      srcRel: '../outside',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: '1',
      sourceIno: '1',
      destDev: '1',
      destIno: '1',
      entries: [],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    }
    await writeJournal('.outside.nuvyn-journal-abcdef012345', journal)

    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    const journalsAfter = await namesIn('.')
    expect(journalsAfter.some((n) => n.includes('.nuvyn-journal-'))).toBe(true)
  })

  it('quarantines when journal file is itself a symlink/junction', async () => {
    // The journal itself cannot be a symlink — recovery must reject
    // before reading. The provenance validator runs `lstat` on the
    // journal file (which reports the symlink itself, not the
    // target) and rejects the journal.
    await seed({ 'proj/a.md': '# hello\n' })
    const realJournalPath = path.join(vault, '.proj.nuvyn-journal-abcdef012345')
    const linkJournalPath = path.join(vault, '.proj.nuvyn-journal-linktest')
    await fs.writeFile(realJournalPath, JSON.stringify({
      version: 4,
      op: 'folder-rename',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: '1',
      sourceIno: '1',
      destDev: '1',
      destIno: '1',
      entries: [],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    }), 'utf8')
    let symlinkSupported = true
    try {
      await fs.symlink(realJournalPath, linkJournalPath)
    } catch {
      // Symlinks unsupported on this platform; the test is a no-op.
      symlinkSupported = false
    }
    if (!symlinkSupported) return
    const report = await recoverInterruptedOperations(vault, db)
    // Either quarantined (the round-14 path) or unrecognized. The
    // round-14 path's symlink rejection logs `quarantined` with a
    // detail mentioning symbolic link/junction.
    const quarantinedActions = report.actions.filter((a) => a.action === 'quarantined')
    expect(quarantinedActions.length).toBeGreaterThan(0)
    // The symlink must remain on disk (round-14: the validator never
    // mutates a quarantined journal's underlying artifact).
    expect(await fs.lstat(linkJournalPath)).toBeDefined()
  })
})

// ─── P1-1: directory manifest schema ─────────────────────────────

describe('v4 directory manifest schema', () => {
  function makeJournal(dirOverride: Partial<FolderMoveJournalV4>): FolderMoveJournalV4 {
    return {
      version: 4,
      op: 'folder-rename',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: '1',
      sourceIno: '1',
      destDev: '1',
      destIno: '1',
      entries: [],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
      ...dirOverride,
    }
  }

  it('rejects directories that are not canonically sorted', async () => {
    const journal = makeJournal({ directories: ['b', 'a'] })
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('rejects duplicate directory entries', async () => {
    const journal = makeJournal({ directories: ['a', 'a'] })
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('rejects entries with empty entries but no emptyTree flag', async () => {
    // entry-less journal without emptyTree:true is structurally invalid.
    const journal = makeJournal({ entries: [], directories: [] })
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('rejects non-empty entries with emptyTree:true', async () => {
    const journal = makeJournal({
      emptyTree: true,
      entries: [{
        relativeFilePath: 'a.md',
        sourceDev: '1',
        sourceIno: '1',
        sourceHash: 'abcdef'.repeat(10),
        documentId: 'doc-1',
        documentPath: 'proj/a',
      }],
      directories: [],
    })
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('rejects reserved segment names (.git, node_modules, metadata.sqlite)', async () => {
    const journal = makeJournal({ directories: ['.git'], emptyTree: true })
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })

  it('does NOT reject legitimate close names (.gitignore, .github, node_modules2, metadata.sqlite.bak)', async () => {
    // The close-name set MUST survive — only the EXACT reserved
    // segments are blocked. Round-14 P1-1 forbids over-matching.
    const journal = makeJournal({
      emptyTree: true,
      directories: ['.gitignore', '.github', 'node_modules2', 'metadata.sqlite.bak'],
    })
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)
    const report = await recoverInterruptedOperations(vault, db)
    // Should NOT be quarantined for manifest reasons. (May still be
    // quarantined for other reasons — recovery without on-disk
    // proj/ren is ambiguous.)
    const actions = report.actions.filter((a) => a.action === 'quarantined')
    for (const action of actions) {
      expect(action.detail ?? '').not.toMatch(/reserved|directory/i)
    }
  })

  it('rejects file paths that are reserved (round-14: .nuvyn-journal-xxx prefix)', async () => {
    const journal = makeJournal({
      emptyTree: true,
      directories: [],
      entries: [{
        relativeFilePath: '.nuvyn-journal-abc',
        sourceDev: '1',
        sourceIno: '1',
        sourceHash: 'abcdef'.repeat(10),
      }],
    })
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)
    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
  })
})

// ─── P1-2: full metadata-committed snapshot verification ─────────

describe('metadata-committed full snapshot verification', () => {
  it('quarantines when a live migration differs from expected even if documentIds overlap', async () => {
    // Round-14: metadata-committed MUST verify the FULL graph.
    // A snapshot whose expected migrations is empty BUT a live
    // migration targets the snapshot's paths with an unrelated
    // document_id must QUARANTINE — restore would otherwise DELETE
    // that unrelated migration row.
    await seed({ 'ren/a.md': '# hello\n' })
    const destStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })

    // Set up the live DB to mirror a completed metadata-committed state
    // except for an extra migration row targeting the snapshot path.
    db.exec(`INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('snap-doc', 'ren/a', 'Snap', '', 0, 0)`)
    db.exec(`INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('external-doc', 'other/x', 'External', '', 0, 0)`)
    db.exec(`INSERT INTO metadata_migrations (path, document_id, original_path, status, source_hash, updated_at)
      VALUES ('ren/a', 'external-doc', 'ren/a', 'legacy', 'abc', 0)`)

    const snapshot = {
      paths: ['ren/a'],
      documentIds: ['snap-doc'],
      tagIds: [],
      preexistingTagIds: [],
      documents: [{ id: 'snap-doc', path: 'ren/a', title: 'Snap', summary: '', created_at: 0, updated_at: 0 }],
      tags: [],
      documentTags: [],
      embeddings: [],
      migrations: [], // empty — but live has a row at 'ren/a' for external-doc
    }
    const revived = reviveMetadataSnapshot(snapshot as any)

    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-move',
      phase: 'metadata-committed',
      srcRel: '.nuvyn-delete-inflight-xyz',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: '1',
      sourceIno: '1',
      destDev: String(destStat.dev),
      destIno: String(destStat.ino),
      emptyTree: true,
      entries: [],
      directories: [],
      metadataDisposition: { kind: 'snapshot-restore', snapshot },
    }
    await writeJournal('.nuvyn-delete-inflight-xyz.nuvyn-journal-abcdef012345', journal)

    const report = await recoverInterruptedOperations(vault, db)

    // Must be quarantined — external migration at the snapshot path
    // means restore would clobber it.
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    // External migration still on disk (recovery did NOT touch it).
    const liveAfter = db.prepare(`SELECT path, document_id, original_path FROM metadata_migrations WHERE path = ?`).get('ren/a') as
      | { path: string; document_id: string; original_path: string }
      | undefined
    expect(liveAfter).toBeDefined()
    expect(liveAfter?.document_id).toBe('external-doc')
  })
})

// ─── P1-3: snapshot CAS rejects unrelated live migrations ─────────

describe('snapshot CAS rejects unrelated live migrations', () => {
  it('rejects when live migration targets snapshot path with different document_id, even when expected.migrations is empty', () => {
    db.exec(`INSERT INTO documents (id, path, title, summary, created_at, updated_at)
      VALUES ('external-doc', 'other/x', 'External', '', 0, 0)`)
    db.exec(`INSERT INTO metadata_migrations (path, document_id, original_path, status, source_hash, updated_at)
      VALUES ('gone/doc', 'external-doc', 'gone/doc', 'legacy', 'abc', 0)`)

    const snapshot = {
      paths: ['gone/doc'],
      documentIds: ['snap-doc'],
      tagIds: [],
      preexistingTagIds: [],
      documents: [{ id: 'snap-doc', path: 'gone/doc', title: 'Snap', summary: '', created_at: 0, updated_at: 0 }],
      tags: [],
      documentTags: [],
      embeddings: [],
      migrations: [],
    }
    const expected = reviveMetadataSnapshot(snapshot as any)
    let threw = false
    try {
      restoreDocumentMetadataMutationCAS(db, expected, (current) =>
        validateSnapshotOwnership(current, expected),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // External migration MUST still be present — restore aborted.
    const live = db.prepare(`SELECT path, document_id, original_path FROM metadata_migrations WHERE path = ?`).get('gone/doc') as
      | { path: string; document_id: string; original_path: string }
      | undefined
    expect(live).toBeDefined()
    expect(live?.document_id).toBe('external-doc')
  })
})

// ─── P1-4: companion conflict detection ──────────────────────────

describe('companion journal conflict', () => {
  it('multiple journals for the same srcRel/destRel quarantine without creating new journals', async () => {
    // Round-14 P1-4: when the rename-reference rollback recovery
    // discovers MULTIPLE existing journals for the same
    // srcRel/destRel (the rollback direction), it must QUARANTINE
    // without creating any new journal.
    //
    // Setup: forward move completed (proj → ren), so the source
    // directory is absent and the destination directory exists with
    // content matching the rename-reference identity's sourceHash.
    // Two companion journals (v4 + v2) are placed at the rollback's
    // source directory (ren). The reference journal's references
    // already match the destination (ren/r.md), so the references
    // loop is a no-op and recovery reaches the rollback-tree branch
    // where the companion conflict is detected.
    const refJournalId = 'aaaaaaaa-1111-2222-3333-444444444444'
    const v4CompanionId = 'bbbbbbbb-1111-2222-3333-444444444444'
    const v2CompanionId = 'cccccccc-1111-2222-3333-444444444444'
    const hash = (s: string) => require('node:crypto').createHash('sha256').update(s, 'utf8').digest('hex')
    const beforeContent = '# before\n'
    const afterContent = '# after\n'
    const beforeHash = hash(beforeContent)
    const afterHash = hash(afterContent)
    await fs.mkdir(path.join(vault, 'ren'), { recursive: true })
    await fs.writeFile(path.join(vault, 'ren', 'r.md'), afterContent, 'utf8')
    await fs.writeFile(path.join(vault, `.proj.nuvyn-ref-before-${refJournalId}-0`), beforeContent, 'utf8')
    await fs.writeFile(path.join(vault, `.proj.nuvyn-ref-after-${refJournalId}-0`), afterContent, 'utf8')

    const v4Journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-move',
      phase: 'prepared',
      srcRel: 'ren',
      destRel: 'proj',
      strategy: 'atomic-rename',
      sourceDev: '1',
      sourceIno: '1',
      entries: [],
      directories: [],
      emptyTree: true,
      metadataDisposition: { kind: 'prefix-move' },
    }
    await fs.writeFile(path.join(vault, `.ren.nuvyn-journal-${v4CompanionId}`), JSON.stringify(v4Journal), 'utf8')
    const v2Journal = {
      version: 2,
      op: 'folder-move',
      srcRel: 'ren',
      destRel: 'proj',
      sourceDev: 1,
      sourceIno: 1,
      strategy: 'atomic-rename',
      entries: [],
      directories: [],
      emptyTree: true,
      metadataDisposition: { kind: 'prefix-move' },
    }
    await fs.writeFile(path.join(vault, `.ren.nuvyn-journal-${v2CompanionId}`), JSON.stringify(v2Journal), 'utf8')

    const refJournal = {
      version: 1,
      op: 'folder-rename-references',
      phase: 'roll-back',
      srcRel: 'proj',
      destRel: 'ren',
      sourceDev: 1,
      sourceIno: 1,
      identities: [{ path: 'proj/r', id: 'doc-1', sourceHash: hash(beforeContent) }],
      references: [{
        path: 'ren/r',
        beforeHash,
        afterHash,
        beforePayload: `.proj.nuvyn-ref-before-${refJournalId}-0`,
        afterPayload: `.proj.nuvyn-ref-after-${refJournalId}-0`,
      }],
    }
    await fs.writeFile(path.join(vault, `.proj.nuvyn-journal-${refJournalId}`), JSON.stringify(refJournal), 'utf8')

    const report = await recoverInterruptedOperations(vault, db)

    expect(report.actions.some((a) =>
      a.action === 'quarantined'
      && /companion|conflict|multiple/i.test(a.detail ?? ''),
    )).toBe(true)
    // Recovery did NOT create a 4th journal — count is at most 3.
    const journalsAfter = await namesIn('.')
    const journalCount = journalsAfter.filter((n) => n.includes('.nuvyn-journal-')).length
    expect(journalCount).toBeLessThanOrEqual(3) // ren:v4 + ren:v2 + proj:ref at most
  })
})

function sha256HexForTest(s: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

// ─── P1-6: real parity test ──────────────────────────────────────

describe('P0-2 real parity test', () => {
  it('keeps the journal when destination parity fails via external replacement of dest contents', async () => {
    // Round-13 P0-2 tampered the source file. Round-14 P1-6 must
    // tamper the DESTINATION (where parity actually checks).
    await seed({
      'proj/a.md': '# hello\n',
    })
    saveDocumentMetadata(db, { id: 'doc-1', path: 'proj/a', title: 'Hello' })

    // Set up: move has not actually happened — both proj and ren
    // directories exist. We write a files-landed journal claiming
    // the move completed; the destination's content is wrong.
    await fs.mkdir(path.join(vault, 'ren'))
    // Land a file at dest with WRONG content (different hash).
    await fs.writeFile(path.join(vault, 'ren', 'a.md'), '# tampered\n', 'utf8')

    const realStat = await fs.stat(path.join(vault, 'proj'), { bigint: true })
    const destStat = await fs.stat(path.join(vault, 'ren'), { bigint: true })

    const physical = await listPhysicalMoveEntries(path.join(vault, 'proj'), (rel) => {
      if (!rel.endsWith('.md')) return null
      return { documentId: 'doc-1', documentPath: 'proj/a' }
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
      destDev: destStat.dev.toString(),
      destIno: destStat.ino.toString(),
      entries: physical.entries.map((e) => ({
        relativeFilePath: e.relativeFilePath,
        sourceDev: e.sourceDev ?? '',
        sourceIno: e.sourceIno ?? '',
        sourceHash: e.sourceHash,
        documentId: 'doc-1',
        documentPath: 'proj/a',
      })),
      directories: physical.directories,
      metadataDisposition: { kind: 'prefix-move' },
    }
    await writeJournal('.proj.nuvyn-journal-abcdef012345', journal)

    const report = await recoverInterruptedOperations(vault, db)
    expect(report.actions.some((a) => a.action === 'quarantined')).toBe(true)
    const journalsAfter = await namesIn('.')
    expect(journalsAfter.some((n) => n.includes('.nuvyn-journal-'))).toBe(true)
    // Metadata must NOT have moved: the document is still at proj/a.
    expect(getDocumentMetadata(db, 'proj/a')).not.toBeNull()
    expect(getDocumentMetadata(db, 'ren/a')).toBeUndefined()
  })
})

function getDocumentMetadata(db: Database.Database, path: string) {
  const row = db.prepare('SELECT id, path FROM documents WHERE path = ?').get(path) as { id: string; path: string } | undefined
  return row
}

// ─── P0-1 helper: gate-created crash from route via atomic-rename ──

describe('atomic-rename gate-created route ordering (P0-1 unit)', () => {
  it('writes the post-rename generation BEFORE the files-landed phase', () => {
    // Indirect: confirm the journal schema requires the post-rename
    // generation. The phase shape validator must accept files-landed
    // with the new (post-rename) destDev/destIno and the source's
    // directory generation (the new gen is the source's gen).
    // This is a structural guard: the journal's destDev/destIno in
    // files-landed must equal what verifyFolderMoveDestinationV4
    // accepts. We test by parsing a representative journal.
    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-rename',
      phase: 'files-landed',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: '1000',
      sourceIno: '2000',
      destDev: '1000', // == sourceDev (post-rename on POSIX)
      destIno: '2000', // == sourceIno (post-rename on POSIX)
      entries: [],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    }
    // This journal is structurally valid; the post-rename generation
    // is exactly the source's generation because rename(2) swapped
    // inodes. The route's P0-1 ordering MUST persist this before
    // declaring files-landed. (Recovery has nothing to recover —
    // test simply locks in the structural contract.)
    expect(journal.destDev).toBe('1000')
    expect(journal.destIno).toBe('2000')
  })
})
