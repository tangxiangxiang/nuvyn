import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import { AttachmentTrash } from '../../attachments/trash.js'
import type { AttachmentCleanupPreview } from '../../../shared/attachmentProtocol.js'

const [root, databasePath, boundary, operation, resourcePath, recordId] = process.argv.slice(2)
if (!root || !databasePath || !boundary || !operation || !resourcePath) throw new Error('Crash fixture arguments required')
const db = new Database(databasePath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = FULL')
const service = new AttachmentTrash(db, root)
const link = fs.link.bind(fs)
const unlink = fs.unlink.bind(fs)
fs.link = async (...args) => {
  if (boundary === 'before-link') process.kill(process.pid, 'SIGKILL')
  await link(...args)
  if (boundary === 'link') process.kill(process.pid, 'SIGKILL')
}
fs.unlink = async (...args) => {
  await unlink(...args)
  if (boundary === 'unlink') process.kill(process.pid, 'SIGKILL')
}
if (operation === 'restore') {
  await service.restore(recordId!)
} else {
  const preview: AttachmentCleanupPreview = {
    resource: { kind: 'vault-file', path: resourcePath }, currentFinding: 'no-current-reference',
    riskLevel: 'review-required', referenceCount: 0, ownerCount: 0, stale: false,
    coverage: { currentNotes: 'complete', boardReferences: 'complete', historicalVersions: 'not-checked',
      unsavedDrafts: 'not-checked', protectedDiary: 'restricted', boardCheckpoints: 'not-checked', externalChanges: 'not-checked' },
    riskReasons: ['historical-versions-not-checked'], deletionAllowed: false, snapshotId: 'crash-test', checkedAt: Date.now(),
  }
  const prepared = await service.preview(preview, 1, true)
  if (!prepared.quarantineToken) throw new Error('Crash fixture preflight failed')
  await service.quarantine(prepared.quarantineToken, 1, async () => {})
}
