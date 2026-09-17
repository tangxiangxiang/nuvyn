import type { FolderMoveJournalV4 } from './folderMoveTransaction.js'
import { validateFolderMoveDirectoryGeneration } from './folderMoveDirectoryOwnership.js'
import { validateFolderMoveGateProof } from './folderMoveTransaction.js'

export type FolderMoveRecoveryStrength = 'strong' | 'weak' | 'unusable'

/**
 * Classify a folder-move journal's recovery strength.
 *
 * Strong journals have every durable site fully populated: v4 with
 * gateProof at the phase-machine gate, every entry carrying
 * dev/ino/hash proof, every declared directory carrying dev/ino
 * proof, and unsafe-numeric dev/ino not used (precision lost).
 *
 * Weak journals are those the parser accepts but recovery cannot
 * trust without further inspection:
 *   - legacy v1/v2/v3 variants (no phase gateProof, no
 *     directoryGenerations).
 *   - v4 at gate-created/files-landed with no gateProof (the
 *     markerless phase-machine variant — anyone could have advanced
 *     the phase without producing a gate token).
 *   - v4 empty-tree journals with no gateProof.
 *   - v4 with mixed proof across entries (some entries lack dev/ino
 *     or hash).
 *   - v4 unsafe-numeric dev/ino (legacy numeric compatibility path;
 *     precision lost).
 *
 * The classifier is consulted by crashRecovery before any
 * filesystem/SQLite mutation. Weak journals are quarantined with a
 * documented detail — disk state is preserved as-is.
 */
export function classifyFolderMoveRecoveryStrength(
  journal: unknown,
): { strength: FolderMoveRecoveryStrength, reason?: string } {
  if (!journal || typeof journal !== 'object') {
    return { strength: 'unusable', reason: 'not an object' }
  }
  const entry = journal as Record<string, unknown>
  const version = entry.version
  if (version !== 4) {
    // v1/v2/v3 journals never carry directoryGenerations, gateProof,
    // or phase-aligned hash proof — they fail closed by definition.
    return {
      strength: 'weak',
      reason: `legacy journal version ${String(version)} lacks durable phase-machine proof`,
    }
  }
  const phase = entry.phase
  const entries = Array.isArray(entry.entries) ? entry.entries : []
  const gateProof = entry.gateProof
  if (!validateFolderMoveGateProof(gateProof)) {
    return {
      strength: 'weak',
      reason: `v4 markerless ${String(phase)} journal lacks destination ownership proof`,
    }
  }
  if (!Array.isArray(entry.directories)) {
    return {
      strength: 'weak',
      reason: 'v4 journal lacks a directory manifest',
    }
  }
  const directoryGenerationError =
    validateFolderMoveDirectoryGeneration({
      directories: entry.directories as string[],
      directoryGenerations: Array.isArray(entry.directoryGenerations)
        ? entry.directoryGenerations as FolderMoveJournalV4['directoryGenerations']
        : undefined,
    })
  if (directoryGenerationError !== null) {
    return {
      strength: 'weak',
      reason: directoryGenerationError,
    }
  }
  if (entry.strategy === 'replayable-move'
    && (phase === 'files-landed' || phase === 'metadata-committed')
    && (entry.directories as string[]).length > 0
    && !Array.isArray(entry.destinationDirectoryGenerations)) {
    return {
      strength: 'weak',
      reason: 'destination directory generation manifest is missing',
    }
  }
  // Mixed proof across entries: some carry dev/ino/hash, some don't.
  // The surface area for any single entry that lost durable
  // ownership is the whole tree — fail closed.
  if (entries.length > 0) {
    let hashedCount = 0
    for (const row of entries as Array<Record<string, unknown>>) {
      if (row
        && typeof row.sourceDev === 'string' && /^\d+$/.test(row.sourceDev)
        && typeof row.sourceIno === 'string' && /^[1-9]\d*$/.test(row.sourceIno)
        && typeof row.sourceHash === 'string' && /^[0-9a-f]{64}$/.test(row.sourceHash)) {
        hashedCount += 1
      }
    }
    if (hashedCount !== entries.length) {
      return {
        strength: 'weak',
        reason: `v4 journal has mixed proof across entries (${hashedCount}/${entries.length} hashed)`,
      }
    }
  }
  // v4 unsafe-numeric dev/ino: precision already lost. The parser
  // accepts these for read-only backward compat, but recovery must
  // not act on them.
  if (typeof entry.sourceDev === 'number'
    || typeof entry.sourceIno === 'number') {
    return {
      strength: 'weak',
      reason: 'v4 journal uses unsafe-numeric dev/ino (precision lost)',
    }
  }
  if (typeof entry.sourceDev !== 'string'
    || !/^\d+$/.test(entry.sourceDev)
    || typeof entry.sourceIno !== 'string'
    || !/^[1-9]\d*$/.test(entry.sourceIno)) {
    return {
      strength: 'weak',
      reason: 'v4 journal source root generation is unsafe',
    }
  }
  if (typeof entry.sourceBirthtimeNs !== 'string'
    || !/^[1-9]\d*$/.test(entry.sourceBirthtimeNs)) {
    return {
      strength: 'weak',
      reason: 'v4 journal source root birthtime proof is missing or unsafe',
    }
  }
  if (phase !== 'prepared'
    && (typeof entry.destBirthtimeNs !== 'string'
      || !/^[1-9]\d*$/.test(entry.destBirthtimeNs))) {
    return {
      strength: 'weak',
      reason: 'v4 journal destination root birthtime proof is missing or unsafe',
    }
  }
  return { strength: 'strong' }
}

/**
 * Convenience: was the journal classified strong?
 */
export function isStrongFolderMoveRecovery(
  journal: FolderMoveJournalV4,
): boolean {
  return classifyFolderMoveRecoveryStrength(journal).strength === 'strong'
}
