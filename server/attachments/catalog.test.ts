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
import type { ManagedAttachment } from '../../shared/attachmentProtocol.js'

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
        { kind: 'vault-file', path: 'inbox/assets/snippet.ts' },
      ])
      expect(result.items.map((item) => item.byteSize)).toEqual([4, Buffer.byteLength('const x = 1')])
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
