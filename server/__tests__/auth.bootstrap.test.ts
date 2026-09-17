import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { applyMigrations } from '../db.js'
import { BootstrapState, MIN_EXPLICIT_BOOTSTRAP_TOKEN_BYTES } from '../auth/bootstrap.js'

function dbWithOwner(): Database.Database {
  const db = new Database(':memory:')
  applyMigrations(db)
  const now = Date.now()
  db.prepare(`
    INSERT INTO users (username, username_normalized, password_hash, created_at, updated_at)
    VALUES ('admin', 'admin', 'hash', ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO auth_instance (id, owner_user_id, created_at, updated_at)
    VALUES (1, 1, ?, ?)
  `).run(now, now)
  return db
}

describe('authentication bootstrap state', () => {
  it('generates and logs a fallback token exactly once, then closes after commit', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const logs: string[] = []
    const state = BootstrapState.create({ db, logger: (message) => logs.push(message) })
    expect(state.setupRequired).toBe(true)
    expect(logs).toHaveLength(1)
    const token = logs[0]!.split(': ').at(-1)!
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(state.verify(token)).toBe(true)
    expect(state.verify(`${token}wrong`)).toBe(false)
    state.markOwnerCommitted()
    expect(state.setupRequired).toBe(false)
    expect(state.verify(token)).toBe(false)
    expect(logs).toHaveLength(1)
    db.close()
  })

  it('does not log explicit tokens or create a fallback after owner creation', () => {
    const explicitDb = new Database(':memory:')
    applyMigrations(explicitDb)
    const explicitLogs: string[] = []
    const explicit = BootstrapState.create({
      db: explicitDb,
      explicitToken: 'operator-secret-0123456789abcdef',
      logger: (message) => explicitLogs.push(message),
    })
    expect(explicitLogs).toEqual([])
    expect(explicit.verify('operator-secret-0123456789abcdef')).toBe(true)
    explicitDb.close()

    const ownerDb = dbWithOwner()
    const ownerLogs: string[] = []
    const owner = BootstrapState.create({ db: ownerDb, logger: (message) => ownerLogs.push(message) })
    expect(owner.setupRequired).toBe(false)
    expect(ownerLogs).toEqual([])
    ownerDb.close()
  })

  it('rejects weak explicit tokens without exposing their value', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const weak = 'weak-token-that-is-too-short'
    expect(Buffer.byteLength(weak, 'utf8')).toBeLessThan(MIN_EXPLICIT_BOOTSTRAP_TOKEN_BYTES)
    expect(() => BootstrapState.create({ db, explicitToken: weak })).toThrow(
      'NUVYN_SETUP_TOKEN must contain at least 32 UTF-8 bytes.',
    )
    let failure: unknown
    try {
      BootstrapState.create({ db, explicitToken: weak })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
    expect(String(failure)).not.toContain(weak)
    db.close()
  })

  it('counts explicit token UTF-8 bytes and preserves the exact token', () => {
    const db = new Database(':memory:')
    applyMigrations(db)
    const token = ` ${'😀'.repeat(7)}xxx`
    expect(token.length).toBeLessThan(MIN_EXPLICIT_BOOTSTRAP_TOKEN_BYTES)
    expect(Buffer.byteLength(token, 'utf8')).toBe(MIN_EXPLICIT_BOOTSTRAP_TOKEN_BYTES)
    const state = BootstrapState.create({ db, explicitToken: token })
    expect(state.verify(token)).toBe(true)
    expect(state.verify(token.trim())).toBe(false)
    db.close()
  })

  it('rejects a 31-byte explicit token and accepts a 32-byte token', () => {
    const weakDb = new Database(':memory:')
    applyMigrations(weakDb)
    expect(() => BootstrapState.create({ db: weakDb, explicitToken: 'x'.repeat(31) })).toThrow()
    weakDb.close()

    const validDb = new Database(':memory:')
    applyMigrations(validDb)
    const state = BootstrapState.create({ db: validDb, explicitToken: 'x'.repeat(32) })
    expect(state.setupRequired).toBe(true)
    expect(state.verify('x'.repeat(32))).toBe(true)
    validDb.close()
  })
})
