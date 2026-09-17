// Crash-test child: kills startup RECOVERY mid-replay of a folder
// reference rollback. Seeds the exact post-forward-rename crash state
// (tree at the destination, reference journal in roll-back phase) with
// the PRODUCTION reference-journal writer, then runs the real
// recoverInterruptedOperations — which writes its own durable
// folder-move journal before reversing the tree — and pauses at the
// first replayed entry announcing READY. The parent kills it there,
// asserts the split state plus the recovery-written move journal, and
// proves the next startup completes everything.
//
// Env: NUVYN_FOLDER_VAULT, NUVYN_FOLDER_DB (sqlite path),
//      NUVYN_FOLDER_CRASH_POINT ('replay:<relativeFilePath>').
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const vault = process.env.NUVYN_FOLDER_VAULT
const dbPath = process.env.NUVYN_FOLDER_DB
const point = process.env.NUVYN_FOLDER_CRASH_POINT ?? ''
if (!vault || !dbPath) {
  console.error('missing NUVYN_FOLDER_* env')
  process.exit(2)
}

const { setContentDir } = await import('../../paths.js')
const { applyMigrations } = await import('../../db.js')
const { saveDocumentMetadata } = await import('../../documentMetadata.js')
const { prepareRenameReferenceJournal } = await import('../../renameReferenceJournal.js')
const { sha256Hex } = await import('../../atomicTextWrite.js')
const { recoverInterruptedOperations } = await import('../../crashRecovery.js')
const {
  __setCreateOnlyMoveHooksForTesting,
  __setDirectoryMoveStrategyOverrideForTesting,
} = await import('../../documentFileLifecycle.js')
const { readyAndWait } = await import('./crash-child-ready.js')

// Recovery's own reverse move runs the Windows journaled per-file
// protocol on every platform, so it can be killed mid-replay.
__setDirectoryMoveStrategyOverrideForTesting('replayable-move')

setContentDir(vault)
const database = new Database(dbPath)
applyMigrations(database)

const A_RAW = '# a\n'
const B_RAW = '# b\n'
// The forward rename completed (tree at ren/, metadata moved) and the
// backlink rewrite landed before the crash; the reference journal was
// durably switched to roll-back. The journal itself was written by the
// route BEFORE the forward move (while proj/ still existed), so it is
// prepared here with proj/ present and the directory is removed
// afterwards — the exact post-move crash state.
await fs.mkdir(path.join(vault, 'proj'), { recursive: true })
saveDocumentMetadata(database, { id: 'rec-a-id', path: 'ren/a', title: 'A', updatedAt: 1 })
saveDocumentMetadata(database, { id: 'rec-b-id', path: 'ren/nested/b', title: 'B', updatedAt: 1 })

const prepared = await prepareRenameReferenceJournal({
  sourceAbs: path.join(vault, 'proj'),
  op: 'folder-rename-references',
  srcRel: 'proj',
  destRel: 'ren',
  identities: [
    { path: 'proj/a', id: 'rec-a-id', sourceHash: sha256Hex(A_RAW) },
    { path: 'proj/nested/b', id: 'rec-b-id', sourceHash: sha256Hex(B_RAW) },
  ],
  references: [{ path: 'ref-a', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' }],
})
if (!prepared) {
  console.error('reference journal was not created')
  process.exit(3)
}
await prepared.setDirection('roll-back')
await fs.rmdir(path.join(vault, 'proj'))

await fs.mkdir(path.join(vault, 'ren', 'nested'), { recursive: true })
await fs.writeFile(path.join(vault, 'ren', 'a.md'), A_RAW, 'utf8')
await fs.writeFile(path.join(vault, 'ren', 'nested', 'b.md'), B_RAW, 'utf8')
await fs.writeFile(path.join(vault, 'ref-a.md'), '[[new]]\n', 'utf8')

__setCreateOnlyMoveHooksForTesting({
  afterReplayableMovedEntry: point.startsWith('replay:')
    ? (entryRel) => { if (entryRel === point.slice('replay:'.length)) return readyAndWait(point) }
    : undefined,
})

await recoverInterruptedOperations(vault, database)
console.error('recovery completed without crashing')
process.exit(1)
