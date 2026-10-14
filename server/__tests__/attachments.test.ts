import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { recordAttachmentOperation } from '../attachments/audit.js'
import { randomUUID } from 'node:crypto'
import { registerNoteImage } from '../attachments/trash.js'
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
  async function managedImage(): Promise<string> {
    await fs.mkdir(path.join(root, 'attachments/images'), { recursive: true })
    const resourcePath = `attachments/images/${randomUUID()}.png`
    await fs.writeFile(path.join(root, resourcePath), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    await registerNoteImage(db, root, resourcePath)
    return resourcePath
  }
  async function jsonRequest(route: string, data: unknown): Promise<Response> {
    return app.fetch(authenticatedRequest(auth, route, { method: 'POST', origin: auth.runtime.config.publicOrigin, body: data }))
  }
  it('recycles and restores managed Note images via authenticated endpoints without breaking historical reads', async () => {
    const resourcePath = await managedImage()
    const preflight = await jsonRequest('/api/attachments/cleanup-preview', { resource: { kind: 'vault-file', path: resourcePath } })
    expect(preflight.status).toBe(200)
    const preview = await preflight.json() as { quarantineAllowed: boolean; quarantineToken: string; deletionAllowed: boolean }
    expect(preview).toMatchObject({ quarantineAllowed: true, deletionAllowed: false })
    const recycled = await jsonRequest('/api/attachments/quarantine', { token: preview.quarantineToken })
    expect(recycled.status, await recycled.clone().text()).toBe(200)
    const item = await recycled.json() as { id: string }
    const duplicate = await jsonRequest('/api/attachments/quarantine', { token: preview.quarantineToken })
    expect(duplicate.ok).toBe(false)
    const fallback = await app.fetch(authenticatedRequest(auth, `/api/markdown-resources?kind=image&path=${resourcePath}`))
    expect(fallback.status).toBe(200)
    const trash = await app.fetch(authenticatedRequest(auth, '/api/attachments/trash'))
    expect(await trash.json()).toMatchObject({ total: 1, items: [{ id: item.id, path: resourcePath, state: 'trashed' }] })
    const restore = await jsonRequest('/api/attachments/trash/restore', { id: item.id })
    expect(restore.status, await restore.clone().text()).toBe(200)
    expect((await app.fetch(authenticatedRequest(auth, '/api/attachments/trash')).then((res) => res.json()))).toMatchObject({ total: 0 })
  })
  it('rechecks newly added current Note references after preflight and leaves the image active', async () => {
    const resourcePath = await managedImage()
    const prepared = await jsonRequest('/api/attachments/cleanup-preview', { resource: { kind: 'vault-file', path: resourcePath } })
    const preview = await prepared.json() as { quarantineToken: string }
    await fs.writeFile(path.join(root, 'inbox/current.md'), `# Current\n\n![image](@/${resourcePath})`)
    const result = await jsonRequest('/api/attachments/quarantine', { token: preview.quarantineToken })
    expect(result.status).toBe(409)
    expect(await fs.readFile(path.join(root, resourcePath))).toHaveLength(8)
    const blocked = await jsonRequest('/api/attachments/cleanup-preview', { resource: { kind: 'vault-file', path: resourcePath } })
    expect(await blocked.json()).toMatchObject({ quarantineAllowed: false, currentFinding: 'in-use' })
  })
  it('protects trash endpoints with owner authentication and Origin checks', async () => {
    for (const [route, method] of [['/api/attachments/trash', 'GET'], ['/api/attachments/quarantine', 'POST'], ['/api/attachments/trash/restore', 'POST']]) {
      expect((await app.fetch(new Request(`http://localhost${route}`, { method }))).status).toBe(401)
    }
    const result = await app.fetch(authenticatedRequest(auth, '/api/attachments/quarantine', {
      method: 'POST', origin: 'https://example.invalid', body: { token: 'invalid' },
    }))
    expect(result.status).toBe(403)
  })
  it('requires the existing authenticated owner session for catalog and refresh endpoints', async () => {
    const list = await app.fetch(new Request('http://localhost/api/attachments'))
    const summary = await app.fetch(new Request('http://localhost/api/attachments/summary'))
    const status = await app.fetch(new Request('http://localhost/api/attachments/index-status'))
    const refresh = await app.fetch(new Request('http://localhost/api/attachments/refresh', { method: 'POST' }))
    const referenceStatus = await app.fetch(new Request('http://localhost/api/attachments/references/status'))
    const referenceQuery = await app.fetch(new Request('http://localhost/api/attachments/references/query', { method: 'POST' }))
    const cleanupPreview = await app.fetch(new Request('http://localhost/api/attachments/cleanup-preview', { method: 'POST' }))
    const audit = await app.fetch(new Request('http://localhost/api/attachments/audit'))
    expect([list.status, summary.status, status.status, refresh.status, referenceStatus.status, referenceQuery.status, cleanupPreview.status, audit.status])
      .toEqual([401, 401, 401, 401, 401, 401, 401, 401])

    const allowed = await app.fetch(authenticatedRequest(auth, '/api/attachments/index-status'))
    expect(allowed.status).toBe(200)
  })

  it('returns only bounded attachment operation metadata and rejects invalid audit paths', async () => {
    const resourceId = '550e8400-e29b-41d4-a716-446655440000'
    recordAttachmentOperation(db, {
      operation: 'board-import-from-vault-image',
      resourceType: 'board-asset',
      resourceId,
      sourceWorkspace: 'vault-image',
      sourceResourceId: 'attachments/images/660e8400-e29b-41d4-a716-446655440000.svg',
      targetWorkspace: 'board',
      targetWorkspaceId: resourceId,
      result: 'success',
      occurredAt: 10,
    })
    recordAttachmentOperation(db, {
      operation: 'board-import-from-vault-image',
      resourceType: 'board-asset',
      resourceId,
      sourceWorkspace: 'vault-image',
      sourceResourceId: '/Volumes/private/diary.svg',
      targetWorkspace: 'board',
      targetWorkspaceId: resourceId,
      result: 'success',
      occurredAt: 11,
    })

    const response = await app.fetch(authenticatedRequest(auth, '/api/attachments/audit?limit=10'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ entries: [{
      operation: 'board-import-from-vault-image',
      resourceId,
      sourceResourceId: 'attachments/images/660e8400-e29b-41d4-a716-446655440000.svg',
      result: 'success',
    }] })
    expect((await app.fetch(authenticatedRequest(auth, '/api/attachments/audit?limit=101'))).status).toBe(400)
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

  it('indexes direct, repeated, included, SVG, and Board references inside Flex Markdown', async () => {
    const timestamp = Date.now()
    const sharedImage = path.join(root, 'inbox', 'shared.png')
    const includedSvg = path.join(root, 'inbox', 'included.svg')
    await fs.writeFile(sharedImage, Buffer.from([1, 2, 3]))
    await fs.writeFile(includedSvg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    await fs.writeFile(path.join(root, 'inbox', 'parts.md'), [
      '![Included PNG](./shared.png)',
      '',
      '![Included SVG](./included.svg)',
    ].join('\n'))

    const boardId = '9b5b4c41-c0e8-4aca-a531-751e4013d1ef'
    const assetId = 'c4d4dd34-1ce4-4b38-9849-eef1607754c0'
    db.prepare('INSERT INTO boards (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(boardId, 'Flex board', timestamp, timestamp)
    db.prepare(`INSERT INTO assets (id, mime_type, byte_size, sha256, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(assetId, 'image/svg+xml', 1, 'a'.repeat(64), 'test/flex-board.svg', timestamp)
    db.prepare(`INSERT INTO asset_references (asset_id, owner_type, owner_id, purpose, created_at)
      VALUES (?, 'board', ?, 'scene', ?)`)
      .run(assetId, boardId, timestamp)

    await fs.writeFile(path.join(root, 'inbox', 'flex-note.md'), [
      ':::: flex direction=row gap=16',
      '![First use](./shared.png)',
      '',
      '![Second use](./shared.png)',
      '',
      '<!--@include: ./parts.md-->',
      '',
      `![Board diagram](board:${boardId})`,
      '::::',
    ].join('\n'))

    const index = new AttachmentReferenceIndex(db, { root: () => root })
    await index.refresh()
    const shared = await index.query({ kind: 'vault-file', path: 'inbox/shared.png' }, 0, 10)
    const svg = await index.query({ kind: 'vault-file', path: 'inbox/included.svg' }, 0, 10)
    const board = await index.query({ kind: 'asset', id: assetId }, 0, 10)

    expect(shared.referenceCount).toBe(4)
    expect(shared.references.filter((reference) => (
      reference.relation === 'direct' && reference.owner.id === 'inbox/flex-note'
    ))).toHaveLength(2)
    expect(shared.references.find((reference) => (
      reference.relation === 'direct' && reference.owner.id === 'inbox/flex-note'
    ))).toMatchObject({
      owner: { kind: 'note', id: 'inbox/flex-note' },
      sourcePath: 'inbox/flex-note',
      line: 2,
    })
    expect(shared.references.filter((reference) => reference.owner.id === 'inbox/parts')).toHaveLength(1)
    expect(shared.references.find((reference) => reference.relation === 'indirect')).toMatchObject({
      owner: { kind: 'note', id: 'inbox/flex-note' },
      sourcePath: 'inbox/parts',
      via: [{ kind: 'include', id: 'inbox/parts' }],
    })
    expect(svg.references.find((reference) => reference.relation === 'indirect')).toMatchObject({
      owner: { kind: 'note', id: 'inbox/flex-note' },
      kind: 'note-image',
      relation: 'indirect',
      sourcePath: 'inbox/parts',
      target: { kind: 'vault-file', id: 'inbox/included.svg' },
    })
    expect(svg.references.find((reference) => reference.relation === 'direct')).toMatchObject({
      owner: { kind: 'note', id: 'inbox/parts' },
      target: { kind: 'vault-file', id: 'inbox/included.svg' },
    })
    expect(board.references.filter((reference) => reference.kind === 'board-embed')).toMatchObject([{
      owner: { kind: 'note', id: 'inbox/flex-note' },
      sourcePath: 'inbox/flex-note',
      target: { kind: 'asset', id: assetId },
    }])
  })

  it('reports an initial reference-index failure and allows an explicit retry', async () => {
    const index = new AttachmentReferenceIndex(db, { root: () => root })
    vi.spyOn(index as unknown as {
      buildSnapshot: (signal: AbortSignal) => Promise<unknown>
    }, 'buildSnapshot').mockRejectedValueOnce(new Error('/private/vault/path must not escape'))
    __setAttachmentReferenceIndexForRoutesTesting(index)

    const failure = await app.fetch(authenticatedRequest(auth, '/api/attachments/references/refresh', {
      method: 'POST', origin: auth.runtime.config.publicOrigin,
    }))
    expect(failure.status).toBe(503)
    expect(await failure.json()).toMatchObject({ code: 'ATTACHMENT_REFERENCES_UNAVAILABLE' })
    expect(JSON.stringify(await (await app.fetch(authenticatedRequest(auth, '/api/attachments/references/status'))).json()))
      .toContain('failed')

    const retry = await app.fetch(authenticatedRequest(auth, '/api/attachments/references/refresh', {
      method: 'POST', origin: auth.runtime.config.publicOrigin,
    }))
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ state: 'ready', complete: true })
  })

  it('keeps failed-refresh previews and catalog projections conservative until a successful retry', async () => {
    const imagePath = path.join(root, 'inbox', 'unreferenced.png')
    await fs.writeFile(imagePath, Buffer.from([1, 2, 3]))
    const index = new AttachmentReferenceIndex(db, { root: () => root })
    __setAttachmentReferenceIndexForRoutesTesting(index)
    const resource = { kind: 'vault-file', path: 'inbox/unreferenced.png' }
    const request = (url: string, options: Parameters<typeof authenticatedRequest>[2] = {}) => app.fetch(
      authenticatedRequest(auth, url, { origin: auth.runtime.config.publicOrigin, ...options }),
    )

    const firstRefresh = await request('/api/attachments/references/refresh', { method: 'POST' })
    expect(firstRefresh.status).toBe(200)
    const lastGood = await firstRefresh.json() as { refreshedAt: number; snapshotId: string }
    const initialQuery = await request('/api/attachments/references/query', { method: 'POST', body: { resource } })
    expect(await initialQuery.json()).toMatchObject({ stale: false, currentFinding: 'no-current-reference' })

    vi.spyOn(index as unknown as {
      buildSnapshot: (signal: AbortSignal) => Promise<unknown>
    }, 'buildSnapshot').mockRejectedValueOnce(new Error('/private/vault/path must not escape'))
    const failedRefresh = await request('/api/attachments/references/refresh', { method: 'POST' })
    expect(failedRefresh.status).toBe(503)
    const failureBody = await failedRefresh.json()
    expect(JSON.stringify(failureBody)).not.toContain('/private/vault/path')

    const staleStatusResponse = await request('/api/attachments/references/status')
    const staleStatus = await staleStatusResponse.json()
    expect(staleStatus).toMatchObject({
      state: 'stale',
      complete: false,
      refreshedAt: lastGood.refreshedAt,
      snapshotId: lastGood.snapshotId,
    })
    const staleQuery = await request('/api/attachments/references/query', { method: 'POST', body: { resource } })
    expect(await staleQuery.json()).toMatchObject({
      stale: true,
      currentFinding: 'unknown',
      referenceCount: 0,
      checkedAt: lastGood.refreshedAt,
      snapshotId: lastGood.snapshotId,
      coverage: { currentNotes: 'unknown', boardReferences: 'unknown' },
    })
    const stalePreview = await request('/api/attachments/cleanup-preview', { method: 'POST', body: { resource } })
    expect(await stalePreview.json()).toMatchObject({
      stale: true,
      currentFinding: 'unknown',
      riskLevel: 'unverified',
      deletionAllowed: false,
      snapshotId: lastGood.snapshotId,
    })
    const catalog = await request('/api/attachments?source=vault-file&search=unreferenced.png')
    expect(await catalog.json()).toMatchObject({
      items: [{ key: resource, referenceStatus: 'unknown', referenceCount: 0, ownerCount: 0 }],
    })

    const retry = await request('/api/attachments/references/refresh', { method: 'POST' })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ state: 'ready', snapshotId: expect.not.stringMatching(lastGood.snapshotId) })
    const freshQuery = await request('/api/attachments/references/query', { method: 'POST', body: { resource } })
    expect(await freshQuery.json()).toMatchObject({ stale: false, currentFinding: 'no-current-reference' })
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
