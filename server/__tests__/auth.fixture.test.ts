import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import app, { __setMetadataDbForTesting } from '../index.js'
import { __resetLinkIndexForTesting } from '../linkIndex.js'
import { setContentDir } from '../paths.js'
import { hashSessionToken } from '../auth/session.js'
import {
  authCookieHeader,
  authenticatedRequest,
  closeAuthTestContext,
  createAuthenticatedTestContext,
  withAuthCookie,
} from './helpers/auth.js'

let originalContentDir: string | undefined
let vault: string | undefined

afterEach(async () => {
  __setMetadataDbForTesting(null)
  __resetLinkIndexForTesting()
  if (vault) await fs.rm(vault, { recursive: true, force: true })
  if (originalContentDir) setContentDir(originalContentDir)
  vault = undefined
  originalContentDir = undefined
})

describe('authenticated application test fixture', () => {
  it('creates a real owner/session and the selected runtime cookie', async () => {
    const context = createAuthenticatedTestContext()
    try {
      expect(context.db.prepare('SELECT owner_user_id FROM auth_instance WHERE id = 1').get()).toEqual({
        owner_user_id: context.userId,
      })
      expect(context.db.prepare('SELECT user_id FROM auth_sessions WHERE id = ?').get(context.session.id)).toEqual({
        user_id: context.userId,
      })
      expect(context.cookie.startsWith(`${context.runtime.config.cookie.name}=`)).toBe(true)
      expect(context.cookie).toContain(context.rawToken)
      expect(context.db.prepare('SELECT token_hash FROM auth_sessions WHERE id = ?').get(context.session.id)).toEqual({
        token_hash: hashSessionToken(context.rawToken),
      })
      const persisted = context.db.prepare(`
        SELECT token_hash, created_at, expires_at, last_seen_at, revoked_at
        FROM auth_sessions
        WHERE id = ?
      `).get(context.session.id)
      expect(JSON.stringify(persisted)).not.toContain(context.rawToken)

      const status = await app.fetch(new Request('http://localhost/api/auth/status', {
        headers: { Cookie: authCookieHeader(context) },
      }))
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({
        authenticated: true,
        user: { id: context.userId, username: context.username },
      })
    } finally {
      closeAuthTestContext(context)
    }
  })

  it('uses a caller-owned database for an authenticated mounted route', async () => {
    originalContentDir = path.resolve(process.cwd(), 'src/content')
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-auth-fixture-'))
    await fs.writeFile(path.join(vault, 'fixture.md'), '# Fixture\n')
    setContentDir(vault)
    __resetLinkIndexForTesting()

    const db = new Database(':memory:')
    const context = createAuthenticatedTestContext({ db })
    __setMetadataDbForTesting(db)
    try {
      const anonymous = await app.fetch(new Request('http://localhost/api/tree'))
      expect(anonymous.status).toBe(401)
      expect(await anonymous.json()).toEqual({ error: 'Authentication required.', code: 'auth-session-required' })

      const response = await app.fetch(authenticatedRequest(context, '/api/tree', { method: 'GET' }))
      expect(response.status).toBe(200)
      expect((await response.json())[0]).toMatchObject({ kind: 'folder' })

      const created = await app.fetch(withAuthCookie(context, new Request('http://localhost/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'fixture-note', title: 'Fixture note' }),
      })))
      expect(created.status).toBe(201)

      const ai = await app.fetch(authenticatedRequest(context, '/api/ai/sessions', { method: 'GET' }))
      expect(ai.status).toBe(200)
      expect(await ai.json()).toEqual([])
      const links = await app.fetch(authenticatedRequest(context, '/api/links/index', { method: 'GET' }))
      expect(links.status).toBe(200)
      expect(await links.json()).toMatchObject({ paths: expect.arrayContaining(['fixture', 'fixture-note']) })
      expect(context.db).toBe(db)
    } finally {
      closeAuthTestContext(context)
      db.close()
    }
  })

  it('derives the secure cookie name from the configured HTTPS profile', () => {
    const context = createAuthenticatedTestContext({ origin: 'https://nuvyn.example.test' })
    try {
      expect(context.runtime.config.cookie.name).toBe('__Host-nuvyn_session')
      expect(context.cookie.startsWith('__Host-nuvyn_session=')).toBe(true)
    } finally {
      closeAuthTestContext(context)
    }
  })
})
