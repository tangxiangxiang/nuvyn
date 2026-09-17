import { promises as fs } from 'node:fs'

import {
  createDestinationGate,
  rewriteDurableJournal,
  syncParentDirectoryBestEffort,
} from './atomicTextWrite.js'
import {
  moveFolderEntriesIntoExistingGate,
  isPhysicallyContained,
  RenameDestinationOccupiedError,
  UnsupportedDirectoryMoveError,
  verifyFolderMoveDestinationV4,
  type FolderMoveJournalStrategy,
} from './documentFileLifecycle.js'
import {
  removeFolderMoveGateProof,
  writeFolderMoveGateProof,
} from './folderMoveGateProof.js'
import type { FolderMoveJournalV4 } from './folderMoveTransaction.js'
import { inspectFolderMoveSourceInventory } from './folderMoveSourceOwnership.js'
import {
  createFolderMoveDestinationDirectories,
} from './folderMoveDirectoryOwnership.js'
import {
  captureDurableDirectoryIdentity,
  matchesDurableDirectoryIdentity,
  type DurableDirectoryIdentity,
} from './durableDirectoryIdentity.js'

export type FolderMoveV4DurableState = {
  /** Latest phase the executor attempted. The disk journal can still be
   * older when the transition rewrite itself failed. */
  journal: FolderMoveJournalV4
  /** True once a physical syscall may have moved any declared bytes. */
  physicalMayHaveLanded: boolean
}

export class FolderMoveV4ExecutionError extends Error {
  readonly state: FolderMoveV4DurableState

  constructor(message: string, state: FolderMoveV4DurableState, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FolderMoveV4ExecutionError'
    this.state = state
  }
}

export class AtomicRenameLandedGenerationReadError extends FolderMoveV4ExecutionError {
  constructor(destinationAbs: string, state: FolderMoveV4DurableState, options?: ErrorOptions) {
    super(`atomic rename landed but destination generation could not be read: ${destinationAbs}`, state, options)
    this.name = 'AtomicRenameLandedGenerationReadError'
  }
}

export class FolderMoveGenerationMismatchError extends FolderMoveV4ExecutionError {
  constructor(message: string, state: FolderMoveV4DurableState) {
    super(message, state)
    this.name = 'FolderMoveGenerationMismatchError'
  }
}

export class FolderMoveSourceGenerationMismatchError
  extends FolderMoveV4ExecutionError {
  constructor(message: string, state: FolderMoveV4DurableState) {
    super(message, state)
    this.name = 'FolderMoveSourceGenerationMismatchError'
  }
}

export class FolderMoveExactParityError extends FolderMoveV4ExecutionError {
  constructor(message: string, state: FolderMoveV4DurableState) {
    super(message, state)
    this.name = 'FolderMoveExactParityError'
  }
}

export type ExecuteFolderMoveV4Input = {
  contentDir: string
  journalAbs: string
  journal: FolderMoveJournalV4 & { phase: 'prepared' }
  srcAbs: string
  destAbs: string
  strategy: FolderMoveJournalStrategy
  afterGateCreated?: (
    destinationAbs: string,
    generation: DurableDirectoryIdentity,
  ) => void | Promise<void>
  afterAtomicRenameBeforeParity?: (
    sourceAbs: string,
    destinationAbs: string,
  ) => void | Promise<void>
  afterFilesLanded?: (destinationAbs: string) => void | Promise<void>
}

export type ExecuteFolderMoveV4Result = {
  journal: FolderMoveJournalV4 & { phase: 'files-landed' }
}

/** Run the one physical state machine used by routes and recovery
 * companions. The prepared journal already exists. Every transition is
 * durable; no error path removes the journal. */
