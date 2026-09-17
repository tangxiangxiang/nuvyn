import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { FolderMoveJournalV4 } from '../folderMoveTransaction'

async function matchingBirthtime(
  candidates: string[],
  dev: string | undefined,
  ino: string | undefined,
): Promise<string> {
  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate, { bigint: true })
      if (stat.isDirectory() && !stat.isSymbolicLink()
        && stat.dev.toString() === dev
        && stat.ino.toString() === ino
        && stat.birthtimeNs > 0n) {
        return stat.birthtimeNs.toString()
      }
    } catch {
      // Try the next durable location.
    }
  }
  return '1'
}

/** Upgrade pre-P0-3 test fixtures without weakening production parsing. */
export async function addCurrentDirectoryBirthtimes(
  vault: string,
  journal: FolderMoveJournalV4,
): Promise<void> {
  const sourceAbs = path.join(vault, journal.srcRel)
  const destinationAbs = path.join(vault, journal.destRel)
  journal.sourceBirthtimeNs ??= await matchingBirthtime(
    [sourceAbs, destinationAbs],
    journal.sourceDev,
    journal.sourceIno,
  )
  if (journal.phase !== 'prepared') {
    journal.destBirthtimeNs ??= await matchingBirthtime(
      [destinationAbs],
      journal.destDev,
      journal.destIno,
    )
  }
  for (const row of journal.directoryGenerations ?? []) {
    row.sourceBirthtimeNs ??= await matchingBirthtime(
      [
        path.join(sourceAbs, row.relativeDirectoryPath),
        path.join(destinationAbs, row.relativeDirectoryPath),
      ],
      row.sourceDev,
      row.sourceIno,
    )
  }
  for (const row of journal.destinationDirectoryGenerations ?? []) {
    row.sourceBirthtimeNs ??= await matchingBirthtime(
      [path.join(destinationAbs, row.relativeDirectoryPath)],
      row.sourceDev,
      row.sourceIno,
    )
  }
}
