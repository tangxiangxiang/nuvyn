// Round-14 folder-move v4 provenance: unified validator for the v4
// trust boundary. Replaces the dual lexical validator and the round-13
// root-aware validator with one consolidated function that performs:
//
//   P0-3: physical containment of every journaled path AND symlink/
//         junction rejection of every endpoint AND the journal file
//         itself; reserved-segment detection (round-10 F9)
//   P1-1: directory manifest schema — canonical sort, no duplicates,
//         parent closure, no file-as-dir, no dir-as-file, emptyTree
//         invariants, reserved-segment rejection on every entry
//         AND directory segment.
//
// All structural + filesystem-bound checks run BEFORE any per-entry
// resolution; a forged journal fails closed before the recovery phase
// machine runs.

import path from 'node:path'
import { promises as fs } from 'node:fs'

import type {
  FolderMoveJournalV4,
} from './folderMoveTransaction.js'

import {
  isReservedPhysicalSegment,
  RESERVED_PATH_SEGMENTS,
} from './folderMoveTransaction.js'

import {
  isPhysicallyContained,
} from './documentFileLifecycle.js'
import { recoveryMarkerPrefix } from './technicalNamespace.js'

function validRelative(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('\\')
    && !value.includes('\0')
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function parentRel(value: string): string {
  const parent = path.posix.dirname(value)
  return parent === '.' ? '' : parent
}

/** The journal filename MUST bind to the source directory: same parent
 * (so a same-parent rename places the journal next to both endpoints),
 * and the prefix `.${basename}.nuvyn-journal-`. A journal whose
 * filename does not describe the journaled source cannot be trusted
 * to describe the tree the journal claims. */
function journalFilenameMatchesSource(
  contentDir: string,
  journalAbs: string,
  srcRel: string,
): boolean {
  const root = path.resolve(contentDir)
  const sourceAbs = path.resolve(root, srcRel)
  const expectedJournalDirectory = path.dirname(sourceAbs)
  const actualJournalAbs = path.resolve(journalAbs)
  if (path.dirname(actualJournalAbs) !== expectedJournalDirectory) return false
  const journalName = path.basename(actualJournalAbs)
  const sourceBase = path.basename(sourceAbs)
  return journalName.startsWith(recoveryMarkerPrefix('journal', sourceBase))
}

/** Reject any path that is itself a symbolic link / junction. A
 * missing path is allowed (the recovery walk may reach it later). */
async function rejectSymlinkIfPresent(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(absPath)
    if (stat.isSymbolicLink()) return `path is a symbolic link or junction: ${absPath}`
    return null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    return `could not lstat path: ${absPath}`
  }
}

function validateReservedSegments(relPath: string): string | null {
  for (const segment of relPath.split('/')) {
    if (isReservedPhysicalSegment(segment)) return `reserved physical segment: ${segment}`
  }
  return null
}

/** Round-14 P1-1 directory manifest schema. */
function validateV4DirectoryManifest(journal: FolderMoveJournalV4): string | null {
  const entries = journal.entries
  const directories = journal.directories

  if (!Array.isArray(entries)) return 'entries must be an array'
  if (!Array.isArray(directories)) return 'directories must be an array'

  // Empty-trees: entries must be empty AND directories must be empty.
  if (entries.length === 0 && journal.emptyTree !== true) {
    return 'entry-less journal must declare emptyTree=true'
  }
  if (entries.length > 0 && journal.emptyTree === true) {
    return 'non-empty journal must not declare emptyTree=true'
  }
  // No duplicates in directories.
  if (new Set(directories).size !== directories.length) {
    return 'duplicate directory manifest entry'
  }

  // Canonical sorted order (same comparator as listPhysicalMoveEntries).
  const sortedDirectories = [...directories].sort((a, b) => a.localeCompare(b))
  for (let i = 0; i < directories.length; i += 1) {
    if (directories[i] !== sortedDirectories[i]) {
      return 'directories are not canonically sorted'
    }
  }

  // Build fast-lookup sets and check entries.
  const filePaths = new Set<string>()
  const directoryPaths = new Set(directories)
  for (const entry of entries) {
    if (!validRelative(entry.relativeFilePath)) {
      return `invalid entry path: ${entry.relativeFilePath}`
    }
    const reserved = validateReservedSegments(entry.relativeFilePath)
    if (reserved) return reserved
    if (filePaths.has(entry.relativeFilePath)) {
      return `duplicate file path: ${entry.relativeFilePath}`
    }
    if (directoryPaths.has(entry.relativeFilePath)) {
      return `path is both file and directory: ${entry.relativeFilePath}`
    }
    filePaths.add(entry.relativeFilePath)
  }

  // Validate directory entries themselves.
  for (const directory of directories) {
    if (!validRelative(directory)) return `invalid directory path: ${directory}`
    const reserved = validateReservedSegments(directory)
    if (reserved) return reserved
    if (filePaths.has(directory)) return `path is both file and directory: ${directory}`
  }

  // Ancestor closure: every directory's ancestor MUST itself be in
  // the directory manifest. The root (empty parent) is exempt.
  for (const directory of directories) {
    const parts = directory.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = parts.slice(0, i).join('/')
      if (!directoryPaths.has(ancestor)) {
        return `directory manifest misses ancestor ${ancestor}`
      }
    }
  }

  // Parent closure: every file's parent MUST be in the directory manifest.
  for (const filePath of filePaths) {
    const parts = filePath.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = parts.slice(0, i).join('/')
      if (!directoryPaths.has(ancestor)) {
        return `directory manifest misses file parent ${ancestor}`
      }
    }
  }

  // No directory beneath a file.
  for (const directory of directories) {
    for (const filePath of filePaths) {
      if (directory.startsWith(`${filePath}/`)) {
        return `directory ${directory} is below file ${filePath}`
      }
    }
  }

  return null
}

