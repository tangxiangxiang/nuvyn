import { promises as fs } from 'node:fs'
import path from 'node:path'

import { parseFolderMoveJournalV4Object } from './folderMoveV4DurableJournal.js'

const JOURNAL_NAME = /^\.(.+)\.nuvyn-journal-[0-9a-f-]+$/

export class FolderMovePathOwnedError extends Error {
  readonly documentPath: string

  constructor(documentPath: string) {
    super(`document path is owned by an active folder-move journal: ${documentPath}`)
    this.name = 'FolderMovePathOwnedError'
    this.documentPath = documentPath
  }
}

function prefixOwns(documentPath: string, prefix: string): boolean {
  return documentPath === prefix || documentPath.startsWith(`${prefix}/`)
}

/**
 * Fail closed when a durable folder-move journal in the target's ancestor
 * footprint owns either spelling of the document path. This is a guard for a
 * retained/quarantined startup artifact; live transactions are excluded by
 * withVaultMutation before this check runs.
 */
export async function assertPathNotOwnedByFolderMove(
  vaultRoot: string,
  historyPath: string,
): Promise<void> {
  const root = path.resolve(vaultRoot)
  const logicalPath = historyPath.slice(0, -'.md'.length)
  let directory = path.dirname(path.resolve(root, historyPath))
  while (directory.startsWith(`${root}${path.sep}`) || directory === root) {
    const names = await fs.readdir(directory).catch(() => [] as string[])
    for (const name of names) {
      const nameMatch = JOURNAL_NAME.exec(name)
      if (!nameMatch) continue
      const journalPath = path.join(directory, name)
      let candidate: unknown
      try {
        candidate = JSON.parse(await fs.readFile(journalPath, 'utf8'))
      } catch {
        // Document journals include the literal `.md` in their basename;
        // folder journal basenames cannot contain a dot. A malformed folder
        // journal has unknown destination ownership and therefore blocks.
        if (!nameMatch[1].includes('.')) {
          throw new FolderMovePathOwnedError(logicalPath)
        }
        continue
      }
      if (!candidate || typeof candidate !== 'object') continue
      const op = (candidate as Record<string, unknown>).op
      if (op !== 'folder-rename' && op !== 'folder-move') continue
      const journal = parseFolderMoveJournalV4Object(candidate)
      if (!journal) throw new FolderMovePathOwnedError(logicalPath)
      if (prefixOwns(logicalPath, journal.srcRel)
        || prefixOwns(logicalPath, journal.destRel)) {
        throw new FolderMovePathOwnedError(logicalPath)
      }
    }
    if (directory === root) break
    directory = path.dirname(directory)
  }
}
