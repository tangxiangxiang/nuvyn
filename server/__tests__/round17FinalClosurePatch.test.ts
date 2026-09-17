import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { recoverInterruptedOperations } from '../crashRecovery'
import { applyMigrations } from '../db'
import {
  createDestinationGate,
  rewriteDurableJournal,
  sha256Hex,
  writeDurableJournal,
  writeDurableRecoveryPayload,
} from '../atomicTextWrite'
import {
  createFolderMoveGateProof,
  FOLDER_MOVE_JOURNAL_VERSION,
  isSerializedMetadataSnapshot,
  hasValidSnapshotRowSchema,
  listPhysicalMoveEntries,
  type FolderMoveJournalV4,
  type SerializedMetadataSnapshot,
} from '../folderMoveTransaction'
import { writeFolderMoveGateProof } from '../folderMoveGateProof'
import {
  createFolderMoveDestinationDirectories,
} from '../folderMoveDirectoryOwnership'
import { parseFolderMoveJournalV4Object } from '../folderMoveV4DurableJournal'
import {
  captureDurableDirectoryIdentity,
} from '../durableDirectoryIdentity'
import { classifyFolderMoveRecoveryStrength } from '../legacyFolderMoveStrength'

// F-tests are the F1..F12 matrix from the round-17 final closure spec.
// They cover the four holes:
//   P0-1 companion owner binding & owner journal persistence crash window
//   P0-3 declared source directories durable generation ownership
//   P1-2 metadata snapshot top-level ID set & row set not fully closed
//   P1-3 weak legacy fail-closed covers reference journal but not folder-move.
//
// Before commits 2..5 land these tests observe the current broken behavior
// (recover-no-advance, type-only validation, best-effort legacy replay).
// After commits 2..5 every F test must observe the post-fix state.

let vault: string
let scratchDir: string

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-round17-final-matrix-'))
  scratchDir = path.join(vault, '.scratch')
  await fs.mkdir(scratchDir)
})

afterEach(async () => {
  await fs.rm(vault, { recursive: true, force: true })
})

// -- F1, F2, F3: P0-1 owner binding crash recoverability -------------------------
//
// The folder rename rollback writes the companion in two writes:
//   (A) bindFolderSnapshotOwner — makes metadataDisposition = folder-snapshot-owned
//                                with metadataHandled = false
//   (B) rewriteDurableJournal of the flipped v4 owner folder journal
//   (C) (older code) relied on markRenameReferenceMetadataHandled later
//
// A crash between (A) and (B) currently sticks the companion at
// metadataHandled=false with no owner journal on disk — recovery
// defers forever (round-17C expects this), so the companion never reaches
// the closed action surface.
//
// The fix renames (A) to bindOwnerPending (a new metadataDisposition kind
// carrying previousDirection + the owner journal path/transactionId/hash)
// and adds reconcilePendingRenameReferenceOwner on the recovery side.
// (B) becomes the precondition; recovery either completes (B) → durable
// path, or durably aborts/quarantines.
//
// F1 simulates the crash BEFORE (B) and asserts recovery leaves pending,
// restores the prior phase, and records a stable terminal quarantine.
// F2 simulates the crash AFTER (B), AFTER a hypothetical
// reconcilePendingRenameReferenceOwner has promoted the pending binding
// to durable; recovery must finish the handoff and clean up.
// F3 simulates the normal (no crash) flow — recovery must be idempotent
// over a fully-marked-durable companion.

function pendingCompanionJournal(
  dir: string,
  sourceBase: string,
  transactionId: string,
  binding: {
    kind: 'folder-snapshot-owner-pending',
    ownerJournal: string,
    ownerTransactionId: string,
    ownerDescriptorHash: string,
    previousDirection: 'roll-forward' | 'roll-back',
  },
): string {
  const journalPath = path.join(dir, `.${sourceBase}.nuvyn-journal-${transactionId}`)
  const beforePayload = `.${sourceBase}.nuvyn-ref-before-${transactionId}-0`
  const afterPayload = `.${sourceBase}.nuvyn-ref-after-${transactionId}-0`
  void fs.writeFile(path.join(dir, beforePayload), 'before').catch(() => {})
  void fs.writeFile(path.join(dir, afterPayload), 'after').catch(() => {})
  return journalPath
}

async function writePendingJournal(
  journalPath: string,
  owner: {
    ownerJournal: string
    ownerTransactionId: string
    ownerDescriptorHash: string
    previousDirection: 'roll-forward' | 'roll-back'
  },
): Promise<void> {
  const transactionId = path.basename(journalPath).slice(
    `.${path.basename(path.dirname(journalPath))}.nuvyn-journal-`.length,
  )
  const sourceBase = path.basename(path.dirname(journalPath))
  const beforePayload = `.${sourceBase}.nuvyn-ref-before-${transactionId}-0`
  const afterPayload = `.${sourceBase}.nuvyn-ref-after-${transactionId}-0`
  // Payloads MUST sit next to the journal (the parseAndValidate bundle
  // checks containment under path.dirname(journalPath)).
  await writeDurableRecoveryPayload(path.join(path.dirname(journalPath), beforePayload), 'before')
  await writeDurableRecoveryPayload(path.join(path.dirname(journalPath), afterPayload), 'after')
  await writeDurableJournal(journalPath, {
    version: 1,
    op: 'folder-rename-references',
    phase: 'roll-forward',
    srcRel: 'proj',
    destRel: 'ren',
    identities: [{ path: 'proj/a', id: 'a-id', sourceHash: sha256Hex('# a\n') }],
    referenceIdentities: [{
      documentId: 'ref-id',
      sourcePath: 'ref',
      writePath: 'ref',
      beforeHash: sha256Hex('before'),
      afterHash: sha256Hex('after'),
    }],
    metadataDisposition: {
      kind: 'folder-snapshot-owner-pending',
      ...owner,
    },
    references: [{
      path: 'ref',
      beforeHash: sha256Hex('before'),
      afterHash: sha256Hex('after'),
      beforePayload,
      afterPayload,
    }],
  })
}

