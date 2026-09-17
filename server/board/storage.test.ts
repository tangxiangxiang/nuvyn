import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../db.js'
import {
  __setDurableArtifactTestHooksForTesting,
} from '../durableCreateOnlyFile.js'
import { AssetError } from '../assets/errors.js'
import { AssetService } from '../assets/service.js'
import { AssetStorage } from '../assets/storage.js'
import { BoardError } from './errors.js'
import { BoardService } from './service.js'

type Fixture = {
  root: string
  db: Database.Database
  assets: AssetService
  boards: BoardService
  storage: AssetStorage
  now: { value: number }
}

async function createFixture(prefix = 'nuvyn-board-b1-'): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  const storage = new AssetStorage(path.join(root, 'assets'))
  const now = { value: 1_700_000_000_000 }
  const assets = new AssetService(db, { storage, now: () => now.value })
  const boards = new BoardService(db, {
    storage,
    now: () => now.value,
    createId: randomUUID,
  })
  return { root, db, assets, boards, storage, now }
}

async function closeFixture(fixture: Fixture): Promise<void> {
  fixture.db.close()
  await fs.rm(fixture.root, { recursive: true, force: true })
}

async function persistPng(fixture: Fixture, content = 'png-bytes'): Promise<{ id: string; data: Buffer }> {
  const id = randomUUID()
  const data = Buffer.from(content)
  await fixture.assets.persistAsset({ assetId: id, mimeType: 'image/png', data })
  return { id, data }
}

