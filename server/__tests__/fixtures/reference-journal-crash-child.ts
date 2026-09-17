// Crash-test child: runs the REAL rename-reference transaction (no fs
// mocks) and pauses at the exact protocol seam named by
// NUVYN_REFERENCE_CRASH_POINT, announcing READY:<point>; the parent
// force-kills it there, asserts the exact journal phase + payload set
// on disk, and replays the transaction through startup recovery.
//
// Points: preparing | payload-<i>-<before|after> | roll-forward |
//         roll-back | cleanup | cleanup-payload-0
// Env: NUVYN_REFERENCE_VAULT, NUVYN_REFERENCE_CRASH_POINT
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  __setRenameReferenceJournalCrashHooksForTesting,
  prepareRenameReferenceJournal,
} from '../../renameReferenceJournal.js'
import { readyAndWait } from './crash-child-ready.js'

const vault = process.env.NUVYN_REFERENCE_VAULT
const point = process.env.NUVYN_REFERENCE_CRASH_POINT
if (!vault || !point) {
  console.error('missing NUVYN_REFERENCE_* env')
  process.exit(2)
}

__setRenameReferenceJournalCrashHooksForTesting({
  afterPreparingJournal: point === 'preparing' ? () => readyAndWait('preparing') : undefined,
  afterPayloadWrite: point.startsWith('payload-')
    ? (index, kind) => {
        const reached = `payload-${index}-${kind}`
        if (reached === point) return readyAndWait(reached)
      }
    : undefined,
  afterPhaseRewrite: point === 'roll-forward' || point === 'roll-back' || point === 'cleanup'
    ? (phase) => { if (phase === point) return readyAndWait(point) }
    : undefined,
  afterPayloadRemove: point === 'cleanup-payload-0'
    ? (index) => { if (index === 0) return readyAndWait('cleanup-payload-0') }
    : undefined,
})

const sourceAbs = path.join(vault, 'old.md')
const prepared = await prepareRenameReferenceJournal({
  sourceAbs,
  op: 'document-rename-references',
  srcRel: 'old',
  destRel: 'new',
  documentId: 'rename-id',
  references: [
    { path: 'ref-a', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' },
    { path: 'ref-b', beforeRaw: '[[old]]\n', afterRaw: '[[new]]\n' },
  ],
})
if (!prepared) {
  console.error('prepareRenameReferenceJournal returned null')
  process.exit(3)
}
if (point === 'roll-back') await prepared.setDirection('roll-back')
if (point === 'cleanup' || point === 'cleanup-payload-0') await prepared.cleanup()
// Reaching this line means the crash hook never fired.
console.error('child completed without crashing')
process.exit(1)