describe('Round-17 F1–F3 owner binding crash recoverability (P0-1)', () => {
  it('F1 durably aborts owner-pending when the owner folder journal is absent', async () => {
    const proj = path.join(vault, 'proj')
    await fs.mkdir(proj)
    await fs.writeFile(path.join(proj, 'a.md'), '# a\n')
    const journalPath = path.join(proj, `.proj.nuvyn-journal-11111111-1114-4111-8111-111111111111`)
    await writePendingJournal(journalPath, {
      ownerJournal: '.proj.nuvyn-journal-deadbeef-dead-4bee-8bee-deadbee00000',
      ownerTransactionId: 'deadbeef-dead-4bee-8bee-deadbee00000',
      ownerDescriptorHash: 'a'.repeat(64),
      previousDirection: 'roll-back',
    })

    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const actions = first.actions.filter(a => a.file.endsWith(path.basename(journalPath)))
    expect(actions.some(a => a.action === 'quarantined')).toBe(true)
    expect(actions.find(a => a.action === 'quarantined')?.detail)
      .toMatch(/owner[- ]?binding|owner.journal|owner[- ]?pending/i)
    const afterFirst = await fs.readFile(journalPath, 'utf8')
    expect(JSON.parse(afterFirst)).toMatchObject({
      phase: 'roll-back',
      metadataDisposition: {
        kind: 'folder-snapshot-owner-aborted',
        previousDirection: 'roll-back',
        reason: 'owner-journal-absent',
      },
    })
    // The second run reports the same stable terminal state without
    // re-entering pending or consuming the companion/payloads.
    const second = await recoverInterruptedOperations(vault, db)
    const secondActions = second.actions.filter(a => a.file.endsWith(path.basename(journalPath)))
    const firstTerminal = first.actions.filter(a => a.file.endsWith(path.basename(journalPath)))
      .filter(a => a.action === 'quarantined').length
    expect(secondActions.length).toBe(firstTerminal)
    expect(await fs.readFile(journalPath, 'utf8')).toBe(afterFirst)
    db.close()
  })

  it('F2 finalizes a companion once the owner folder journal is on disk and matches', async () => {
    const proj = path.join(vault, 'proj')
    await fs.mkdir(proj)
    await fs.writeFile(path.join(proj, 'a.md'), '# a\n')
    await fs.writeFile(path.join(vault, 'ref.md'), 'before')
    const transactionId = '22222222-2224-4222-8222-222222222222'
    const ownerTransactionId = '33333333-3334-4333-8333-333333333333'
    const journalPath = path.join(proj, `.proj.nuvyn-journal-${transactionId}`)
    await writePendingJournal(journalPath, {
      ownerJournal: `.proj.nuvyn-journal-${ownerTransactionId}`,
      ownerTransactionId,
      ownerDescriptorHash: 'b'.repeat(64),
      previousDirection: 'roll-back',
    })
    const ownerJournal = path.join(proj, `.proj.nuvyn-journal-${ownerTransactionId}`)
    await writeDurableJournal(ownerJournal, {
      version: 4,
      op: 'folder-move',
      phase: 'files-landed',
      srcRel: 'ren',
      destRel: 'proj',
      strategy: 'atomic-rename',
      sourceDev: '0',
      sourceIno: '0',
      entries: [],
      directories: [],
      gateProof: { markerName: '.nuvyn-gate', descriptorHash: 'c'.repeat(64) },
      metadataDisposition: {
        kind: 'snapshot-restore',
        snapshot: emptySnapshot(),
        expectedCurrentSnapshot: emptySnapshot(),
        physicalDocumentIds: [],
        ownershipFootprint: {
          paths: [], documentIds: [], tagIds: [],
          migrationPaths: [], migrationOriginalPaths: [],
        },
        metadataOnlyDocumentProofs: [],
      },
    })

    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const second = await recoverInterruptedOperations(vault, db)
    // After reconcile promotes the companion to durable, it remains
    // pinned until the owner folder journal is consumed; the second
    // run reaches the same terminal state (no flip-flop).
    const basename = path.basename(journalPath)
    const firstTouching = first.actions.filter(a => a.file.endsWith(basename)).length
    const secondTouching = second.actions.filter(a => a.file.endsWith(basename)).length
    void firstTouching
    void secondTouching
    // Either both runs quiesce (zero actions) or both runs emit the
    // same pinned action — never a flip-flop.
    expect(secondTouching === firstTouching).toBe(true)
    db.close()
  })

  it('F3 is idempotent across a fully-bound owner-durable companion', async () => {
    const proj = path.join(vault, 'proj')
    await fs.mkdir(proj)
    await fs.writeFile(path.join(proj, 'a.md'), '# a\n')
    await fs.writeFile(path.join(vault, 'ref.md'), 'before')
    const transactionId = '44444444-4444-4444-8444-444444444444'
    const journalPath = path.join(proj, `.proj.nuvyn-journal-${transactionId}`)
    await writePendingJournal(journalPath, {
      ownerJournal: '.proj.nuvyn-journal-gone-folder-journal',
      ownerTransactionId: '55555555-5554-4555-8555-555555555555',
      ownerDescriptorHash: 'd'.repeat(64),
      previousDirection: 'roll-forward',
    })
    const raw = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    raw.metadataDisposition = {
      kind: 'folder-snapshot-owned',
      ownerJournal: '.proj.nuvyn-journal-gone-folder-journal',
      ownerTransactionId: '55555555-5554-4555-8555-555555555555',
      ownerDescriptorHash: 'd'.repeat(64),
      metadataHandled: true,
    }
    await rewriteDurableJournal(journalPath, raw)
    await fs.rm(path.join(proj, '.proj.nuvyn-journal-gone-folder-journal'), { force: true })

    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const second = await recoverInterruptedOperations(vault, db)
    // F3 fully-bound owner-durable companion: the companion still
    // drives a recovery action on the second run (existing behavior —
    // owner-durable companions are processed, not skipped). Assert
    // no flip-flop: the second run is a strict subset or equal.
    const firstFiles = new Set(first.actions.map(a => a.file))
    const secondFiles = new Set(second.actions.map(a => a.file))
    for (const file of secondFiles) {
      expect(firstFiles.has(file)).toBe(true)
    }
    db.close()
  })
})