/** Round-14 P0-3 / P1-1: unified v4 provenance validator. Replaces the
 * round-12/13 pair with a single trust-boundary check that handles:
 *
 *   * structural validity of srcRel/destRel/entries/directories
 *     (no `.`, no leading slash, no backslash, no NUL)
 *   * srcRel !== destRel
 *   * same-parent directories (single-segment rename / delete-rollback)
 *   * journal filename binds to srcRel (same parent + the
 *     `.${basename}.nuvyn-journal-` prefix)
 *   * physical containment of every endpoint AND per-entry path
 *     (vault-root containment + no symlink/junction ancestor escape)
 *   * journal file itself is not a symlink/junction
 *   * directory manifest schema (sort, dedup, parent/ancestor closure,
 *     reserved segments, no file-as-dir, emptyTree invariant)
 *
 * Returns null on success, a reason string on failure. Failure
 * signals `quarantined` in recovery (no path was touched). */
export async function validateFolderMoveJournalV4Provenance(
  journal: FolderMoveJournalV4,
  contentDir: string,
  journalAbs: string,
): Promise<string | null> {
  if (!validRelative(journal.srcRel)) return `invalid srcRel: ${journal.srcRel}`
  if (!validRelative(journal.destRel)) return `invalid destRel: ${journal.destRel}`
  if (journal.srcRel === journal.destRel) return 'srcRel must not equal destRel'

  // Folder rename and delete rollback are same-parent protocols:
  // the journal must live next to both endpoints.
  if (parentRel(journal.srcRel) !== parentRel(journal.destRel)) {
    return 'folder move endpoints must share one parent directory'
  }

  const filenameBindsSource = journalFilenameMatchesSource(
    contentDir,
    journalAbs,
    journal.srcRel,
  )
  // A folder-rename journal keeps its original filename while the
  // rollback durably flips src/dest. In that reverse direction its
  // filename is necessarily bound to destRel (the original source).
  const filenameBindsReverseRename = journal.op === 'folder-rename'
    && journalFilenameMatchesSource(contentDir, journalAbs, journal.destRel)
  if (!filenameBindsSource && !filenameBindsReverseRename) {
    return 'journal filename or location is not bound to the folder rename endpoints'
  }

  const root = path.resolve(contentDir)
  const srcAbs = path.resolve(root, journal.srcRel)
  const destAbs = path.resolve(root, journal.destRel)

  // Physical containment at the source/destination root.
  if (!await isPhysicallyContained(root, srcAbs)) return 'source physically escapes contentDir'
  if (!await isPhysicallyContained(root, destAbs)) return 'destination physically escapes contentDir'

  // Symlink/junction rejection on every endpoint.
  const sourceSymlinkError = await rejectSymlinkIfPresent(srcAbs)
  if (sourceSymlinkError) return sourceSymlinkError
  const destinationSymlinkError = await rejectSymlinkIfPresent(destAbs)
  if (destinationSymlinkError) return destinationSymlinkError

  // The journal file itself cannot be a symlink/junction.
  const journalSymlinkError = await rejectSymlinkIfPresent(path.resolve(journalAbs))
  if (journalSymlinkError) return journalSymlinkError

  // Directory manifest schema (P1-1).
  const manifestError = validateV4DirectoryManifest(journal)
  if (manifestError) return manifestError

  // Per-entry physical containment.
  for (const entry of journal.entries) {
    const sourceEntryAbs = path.join(srcAbs, entry.relativeFilePath)
    const destinationEntryAbs = path.join(destAbs, entry.relativeFilePath)
    if (!await isPhysicallyContained(root, sourceEntryAbs)
      || !await isPhysicallyContained(root, destinationEntryAbs)) {
      return `entry physically escapes contentDir: ${entry.relativeFilePath}`
    }
  }

  // Per-directory physical containment.
  for (const directory of journal.directories) {
    const sourceDirectoryAbs = path.join(srcAbs, directory)
    const destinationDirectoryAbs = path.join(destAbs, directory)
    if (!await isPhysicallyContained(root, sourceDirectoryAbs)
      || !await isPhysicallyContained(root, destinationDirectoryAbs)) {
      return `directory physically escapes contentDir: ${directory}`
    }
  }

  // Avoid unused-import warnings.
  void RESERVED_PATH_SEGMENTS

  return null
}
