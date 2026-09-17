// Server-side SQLite — single connection to ./data/nuvyn.db, opened
// lazily on first call to getDb(). Migrations live in
// server/migrations/*.sql and are applied in version order on the
// first getDb() call. The runner is also exported (applyMigrations)
// so tests can apply the same migrations to an in-memory DB without
// touching the on-disk file.
//
// Conventions:
//   - timestamps are INTEGER ms-since-epoch (Date.now())
//   - SQL uses snake_case; service modules map to camelCase for the client
//   - foreign_keys=ON so ON DELETE CASCADE actually fires
//   - journal_mode=WAL for better concurrent reads
import Database, { type Database as DatabaseT } from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { NUVYN_DATABASE_FILE_NAME } from './technicalNamespace.js'
import { readCanonicalEnv } from './env.js'

// Browser integration harnesses may provide an explicitly isolated database
// path. Production otherwise uses the canonical process.cwd()/data/nuvyn.db
// location, while E2E servers can create real owners/sessions without
// touching a developer's database.
function configuredDbPath(): string {
  const configured = readCanonicalEnv(process.env, 'NUVYN_E2E_DB_PATH')
  return configured
    ? path.resolve(configured)
    : path.resolve(process.cwd(), 'data', NUVYN_DATABASE_FILE_NAME)
}

const DB_PATH = configuredDbPath()
const DATA_DIR = path.dirname(DB_PATH)
// import.meta.dirname resolves to the directory of THIS source file
// at runtime, which is server/ — so server/migrations/ is found
// regardless of where vite/tsx was launched from.
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations')

/** The data root used by the current database connection configuration. */
export function getDataDir(): string {
  return DATA_DIR
}

/** Explicit production wait before SQLite reports an exhausted write lock. */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

/**
 * Apply all un-applied migrations to the given DB. The runner is a
 * no-op on the second call (idempotent): it reads the current
 * version from `schema_version` and only runs files whose N > current.
 *
 * The schema_version table is created on the very first call (before
 * any migration runs), so subsequent migrations can record their
 * version. Tests may pass a maximum version to inspect an intermediate
 * schema.
 */
export function applyMigrations(db: DatabaseT, maxVersion = Number.POSITIVE_INFINITY) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`)
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  const current = row?.version ?? 0

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()

  for (const file of files) {
    const version = parseInt(file.match(/^(\d+)/)![1], 10)
    if (version <= current || version > maxVersion) continue
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      // schema_version holds a single row of the current version. We
      // upsert: delete any existing row, then insert. A real UPSERT
      // works too but `DELETE + INSERT` is unambiguous and the table
      // is one row so the cost is trivial.
      db.prepare('DELETE FROM schema_version').run()
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version)
    })()
    console.log(`[migrate] applied ${file} (→ v${version})`)
  }
}

let _db: DatabaseT | null = null
let _testDbOverride: DatabaseT | null = null

/**
 * Lazily open the canonical on-disk DB. The first call ensures data/ exists,
 * opens ./data/nuvyn.db, sets the two PRAGMAs, and runs the migration runner.
 * Subsequent calls return the same instance.
 */
export function getDb(): DatabaseT {
  if (_testDbOverride) return _testDbOverride
  if (_db) return _db
  ensureDataDir()
  _db = new Database(DB_PATH, { timeout: SQLITE_BUSY_TIMEOUT_MS })
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  applyMigrations(_db)
  return _db
}

/**
 * Test-only database injection for mounted application fixtures. It changes
 * only which SQLite connection the existing handlers read/write; migrations,
 * auth/session semantics, and production path resolution remain untouched.
 */
export function __setDbForTesting(db: DatabaseT | null): void {
  _testDbOverride = db
}

/**
 * Test-only escape hatch: close the cached connection and forget it
 * so the next `getDb()` opens a fresh one. Use this in test
 * `beforeAll`/`beforeEach` after deleting the on-disk file so the
 * cached handle doesn't survive the rm. The on-disk file is NOT
 * deleted by this function — callers that want a clean slate should
 * `fs.rm(DATA_DIR, { recursive: true, force: true })` as well.
 */
export function __resetDbForTesting(): void {
  _testDbOverride = null
  if (_db) {
    _db.close()
    _db = null
  }
}
