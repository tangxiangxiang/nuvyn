import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import app from '../index.js'
import { __setDbForTesting } from '../db.js'
import { CONTENT_DIR, setContentDir } from '../paths.js'
import { __setAttachmentCatalogForTesting, __setAttachmentReferenceIndexForRoutesTesting } from '../attachments/routes.js'
import { AttachmentCatalog, type AttachmentCatalogAdapter } from '../attachments/catalog.js'
import { AttachmentReferenceIndex } from '../attachments/references.js'
import type { AttachmentSource } from '../../shared/attachmentProtocol.js'
import {
  authenticatedRequest,
  closeAuthTestContext,
  createAuthenticatedTestContext,
  type AuthenticatedTestContext,
} from './helpers/auth.js'

const originalContentDir = CONTENT_DIR
let root = ''
let db: Database.Database
let auth: AuthenticatedTestContext

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-attachments-api-'))
  await fs.mkdir(path.join(root, 'inbox'), { recursive: true })
  setContentDir(root)
  db = new Database(':memory:')
  auth = createAuthenticatedTestContext({ db })
  __setDbForTesting(db)
})

afterEach(async () => {
  __setAttachmentCatalogForTesting(null)
  __setAttachmentReferenceIndexForRoutesTesting(null)
  closeAuthTestContext(auth)
  if (db.open) db.close()
  setContentDir(originalContentDir)
  await fs.rm(root, { recursive: true, force: true })
})

