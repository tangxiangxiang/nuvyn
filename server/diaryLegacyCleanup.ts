import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { parseDiaryDate } from '../shared/diaryProtocol.js'
import { withVaultStructureLock } from './documentWriteLock.js'
import { deleteDocumentMetadata } from './documentMetadata.js'

/** Idempotent retirement, called before serving requests. Never traverse the
 * namespace or follow symlinks; only exact managed dates with metadata qualify.
 * Shared Git history is left intact because rewriting it affects other workspaces.
 */
export async function cleanupLegacyDiary(db: Database, vault: string): Promise<number> {
  return withVaultStructureLock(async () => {
    const root = await fs.realpath(vault)
    const directory = path.join(root, 'diary')
    let stat
    try { stat = await fs.lstat(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 0
    let removed = 0
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || !parseDiaryDate(entry.name.slice(0, -3))) continue
      const logicalPath = `diary/${entry.name.slice(0, -3)}`
      const metadata = db.prepare('SELECT id FROM documents WHERE path = ?').get(logicalPath)
      if (!metadata) continue
      const file = path.join(directory, entry.name)
      const current = await fs.lstat(file)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) continue
      await fs.unlink(file)
      deleteDocumentMetadata(db, logicalPath)
      removed++
    }
    // A previous crash may have removed a verified file before its metadata.
    const rows = db.prepare("SELECT path FROM documents WHERE path LIKE 'diary/%'").all() as Array<{ path: string }>
    for (const row of rows) {
      if (!parseDiaryDate(row.path.slice(6))) continue
      try { await fs.lstat(path.join(root, `${row.path}.md`)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        deleteDocumentMetadata(db, row.path)
      }
    }
    return removed
  })
}
