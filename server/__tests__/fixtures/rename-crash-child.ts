// Crash-test child: runs the REAL create-only file move (no fs mocks)
// and pauses right AFTER the destination link lands but BEFORE the
// staging name is removed — the window that leaves two names on one
// inode — announcing READY:linked. The parent force-kills it there,
// asserts the crash state, runs startup recovery, and verifies the
// metadata move completes without losing the documentId.
//
// Env: NUVYN_CRASH_FROM (abs path), NUVYN_CRASH_TO (abs path)
import {
  createOnlyMoveFile,
  __setCreateOnlyMoveHooksForTesting,
} from '../../documentFileLifecycle.js'
import { readyAndWait } from './crash-child-ready.js'

const from = process.env.NUVYN_CRASH_FROM
const to = process.env.NUVYN_CRASH_TO
if (!from || !to) {
  console.error('missing NUVYN_CRASH_FROM or NUVYN_CRASH_TO env')
  process.exit(2)
}

__setCreateOnlyMoveHooksForTesting({
  afterRenameLinked: () => readyAndWait('linked'),
})

await createOnlyMoveFile(from, to)
// Reaching this line means the crash hook never fired.
console.error('child completed without crashing')
process.exit(1)