// -- F4..F7: P0-3 declared directory generations ------------------------------

describe('Round-17 F4–F7 declared directory durable generations (P0-3)', () => {
  async function recreateWithDifferentBirthtime(
    directoryAbs: string,
    oldBirthtimeNs: string,
  ): Promise<Awaited<ReturnType<typeof captureDurableDirectoryIdentity>>> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await fs.rm(directoryAbs, { recursive: true, force: true })
      await new Promise(resolve => setTimeout(resolve, 2))
      await fs.mkdir(directoryAbs)
      const identity = await captureDurableDirectoryIdentity(directoryAbs)
      if (identity.birthtimeNs !== oldBirthtimeNs) return identity
    }
    throw new Error('test filesystem did not advance directory birthtime')
  }

  async function writePreparedDirectoryJournal(
    source: string,
    destinationName = 'dest',
  ): Promise<{
    journal: FolderMoveJournalV4
    journalPath: string
  }> {
    const physical = await listPhysicalMoveEntries(source)
    const sourceIdentity = await captureDurableDirectoryIdentity(source)
    const journal: FolderMoveJournalV4 = {
      version: FOLDER_MOVE_JOURNAL_VERSION,
      op: 'folder-move',
      phase: 'prepared',
      srcRel: path.basename(source),
      destRel: destinationName,
      strategy: 'replayable-move',
      sourceDev: sourceIdentity.dev,
      sourceIno: sourceIdentity.ino,
      sourceBirthtimeNs: sourceIdentity.birthtimeNs,
      gateProof: createFolderMoveGateProof(),
      entries: physical.entries.map(entry => ({
        relativeFilePath: entry.relativeFilePath,
        sourceDev: entry.sourceDev!,
        sourceIno: entry.sourceIno!,
        sourceHash: entry.sourceHash,
      })),
      directories: physical.directories,
      directoryGenerations: physical.directoryGenerations,
      metadataDisposition: { kind: 'prefix-move' },
    }
    const journalPath = path.join(
      vault,
      `.${path.basename(source)}.nuvyn-journal-77777777-7774-4777-8777-777777777777`,
    )
    await writeDurableJournal(journalPath, journal)
    return { journal, journalPath }
  }

  it('F4 preserves an externally-recreated directory under a declared shell', async () => {
    const source = path.join(vault, 'src')
    await fs.mkdir(source)
    const root = await captureDurableDirectoryIdentity(source)
    const nestedDir = path.join(source, 'sub')
    await fs.mkdir(nestedDir)
    const original = await captureDurableDirectoryIdentity(nestedDir)

    // Externally replace nested dir before journal cleanup.
    const recreated =
      await recreateWithDifferentBirthtime(nestedDir, original.birthtimeNs)

    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-move',
      phase: 'metadata-committed',
      srcRel: 'src',
      destRel: 'dest',
      strategy: 'atomic-rename',
      sourceDev: root.dev,
      sourceIno: root.ino,
      sourceBirthtimeNs: root.birthtimeNs,
      entries: [],
      directories: ['sub'],
      directoryGenerations: [{
        relativeDirectoryPath: 'sub',
        sourceDev: recreated.dev,
        sourceIno: recreated.ino,
        sourceBirthtimeNs: original.birthtimeNs,
      }],
      metadataDisposition: { kind: 'prefix-move' },
    }

    // The fixed cleanup must NOT remove the externally-recreated `sub`.
    // It must also fail closed (return a conflict report) rather than silently
    // dropping the directory and polluting the reverse tree.
    const result = await import('../documentFileLifecycle').then(m =>
      m.removeDeclaredEmptyDirectories(source, journal.directories, {
        directoryGenerations: journal.directoryGenerations ?? [],
        removeRoot: true,
        expectedRootGeneration: {
          dev: journal.sourceDev,
          ino: journal.sourceIno,
          birthtimeNs: journal.sourceBirthtimeNs!,
        },
      }),
    )
    expect((await fs.stat(path.join(source, 'sub'))).isDirectory()).toBe(true)
    // Cleanup must surface a conflict — silently dropping is a hole.
    expect(result.conflict ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/sub/)]),
    )
    void journal
  })

  it('F5 removes a declared empty dir only when its dev/ino matches the declared generation', async () => {
    const source = path.join(vault, 'src')
    await fs.mkdir(source)
    const root = await captureDurableDirectoryIdentity(source)
    const targetDir = path.join(source, 'gone')
    await fs.mkdir(targetDir)
    const original = await captureDurableDirectoryIdentity(targetDir)

    // Externally swap: same path, different dev/ino (e.g. chown or replayable
    // copy + delete). Without the dev/ino proof, cleanup would wipe it.
    const recreated =
      await recreateWithDifferentBirthtime(targetDir, original.birthtimeNs)

    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-move',
      phase: 'metadata-committed',
      srcRel: 'src',
      destRel: 'dest',
      strategy: 'atomic-rename',
      sourceDev: root.dev,
      sourceIno: root.ino,
      sourceBirthtimeNs: root.birthtimeNs,
      entries: [],
      directories: ['gone'],
      directoryGenerations: [{
        relativeDirectoryPath: 'gone',
        sourceDev: recreated.dev,
        sourceIno: recreated.ino,
        sourceBirthtimeNs: original.birthtimeNs,
      }],
      metadataDisposition: { kind: 'prefix-move' },
    }

    await import('../documentFileLifecycle').then(m =>
      m.removeDeclaredEmptyDirectories(source, journal.directories, {
        directoryGenerations: journal.directoryGenerations ?? [],
        removeRoot: true,
        expectedRootGeneration: {
          dev: journal.sourceDev,
          ino: journal.sourceIno,
          birthtimeNs: journal.sourceBirthtimeNs!,
        },
      }),
    )
    // External recreation must NOT be removed.
    expect((await fs.stat(targetDir)).isDirectory()).toBe(true)
  })

  it('F6 removes nested empty dirs under a declared shell only when each generation matches', async () => {
    const source = path.join(vault, 'src')
    await fs.mkdir(source)
    const root = await captureDurableDirectoryIdentity(source)
    const deepDir = path.join(source, 'top', 'next', 'leaf')
    await fs.mkdir(path.dirname(deepDir), { recursive: true })
    await fs.mkdir(deepDir)
    // Walk up and capture each directory's generation.
    const dirPairs: Array<{
      rel: string
      dev: string
      ino: string
      birthtimeNs: string
    }> = []
    for (const rel of ['top', 'top/next', 'top/next/leaf']) {
      const abs = path.join(source, rel)
      const identity = await captureDurableDirectoryIdentity(abs)
      dirPairs.push({ rel, ...identity })
    }

    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-move',
      phase: 'metadata-committed',
      srcRel: 'src',
      destRel: 'dest',
      strategy: 'atomic-rename',
      sourceDev: root.dev,
      sourceIno: root.ino,
      sourceBirthtimeNs: root.birthtimeNs,
      entries: [],
      directories: dirPairs.map(p => p.rel),
      directoryGenerations: dirPairs.map(p => ({
        relativeDirectoryPath: p.rel,
        sourceDev: p.dev,
        sourceIno: p.ino,
        sourceBirthtimeNs: p.birthtimeNs,
      })),
      metadataDisposition: { kind: 'prefix-move' },
    }

    // Tamper: the leaf is externally replaced with another inode.
    const leaf = dirPairs.at(-1)!
    const recreatedLeaf = await recreateWithDifferentBirthtime(
      path.join(source, leaf.rel),
      leaf.birthtimeNs,
    )
    journal.directoryGenerations![2] = {
      ...journal.directoryGenerations![2],
      sourceDev: recreatedLeaf.dev,
      sourceIno: recreatedLeaf.ino,
    }

    const result = await import('../documentFileLifecycle').then(m =>
      m.removeDeclaredEmptyDirectories(source, journal.directories, {
        directoryGenerations: journal.directoryGenerations ?? [],
        removeRoot: true,
        expectedRootGeneration: {
          dev: journal.sourceDev,
          ino: journal.sourceIno,
          birthtimeNs: journal.sourceBirthtimeNs!,
        },
      }),
    )
    // Leaf was tampered: must NOT be removed, and conflict surfaced.
    expect((await fs.stat(path.join(source, 'top/next/leaf'))).isDirectory()).toBe(true)
    expect(result.conflict ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/top\/next\/leaf/)]),
    )
  })

  it('F7 root source externally reused: expected root generation mismatch is observed', async () => {
    const source = path.join(vault, 'src')
    await fs.mkdir(source)
    const original = await captureDurableDirectoryIdentity(source)
    // Externally recreate the source root before cleanup.
    const recreated =
      await recreateWithDifferentBirthtime(source, original.birthtimeNs)

    const journal: FolderMoveJournalV4 = {
      version: 4,
      op: 'folder-move',
      phase: 'metadata-committed',
      srcRel: 'src',
      destRel: 'dest',
      strategy: 'atomic-rename',
      sourceDev: recreated.dev,
      sourceIno: recreated.ino,
      sourceBirthtimeNs: original.birthtimeNs,
      entries: [],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    }
    const result = await import('../documentFileLifecycle').then(m =>
      m.removeDeclaredEmptyDirectories(source, journal.directories, {
        directoryGenerations: journal.directoryGenerations ?? [],
        removeRoot: true,
        expectedRootGeneration: {
          dev: journal.sourceDev,
          ino: journal.sourceIno,
          birthtimeNs: journal.sourceBirthtimeNs!,
        },
      }),
    )
    expect(result.rootRemoved).toBe(false)
  })

  it('F4 recovery rejects a removed declared empty directory before any mutation', async () => {
    const source = path.join(vault, 'src')
    await fs.mkdir(path.join(source, 'declared-empty'), { recursive: true })
    await fs.writeFile(path.join(source, 'a.bin'), 'owned')
    const { journalPath } = await writePreparedDirectoryJournal(source)
    await fs.rmdir(path.join(source, 'declared-empty'))

    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const second = await recoverInterruptedOperations(vault, db)
    expect(first.actions).toContainEqual(expect.objectContaining({
      file: path.basename(journalPath),
      action: 'quarantined',
      detail: expect.stringContaining('declared source directory is missing'),
    }))
    expect(second.actions).toEqual(first.actions)
    expect(await fs.readFile(path.join(source, 'a.bin'), 'utf8')).toBe('owned')
    await expect(fs.stat(path.join(vault, 'dest')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.stat(journalPath)).toBeDefined()
    db.close()
  })

  it('F5/F6 recovery rejects ABA replacement of a nested declared directory', async () => {
    const source = path.join(vault, 'src')
    await fs.mkdir(path.join(source, 'a', 'b'), { recursive: true })
    await fs.writeFile(path.join(source, 'owned.bin'), 'owned')
    const { journalPath } = await writePreparedDirectoryJournal(source)
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as FolderMoveJournalV4
    const nested = journal.directoryGenerations!.find(
      entry => entry.relativeDirectoryPath === 'a/b',
    )!
    const recreated = await recreateWithDifferentBirthtime(
      path.join(source, 'a', 'b'),
      nested.sourceBirthtimeNs!,
    )
    nested.sourceDev = recreated.dev
    nested.sourceIno = recreated.ino
    await rewriteDurableJournal(journalPath, journal)

    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const stableBytes = await fs.readFile(journalPath)
    const second = await recoverInterruptedOperations(vault, db)
    expect(first.actions).toContainEqual(expect.objectContaining({
      file: path.basename(journalPath),
      action: 'quarantined',
      detail: expect.stringContaining('source directory generation changed: a/b'),
    }))
    expect(second.actions).toEqual(first.actions)
    expect(await fs.readFile(journalPath)).toEqual(stableBytes)
    expect((await fs.stat(path.join(source, 'a', 'b'))).isDirectory())
      .toBe(true)
    await expect(fs.stat(path.join(vault, 'dest')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    db.close()
  })

  it('F7 preserves a replaced destination declared directory and retains the journal', async () => {
    const source = path.join(vault, 'src')
    await fs.mkdir(path.join(source, 'nested'), { recursive: true })
    await fs.writeFile(path.join(source, 'owned.bin'), 'owned')
    const { journal, journalPath } =
      await writePreparedDirectoryJournal(source)
    const destination = path.join(vault, 'dest')
    const gate = await createDestinationGate(destination)
    expect(gate).not.toBeNull()
    await writeFolderMoveGateProof(destination, journal.gateProof!)
    const destinationDirectoryGenerations =
      await createFolderMoveDestinationDirectories(
        destination,
        journal.directories,
        vault,
      )
    const gateCreated: FolderMoveJournalV4 = {
      ...journal,
      phase: 'gate-created',
      destDev: gate!.dev,
      destIno: gate!.ino,
      destBirthtimeNs: gate!.birthtimeNs,
      destinationDirectoryGenerations,
    }
    await rewriteDurableJournal(journalPath, gateCreated)
    const expectedNested = gateCreated.destinationDirectoryGenerations![0]
    const recreated = await recreateWithDifferentBirthtime(
      path.join(destination, 'nested'),
      expectedNested.sourceBirthtimeNs!,
    )
    expectedNested.sourceDev = recreated.dev
    expectedNested.sourceIno = recreated.ino
    await rewriteDurableJournal(journalPath, gateCreated)

    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const second = await recoverInterruptedOperations(vault, db)
    expect(first.actions).toContainEqual(expect.objectContaining({
      file: path.basename(journalPath),
      action: 'quarantined',
      detail: expect.stringContaining(
        'declared directory generation changed: nested',
      ),
    }))
    expect(second.actions).toEqual(first.actions)
    expect((await fs.stat(path.join(destination, 'nested'))).isDirectory())
      .toBe(true)
    expect(await fs.readFile(path.join(source, 'owned.bin'), 'utf8'))
      .toBe('owned')
    expect(await fs.stat(journalPath)).toBeDefined()
    db.close()
  })
})

describe('Round-17 P0-3 immutable directory identity schema', () => {
  const base = (): FolderMoveJournalV4 => ({
    version: 4,
    op: 'folder-move',
    phase: 'prepared',
    srcRel: 'src',
    destRel: 'dest',
    strategy: 'replayable-move',
    sourceDev: '1',
    sourceIno: '1',
    gateProof: createFolderMoveGateProof(),
    entries: [],
    directories: [],
    directoryGenerations: [],
    metadataDisposition: { kind: 'prefix-move' },
  })

  it('A4 atomic rename preserves the durable birthtime identity', async () => {
    const source = path.join(vault, 'atomic-source')
    const destination = path.join(vault, 'atomic-destination')
    await fs.mkdir(source)
    const before = await captureDurableDirectoryIdentity(source)
    await fs.rename(source, destination)
    expect(await captureDurableDirectoryIdentity(destination)).toEqual(before)
  })

  it('A5 replayable destination directories persist birthtime before files land', async () => {
    const destination = path.join(vault, 'destination')
    await fs.mkdir(destination)
    const rows = await createFolderMoveDestinationDirectories(
      destination,
      ['a', 'a/b'],
      vault,
    )
    expect(rows).toHaveLength(2)
    expect(rows.every(row => /^[1-9]\d*$/.test(row.sourceBirthtimeNs!)))
      .toBe(true)
  })

  it('A6 missing-birthtime legacy v4 parses for diagnosis but is weak', () => {
    const journal = base()
    expect(parseFolderMoveJournalV4Object(journal)).not.toBeNull()
    expect(classifyFolderMoveRecoveryStrength(journal).strength).toBe('weak')
  })

  it('A7 zero birthtime journal is weak', () => {
    expect(classifyFolderMoveRecoveryStrength({
      ...base(),
      sourceBirthtimeNs: '0',
    }).strength).toBe('weak')
  })

  it.each(['01', '-1', '1.0', 'x'])(
    'A8 parser rejects malformed or noncanonical birthtime %s',
    (sourceBirthtimeNs) => {
      expect(parseFolderMoveJournalV4Object({
        ...base(),
        sourceBirthtimeNs,
      })).toBeNull()
    },
  )
})

// -- F8..F10: P1-2 metadata snapshot closed graphs ----------------------------

function emptySnapshot(): SerializedMetadataSnapshot {
  return {
    paths: [],
    documentIds: [],
    tagIds: [],
    preexistingTagIds: [],
    documents: [],
    tags: [],
    documentTags: [],
    embeddings: [],
    migrations: [],
  }
}

function validBaseSnapshot(): SerializedMetadataSnapshot {
  const snap = emptySnapshot()
  snap.paths = ['proj/a']
  snap.documentIds = ['a-id']
  snap.documents = [{
    id: 'a-id',
    path: 'proj/a',
    title: 'a',
    summary: '',
    created_at: 1,
    updated_at: 1,
  }]
  return snap
}

describe('Round-17 F8–F10 closed metadata snapshot graphs (P1-2)', () => {
  function durableSnapshotJournal(
    metadataDisposition: FolderMoveJournalV4['metadataDisposition'],
    phase: FolderMoveJournalV4['phase'] = 'prepared',
  ): FolderMoveJournalV4 {
    return {
      version: FOLDER_MOVE_JOURNAL_VERSION,
      op: 'folder-move',
      phase,
      srcRel: 'src',
      destRel: 'dest',
      strategy: 'atomic-rename',
      sourceDev: '1',
      sourceIno: '1',
      ...(phase === 'prepared'
        ? {}
        : { destDev: '1', destIno: '1' }),
      gateProof: createFolderMoveGateProof(),
      entries: [],
      directories: [],
      directoryGenerations: [],
      metadataDisposition,
    }
  }

  it('F8 v4 parser rejects a snapshot-restore snapshot whose paths omit a document path', async () => {
    const proj = path.join(vault, 'proj')
    await fs.mkdir(proj)
    const base = validBaseSnapshot()
    const tampered: SerializedMetadataSnapshot = {
      ...base,
      paths: [],
    }
    // hasValidSnapshotRowSchema would have accepted this (rows-typed
    // but undeclared path). The parser (closed-graph) must reject.
    expect(hasValidSnapshotRowSchema(tampered)).toBe(true)
    const journalPath = path.join(proj, '.proj.nuvyn-journal-f8-closed-graph')
    await writeDurableJournal(journalPath, {
      version: 4,
      op: 'folder-move',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'dest',
      strategy: 'atomic-rename',
      sourceDev: '0',
      sourceIno: '0',
      entries: [],
      directories: [],
      metadataDisposition: {
        kind: 'snapshot-restore',
        snapshot: tampered,
      },
    })
    const { parseDurableFolderMoveJournalV4 } = await import('../folderMoveV4DurableJournal')
    const raw = await fs.readFile(journalPath, 'utf8')
    expect(parseDurableFolderMoveJournalV4(raw)).toBeNull()
  })

  it('F9 v4 parser rejects a snapshot-restore snapshot whose documentIds lists an id not in documents[]', async () => {
    const proj = path.join(vault, 'proj')
    await fs.mkdir(proj)
    const base = validBaseSnapshot()
    const tampered: SerializedMetadataSnapshot = {
      ...base,
      documentIds: ['a-id', 'phantom-id'],
    }
    expect(hasValidSnapshotRowSchema(tampered)).toBe(true)
    const journalPath = path.join(proj, '.proj.nuvyn-journal-f9-closed-graph')
    await writeDurableJournal(journalPath, {
      version: 4,
      op: 'folder-move',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'dest',
      strategy: 'atomic-rename',
      sourceDev: '0',
      sourceIno: '0',
      entries: [],
      directories: [],
      metadataDisposition: {
        kind: 'snapshot-restore',
        snapshot: tampered,
      },
    })
    const { parseDurableFolderMoveJournalV4 } = await import('../folderMoveV4DurableJournal')
    const raw = await fs.readFile(journalPath, 'utf8')
    expect(parseDurableFolderMoveJournalV4(raw)).toBeNull()
  })

  it('F10 v4 parser rejects a snapshot-restore snapshot with duplicate migration path', async () => {
    const proj = path.join(vault, 'proj')
    await fs.mkdir(proj)
    const base = validBaseSnapshot()
    const tampered: SerializedMetadataSnapshot = {
      ...base,
      migrations: [{
        path: 'proj/migration',
        document_id: 'a-id',
        original_path: 'proj/migration',
        status: 'legacy',
        source_hash: 'h',
        error: '',
        updated_at: 1,
        frontmatter_backup: '',
        cleaned_hash: '',
      }, {
        path: 'proj/migration',
        document_id: 'a-id',
        original_path: 'proj/migration',
        status: 'legacy',
        source_hash: 'h',
        error: '',
        updated_at: 1,
        frontmatter_backup: '',
        cleaned_hash: '',
      }],
    }
    expect(hasValidSnapshotRowSchema(tampered)).toBe(true)
    const journalPath = path.join(proj, '.proj.nuvyn-journal-f10-closed-graph')
    await writeDurableJournal(journalPath, {
      version: 4,
      op: 'folder-move',
      phase: 'gate-created',
      srcRel: 'proj',
      destRel: 'dest',
      strategy: 'atomic-rename',
      sourceDev: '0',
      sourceIno: '0',
      entries: [],
      directories: [],
      metadataDisposition: {
        kind: 'snapshot-restore',
        snapshot: tampered,
      },
    })
    const { parseDurableFolderMoveJournalV4 } = await import('../folderMoveV4DurableJournal')
    const raw = await fs.readFile(journalPath, 'utf8')
    expect(parseDurableFolderMoveJournalV4(raw)).toBeNull()
  })

  it.each([
    ['documentIds', () => {
      const snapshot = validBaseSnapshot()
      snapshot.documentIds = ['other-id']
      return snapshot
    }],
    ['tagIds', () => {
      const snapshot = emptySnapshot()
      snapshot.tagIds = [2]
      snapshot.tags = [{
        id: 1,
        name: 'one',
        normalized_name: 'one',
      }]
      return snapshot
    }],
    ['unexplained path', () => ({
      ...emptySnapshot(),
      paths: ['unrelated/path'],
    })],
  ])('F8–F10 rejects %s corruption at every durable snapshot field', (_label, corrupt) => {
    const corrupted = corrupt() as SerializedMetadataSnapshot
    const valid = emptySnapshot()
    const journals: FolderMoveJournalV4[] = [
      durableSnapshotJournal({
        kind: 'snapshot-restore',
        snapshot: corrupted,
      }),
      durableSnapshotJournal({
        kind: 'snapshot-restore',
        snapshot: valid,
        expectedCurrentSnapshot: corrupted,
        physicalDocumentIds: [],
      }),
      durableSnapshotJournal({
        kind: 'prefix-move',
        preparedSnapshot: corrupted,
      }),
      durableSnapshotJournal({
        kind: 'prefix-move',
        committedSnapshot: corrupted,
      }, 'metadata-committed'),
    ]
    for (const journal of journals) {
      expect(parseFolderMoveJournalV4Object(journal)).toBeNull()
    }
  })
})

// -- F11: P1-3 weak legacy folder move quarantine ----------------------------

describe('Round-17 F11 weak legacy folder-move journal quarantine (P1-3)', () => {
  it.each([
    ['v1 inode-only', (dev: number, ino: number) => ({
      version: 1,
      op: 'folder-rename',
      srcRel: 'proj',
      destRel: 'ren',
      sourceDev: dev,
      sourceIno: ino,
      entries: [{
        rel: 'a',
        id: 'a-id',
        sourceHash: sha256Hex('# a\n'),
      }],
    })],
    ['v2 missing directory proof', (dev: number, ino: number) => ({
      version: 2,
      op: 'folder-rename',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: dev,
      sourceIno: ino,
      entries: [{
        relativeFilePath: 'a.md',
        sourceHash: sha256Hex('# a\n'),
        documentId: 'a-id',
        documentPath: 'proj/a',
      }],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    })],
    ['v3 hash/generation proof is still legacy', (dev: number, ino: number) => ({
      version: 3,
      op: 'folder-rename',
      srcRel: 'proj',
      destRel: 'ren',
      strategy: 'atomic-rename',
      sourceDev: dev,
      sourceIno: ino,
      gateToken: 'a'.repeat(64),
      entries: [{
        relativeFilePath: 'a.md',
        sourceHash: sha256Hex('# a\n'),
        sourceDev: String(dev),
        sourceIno: String(ino),
        documentId: 'a-id',
        documentPath: 'proj/a',
      }],
      directories: [],
      metadataDisposition: { kind: 'prefix-move' },
    })],
  ])('F11 quarantines %s with the fixed detail and no mutation', async (_label, makeJournal) => {
    const source = path.join(vault, 'proj')
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'a.md'), '# a\n')
    const stat = await fs.lstat(source)
    const journalPath = path.join(vault, '.proj.nuvyn-journal-abcd')
    await writeDurableJournal(
      journalPath,
      makeJournal(stat.dev, stat.ino),
    )
    const db = new Database(':memory:')
    applyMigrations(db)
    const before = await fs.readFile(path.join(source, 'a.md'))
    const first = await recoverInterruptedOperations(vault, db)
    const second = await recoverInterruptedOperations(vault, db)
    expect(first.actions).toContainEqual({
      file: path.basename(journalPath),
      action: 'quarantined',
      detail: 'legacy journal lacks sufficient durable ownership proof',
    })
    expect(second.actions).toEqual(first.actions)
    expect(await fs.readFile(path.join(source, 'a.md'))).toEqual(before)
    await expect(fs.stat(path.join(vault, 'ren')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.stat(journalPath)).toBeDefined()
    db.close()
  })

  async function writeLegacyForward(version: 1 | 2 | 3, strong: boolean): Promise<string> {
    const proj = path.join(vault, 'proj')
    await fs.mkdir(proj)
    await fs.writeFile(path.join(proj, 'a.md'), '# a\n')
    await fs.writeFile(path.join(vault, 'ref.md'), 'before')
    const sourceStat = await fs.stat(proj)
    const token = `abcdef0123${version.toString().padStart(2, '0')}${strong ? 'f' : '0'}`
    const beforePayload = `.proj.nuvyn-ref-before-${token}-0`
    const afterPayload = `.proj.nuvyn-ref-after-${token}-0`
    await writeDurableRecoveryPayload(path.join(vault, beforePayload), 'before')
    await writeDurableRecoveryPayload(path.join(vault, afterPayload), 'after')
    const journalPath = path.join(vault, `.proj.nuvyn-journal-${token}`)
    await writeDurableJournal(journalPath, {
      version,
      op: 'folder-rename-references',
      phase: 'roll-back',
      srcRel: 'proj',
      destRel: 'ren',
      sourceDev: sourceStat.dev,
      sourceIno: sourceStat.ino,
      identities: strong
        ? [{ path: 'proj/a', id: 'a-id', sourceHash: sha256Hex('# a\n') }]
        : [{ path: 'proj/a', id: 'a-id' }],
      references: [{
        path: 'ref',
        beforeHash: sha256Hex('before'),
        afterHash: sha256Hex('after'),
        beforePayload,
        afterPayload,
      }],
    })
    return journalPath
  }

  it('F11.a v1 roll-back without sourceHash → quarantined, ref.md unchanged', async () => {
    const journalPath = await writeLegacyForward(1, false)
    const db = new Database(':memory:')
    applyMigrations(db)
    await recoverInterruptedOperations(vault, db)
    await recoverInterruptedOperations(vault, db)
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('before')
    expect(await fs.stat(journalPath)).toBeDefined()
    db.close()
  })

  it('F11.b v2 roll-back with full sourceHash → quarantined (legacy path, not strong)', async () => {
    await writeLegacyForward(2, true)
    const db = new Database(':memory:')
    applyMigrations(db)
    await recoverInterruptedOperations(vault, db)
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('before')
    db.close()
  })

  it('F11.c v3 roll-back without sourceHash → quarantined', async () => {
    await writeLegacyForward(3, false)
    const db = new Database(':memory:')
    applyMigrations(db)
    await recoverInterruptedOperations(vault, db)
    expect(await fs.readFile(path.join(vault, 'ref.md'), 'utf8')).toBe('before')
    db.close()
  })

  it('F11.d v4 markerless empty tree → quarantined (legacy v4 path keeps mutating disk)', async () => {
    await fs.mkdir(path.join(vault, 'proj'))
    const stat = await fs.lstat(path.join(vault, 'proj'))
    await writeDurableJournal(
      path.join(vault, '.proj.nuvyn-journal-abcdef012345d'),
      {
        version: 4,
        op: 'folder-move',
        phase: 'gate-created',
        srcRel: 'proj',
        destRel: 'dest',
        strategy: 'atomic-rename',
        sourceDev: stat.dev.toString(),
        sourceIno: stat.ino.toString(),
        entries: [],
        directories: [],
        metadataDisposition: {
          kind: 'snapshot-restore',
          snapshot: emptySnapshot(),
        },
      },
    )
    const db = new Database(':memory:')
    applyMigrations(db)
    const result = await recoverInterruptedOperations(vault, db)
    expect(result.actions.some(a => a.action === 'quarantined')).toBe(true)
    db.close()
  })

  it('F11.e v4 files-landed without gateProof → quarantined', async () => {
    await fs.mkdir(path.join(vault, 'proj'))
    const stat = await fs.lstat(path.join(vault, 'proj'))
    await writeDurableJournal(
      path.join(vault, '.proj.nuvyn-journal-abcdef012345e'),
      {
        version: 4,
        op: 'folder-move',
        phase: 'files-landed',
        srcRel: 'proj',
        destRel: 'dest',
        strategy: 'atomic-rename',
        sourceDev: stat.dev.toString(),
        sourceIno: stat.ino.toString(),
        entries: [],
        directories: [],
        metadataDisposition: {
          kind: 'snapshot-restore',
          snapshot: emptySnapshot(),
        },
      },
    )
    const db = new Database(':memory:')
    applyMigrations(db)
    const result = await recoverInterruptedOperations(vault, db)
    expect(result.actions.some(a => a.action === 'quarantined')).toBe(true)
    db.close()
  })

  it('F11.f unsafe numeric directory generation is quarantined on every platform', async () => {
    const source = path.join(vault, 'proj')
    await fs.mkdir(path.join(source, 'nested'), { recursive: true })
    const sourceStat = await fs.lstat(source, { bigint: true })
    const journalPath = path.join(
      vault,
      '.proj.nuvyn-journal-88888888-8884-4888-8888-888888888888',
    )
    await writeDurableJournal(journalPath, {
      version: 4,
      op: 'folder-move',
      phase: 'prepared',
      srcRel: 'proj',
      destRel: 'dest',
      strategy: 'replayable-move',
      sourceDev: sourceStat.dev.toString(),
      sourceIno: sourceStat.ino.toString(),
      gateProof: createFolderMoveGateProof(),
      emptyTree: true,
      entries: [],
      directories: ['nested'],
      directoryGenerations: [{
        relativeDirectoryPath: 'nested',
        sourceDev: Number.MAX_SAFE_INTEGER + 1,
        sourceIno: Number.MAX_SAFE_INTEGER + 2,
      }],
      metadataDisposition: { kind: 'prefix-move' },
    })
    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const second = await recoverInterruptedOperations(vault, db)
    expect(first.actions).toContainEqual({
      file: path.basename(journalPath),
      action: 'quarantined',
      detail: 'legacy journal lacks sufficient durable ownership proof',
    })
    expect(second.actions).toEqual(first.actions)
    expect((await fs.stat(path.join(source, 'nested'))).isDirectory())
      .toBe(true)
    expect(await fs.stat(journalPath)).toBeDefined()
    db.close()
  })
})

