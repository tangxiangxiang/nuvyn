import { promises as fs } from 'node:fs'
import path from 'node:path'

import { sha256HexBuffer } from './atomicTextWrite.js'
import type { FolderMoveJournalV4 } from './folderMoveTransaction.js'
import { matchesDurableDirectoryIdentity } from './durableDirectoryIdentity.js'

export type FolderMoveSourceInventory =
  | { kind: 'intact' }
  | { kind: 'partially-moved'; remainingEntries: string[] }
  | { kind: 'empty-owned-shell' }
  | { kind: 'external'; reason: string }
  | { kind: 'absent' }

/**
 * Inspect the source without mutating it.  Every discovered path must be in
 * the durable file/directory manifest; an undeclared empty directory is
 * external state just like an undeclared file.
 */
export async function inspectFolderMoveSourceInventory(
  srcAbs: string,
  journal: FolderMoveJournalV4,
): Promise<FolderMoveSourceInventory> {
  let root: Awaited<ReturnType<typeof fs.lstat>>
  try {
    root = await fs.lstat(srcAbs, { bigint: true })
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'external', reason: 'source root could not be inspected' }
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return { kind: 'external', reason: 'source root is not a real directory' }
  }
  if (typeof journal.sourceBirthtimeNs !== 'string'
    || !matchesDurableDirectoryIdentity(root, {
      dev: String(journal.sourceDev),
      ino: String(journal.sourceIno),
      birthtimeNs: journal.sourceBirthtimeNs,
    })) {
    return { kind: 'external', reason: 'source root generation changed' }
  }

  const declaredFiles = new Map(
    journal.entries.map(entry => [entry.relativeFilePath, entry]),
  )
  const declaredDirectories = new Set(journal.directories)
  const directoryGenerations = new Map(
    (journal.directoryGenerations ?? []).map(entry => [
      entry.relativeDirectoryPath,
      entry,
    ]),
  )
  if (directoryGenerations.size !== declaredDirectories.size) {
    return {
      kind: 'external',
      reason: 'source directory generation manifest is incomplete',
    }
  }
  const remainingEntries: string[] = []
  const seenDirectories = new Set<string>()
  const walk = async (
    directoryAbs: string,
    relativeParent: string,
  ): Promise<string | null> => {
    const dirents = await fs.readdir(directoryAbs, { withFileTypes: true })
    for (const dirent of dirents) {
      const relative = relativeParent
        ? `${relativeParent}/${dirent.name}`
        : dirent.name
      const absolute = path.join(directoryAbs, dirent.name)
      const stat = await fs.lstat(absolute, { bigint: true })
      if (stat.isSymbolicLink()) {
        return `source contains symlink or junction: ${relative}`
      }
      if (stat.isDirectory()) {
        if (!declaredDirectories.has(relative)) {
          return `source contains undeclared directory: ${relative}`
        }
        const generation = directoryGenerations.get(relative)
        if (!generation || typeof generation.sourceBirthtimeNs !== 'string'
          || !matchesDurableDirectoryIdentity(stat, {
            dev: generation.sourceDev,
            ino: generation.sourceIno,
            birthtimeNs: generation.sourceBirthtimeNs,
          })) {
          return `source directory generation changed: ${relative}`
        }
        seenDirectories.add(relative)
        const nested = await walk(absolute, relative)
        if (nested) return nested
        const after = await fs.lstat(absolute, { bigint: true })
        if (!matchesDurableDirectoryIdentity(after, {
          dev: generation.sourceDev,
          ino: generation.sourceIno,
          birthtimeNs: generation.sourceBirthtimeNs,
        })) {
          return `source directory generation changed: ${relative}`
        }
        continue
      }
      if (!stat.isFile()) {
        return `source contains special entry: ${relative}`
      }
      const declared = declaredFiles.get(relative)
      if (!declared) return `source contains undeclared file: ${relative}`
      if (stat.dev.toString() !== declared.sourceDev
        || stat.ino.toString() !== declared.sourceIno
        || sha256HexBuffer(await fs.readFile(absolute))
          !== declared.sourceHash) {
        return `source entry generation changed: ${relative}`
      }
      remainingEntries.push(relative)
    }
    return null
  }
  try {
    const external = await walk(srcAbs, '')
    if (external) return { kind: 'external', reason: external }
    const rootAfter = await fs.lstat(srcAbs, { bigint: true })
    if (!matchesDurableDirectoryIdentity(rootAfter, {
      dev: String(journal.sourceDev),
      ino: String(journal.sourceIno),
      birthtimeNs: journal.sourceBirthtimeNs,
    })) {
      return { kind: 'external', reason: 'source root generation changed' }
    }
  } catch {
    return { kind: 'external', reason: 'source inventory changed while inspecting' }
  }

  for (const relative of declaredDirectories) {
    if (!seenDirectories.has(relative)) {
      return {
        kind: 'external',
        reason: `declared source directory is missing: ${relative}`,
      }
    }
  }
  remainingEntries.sort()
  if (remainingEntries.length === journal.entries.length) {
    return { kind: 'intact' }
  }
  if (remainingEntries.length > 0) {
    return { kind: 'partially-moved', remainingEntries }
  }
  return { kind: 'empty-owned-shell' }
}
