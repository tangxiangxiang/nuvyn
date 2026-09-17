import { promises as fs } from 'node:fs'
import path from 'node:path'

import { isPhysicallyContained } from './documentFileLifecycle.js'
import {
  captureDurableDirectoryIdentity,
  matchesDurableDirectoryIdentity,
} from './durableDirectoryIdentity.js'

export type FolderMoveDirectoryEntry = {
  relativeDirectoryPath: string
  sourceDev: string
  sourceIno: string
  sourceBirthtimeNs?: string
}

export type FolderMoveDirectoryRemovalResult = {
  removed: string[]
  retained: string[]
  rootRemoved: boolean
  conflict: string[]
}

/**
 * Walk every directory under dirAbs (excluding the root itself) and
 * capture its dev/ino. Symlinks, junctions and any other non-directory
 * entries are rejected; an ABI-like replacement directory that misses
 * the journal's generation proof is the whole point of this helper.
 *
 * The returned list uses stable code-unit path order. Cleanup derives
 * its own deepest-first traversal without changing the durable order.
 */
export async function captureFolderMoveDirectoryEntries(
  dirAbs: string,
  vaultRoot?: string,
): Promise<FolderMoveDirectoryEntry[]> {
  const rootIdentity = await captureDurableDirectoryIdentity(dirAbs)
  const entries: FolderMoveDirectoryEntry[] = []
  const walk = async (current: string, rel: string): Promise<void> => {
    const dirents = await fs.readdir(current, { withFileTypes: true })
    for (const dirent of dirents) {
      const abs = path.join(current, dirent.name)
      const nextRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      if (vaultRoot && !(await isPhysicallyContained(vaultRoot, abs))) {
        throw new Error(
          `folder move directory escaped the vault: ${nextRel}`,
        )
      }
      const stat = await fs.lstat(abs, { bigint: true })
      if (dirent.isFile() && stat.isFile() && !stat.isSymbolicLink()) {
        continue
      }
      if (dirent.isSymbolicLink()
        || !stat.isDirectory()
        || dirent.isBlockDevice()
        || dirent.isCharacterDevice()
        || dirent.isFIFO()
        || dirent.isSocket()) {
        throw new Error(
          `unsupported entry inside the moved folder: ${nextRel}`,
        )
      }
      const identity = await captureDurableDirectoryIdentity(abs)
      entries.push({
        relativeDirectoryPath: nextRel,
        sourceDev: identity.dev,
        sourceIno: identity.ino,
        sourceBirthtimeNs: identity.birthtimeNs,
      })
      await walk(abs, nextRel)
      const after = await fs.lstat(abs, { bigint: true })
      if (!matchesDurableDirectoryIdentity(after, identity)) {
        throw new Error('folder move source changed during durable enumeration')
      }
    }
  }
  await walk(dirAbs, '')
  const rootAfter = await fs.lstat(dirAbs, { bigint: true })
  if (!matchesDurableDirectoryIdentity(rootAfter, rootIdentity)) {
    throw new Error('folder move source changed during durable enumeration')
  }
  entries.sort((left, right) =>
    left.relativeDirectoryPath < right.relativeDirectoryPath
      ? -1
      : left.relativeDirectoryPath > right.relativeDirectoryPath
        ? 1
        : 0)
  return entries
}

export async function createFolderMoveDestinationDirectories(
  rootAbs: string,
  directories: readonly string[],
  vaultRoot?: string,
): Promise<FolderMoveDirectoryEntry[]> {
  for (const relative of directories) {
    const absolute = path.join(rootAbs, relative)
    if (vaultRoot && !await isPhysicallyContained(vaultRoot, absolute)) {
      throw new Error(`folder move destination directory escaped the vault: ${relative}`)
    }
    await fs.mkdir(absolute, { recursive: true })
  }
  const captured = await captureFolderMoveDirectoryEntries(rootAbs, vaultRoot)
  if (captured.length !== directories.length
    || captured.some((entry, index) =>
      entry.relativeDirectoryPath !== directories[index])) {
    throw new Error('folder move destination directory set changed during creation')
  }
  return captured
}

export async function verifyFolderMoveDirectoryEntries(
  rootAbs: string,
  expected: readonly FolderMoveDirectoryEntry[],
): Promise<string | null> {
  for (const entry of expected) {
    const absolute = path.join(rootAbs, entry.relativeDirectoryPath)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(absolute, { bigint: true })
    } catch {
      return `declared directory is missing: ${entry.relativeDirectoryPath}`
    }
    if (!entry.sourceBirthtimeNs
      || !stat.isDirectory() || stat.isSymbolicLink()
      || !matchesDurableDirectoryIdentity(stat, {
        dev: entry.sourceDev,
        ino: entry.sourceIno,
        birthtimeNs: entry.sourceBirthtimeNs,
      })) {
      return `declared directory generation changed: ${entry.relativeDirectoryPath}`
    }
  }
  return null
}

export function validateFolderMoveDirectoryGeneration(
  journal: {
    directories: string[]
    directoryGenerations?: FolderMoveDirectoryEntry[]
  },
): string | null {
  if (new Set(journal.directories).size !== journal.directories.length) {
    return 'directory manifest contains duplicate paths'
  }
  const sortedDeclared = [...journal.directories].sort()
  if (sortedDeclared.some((value, index) =>
    value !== journal.directories[index])) {
    return 'directory manifest is not stably sorted'
  }
  const declaredSet = new Set(sortedDeclared)
  if (!journal.directoryGenerations) {
    return 'directory generation manifest is missing'
  }
  const generations = journal.directoryGenerations
  if (generations.length !== sortedDeclared.length) {
    return 'directory generation manifest does not exactly cover directories'
  }
  const seen = new Set<string>()
  for (let index = 0; index < generations.length; index += 1) {
    const entry = generations[index]
    if (!entry || typeof entry.relativeDirectoryPath !== 'string') {
      return 'directory generation path is invalid'
    }
    if (typeof entry.sourceDev !== 'string'
      || !/^\d+$/.test(entry.sourceDev)) {
      return 'directory generation sourceDev is invalid'
    }
    if (typeof entry.sourceIno !== 'string'
      || !/^[1-9]\d*$/.test(entry.sourceIno)) {
      return 'directory generation sourceIno is invalid'
    }
    if (typeof entry.sourceBirthtimeNs !== 'string'
      || !/^[1-9]\d*$/.test(entry.sourceBirthtimeNs)) {
      return 'directory generation sourceBirthtimeNs is invalid'
    }
    if (seen.has(entry.relativeDirectoryPath)) {
      return 'directory generation path is duplicated'
    }
    if (index > 0
      && generations[index - 1].relativeDirectoryPath
        >= entry.relativeDirectoryPath) {
      return 'directory generation manifest is not stably sorted'
    }
    seen.add(entry.relativeDirectoryPath)
    if (!declaredSet.has(entry.relativeDirectoryPath)) {
      return 'directory generation path is not declared'
    }
  }
  if (seen.size !== declaredSet.size) {
    return 'directory generation manifest does not exactly cover directories'
  }
  for (const declared of sortedDeclared) {
    if (!seen.has(declared)) {
      return 'directory generation manifest does not exactly cover directories'
    }
  }
  return null
}
