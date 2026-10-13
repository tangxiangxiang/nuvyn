import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations } from '../db.js'
import { CONTENT_DIR, setContentDir } from '../paths.js'
import { AttachmentCatalog, type AttachmentCatalogAdapters, type AttachmentCatalogAdapter } from './catalog.js'
import { listBoardAssetCatalog } from './adapters/boardAssets.js'
import { listBoardMaterialCatalog } from './adapters/boardMaterials.js'
import { scanVaultAttachments } from './adapters/vaultFiles.js'
import type { AttachmentSource, ManagedAttachment } from '../../shared/attachmentProtocol.js'

const originalContentDir = CONTENT_DIR
let root = ''
let db: Database.Database

function asset(id: string, referenceStatus: ManagedAttachment['referenceStatus'] = 'unknown'): ManagedAttachment {
  return {
    key: { kind: 'asset', id }, source: 'board-asset', type: 'image', displayName: null,
    mimeType: 'image/png', byteSize: 8, createdAt: 1, modifiedAt: null, referenceStatus,
  }
}

function fixedAdapter(source: AttachmentCatalogAdapter['source'], items: ManagedAttachment[]): AttachmentCatalogAdapter {
  return { source, scan: async () => ({ items, complete: true }) }
}

function adapters(overrides: Partial<AttachmentCatalogAdapters> = {}): AttachmentCatalogAdapters {
  return {
    boardAssets: fixedAdapter('board-asset', []),
    vaultFiles: fixedAdapter('vault-file', []),
    boardMaterials: fixedAdapter('board-material', []),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-attachment-catalog-'))
  setContentDir(root)
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
})

afterEach(async () => {
  db.close()
  setContentDir(originalContentDir)
  await fs.rm(root, { recursive: true, force: true })
})