export async function executeFolderMoveV4Physical(
  input: ExecuteFolderMoveV4Input,
): Promise<ExecuteFolderMoveV4Result> {
  const {
    contentDir,
    journalAbs,
    srcAbs,
    destAbs,
    strategy,
  } = input
  let journal: FolderMoveJournalV4 = input.journal
  let state: FolderMoveV4DurableState = {
    journal,
    physicalMayHaveLanded: false,
  }

  try {
    let sourceStat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      sourceStat = await fs.lstat(srcAbs, { bigint: true })
    } catch {
      throw new FolderMoveSourceGenerationMismatchError(
        'folder move source generation is missing',
        state,
      )
    }
    if (typeof journal.sourceBirthtimeNs !== 'string'
      || !matchesDurableDirectoryIdentity(sourceStat, {
        dev: String(journal.sourceDev),
        ino: String(journal.sourceIno),
        birthtimeNs: journal.sourceBirthtimeNs,
      })
      || !await isPhysicallyContained(contentDir, srcAbs)) {
      throw new FolderMoveSourceGenerationMismatchError(
        'folder move source generation does not match prepared journal',
        state,
      )
    }
    const sourceInventory = await inspectFolderMoveSourceInventory(
      srcAbs,
      journal,
    )
    if (sourceInventory.kind !== 'intact') {
      throw new FolderMoveSourceGenerationMismatchError(
        sourceInventory.kind === 'external'
          ? sourceInventory.reason
          : `folder move source inventory is ${sourceInventory.kind}`,
        state,
      )
    }
    const gate = await createDestinationGate(destAbs)
    if (!gate) {
      throw new RenameDestinationOccupiedError(destAbs)
    }
    if (journal.gateProof) {
      try {
        await writeFolderMoveGateProof(destAbs, journal.gateProof)
      } catch (error) {
        await fs.rmdir(destAbs).catch(() => {})
        await syncParentDirectoryBestEffort(destAbs)
        throw error
      }
    }
    journal = {
      ...journal,
      phase: 'gate-created',
      destDev: gate.dev,
      destIno: gate.ino,
      destBirthtimeNs: gate.birthtimeNs,
    }
    state = { ...state, journal }
    await rewriteDurableJournal(journalAbs, journal)
    await input.afterGateCreated?.(destAbs, gate)

    if (strategy === 'atomic-rename') {
      // POSIX can replace an empty directory, so remove the verified
      // marker immediately before rename. A landed atomic source
      // replaces the gate generation and does not retain the marker.
      if (journal.gateProof) {
        await removeFolderMoveGateProof(destAbs, journal.gateProof)
      }
      try {
        await fs.rename(srcAbs, destAbs)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
          throw new RenameDestinationOccupiedError(destAbs)
        }
        if (code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOTSUP') {
          throw new UnsupportedDirectoryMoveError(
            `atomic directory rename failed; the platform needs the replayable strategy`,
            { cause: error },
          )
        }
        throw error
      }
      state = { ...state, physicalMayHaveLanded: true }
      await input.afterAtomicRenameBeforeParity?.(srcAbs, destAbs)

      let finalGeneration: DurableDirectoryIdentity
      try {
        finalGeneration = await captureDurableDirectoryIdentity(destAbs)
      } catch (error) {
        throw new AtomicRenameLandedGenerationReadError(destAbs, state, { cause: error })
      }
      if (finalGeneration.dev !== String(journal.sourceDev)
        || finalGeneration.ino !== String(journal.sourceIno)
        || finalGeneration.birthtimeNs !== journal.sourceBirthtimeNs) {
        throw new FolderMoveGenerationMismatchError(
          'atomic destination generation does not equal original source generation',
          state,
        )
      }
      if (await verifyFolderMoveDestinationV4(destAbs, {
        destDev: finalGeneration.dev,
        destIno: finalGeneration.ino,
        destBirthtimeNs: finalGeneration.birthtimeNs,
        entries: journal.entries,
        directories: journal.directories,
        directoryGenerations: journal.directoryGenerations,
        strategy: journal.strategy,
      })) {
        throw new FolderMoveExactParityError('atomic destination exact parity failed', state)
      }
      journal = {
        ...journal,
        phase: 'files-landed',
        destDev: finalGeneration.dev,
        destIno: finalGeneration.ino,
        destBirthtimeNs: finalGeneration.birthtimeNs,
      }
    } else {
      const destinationDirectoryGenerations =
        await createFolderMoveDestinationDirectories(
          destAbs,
          journal.directories,
          contentDir,
        )
      journal = {
        ...journal,
        destinationDirectoryGenerations,
      }
      state = { ...state, journal }
      await rewriteDurableJournal(journalAbs, journal)
      // Enter uncertainty before the mover: its first create-only link
      // can land before any hook or later I/O failure becomes visible
      // to this boundary.
      state = { ...state, physicalMayHaveLanded: true }
      await moveFolderEntriesIntoExistingGate(srcAbs, destAbs, {
        vaultRoot: contentDir,
        entries: journal.entries,
        directories: journal.directories,
        directoryGenerations: journal.directoryGenerations,
        expectedDestinationDirectoryGenerations:
          journal.destinationDirectoryGenerations,
        ignoredDestinationEntries: journal.gateProof
          ? [journal.gateProof.markerName]
          : [],
        preservePartialLandingOnError: true,
        sourceGeneration: {
          dev: String(journal.sourceDev),
          ino: String(journal.sourceIno),
          birthtimeNs: journal.sourceBirthtimeNs as string,
        },
      })
      if (await verifyFolderMoveDestinationV4(destAbs, journal, {
        ignoredRelativePaths: journal.gateProof
          ? [journal.gateProof.markerName]
          : [],
      })) {
        throw new FolderMoveExactParityError('replayable destination exact parity failed', state)
      }
      journal = {
        ...journal,
        phase: 'files-landed',
      }
    }

    state = {
      journal,
      physicalMayHaveLanded: true,
    }
    await rewriteDurableJournal(journalAbs, journal)
    await input.afterFilesLanded?.(destAbs)
    return {
      journal: journal as FolderMoveJournalV4 & { phase: 'files-landed' },
    }
  } catch (error) {
    if (error instanceof FolderMoveV4ExecutionError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new FolderMoveV4ExecutionError(message, state, { cause: error })
  }
}
