import type { Database as DatabaseT } from 'better-sqlite3'
import { runLedgerWrite } from './writeTransaction.js'

declare const db: DatabaseT
declare const thenable: PromiseLike<void>

const numberResult: number = runLedgerWrite(db, () => 1)
runLedgerWrite(db, () => undefined)
const objectResult: { committed: true } = runLedgerWrite(db, () => ({ committed: true as const }))

void numberResult
void objectResult

// @ts-expect-error Ledger write callbacks must not return a Promise.
runLedgerWrite(db, async () => undefined)

// @ts-expect-error PromiseLike results are not valid Ledger write callbacks.
runLedgerWrite(db, () => thenable)
