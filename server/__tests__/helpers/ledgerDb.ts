import Database, { type Database as DatabaseT } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations, SQLITE_BUSY_TIMEOUT_MS } from '../../db.js'

export interface LedgerTestConnectionOptions {
  readonly timeout?: number
}

export interface LedgerTestDatabase {
  readonly path: string
  readonly db: DatabaseT
  openConnection(options?: LedgerTestConnectionOptions): DatabaseT
  close(): void
  cleanup(): void
}

function configureConnection(db: DatabaseT, timeout: number): void {
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  // The constructor timeout is the authoritative setting. Keeping the
  // PRAGMA explicit makes the test helper's connection state inspectable.
  db.pragma(`busy_timeout = ${timeout}`)
}

/**
 * Create a migrated, file-backed Ledger database and track every connection
 * so cleanup closes handles before removing the directory on all platforms.
 */
export function createLedgerTestDatabase(): LedgerTestDatabase {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nuvyn-ledger-'))
  const databasePath = path.join(directory, 'ledger.sqlite')
  const handles = new Set<DatabaseT>()

  const openConnection = (options: LedgerTestConnectionOptions = {}): DatabaseT => {
    const db = new Database(databasePath, {
      timeout: options.timeout ?? SQLITE_BUSY_TIMEOUT_MS,
    })
    configureConnection(db, options.timeout ?? SQLITE_BUSY_TIMEOUT_MS)
    handles.add(db)
    return db
  }

  const db = openConnection()
  applyMigrations(db)

  let cleaned = false
  const close = (): void => {
    for (const handle of handles) {
      if (handle.open) handle.close()
    }
    handles.clear()
  }
  const cleanup = (): void => {
    if (cleaned) return
    close()
    rmSync(directory, { recursive: true, force: true })
    cleaned = true
  }

  return {
    path: databasePath,
    db,
    openConnection,
    close,
    cleanup,
  }
}
