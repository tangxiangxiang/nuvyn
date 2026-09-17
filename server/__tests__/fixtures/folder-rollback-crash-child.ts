// Crash-test child: drives the REAL folder rename HTTP route through
// its ROLLBACK path and kills it at a named reverse-move seam.
//
// The route is made to roll back the way production actually does:
// updateReferences plans a backlink rewrite, and the afterRenamePlanBuilt
// hook mutates the reference file like an external editor — the
// ownership-verified reference write then fails (AtomicTextWriteConflict)
// and the route enters its real rollback: durably flip the folder-move
// journal's direction, reverse the tree, restore the metadata snapshot.
//
// Env: NUVYN_FOLDER_VAULT, NUVYN_FOLDER_DB (sqlite path),
//      NUVYN_FOLDER_CRASH_POINT:
//        'reverse-gate'              — after reverse gate mkdir + phase rewrite
//        'reverse-entry:a.md'        — after first reverse file landed
//        'reverse-parity'            — after reverse exact parity passed
//        'reverse-before-metadata'    — immediately before reverse CAS
//        'reverse-metadata'          — after reverse metadata restore
//        'reverse-journal-remove'    — just before reverse journal removal
//        'reverse-prepared'           — reverse journal durable, before gate
//        'reverse-handoff'            — owner gone, dependent still durable
//        'bind-owner-pending'         — owner-pending rewrite; v4 not yet durable
//        'v4-owner-durable'           — v4 owner journal durable; pending still
//        'owner-durable-mark'         — mark owner durable; handoff complete
// The vault must hold proj/a.md, proj/image.bin, proj/nested/b.md and
// ref-a.md linking into the folder.
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
if (point === 'reverse-before-metadata') {
  __setCreateOnlyMoveHooksForTesting({
    beforeReverseMetadataRestore: () => readyAndWait(point),
  })
}
// The forward move runs WITHOUT move hooks (they would fire on the
// forward entries too); the reverse-move kill is armed inside
// afterRenamePlanBuilt — which fires only after the forward move,
// metadata commit and journal removal, right before the reference
// write loop. The external save planted there is what fails the
// reference write and drives the route into its real rollback.
const raceHooks: import('../../routes/folders.js').FolderRaceHooks = {}
if (point === 'rollback-after-tree') {
  raceHooks.afterRollbackMove = () => readyAndWait(point)
}
if (point === 'reverse-prepared') {
  raceHooks.afterRenameRollbackPrepared = () => readyAndWait(point)
}
// F1 / F2 owner-binding crash seams. The route binds owner-pending durably,
// then durably rewrites the flipped v4 owner journal (the second durable
// write), then promotes the companion to owner-durable. The fixture waits
// at each of the three seams: bind-owner-pending (after pending-rewite,
// before v4 owner journal rewrite), v4-owner-durable (after v4 rewrite,
// before owner-durable mark), owner-durable-mark (after mark).
if (point === 'bind-owner-pending') {
  raceHooks.afterBindOwnerPending = () => readyAndWait(point)
}
if (point === 'v4-owner-durable') {
  raceHooks.afterV4OwnerJournalDurable = () => readyAndWait(point)
}
if (point === 'owner-durable-mark') {
  raceHooks.afterOwnerDurableMark = () => readyAndWait(point)
}
if (point === 'bind-owner-pending'
  || point === 'v4-owner-durable'
  || point === 'owner-durable-mark') {
  raceHooks.afterReferenceWrites = () => {
    throw new Error('force rollback after reference writes')
  }
}
if (point === 'reverse-handoff') {
  raceHooks.afterReferenceWrites = () => {
    throw new Error('force rollback after reference writes')
  }
}
__setFolderRaceHooksForTesting(raceHooks)
__setFolderRaceHooksForTesting({
  ...raceHooks,
  afterRenamePlanBuilt: async () => {
    const hooks: Record<string, unknown> = {}
    // Support both old "rollback-" and new "reverse-" prefixes
    const effectivePoint = point.replace(/^rollback-/, 'reverse-')
    if (effectivePoint.startsWith('reverse-entry:')) {
      const targetEntry = effectivePoint.slice('reverse-entry:'.length)
      hooks.afterReplayableMovedEntry = (entryRel: string) => {
        if (entryRel === targetEntry) return readyAndWait(point)
      }
    }
    if (effectivePoint === 'reverse-gate') {
      hooks.afterReverseGateCreated = () => readyAndWait(point)
    }
    if (effectivePoint === 'reverse-parity') {
      hooks.afterReverseParity = () => readyAndWait(point)
    }
    if (effectivePoint === 'reverse-before-metadata') {
      hooks.beforeReverseMetadataRestore = () => readyAndWait(point)
    }
    if (effectivePoint === 'reverse-metadata') {
      hooks.afterReverseMetadata = () => readyAndWait(point)
    }
    if (effectivePoint === 'reverse-journal-remove') {
      hooks.beforeReverseJournalRemove = () => readyAndWait(point)
    }
    if (effectivePoint === 'reverse-handoff') {
      hooks.afterReverseOwnerCleanupBeforeReferenceCleanup =
        () => readyAndWait(point)
    }
    __setCreateOnlyMoveHooksForTesting(hooks as any)
    if (effectivePoint !== 'reverse-handoff'
      && point !== 'bind-owner-pending'
      && point !== 'v4-owner-durable'
      && point !== 'owner-durable-mark') {
      await fs.writeFile(path.join(vault, 'ref-a.md'), '# externally changed\n', 'utf8')
    }
  },
})

const response = await app.fetch(withAuthCookie(auth, new Request('http://localhost/api/folders/proj', {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newPath: 'ren', updateReferences: true }),
})))
console.error(
  `child completed without crashing (status=${response.status}, body=${await response.text()})`,
)
process.exit(1)