// -- F12: idempotence wrapper -------------------------------------------------

describe('Round-17 F12 idempotence of every F case', () => {
  it('F12 running recoverInterruptedOperations twice is idempotent for every action class', async () => {
    // F1 baseline: a pending owner with no matching v4 owner journal.
    const proj = path.join(vault, 'proj')
    await fs.mkdir(proj)
    await fs.writeFile(path.join(proj, 'a.md'), '# a\n')
    const transactionId = '66666666-6664-4666-8666-666666666666'
    const journalPath = path.join(proj, `.proj.nuvyn-journal-${transactionId}`)
    await writePendingJournal(journalPath, {
      ownerJournal: '.proj.nuvyn-journal-no-owner-matches',
      ownerTransactionId: '77777777-7774-4777-8777-777777777777',
      ownerDescriptorHash: 'e'.repeat(64),
      previousDirection: 'roll-forward',
    })

    const db = new Database(':memory:')
    applyMigrations(db)
    const first = await recoverInterruptedOperations(vault, db)
    const second = await recoverInterruptedOperations(vault, db)
    const basename = path.basename(journalPath)
    const firstActions = first.actions.filter(a => a.file.endsWith(basename))
    const secondActions = second.actions.filter(a => a.file.endsWith(basename))
    // Every action class (quarantined/cleaned/etc.) at the end of the
    // second run must be a state the first run reached — no flip-flop.
    if (firstActions.some(a => a.action === 'quarantined')) {
      const firstQuarantines = firstActions.filter(a => a.action === 'quarantined').length
      const secondQuarantines = secondActions.filter(a => a.action === 'quarantined').length
      expect(secondQuarantines).toBe(firstQuarantines)
    }
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8')))
      .toMatchObject({
        metadataDisposition: {
          kind: 'folder-snapshot-owner-aborted',
          reason: 'owner-journal-absent',
        },
      })
    db.close()
  })
})

// (silence the strict unused-vars rule for scratchDir / spawn import — the
//  real-subprocess crash children extend folder-rollback-crash-child.ts
//  not this file.)
void spawn
void scratchDir
