import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import {
  __setTagManagementApplyHooksForTesting,
  applyTagOperation,
  TagManagementError,
  type TagOperationRequest,
} from '../../tagManagement.js'

const databasePath = process.env.NUVYN_TAG_WAL_DB
const operationJson = process.env.NUVYN_TAG_WAL_OPERATION
const planFingerprint = process.env.NUVYN_TAG_WAL_FINGERPRINT
const workerName = process.env.NUVYN_TAG_WAL_WORKER ?? 'unknown'

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`RESULT:${JSON.stringify(payload)}\n`)
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof TagManagementError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details,
    }
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { message: String(error) }
}

let db: Database.Database | null = null

try {
  if (!databasePath || !operationJson || !planFingerprint) {
    throw new Error('missing NUVYN_TAG_WAL_* environment')
  }

  db = new Database(databasePath)
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 15000')
  const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase()
  if (journalMode !== 'wal') throw new Error(`expected WAL journal mode, got ${journalMode}`)
  const state = db.prepare(`
    SELECT database_generation
    FROM tag_undo_state
    WHERE state_id = 1
  `).get() as { database_generation: string } | undefined
  if (!state) throw new Error('tag Undo foundation state is missing')

  const connectionId = randomUUID()
  __setTagManagementApplyHooksForTesting({
    afterLocks: () => {
      process.stdout.write(`READY:${JSON.stringify({
        workerName,
        pid: process.pid,
        connectionId,
        journalMode,
        databaseGeneration: state.database_generation,
      })}\n`)
    },
  })

  const operation = JSON.parse(operationJson) as TagOperationRequest
  const result = await applyTagOperation(db, operation, planFingerprint)
  emit({
    ok: true,
    workerName,
    pid: process.pid,
    connectionId,
    journalMode,
    databaseGeneration: state.database_generation,
    result,
  })
} catch (error) {
  emit({
    ok: false,
    workerName,
    pid: process.pid,
    error: serializeError(error),
  })
} finally {
  __setTagManagementApplyHooksForTesting(null)
  if (db?.open) db.close()
}
