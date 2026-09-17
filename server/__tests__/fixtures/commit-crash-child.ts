// Crash-test child: runs the REAL atomic replace protocol (no fs
// mocks) and pauses at the exact protocol point named by
// NUVYN_CRASH_POINT, announcing READY:<point> on stdout; the parent
// (crashRecovery.test.ts) force-kills it there and then asserts the
// on-disk crash state before running startup recovery.
//
// Env: NUVYN_CRASH_TARGET (abs path), NUVYN_CRASH_EXPECTED,
//      NUVYN_CRASH_REPLACEMENT, NUVYN_CRASH_POINT ('takeover'|'journal')
import {
  atomicReplaceTextIfUnchanged,
  __setAtomicWriteCrashHooksForTesting,
} from '../../atomicTextWrite.js'
import { readyAndWait } from './crash-child-ready.js'

const target = process.env.NUVYN_CRASH_TARGET
const expected = process.env.NUVYN_CRASH_EXPECTED
const replacement = process.env.NUVYN_CRASH_REPLACEMENT
const point = process.env.NUVYN_CRASH_POINT ?? 'takeover'
if (!target || expected === undefined || replacement === undefined) {
  console.error('missing NUVYN_CRASH_* env')
  process.exit(2)
}

__setAtomicWriteCrashHooksForTesting({
  afterJournalWrite: point === 'journal' ? () => readyAndWait('journal') : undefined,
  afterTakeover: point === 'takeover' ? () => readyAndWait('takeover') : undefined,
})

await atomicReplaceTextIfUnchanged(target, expected, replacement)
// Reaching this line means the crash hook never fired.
console.error('child completed without crashing')
process.exit(1)
