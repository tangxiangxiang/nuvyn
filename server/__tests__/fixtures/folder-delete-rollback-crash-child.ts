// Crash-test child: drives the REAL folder delete HTTP route through
// its ROLLBACK path and kills it mid reverse move. failDeleteRemoval
// makes the staged-tree removal fail (the route's genuine rollback
// trigger); the replayable restore then runs under a durable
// folder-move journal with the persisted metadata snapshot, and the
// child pauses at the named entry announcing READY.
//
// Env: NUVYN_FOLDER_VAULT, NUVYN_FOLDER_DB (sqlite path),
//      NUVYN_FOLDER_CRASH_POINT ('entry:<relativeFilePath>', e.g.
//      'entry:a.md'). The vault must hold gone/a.md and
//      gone/image.bin; gone/a carries metadata (the route's
//      ensureMetadata creates it on first touch — here the parent
//      seeds it via the link-index build or saveDocumentMetadata).
import Database from 'better-sqlite3'

const vault = process.env.NUVYN_FOLDER_VAULT
const dbPath = process.env.NUVYN_FOLDER_DB
const point = process.env.NUVYN_FOLDER_CRASH_POINT ?? ''
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
const { __setFolderRaceHooksForTesting } = await import('../../routes/folders.js')
const { readyAndWait } = await import('./crash-child-ready.js')

setContentDir(vault)
const database = new Database(dbPath)
applyMigrations(database)
__setMetadataDbForTesting(database)
const auth = createAuthenticatedTestContext({ db: database })

__setDirectoryMoveStrategyOverrideForTesting('replayable-move')
__setFolderRaceHooksForTesting({ failDeleteRemoval: true })
__setCreateOnlyMoveHooksForTesting({
  afterReplayableMovedEntry: point.startsWith('entry:')
    ? (entryRel) => { if (entryRel === point.slice('entry:'.length)) return readyAndWait(point) }
    : undefined,
})

const response = await app.fetch(withAuthCookie(auth, new Request(`http://localhost/api/folders/gone?recursive=true`, {
  method: 'DELETE',
})))
console.error(`child completed without crashing (status=${response.status})`)
process.exit(1)
