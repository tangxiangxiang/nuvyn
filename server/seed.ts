// Lazy-seed the four vault root folders under the content root.
//
// The vault protocol (shared/archiveProtocol.ts) treats
// `inbox`, `literature`, `archive`, and `diary` as reserved top-level roots —
// they must exist for the tree, scope filter, and rename/delete
// guards to behave correctly. With a fresh content directory
// (typical on the first `docker compose up` against an empty named
// volume), none of them are present and the UI shows a blank tree
// with no scope chips.
//
// `ensureInitialFolders` is idempotent: missing folders are created,
// existing ones are left strictly alone. Nothing inside the folders
// is touched, so a user who has already populated `inbox/foo.md`
// on a prior run keeps every file.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const INITIAL_FOLDERS = ['inbox', 'literature', 'archive', 'diary'] as const

export async function ensureInitialFolders(rootDir: string): Promise<void> {
  for (const name of INITIAL_FOLDERS) {
    const abs = path.join(rootDir, name)
    try {
      await fs.mkdir(abs, { recursive: true })
    } catch (e) {
      // EEXIST means a file (not a dir) is in the way — that's a
      // user-data conflict we shouldn't silently overwrite. Re-throw
      // so the operator sees it in the startup log; the server can
      // still keep running because mkdir-recursive is best-effort.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      console.warn(`[nuvyn] cannot seed ${name}: a non-directory file already exists at ${abs}`)
    }
  }
}
