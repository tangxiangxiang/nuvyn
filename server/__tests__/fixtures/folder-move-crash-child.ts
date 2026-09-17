// Crash-test child: runs the REAL folder rename HTTP route against a
// temp vault — the route writes the real durable journal (schema v4:
// four-state phase machine with destination directory generation proof)
// and performs the real move. The child pauses at the named seam
// announcing READY:<point>; the parent force-kills it there, asserts
// the exact split state on disk INCLUDING the real journal JSON, and
// replays from the journal. The journal is never hand-copied here —
// it is the route's own artifact.
//
// Env: NUVYN_FOLDER_VAULT, NUVYN_FOLDER_DB (sqlite path),
//      NUVYN_FOLDER_CRASH_POINT ('gate' | 'entry:<relativeFilePath>' |
//      'parity' | 'metadata' | 'journal-remove' |
//      'reverse-gate' | 'reverse-entry:<relativeFilePath>' |
//      'reverse-parity' | 'reverse-metadata' | 'reverse-journal-remove').
//      The vault must hold proj/a.md, proj/image.bin and proj/nested/b.md.
import Database from 'better-sqlite3'

const vault = process.env.NUVYN_FOLDER_VAULT
const dbPath = process.env.NUVYN_FOLDER_DB
const point = process.env.NUVYN_FOLDER_CRASH_POINT ?? 'gate'
if (!vault || !dbPath) {
  console.error('missing NUVYN_FOLDER_* env')
  process.exit(2)
}

const { setContentDir } = await import('../../paths.js')
const { applyMigrations } = await import('../../db.js')
const { default: app, __setMetadataDbForTesting } = await import('../../index.js')
const { createAuthenticatedTestContext, withAuthCookie } = await import('../helpers/auth.js')
const {
  __setCreateOnlyMoveHooksForTesting,
  __setDirectoryMoveStrategyOverrideForTesting,
} = await import('../../documentFileLifecycle.js')
const { readyAndWait } = await import('./crash-child-ready.js')

setContentDir(vault)
const database = new Database(dbPath)
applyMigrations(database)
__setMetadataDbForTesting(database)
const auth = createAuthenticatedTestContext({ db: database })

// Exercise the Windows journaled protocol through the real route on
// every platform: the override makes the route PERSIST strategy
// 'replayable-move' and run the per-file move under that journal.
__setDirectoryMoveStrategyOverrideForTesting('replayable-move')

// Build the hook bag based on which crash point the parent requested.
const hooks: Record<string, unknown> = {}

// Forward seams (v4)
if (point === 'gate') {
  hooks.afterGateCreated = () => readyAndWait('gate')
}
if (point.startsWith('entry:')) {
  const targetEntry = point.slice('entry:'.length)
  hooks.afterReplayableMovedEntry = (entryRel: string) => {
    if (entryRel === targetEntry) return readyAndWait(`entry:${entryRel}`)
  }
}
if (point === 'parity') {
  hooks.afterFilesLanded = () => readyAndWait('parity')
}
if (point === 'metadata') {
  hooks.afterMetadataCommitted = () => readyAndWait('metadata')
}
if (point === 'journal-remove') {
  hooks.afterMetadataCommitted = () => readyAndWait('journal-remove')
}

// Reverse seams — support both old "rollback-" and new "reverse-" prefixes
// for backward compatibility with existing test names.
const reversePoint = point.replace(/^rollback-/, 'reverse-')
if (reversePoint === 'reverse-gate' || point === 'rollback-after-tree') {
  if (point === 'rollback-after-tree') {
    // Old name for afterRollbackMove in the route hooks
    hooks.afterRollbackMove = () => readyAndWait('rollback-after-tree')
  } else {
    hooks.afterReverseGateCreated = () => readyAndWait('reverse-gate')
  }
}
if (reversePoint.startsWith('reverse-entry:') || point.startsWith('rollback-entry:')) {
  const targetEntry = point.startsWith('rollback-entry:')
    ? point.slice('rollback-entry:'.length)
    : point.slice('reverse-entry:'.length)
  hooks.afterReplayableMovedEntry = (entryRel: string) => {
    if (entryRel === targetEntry) return readyAndWait(point)
  }
}
if (reversePoint === 'reverse-parity') {
  hooks.afterReverseParity = () => readyAndWait('reverse-parity')
}
if (reversePoint === 'reverse-metadata') {
  hooks.afterReverseMetadata = () => readyAndWait('reverse-metadata')
}
if (reversePoint === 'reverse-journal-remove') {
  hooks.beforeReverseJournalRemove = () => readyAndWait('reverse-journal-remove')
}

__setCreateOnlyMoveHooksForTesting(hooks as any)

const response = await app.fetch(withAuthCookie(auth, new Request('http://localhost/api/folders/proj', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newPath: 'ren' }),
})))
// Reaching this line means the crash hook never fired.
console.error(`child completed without crashing (status=${response.status})`)
process.exit(1)