describe('Board V1 storage foundation migrations', () => {
  let fixture: Fixture

  beforeEach(async () => { fixture = await createFixture() })
  afterEach(async () => { await closeFixture(fixture) })

  it('applies the Asset and Board tables with active foreign keys and non-null scene columns', () => {
    expect(fixture.db.pragma('foreign_keys', { simple: true })).toBe(1)
    const tables = fixture.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('assets', 'asset_references', 'boards', 'board_scenes', 'board_folders')
      ORDER BY name
    `).all() as Array<{ name: string }>
    expect(tables.map(({ name }) => name)).toEqual([
      'asset_references',
      'assets',
      'board_folders',
      'board_scenes',
      'boards',
    ])

    const sceneColumns = fixture.db.prepare('PRAGMA table_info(board_scenes)').all() as Array<{
      name: string
      notnull: number
    }>
    expect(sceneColumns.find((column) => column.name === 'engine_data_json')?.notnull).toBe(1)
    expect(sceneColumns.find((column) => column.name === 'persistent_app_state_json')?.notnull).toBe(1)
  })

  it('migrates legacy Boards into the root folder scope without changing their scene', () => {
    const legacyDb = new Database(':memory:')
    legacyDb.pragma('foreign_keys = ON')
    applyMigrations(legacyDb, 32)
    legacyDb.prepare(`
      INSERT INTO boards (id, title, created_at, updated_at, last_opened_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('legacy-board', 'Legacy', 100, 200, 300)
    legacyDb.prepare(`
      INSERT INTO board_scenes (
        board_id, engine, scene_version, revision, engine_data_json, persistent_app_state_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('legacy-board', 'excalidraw', 1, 4, '{"elements":[],"fileMap":{}}', '{}')

    applyMigrations(legacyDb)

    expect(legacyDb.prepare('SELECT folder_id FROM boards WHERE id = ?').get('legacy-board')).toEqual({ folder_id: null })
    expect(legacyDb.prepare('SELECT revision FROM board_scenes WHERE board_id = ?').get('legacy-board')).toEqual({ revision: 4 })
    legacyDb.close()
  })
})

describe('Board metadata and canonical scene storage', () => {
  let fixture: Fixture

  beforeEach(async () => { fixture = await createFixture() })
  afterEach(async () => { await closeFixture(fixture) })

  it('creates Board metadata and its initial canonical scene atomically', () => {
    const board = fixture.boards.createBoard()
    expect(board.metadata).toMatchObject({
      title: 'Untitled Board',
      thumbnailAssetId: null,
      lastOpenedAt: null,
    })
    expect(board.sceneRecord).toMatchObject({
      boardId: board.metadata.id,
      engine: 'excalidraw',
      sceneVersion: 1,
      revision: 0,
      scene: {
        engineData: { elements: [], fileMap: {} },
        persistentAppState: {},
        assetRefs: [],
      },
    })
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM boards').get()).toEqual({ count: 1 })
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM board_scenes').get()).toEqual({ count: 1 })
    expect(fixture.db.prepare('SELECT engine_data_json FROM board_scenes').get()).toEqual({
      engine_data_json: '{"elements":[],"fileMap":{}}',
    })
  })

  it('lists by updatedAt descending and id descending for ties, and renames safely', () => {
    const first = fixture.boards.createBoard({ title: 'First' })
    const second = fixture.boards.createBoard({ title: 'Second' })
    expect(fixture.boards.listBoards().map((board) => board.id)).toEqual(
      [second.metadata.id, first.metadata.id].sort().reverse(),
    )

    fixture.now.value += 100
    const renamed = fixture.boards.renameBoard(first.metadata.id, '  Renamed  ')
    expect(renamed.title).toBe('Renamed')
    expect(renamed.updatedAt).toBe(fixture.now.value)
    expect(fixture.boards.listBoards()[0]?.id).toBe(first.metadata.id)
  })

  it('tracks Board opens separately from content updates and never moves access time backwards', async () => {
    const board = fixture.boards.createBoard({ title: 'Opened Board' })
    const originalUpdatedAt = board.metadata.updatedAt

    fixture.now.value += 100
    const opened = await fixture.boards.getBoard(board.metadata.id)
    expect(opened.metadata.lastOpenedAt).toBe(fixture.now.value)
    expect(opened.metadata.updatedAt).toBe(originalUpdatedAt)

    fixture.now.value -= 50
    const reopenedWithOlderClock = await fixture.boards.getBoard(board.metadata.id)
    expect(reopenedWithOlderClock.metadata.lastOpenedAt).toBe(opened.metadata.lastOpenedAt)
    expect(reopenedWithOlderClock.metadata.updatedAt).toBe(originalUpdatedAt)
  })

  it('normalizes empty and whitespace titles for create and rename', () => {
    const empty = fixture.boards.createBoard({ title: '' })
    const whitespace = fixture.boards.createBoard({ title: '   ' })
    expect(empty.metadata.title).toBe('Untitled Board')
    expect(whitespace.metadata.title).toBe('Untitled Board')

    expect(fixture.boards.renameBoard(empty.metadata.id, '').title).toBe('Untitled Board')
    expect(fixture.boards.renameBoard(whitespace.metadata.id, '   ').title).toBe('Untitled Board')
    expect(fixture.boards.renameBoard(empty.metadata.id, '  Hello  ').title).toBe('Hello')

    for (const title of [null, 123, {}]) {
      expect(() => fixture.boards.createBoard({ title })).toThrow('Board title must be a string')
      expect(() => fixture.boards.renameBoard(empty.metadata.id, title)).toThrow('Board title must be a string')
    }
  })

  it('deletes Board rows and only releases assets that are no longer referenced', async () => {
    const shared = await persistPng(fixture, 'shared')
    const first = fixture.boards.createBoard({ title: 'First' })
    const second = fixture.boards.createBoard({ title: 'Second' })
    await fixture.boards.saveBoardScene({
      boardId: first.metadata.id,
      expectedRevision: 0,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: {
        engineData: {
          elements: [{ id: 'image-first', type: 'image', fileId: 'file-first', isDeleted: false }],
          fileMap: { 'file-first': shared.id },
        },
        persistentAppState: {},
        assetRefs: [shared.id],
      },
    })
    await fixture.boards.saveBoardScene({
      boardId: second.metadata.id,
      expectedRevision: 0,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: {
        engineData: {
          elements: [{ id: 'image-second', type: 'image', fileId: 'file-second', isDeleted: false }],
          fileMap: { 'file-second': shared.id },
        },
        persistentAppState: {},
        assetRefs: [shared.id],
      },
    })

    await fixture.boards.deleteBoard(first.metadata.id)
    expect(fixture.assets.getAssetMetadata(shared.id)).not.toBeNull()
    expect(await fs.readFile(fixture.storage.pathForAssetId(shared.id))).toEqual(shared.data)

    await fixture.boards.deleteBoard(second.metadata.id)
    expect(fixture.assets.getAssetMetadata(shared.id)).toBeNull()
    await expect(fs.stat(fixture.storage.pathForAssetId(shared.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Asset durable persistence', () => {
  let fixture: Fixture

  beforeEach(async () => { fixture = await createFixture() })
  afterEach(async () => {
    __setDurableArtifactTestHooksForTesting(null)
    await closeFixture(fixture)
  })

  it('initializes a safe directory and persists readable metadata plus binary', async () => {
    const { id, data } = await persistPng(fixture, 'durable-png')
    const metadata = fixture.assets.getAssetMetadata(id)
    expect(metadata).toMatchObject({
      id,
      mimeType: 'image/png',
      byteSize: data.byteLength,
      storageKey: id,
    })
    expect(metadata?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await fixture.assets.readAssetBinary(id)).toEqual(data)
    expect(await fs.readFile(fixture.storage.pathForAssetId(id))).toEqual(data)
  })

  it('supports same-content retry but rejects a different payload without overwrite', async () => {
    const id = randomUUID()
    const original = Buffer.from('original')
    const retried = await fixture.assets.persistAsset({ assetId: id, mimeType: 'image/png', data: original })
    const same = await fixture.assets.persistAsset({ assetId: id, mimeType: 'image/jpeg', data: original })
    expect(same).toEqual(retried)

    await expect(fixture.assets.persistAsset({
      assetId: id,
      mimeType: 'image/png',
      data: Buffer.from('different'),
    })).rejects.toMatchObject({ code: 'ASSET_ID_CONFLICT' })
    expect(await fixture.assets.readAssetBinary(id)).toEqual(original)
  })

  it('fails closed when a binary exists without committed metadata', async () => {
    const id = randomUUID()
    const data = Buffer.from('incumbent-binary')
    await fixture.storage.createAssetBinary(id, data)

    await expect(fixture.assets.persistAsset({
      assetId: id,
      mimeType: 'image/png',
      data,
    })).rejects.toMatchObject({ code: 'ASSET_BINARY_CONFLICT', status: 409 })
    expect(fixture.assets.getAssetMetadata(id)).toBeNull()
    expect(await fs.readFile(fixture.storage.pathForAssetId(id))).toEqual(data)
  })

  it('enforces the Board V1 image MIME allow-list and optional byte limit', async () => {
    const svg = await fixture.assets.persistAsset({
      assetId: randomUUID(),
      mimeType: 'image/svg+xml',
      data: Buffer.from('<svg />'),
    })
    expect(svg).toMatchObject({ mimeType: 'image/svg+xml', byteSize: 7 })
    await expect(fixture.assets.persistAsset({
      assetId: randomUUID(),
      mimeType: 'image/png',
      data: Buffer.from('too large'),
      maxBytes: 2,
    })).rejects.toMatchObject({ status: 413 })
  })

  it('rejects unsafe Asset IDs before path construction', () => {
    for (const value of ['../foo', '/foo', 'foo/bar', 'foo\\bar', '', 'https://x.test/a', 'not-a-uuid']) {
      expect(() => fixture.storage.pathForAssetId(value)).toThrow()
    }
  })

  it('rejects a symlink in place of the Asset directory', async () => {
    const target = await fs.mkdtemp(path.join(fixture.root, 'outside-'))
    const linked = path.join(fixture.root, 'linked-assets')
    await fs.symlink(target, linked, 'dir')
    await expect(new AssetStorage(linked).ensureDirectory()).rejects.toMatchObject({
      code: 'ASSET_STORAGE_ERROR',
    })
  })

  it('compensates an owned binary when metadata insertion fails', async () => {
    fixture.db.exec(`
      CREATE TRIGGER fail_asset_metadata
      BEFORE INSERT ON assets
      BEGIN
        SELECT RAISE(ABORT, 'forced metadata failure');
      END;
    `)
    const id = randomUUID()
    await expect(fixture.assets.persistAsset({
      assetId: id,
      mimeType: 'image/png',
      data: Buffer.from('must be compensated'),
    })).rejects.toMatchObject({ code: 'ASSET_METADATA_PERSIST_FAILED' })
    expect(fixture.assets.getAssetMetadata(id)).toBeNull()
    await expect(fs.stat(fixture.storage.pathForAssetId(id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows an orphan binary when owned-file compensation itself fails', async () => {
    fixture.db.exec(`
      CREATE TRIGGER fail_asset_metadata
      BEFORE INSERT ON assets
      BEGIN
        SELECT RAISE(ABORT, 'forced metadata failure');
      END;
    `)
    __setDurableArtifactTestHooksForTesting({
      beforeDurableArtifactUnlink: () => { throw new Error('unlink unavailable') },
    })
    const id = randomUUID()
    await expect(fixture.assets.persistAsset({
      assetId: id,
      mimeType: 'image/png',
      data: Buffer.from('orphan is allowed'),
    })).rejects.toMatchObject({ code: 'ASSET_METADATA_PERSIST_FAILED' })
    expect(fixture.assets.getAssetMetadata(id)).toBeNull()
    expect(await fs.readFile(fixture.storage.pathForAssetId(id), 'utf8')).toBe('orphan is allowed')
  })
})

describe('Scene revision, references, and fail-closed reads', () => {
  let fixture: Fixture

  beforeEach(async () => { fixture = await createFixture() })
  afterEach(async () => { await closeFixture(fixture) })

  function scene(assetRefs: readonly string[] = []) {
    const fileMap = Object.fromEntries(assetRefs.map((assetId, index) => [`file-${index}`, assetId]))
    return {
      engineData: {
        elements: [
          { id: 'rectangle-1' },
          ...assetRefs.map((_, index) => ({
            id: `image-${index}`,
            type: 'image',
            fileId: `file-${index}`,
            isDeleted: false,
          })),
        ],
        fileMap,
      },
      persistentAppState: { zoom: 1, scrollX: 10, scrollY: 20 },
      assetRefs: [...new Set(assetRefs)],
    }
  }

  it('saves with CAS and rejects stale writes', async () => {
    const board = fixture.boards.createBoard()
    const asset = await persistPng(fixture)
    fixture.now.value += 1
    const saved = await fixture.boards.saveBoardScene({
      boardId: board.metadata.id,
      expectedRevision: 0,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: scene([asset.id]),
    })
    expect(saved.revision).toBe(1)
    expect(saved.updatedAt).toBe(fixture.now.value)
    expect(fixture.boards.getBoardMetadata(board.metadata.id).updatedAt).toBe(fixture.now.value)
    expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM asset_references WHERE owner_id = ?').get(board.metadata.id)).toEqual({ count: 1 })

    await expect(fixture.boards.saveBoardScene({
      boardId: board.metadata.id,
      expectedRevision: 0,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: scene([]),
    })).rejects.toMatchObject({ code: 'BOARD_SCENE_REVISION_CONFLICT' })

    const current = await fixture.boards.getBoard(board.metadata.id)
    expect(current.sceneRecord.revision).toBe(1)
    expect(current.sceneRecord.scene.assetRefs).toEqual([asset.id])
    expect(current.sceneRecord.scene.engineData).toEqual(scene([asset.id]).engineData)
  })

  it('fails a Scene Save atomically when reference replacement fails', async () => {
    const board = fixture.boards.createBoard()
    const first = await persistPng(fixture, 'first')
    const second = await persistPng(fixture, 'second')
    fixture.now.value += 10
    await fixture.boards.saveBoardScene({
      boardId: board.metadata.id,
      expectedRevision: 0,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: scene([first.id]),
    })
    const before = fixture.boards.getBoardMetadata(board.metadata.id)
    fixture.db.exec(`
      CREATE TRIGGER reject_second_scene_reference
      BEFORE INSERT ON asset_references
      WHEN NEW.asset_id = '${second.id}' AND NEW.purpose = 'scene'
      BEGIN
        SELECT RAISE(ABORT, 'forced reference replacement failure');
      END;
    `)
    fixture.now.value += 10

    await expect(fixture.boards.saveBoardScene({
      boardId: board.metadata.id,
      expectedRevision: 1,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: scene([second.id]),
    })).rejects.toThrow()

    const after = await fixture.boards.getBoard(board.metadata.id)
    expect(after.sceneRecord.revision).toBe(1)
    expect(after.sceneRecord.scene.assetRefs).toEqual([first.id])
    expect(after.metadata.updatedAt).toBe(before.updatedAt)
  })

  it('rejects a missing binary even when metadata remains', async () => {
    const board = fixture.boards.createBoard()
    const asset = await persistPng(fixture, 'missing-binary')
    await fs.unlink(fixture.storage.pathForAssetId(asset.id))

    await expect(fixture.boards.saveBoardScene({
      boardId: board.metadata.id,
      expectedRevision: 0,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: scene([asset.id]),
    })).rejects.toMatchObject({ code: 'ASSET_BINARY_MISSING' })
    expect(fixture.db.prepare('SELECT revision FROM board_scenes WHERE board_id = ?').get(board.metadata.id)).toEqual({ revision: 0 })
  })

  it('keeps a successful Scene Save successful when post-commit physical cleanup fails', async () => {
    const board = fixture.boards.createBoard()
    const asset = await persistPng(fixture, 'cleanup-failure')
    await fixture.boards.saveBoardScene({
      boardId: board.metadata.id,
      expectedRevision: 0,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: scene([asset.id]),
    })
    __setDurableArtifactTestHooksForTesting({
      beforeDurableArtifactUnlink: () => { throw new Error('physical cleanup blocked') },
    })
    const result = await fixture.boards.saveBoardScene({
      boardId: board.metadata.id,
      expectedRevision: 1,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: scene([]),
    })
    __setDurableArtifactTestHooksForTesting(null)
    expect(result.revision).toBe(2)
    expect(result.cleanupFailures).toHaveLength(1)
    expect(fixture.assets.getAssetMetadata(asset.id)).toBeNull()
    expect(await fs.readFile(fixture.storage.pathForAssetId(asset.id), 'utf8')).toBe('cleanup-failure')
  })

  it('fails closed on corrupt JSON and a future scene version', async () => {
    const board = fixture.boards.createBoard()
    fixture.db.prepare('UPDATE board_scenes SET engine_data_json = ? WHERE board_id = ?').run('not-json', board.metadata.id)
    await expect(fixture.boards.getBoard(board.metadata.id)).rejects.toMatchObject({ code: 'BOARD_SCENE_CORRUPT' })

    const future = fixture.boards.createBoard()
    fixture.db.prepare('UPDATE board_scenes SET scene_version = ? WHERE board_id = ?').run(2, future.metadata.id)
    await expect(fixture.boards.getBoard(future.metadata.id)).rejects.toMatchObject({ code: 'BOARD_SCENE_VERSION_UNSUPPORTED' })
  })

  it('replaces thumbnail references without changing Board updatedAt', async () => {
    const board = fixture.boards.createBoard()
    const first = await persistPng(fixture, 'thumbnail-one')
    const second = await persistPng(fixture, 'thumbnail-two')

    const createdAt = board.metadata.updatedAt
    fixture.now.value += 100
    await fixture.boards.setThumbnailAsset(board.metadata.id, first.id)
    expect(fixture.boards.getBoardMetadata(board.metadata.id).thumbnailAssetId).toBe(first.id)

    const afterFirst = fixture.boards.getBoardMetadata(board.metadata.id)
    expect(afterFirst.updatedAt).toBe(createdAt)
    expect(fixture.db.prepare(`
      SELECT created_at
      FROM asset_references
      WHERE owner_id = ? AND purpose = 'thumbnail'
    `).get(board.metadata.id)).toEqual({ created_at: fixture.now.value })

    fixture.now.value += 100
    await fixture.boards.setThumbnailAsset(board.metadata.id, second.id)
    expect(fixture.boards.getBoardMetadata(board.metadata.id)).toMatchObject({
      thumbnailAssetId: second.id,
      updatedAt: createdAt,
    })
    expect(fixture.assets.getAssetMetadata(first.id)).toBeNull()
    expect(fixture.assets.getAssetMetadata(second.id)).not.toBeNull()
  })
})

describe('Atomic Asset cleanup claim concurrency', () => {
  let root = ''
  let dbA: Database.Database
  let dbB: Database.Database
  let storage: AssetStorage
  let assetsA: AssetService
  let assetsB: AssetService

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-asset-claim-'))
    const dbPath = path.join(root, 'nuvyn.db')
    dbA = new Database(dbPath)
    dbB = new Database(dbPath)
    dbA.pragma('journal_mode = WAL')
    dbA.pragma('foreign_keys = ON')
    dbB.pragma('foreign_keys = ON')
    applyMigrations(dbA)
    storage = new AssetStorage(path.join(root, 'assets'))
    assetsA = new AssetService(dbA, { storage })
    assetsB = new AssetService(dbB, { storage })
  })

  afterEach(async () => {
    __setDurableArtifactTestHooksForTesting(null)
    dbA.close()
    dbB.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('gives two cleanup workers one and only one claim', async () => {
    const id = randomUUID()
    await assetsA.persistAsset({ assetId: id, mimeType: 'image/png', data: Buffer.from('claim-once') })
    const first = await assetsA.tryClaimUnreferencedAssetForDeletion(id)
    const second = await assetsB.tryClaimUnreferencedAssetForDeletion(id)
    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
    expect(assetsA.getAssetMetadata(id)).toBeNull()
  })

  it('lets a committed reference win, and rejects a reference after cleanup wins', async () => {
    const referencedId = randomUUID()
    await assetsA.persistAsset({ assetId: referencedId, mimeType: 'image/png', data: Buffer.from('reference-wins') })
    dbB.prepare(`
      INSERT INTO asset_references (asset_id, owner_type, owner_id, purpose, created_at)
      VALUES (?, 'board', 'board-a', 'scene', ?)
    `).run(referencedId, Date.now())
    const referenceWins = await assetsA.tryClaimUnreferencedAssetForDeletion(referencedId)
    expect(referenceWins.claimed).toBe(false)
    expect(assetsA.getAssetMetadata(referencedId)).not.toBeNull()

    const cleanupWinsId = randomUUID()
    await assetsA.persistAsset({ assetId: cleanupWinsId, mimeType: 'image/png', data: Buffer.from('cleanup-wins') })
    const cleanupWins = await assetsA.tryClaimUnreferencedAssetForDeletion(cleanupWinsId)
    expect(cleanupWins.claimed).toBe(true)
    expect(() => dbB.prepare(`
      INSERT INTO asset_references (asset_id, owner_type, owner_id, purpose, created_at)
      VALUES (?, 'board', 'board-b', 'scene', ?)
    `).run(cleanupWinsId, Date.now())).toThrow()
    expect(assetsA.getAssetMetadata(cleanupWinsId)).toBeNull()
    expect(dbB.prepare('SELECT COUNT(*) AS count FROM asset_references WHERE asset_id = ?').get(cleanupWinsId)).toEqual({ count: 0 })
  })

  it('does not recreate metadata during the cleanup physical-delete window', async () => {
    const id = randomUUID()
    const data = Buffer.from('cleanup-window')
    await assetsA.persistAsset({ assetId: id, mimeType: 'image/png', data })

    let signalPhysicalDelete = () => {}
    let releasePhysicalDelete = () => {}
    const physicalDeleteEntered = new Promise<void>((resolve) => {
      signalPhysicalDelete = resolve
    })
    const allowPhysicalDelete = new Promise<void>((resolve) => {
      releasePhysicalDelete = resolve
    })
    __setDurableArtifactTestHooksForTesting({
      beforeDurableArtifactUnlink: async () => {
        signalPhysicalDelete()
        await allowPhysicalDelete
      },
    })

    const cleanupPromise = assetsA.tryClaimUnreferencedAssetForDeletion(id)
    await physicalDeleteEntered
    try {
      expect(assetsA.getAssetMetadata(id)).toBeNull()
      expect(await fs.readFile(storage.pathForAssetId(id))).toEqual(data)
      await expect(assetsB.persistAsset({ assetId: id, mimeType: 'image/png', data }))
        .rejects.toMatchObject({ code: 'ASSET_BINARY_CONFLICT', status: 409 })
      expect(assetsB.getAssetMetadata(id)).toBeNull()
    } finally {
      releasePhysicalDelete()
    }

    await expect(cleanupPromise).resolves.toMatchObject({
      claimed: true,
      physicalDeleted: true,
    })
    expect(assetsA.getAssetMetadata(id)).toBeNull()
    await expect(fs.stat(storage.pathForAssetId(id))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('storage error vocabulary', () => {
  it('keeps domain errors distinguishable from ordinary Error values', () => {
    const error = new AssetError('ASSET_ID_CONFLICT', 409, 'conflict')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('ASSET_ID_CONFLICT')
    expect(new BoardError('BOARD_SCENE_REVISION_CONFLICT', 409, 'stale').code).toBe('BOARD_SCENE_REVISION_CONFLICT')
  })
})
