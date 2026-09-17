import Database from 'better-sqlite3'
import type { BrowserContext } from '@playwright/test'
import { parsePublicOrigin } from '../../server/auth/config.js'
import { createSession, hashSessionToken } from '../../server/auth/session.js'

/**
 * Revoke exactly the session represented by the browser's active HttpOnly
 * cookie. This helper is deliberately test-side: production exposes no
 * session-mutation endpoint for browser tests. The raw token is hashed by
 * the production primitive and never returned, logged, or persisted.
 */
export async function revokeCurrentBrowserSession(
  context: BrowserContext,
): Promise<{ sessionId: number; revokedAt: number }> {
  const origin = process.env.NUVYN_PUBLIC_ORIGIN
  if (!origin) throw new Error('NUVYN_PUBLIC_ORIGIN is required for auth E2E')
  const cookieName = parsePublicOrigin(origin).cookie.name
  const cookie = (await context.cookies()).find((candidate) => candidate.name === cookieName)
  if (!cookie?.value) throw new Error(`active ${cookieName} cookie was not found`)

  const databasePath = process.env.NUVYN_E2E_DB_PATH
  if (!databasePath) throw new Error('NUVYN_E2E_DB_PATH is required for auth E2E')

  const tokenHash = hashSessionToken(cookie.value)
  const revokedAt = Date.now()
  const db = new Database(databasePath)
  try {
    db.pragma('busy_timeout = 5000')
    const session = db.prepare(
      'SELECT id FROM auth_sessions WHERE token_hash = ? LIMIT 1',
    ).get(tokenHash) as { id?: number } | undefined
    if (!session?.id) throw new Error('active browser session row was not found')

    const result = db.prepare(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND token_hash = ? AND revoked_at IS NULL`,
    ).run(revokedAt, session.id, tokenHash)
    if (result.changes !== 1) throw new Error('browser session revoke did not affect exactly one row')
    return { sessionId: session.id, revokedAt }
  } finally {
    db.close()
  }
}

/** Seed a second owner session without returning its raw token. This keeps
 * the browser-revocation regression honest: the helper must update only the
 * cookie-selected row, not every session owned by the user. */
export function createAdditionalOwnerSession(): number {
  const databasePath = process.env.NUVYN_E2E_DB_PATH
  if (!databasePath) throw new Error('NUVYN_E2E_DB_PATH is required for auth E2E')
  const db = new Database(databasePath)
  try {
    const owner = db.prepare(
      'SELECT owner_user_id FROM auth_instance WHERE id = 1 LIMIT 1',
    ).get() as { owner_user_id?: number } | undefined
    if (!owner?.owner_user_id) throw new Error('singleton owner row was not found')
    return createSession(db, owner.owner_user_id, { now: Date.now() }).session.id
  } finally {
    db.close()
  }
}

export function readSessionRevokedAt(sessionId: number): number | null {
  const databasePath = process.env.NUVYN_E2E_DB_PATH
  if (!databasePath) throw new Error('NUVYN_E2E_DB_PATH is required for auth E2E')
  const db = new Database(databasePath, { readonly: true })
  try {
    const row = db.prepare(
      'SELECT revoked_at FROM auth_sessions WHERE id = ? LIMIT 1',
    ).get(sessionId) as { revoked_at: number | null } | undefined
    if (!row) throw new Error('session row was not found')
    return row.revoked_at
  } finally {
    db.close()
  }
}
