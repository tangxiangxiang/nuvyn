import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import app, { __setMetadataDbForTesting } from '../index.js'
import { applyMigrations } from '../db.js'
import { createDocumentMetadata } from '../documentMetadata.js'
import { resetDiaryMigrationServiceForTesting } from '../diaryMigration/service.js'
import { CONTENT_DIR, setContentDir } from '../paths.js'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  unlockDiaryAccessForTesting,
  type AuthenticatedTestContext,
} from '../__tests__/helpers/auth.js'

const ORIGINAL_CONTENT_DIR = CONTENT_DIR
const LOGICAL_PATH = 'diary/2026-08-31'

let root: string
let db: Database.Database
let auth: AuthenticatedTestContext

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-d8-4-route-'))
  await fs.mkdir(path.join(root, 'diary'))
  await fs.writeFile(path.join(root, 'diary', '2026-08-31.md'), '# legacy route body\n')
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  createDocumentMetadata(db, { id: 'route-d8-4-document', path: LOGICAL_PATH, title: 'Legacy', summary: '', tags: [], mood: null })
  __setMetadataDbForTesting(db)
  setContentDir(root)
  auth = createAuthenticatedTestContext({ db })
})

afterEach(async () => {
  resetDiaryMigrationServiceForTesting()
  __setMetadataDbForTesting(null)
  closeAuthTestContext(auth)
  db.close()
  setContentDir(ORIGINAL_CONTENT_DIR)
  await fs.rm(root, { recursive: true, force: true })
})

async function call(method: string, urlPath: string, body?: unknown, capability?: string): Promise<Response> {
  const headers = new Headers({ Origin: auth.runtime.config.publicOrigin, Cookie: auth.cookie })
  if (body !== undefined) headers.set('content-type', 'application/json')
  if (capability) headers.set('X-Nuvyn-Diary-Capability', capability)
  return app.fetch(new Request(`http://localhost${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
}

describe('D8.4 migration routes', () => {
  it('keeps scan structural while requiring an unlocked lease for migration', async () => {
    const initial = await call('GET', '/api/diary/migration/status')
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ runId: null, state: 'NOT_STARTED' })
    expect(initial.headers.get('cache-control')).toBe('no-store')

    const scan = await call('POST', '/api/diary/migration/scan', {})
    expect(scan.status).toBe(202)
    const inventory = await scan.json() as { runId: string; inventoryRevision: number; state: string }
    expect(inventory.state).toBe('NEEDS_UNLOCK')

    const status = await call('GET', `/api/diary/migration/status?runId=${encodeURIComponent(inventory.runId)}`)
    const snapshot = await status.json() as { items: Array<{ itemKey: string; classification: string; state: string }>; inventoryRevision: number }
    const item = snapshot.items.find((entry) => entry.classification === 'LEGACY_PLAINTEXT')!
    expect(item.state).toBe('NEEDS_UNLOCK')

    const lockedStart = await call('POST', '/api/diary/migration/start', {
      runId: inventory.runId,
      inventoryRevision: inventory.inventoryRevision,
      requestedScopes: [{ itemKey: item.itemKey, scope: 'MIGRATE_PRIMARY' }],
    })
    expect(lockedStart.status).toBe(423)
    expect(await lockedStart.json()).toMatchObject({ code: 'diary-migration-locked' })

    const capability = await unlockDiaryAccessForTesting(auth)
    const prepared = await call('POST', '/api/diary/migration/start', {
      runId: inventory.runId,
      inventoryRevision: inventory.inventoryRevision,
      requestedScopes: [{ itemKey: item.itemKey, scope: 'MIGRATE_PRIMARY' }],
    }, capability)
    if (process.platform === 'win32') {
      expect(prepared.status).toBe(409)
      expect(await prepared.json()).toMatchObject({ code: 'diary-migration-durability-pending' })
      const pending = await call('GET', `/api/diary/migration/status?runId=${encodeURIComponent(inventory.runId)}`)
      const pendingSnapshot = await pending.json() as { items: Array<{ canonicalPath: string; classification: string; state: string; migrationFinalizeCapability: string }> }
      expect(pendingSnapshot.items.find((entry) => entry.canonicalPath === LOGICAL_PATH)).toMatchObject({
        classification: 'UNSUPPORTED',
        state: 'DURABILITY_PENDING',
        migrationFinalizeCapability: 'USER_FINALIZE_REQUIRED',
      })
      expect(await fs.readFile(path.join(root, 'diary', '2026-08-31.md'), 'utf8')).toContain('legacy route body')
      return
    }
    expect(prepared.status).toBe(202)
    expect(await prepared.json()).toMatchObject({ state: 'RUNNING', inventoryRevision: inventory.inventoryRevision })
    expect((await fs.readFile(path.join(root, 'diary', '2026-08-31.md'), 'utf8'))).toContain('legacy route body')
  })

  it('rejects an explicit status revision that is not the run revision', async () => {
    const scan = await call('POST', '/api/diary/migration/scan', {})
    const inventory = await scan.json() as { runId: string; inventoryRevision: number }
    const stale = await call('GET', `/api/diary/migration/status?runId=${encodeURIComponent(inventory.runId)}&inventoryRevision=${inventory.inventoryRevision + 1}`)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'diary-migration-consent-required' })
  })
})