describe('Attachment Manager API', () => {
  it('requires the existing authenticated owner session for catalog and refresh endpoints', async () => {
    const list = await app.fetch(new Request('http://localhost/api/attachments'))
    const summary = await app.fetch(new Request('http://localhost/api/attachments/summary'))
    const status = await app.fetch(new Request('http://localhost/api/attachments/index-status'))
    const refresh = await app.fetch(new Request('http://localhost/api/attachments/refresh', { method: 'POST' }))
    const referenceStatus = await app.fetch(new Request('http://localhost/api/attachments/references/status'))
    const referenceQuery = await app.fetch(new Request('http://localhost/api/attachments/references/query', { method: 'POST' }))
    const cleanupPreview = await app.fetch(new Request('http://localhost/api/attachments/cleanup-preview', { method: 'POST' }))
    expect([list.status, summary.status, status.status, refresh.status, referenceStatus.status, referenceQuery.status, cleanupPreview.status])
      .toEqual([401, 401, 401, 401, 401, 401, 401])

    const allowed = await app.fetch(authenticatedRequest(auth, '/api/attachments/index-status'))
    expect(allowed.status).toBe(200)
  })

  it('returns authenticated reference pages and a read-only risk preflight for a real Vault file', async () => {
    const imagePath = path.join(root, 'inbox', 'diagram.png')
    await fs.writeFile(imagePath, Buffer.from([1, 2, 3]))
    await fs.writeFile(path.join(root, 'inbox', 'using-note.md'), '# Using note\n\n![Diagram](./diagram.png)')
    const index = new AttachmentReferenceIndex(db, { root: () => root })
    __setAttachmentReferenceIndexForRoutesTesting(index)

    const resource = { kind: 'vault-file', path: 'inbox/diagram.png' }
    const query = await app.fetch(authenticatedRequest(auth, '/api/attachments/references/query', {
      method: 'POST',
      origin: auth.runtime.config.publicOrigin,
      body: { resource, offset: 0, limit: 10 },
    }))
    expect(query.status).toBe(200)
    expect(await query.json()).toMatchObject({
      resource,
      referenceCount: 1,
      ownerCount: 1,
      currentFinding: 'in-use',
      references: [{ owner: { kind: 'note', id: 'inbox/using-note' }, kind: 'note-image', relation: 'direct' }],
    })

    const preview = await app.fetch(authenticatedRequest(auth, '/api/attachments/cleanup-preview', {
      method: 'POST',
      origin: auth.runtime.config.publicOrigin,
      body: { resource },
    }))
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({
      currentFinding: 'in-use',
      deletionAllowed: false,
      riskReasons: expect.arrayContaining([
        'historical-versions-not-checked',
        'draft-recovery-not-checked',
        'protected-diary-restricted',
      ]),
    })
    expect((await fs.readFile(imagePath)).byteLength).toBe(3)
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets').get()).toEqual({ count: 0 })
  })

  it('rejects arbitrary paths and malformed resource keys without exposing filesystem details', async () => {
    const response = await app.fetch(authenticatedRequest(auth, '/api/attachments/references/query', {
      method: 'POST',
      origin: auth.runtime.config.publicOrigin,
      body: { resource: { kind: 'vault-file', path: '../../etc/passwd' } },
    }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'ATTACHMENT_RESOURCE_INVALID' })
  })

  it('merges real sources, filters and paginates while keeping unknown references conservative', async () => {
    const referencedAsset = '11111111-1111-4111-8111-111111111111'
    const unknownAsset = '22222222-2222-4222-8222-222222222222'
    db.prepare(`INSERT INTO assets (id, mime_type, byte_size, sha256, storage_key, created_at)
      VALUES (?, 'image/png', 8, ?, ?, 10), (?, 'image/png', 5, ?, ?, 11)`)
      .run(referencedAsset, 'a'.repeat(64), referencedAsset, unknownAsset, 'b'.repeat(64), unknownAsset)
    db.prepare(`INSERT INTO asset_references (asset_id, owner_type, owner_id, purpose, created_at)
      VALUES (?, 'board', 'board-1', 'scene', 10)`).run(referencedAsset)
    db.prepare(`INSERT INTO board_materials
      (id, name, kind, content, archived, created_at, updated_at)
      VALUES ('33333333-3333-4333-8333-333333333333', '同名图', 'svg', '<svg>图</svg>', 1, 20, 30)`).run()
    await fs.writeFile(path.join(root, 'inbox', 'same.png'), Buffer.from([1, 2, 3, 4]))
    await fs.writeFile(path.join(root, 'inbox', 'main-note.md'), '# not an attachment')
    await fs.mkdir(path.join(root, 'diary', '2026-10-12'), { recursive: true })
    await fs.writeFile(path.join(root, 'diary', '2026-10-12', 'private.png'), Buffer.from([1]))

    const beforeAssets = db.prepare('SELECT COUNT(*) AS count FROM assets').get() as { count: number }
    const firstResponse = await app.fetch(authenticatedRequest(auth, '/api/attachments?limit=2'))
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json() as {
      items: Array<{ key: { kind: string; id?: string; path?: string }; source: string }>
      total: number
      summary: { total: number; knownBytes: number; unknownReferenceCount: number; complete: boolean }
    }
    expect(first.total, JSON.stringify(first)).toBe(4)
    expect(first.items).toHaveLength(2)
    expect(first.summary).toMatchObject({ total: 4, knownBytes: 31, unknownReferenceCount: 3, complete: true })

    const nextResponse = await app.fetch(authenticatedRequest(auth, '/api/attachments?offset=2&limit=2'))
    const next = await nextResponse.json() as typeof first
    const identities = [...first.items, ...next.items].map((item) => JSON.stringify(item.key))
    expect(new Set(identities).size).toBe(4)
    expect(identities.some((key) => key.includes('private.png'))).toBe(false)

    const filteredResponse = await app.fetch(authenticatedRequest(
      auth,
      '/api/attachments?source=board-asset&referenceStatus=unknown&search=22222222',
    ))
    expect(await filteredResponse.json()).toMatchObject({
      total: 1,
      items: [{ key: { kind: 'asset', id: unknownAsset }, referenceStatus: 'unknown', knownReferenceCount: 0 }],
    })
    const summaryResponse = await app.fetch(authenticatedRequest(auth, '/api/attachments/summary'))
    expect(summaryResponse.status).toBe(200)
    expect(await summaryResponse.json()).toMatchObject({
      total: 4,
      sources: {
        'board-asset': { count: 2, knownBytes: 13 },
        'vault-file': { count: 1, knownBytes: 4 },
        'board-material': { count: 1, knownBytes: Buffer.byteLength('<svg>图</svg>') },
      },
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets').get()).toEqual(beforeAssets)
    expect((await fs.readFile(path.join(root, 'inbox', 'same.png'))).byteLength).toBe(4)
  })

  it('refreshes only on request, reports index status, and rejects invalid filters', async () => {
    await fs.writeFile(path.join(root, 'inbox', 'one.txt'), 'one')
    const initial = await app.fetch(authenticatedRequest(auth, '/api/attachments'))
    expect(await initial.json()).toMatchObject({ total: 1 })

    await fs.writeFile(path.join(root, 'inbox', 'two.txt'), 'two!')
    const stale = await app.fetch(authenticatedRequest(auth, '/api/attachments?offset=0'))
    expect(await stale.json()).toMatchObject({ total: 1 })

    const refresh = await app.fetch(authenticatedRequest(auth, '/api/attachments/refresh', {
      method: 'POST', origin: auth.runtime.config.publicOrigin,
    }))
    expect(refresh.status).toBe(200)
    expect(await refresh.json()).toMatchObject({ summary: { total: 2 }, indexStatus: { complete: true, refreshing: false } })
    const status = await app.fetch(authenticatedRequest(auth, '/api/attachments/index-status'))
    expect(await status.json()).toMatchObject({ ready: true, complete: true, refreshedAt: expect.any(Number) })

    for (const query of ['?type=bogus', '?limit=0', '?offset=-1', '?search=' + 'x'.repeat(201)]) {
      const response = await app.fetch(authenticatedRequest(auth, `/api/attachments${query}`))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'ATTACHMENT_QUERY_INVALID' })
    }
  })

  it('reports a total source failure from explicit refresh instead of claiming success', async () => {
    const unavailable = (source: AttachmentSource): AttachmentCatalogAdapter => ({
      source,
      scan: async () => { throw new Error('offline') },
    })
    __setAttachmentCatalogForTesting(new AttachmentCatalog({
      boardAssets: unavailable('board-asset'),
      vaultFiles: unavailable('vault-file'),
      boardMaterials: unavailable('board-material'),
    }))

    const refresh = await app.fetch(authenticatedRequest(auth, '/api/attachments/refresh', {
      method: 'POST', origin: auth.runtime.config.publicOrigin,
    }))
    expect(refresh.status).toBe(500)
    expect(await refresh.json()).toMatchObject({ code: 'ATTACHMENT_CATALOG_UNAVAILABLE' })
    const status = await app.fetch(authenticatedRequest(auth, '/api/attachments/index-status'))
    expect(await status.json()).toMatchObject({ ready: false, refreshing: false, complete: null, refreshedAt: null })
  })
})