describe('Attachment Manager adapters', () => {
  it('lists Board Asset metadata without requiring or reading binary files', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    db.prepare(`INSERT INTO assets (id, mime_type, byte_size, sha256, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, 'image/png', 19, 'a'.repeat(64), id, 123)
    db.prepare(`INSERT INTO asset_references (asset_id, owner_type, owner_id, purpose, created_at)
      VALUES (?, 'board', 'board-1', 'scene', 123)`).run(id)

    expect(listBoardAssetCatalog(db)).toEqual([{
      key: { kind: 'asset', id }, source: 'board-asset', type: 'image', displayName: null,
      mimeType: 'image/png', byteSize: 19, createdAt: 123, modifiedAt: null,
      referenceStatus: 'referenced', knownReferenceCount: 1,
    }])
  })

  it('lists active and archived Materials with UTF-8 byte sizes but no SVG body', () => {
    const id = '22222222-2222-4222-8222-222222222222'
    db.prepare(`INSERT INTO board_materials
      (id, name, kind, content, archived, created_at, updated_at)
      VALUES (?, '流程图', 'svg', '<svg>图</svg>', 1, 20, 30)`).run(id)

    const rows = listBoardMaterialCatalog(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: { kind: 'board-material', id }, source: 'board-material', type: 'material',
      displayName: '流程图', mimeType: 'image/svg+xml', byteSize: Buffer.byteLength('<svg>图</svg>'),
      createdAt: 20, modifiedAt: 30, referenceStatus: 'unknown', archived: true,
    })
    expect(rows[0]).not.toHaveProperty('svg')
  })

  it('scans only supported visible Vault resources and excludes Diary, Markdown, temp and symlink entries', async () => {
    await fs.mkdir(path.join(root, 'inbox', 'assets'), { recursive: true })
    await fs.mkdir(path.join(root, 'diary', '2026-10-12'), { recursive: true })
    await fs.mkdir(path.join(root, '.nuvyn'), { recursive: true })
    await fs.writeFile(path.join(root, 'inbox', 'assets', 'same.png'), Buffer.from([1, 2, 3, 4]))
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>'
    await fs.writeFile(path.join(root, 'inbox', 'assets', 'same.svg'), svg)
    await fs.writeFile(path.join(root, 'inbox', 'assets', 'snippet.ts'), 'const x = 1')
    await fs.writeFile(path.join(root, 'inbox', 'assets', 'main-note.md'), '# not an attachment')
    await fs.writeFile(path.join(root, 'inbox', 'assets', 'cache.tmp'), 'temporary')
    await fs.writeFile(path.join(root, '.nuvyn', 'private.png'), Buffer.from([1]))
    await fs.writeFile(path.join(root, 'diary', '2026-10-12', 'private.png'), Buffer.from([1]))
    const external = path.join(os.tmpdir(), `nuvyn-attachment-external-${Date.now()}.png`)
    await fs.writeFile(external, Buffer.from([1, 2]))
    try {
      await fs.symlink(external, path.join(root, 'inbox', 'assets', 'escape.png'))
      const result = await scanVaultAttachments(root)
      expect(result.complete).toBe(true)
      expect(result.items.map((item) => item.key)).toEqual([
        { kind: 'vault-file', path: 'inbox/assets/same.png' },
        { kind: 'vault-file', path: 'inbox/assets/same.svg' },
        { kind: 'vault-file', path: 'inbox/assets/snippet.ts' },
      ])
      expect(result.items.map((item) => item.mimeType)).toEqual(['image/png', 'image/svg+xml', 'text/plain'])
      expect(result.items.map((item) => item.byteSize)).toEqual([4, Buffer.byteLength(svg), Buffer.byteLength('const x = 1')])
      expect(result.items.every((item) => item.referenceStatus === 'unknown')).toBe(true)
      expect(JSON.stringify(result.items)).not.toContain(root)
      expect(JSON.stringify(result.items)).not.toContain('private')
    } finally {
      await fs.rm(external, { force: true })
    }
  })

  it('enforces scan bounds and reports an incomplete source', async () => {
    await fs.mkdir(path.join(root, 'folder'))
    await fs.writeFile(path.join(root, 'folder', 'a.txt'), 'a')
    const result = await scanVaultAttachments(root, undefined, { maxEntries: 1 })
    expect(result.complete).toBe(false)
    expect(result.errorCode).toBe('scan-limited')
  })
})

describe('AttachmentCatalog', () => {
  it('merges identities, sorts consistently, computes summary and filters before pagination', async () => {
    const first = asset('11111111-1111-4111-8111-111111111111', 'referenced')
    const second = asset('22222222-2222-4222-8222-222222222222')
    const vault: ManagedAttachment = {
      key: { kind: 'vault-file', path: 'inbox/same.png' }, source: 'vault-file', type: 'image',
      displayName: 'same.png', mimeType: 'image/png', byteSize: 10, createdAt: null, modifiedAt: 2,
      referenceStatus: 'unknown',
    }
    const material: ManagedAttachment = {
      key: { kind: 'board-material', id: '11111111-1111-4111-8111-111111111111' }, source: 'board-material', type: 'material',
      displayName: 'same.png', mimeType: 'image/svg+xml', byteSize: 12, createdAt: 1, modifiedAt: 2,
      referenceStatus: 'unknown',
    }
    const catalog = new AttachmentCatalog(adapters({
      boardAssets: fixedAdapter('board-asset', [first, second]),
      vaultFiles: fixedAdapter('vault-file', [vault]),
      boardMaterials: fixedAdapter('board-material', [material]),
    }), () => 50)

    const firstPage = await catalog.list({ limit: 2 })
    expect(firstPage.total).toBe(4)
    expect(firstPage.items).toHaveLength(2)
    expect(new Set(firstPage.items.map((item) => JSON.stringify(item.key))).size).toBe(2)
    expect(firstPage.summary).toMatchObject({
      total: 4, knownBytes: 38, unknownByteSizeCount: 0, unknownReferenceCount: 3, complete: true,
      sources: {
        'board-asset': { count: 2, knownBytes: 16 },
        'vault-file': { count: 1, knownBytes: 10 },
        'board-material': { count: 1, knownBytes: 12 },
      },
    })
    const nextPage = await catalog.list({ offset: 2, limit: 2 })
    expect(new Set([...firstPage.items, ...nextPage.items].map((item) => JSON.stringify(item.key))).size).toBe(4)
    expect((await catalog.list({ source: 'board-asset', referenceStatus: 'unknown' })).items).toEqual([second])
    expect((await catalog.list({ search: 'same.png' })).total).toBe(2)
    expect(catalog.getIndexStatus().refreshedAt).toBe(50)
  })

  it('keeps usable sources visible and marks summary partial when one adapter fails', async () => {
    const catalog = new AttachmentCatalog(adapters({
      boardAssets: { source: 'board-asset', scan: async () => { throw new Error('private path must not leak') } },
      vaultFiles: fixedAdapter('vault-file', []),
    }))
    const summary = await catalog.getSummary()
    expect(summary.complete).toBe(false)
    expect(summary.sources['board-asset'].count).toBe(0)
    expect(catalog.getIndexStatus().sources['board-asset']).toEqual({
      state: 'failed', itemCount: 0, errorCode: 'source-unavailable',
    })
  })

  it('deduplicates concurrent initial readers onto one scan and publishes a usable snapshot', async () => {
    const scanResult = deferred<{ items: ManagedAttachment[]; complete: boolean }>()
    const scan = vi.fn(() => scanResult.promise)
    const item = asset('44444444-4444-4444-8444-444444444444')
    const catalog = new AttachmentCatalog(adapters({
      boardAssets: { source: 'board-asset', scan },
    }))

    const listPromise = catalog.list({ source: 'board-asset' })
    const summaryPromise = catalog.getSummary()
    expect(scan).toHaveBeenCalledTimes(1)

    scanResult.resolve({ items: [item], complete: true })
    const [listed, summary] = await Promise.all([listPromise, summaryPromise])
    expect(listed.items).toEqual([item])
    expect(summary.total).toBe(1)
    expect(catalog.getIndexStatus()).toMatchObject({ ready: true, refreshing: false, complete: true })
  })

  it('keeps initial readers waiting when a forced refresh supersedes the initial scan', async () => {
    const scans = [deferred<{ items: ManagedAttachment[]; complete: boolean }>(), deferred<{ items: ManagedAttachment[]; complete: boolean }>()]
    let scanIndex = 0
    const scan = vi.fn(() => scans[scanIndex++]!.promise)
    const oldItem = asset('55555555-5555-4555-8555-555555555555')
    const newItem = asset('66666666-6666-4666-8666-666666666666')
    const catalog = new AttachmentCatalog(adapters({ boardAssets: { source: 'board-asset', scan } }))

    let readerSettled = false
    const reader = catalog.list({ source: 'board-asset' }).then((result) => {
      readerSettled = true
      return result
    })
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    const forcedRefresh = catalog.refresh(true)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2))

    scans[0]!.resolve({ items: [oldItem], complete: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(readerSettled).toBe(false)
    expect(catalog.getIndexStatus()).toMatchObject({ ready: false, refreshing: true })

    scans[1]!.resolve({ items: [newItem], complete: true })
    await forcedRefresh
    expect((await reader).items).toEqual([newItem])
  })

  it('waits for the latest of consecutive forced refreshes without publishing canceled scans', async () => {
    const scans = [
      deferred<{ items: ManagedAttachment[]; complete: boolean }>(),
      deferred<{ items: ManagedAttachment[]; complete: boolean }>(),
      deferred<{ items: ManagedAttachment[]; complete: boolean }>(),
    ]
    let scanIndex = 0
    const scan = vi.fn(() => scans[scanIndex++]!.promise)
    const items = [
      asset('77777777-7777-4777-8777-777777777777'),
      asset('88888888-8888-4888-8888-888888888888'),
      asset('99999999-9999-4999-8999-999999999999'),
    ]
    const catalog = new AttachmentCatalog(adapters({ boardAssets: { source: 'board-asset', scan } }))
    const reader = catalog.list({ source: 'board-asset' })
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    const second = catalog.refresh(true)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2))
    const third = catalog.refresh(true)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(3))

    scans[0]!.resolve({ items: [items[0]!], complete: true })
    scans[1]!.resolve({ items: [items[1]!], complete: true })
    await second
    expect(catalog.getIndexStatus()).toMatchObject({ ready: false, refreshing: true })
    scans[2]!.resolve({ items: [items[2]!], complete: true })

    await third
    expect((await reader).items).toEqual([items[2]])
    expect(catalog.getIndexStatus()).toMatchObject({ ready: true, refreshing: false, complete: true })
  })

  it('preserves the last usable snapshot when a forced refresh loses every source', async () => {
    let fail = false
    const makeAdapter = (source: AttachmentSource, items: ManagedAttachment[]): AttachmentCatalogAdapter => ({
      source,
      scan: async () => {
        if (fail) throw new Error('source unavailable')
        return { items, complete: true }
      },
    })
    const item = asset('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    const catalog = new AttachmentCatalog({
      boardAssets: makeAdapter('board-asset', [item]),
      vaultFiles: makeAdapter('vault-file', []),
      boardMaterials: makeAdapter('board-material', []),
    }, () => 123)
    await catalog.list({})
    fail = true

    await expect(catalog.refresh(true)).rejects.toThrow('All attachment catalog sources are unavailable')
    expect(catalog.getIndexStatus()).toMatchObject({
      ready: true,
      refreshing: false,
      complete: true,
      refreshedAt: 123,
    })
    expect((await catalog.list({})).items).toEqual([item])
  })

  it('fails initial reads instead of marking an unavailable catalog ready', async () => {
    const unavailable = (source: AttachmentSource): AttachmentCatalogAdapter => ({
      source,
      scan: async () => { throw new Error('offline') },
    })
    const catalog = new AttachmentCatalog({
      boardAssets: unavailable('board-asset'),
      vaultFiles: unavailable('vault-file'),
      boardMaterials: unavailable('board-material'),
    })

    await expect(catalog.list({})).rejects.toThrow('All attachment catalog sources are unavailable')
    expect(catalog.getIndexStatus()).toMatchObject({ ready: false, refreshing: false, complete: null, refreshedAt: null })
  })

  it('prevents an older explicit refresh from replacing a newer generation', async () => {
    let releaseOld: (() => void) | undefined
    let runCount = 0
    const oldItem = asset('11111111-1111-4111-8111-111111111111')
    const newItem = asset('33333333-3333-4333-8333-333333333333')
    const catalog = new AttachmentCatalog(adapters({
      boardAssets: {
        source: 'board-asset',
        scan: async () => {
          runCount += 1
          if (runCount === 1) {
            await new Promise<void>((resolve) => { releaseOld = resolve })
            return { items: [oldItem], complete: true }
          }
          return { items: [newItem], complete: true }
        },
      },
    }))

    const oldRefresh = catalog.refresh()
    await vi.waitFor(() => expect(releaseOld).toBeTypeOf('function'))
    await catalog.refresh(true)
    releaseOld?.()
    await oldRefresh
    expect((await catalog.list({ source: 'board-asset' })).items).toEqual([newItem])
  })

  it('does not rescan Vault for pagination; only explicit refresh updates the snapshot', async () => {
    const scan = vi.fn(async () => ({ items: [], complete: true }))
    const catalog = new AttachmentCatalog(adapters({ vaultFiles: { source: 'vault-file', scan } }))
    await catalog.list({ offset: 0 })
    await catalog.list({ offset: 30 })
    expect(scan).toHaveBeenCalledTimes(1)
    await catalog.refresh(true)
    expect(scan).toHaveBeenCalledTimes(2)
  })
})
