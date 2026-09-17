import Database from 'better-sqlite3'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../index.js'
import { applyMigrations } from '../db.js'
import { __setDurableArtifactTestHooksForTesting } from '../durableCreateOnlyFile.js'
import { AssetStorage } from '../assets/storage.js'
import { BoardService } from './service.js'
import {
  __setBoardServiceForTesting,
  BOARD_SCENE_MAX_JSON_BYTES,
} from './routes.js'
import {
  __setAssetServiceForTesting,
  BOARD_ASSET_MAX_BYTES,
} from '../assets/routes.js'
import { __setBoardMaterialServiceForTesting } from './materialRoutes.js'
import { BoardMaterialService } from './materialService.js'
import {
  closeAuthTestContext,
  createAuthenticatedTestContext,
  type AuthenticatedTestContext,
} from '../__tests__/helpers/auth.js'

const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x01])
const GIF = Buffer.from('GIF89a')
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBP')
const SVG = Buffer.from('\uFEFF \n<?xml version="1.0"?>\n<!-- Board asset -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>', 'utf8')
const AVIF = (() => {
  const data = Buffer.alloc(24)
  data.writeUInt32BE(24, 0)
  data.write('ftyp', 4, 'ascii')
  data.write('avif', 8, 'ascii')
  data.writeUInt32BE(0, 12)
  data.write('mif1', 16, 'ascii')
  data.write('miaf', 20, 'ascii')
  return data
})()

const BASE_TIME = 1_700_000_000_000

type RequestOptions = {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  authenticated?: boolean
}

type RequestBody = string | Uint8Array | ReadableStream<Uint8Array>
type RequestHeaders = Record<string, string>

type BoardJson = {
  metadata: {
    id: string
    title: string
    thumbnailAssetId: string | null
    folderId: string | null
    createdAt: number
    updatedAt: number
    lastOpenedAt: number | null
  }
  sceneRecord: {
    revision: number
    scene: {
      assetRefs: string[]
      engineData: {
        elements: Array<Record<string, unknown>>
        fileMap: Record<string, string>
      }
    }
  }
}

const db = new Database(':memory:')
let root = ''
let now = BASE_TIME
let storage: AssetStorage
let boards: BoardService
let materials: BoardMaterialService
let auth: AuthenticatedTestContext

function isRawBody(value: unknown): value is RequestBody {
  return typeof value === 'string' || value instanceof Uint8Array || value instanceof ReadableStream
}

async function request(urlPath: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers)
  if (options.authenticated !== false) headers.set('Cookie', auth.cookie)

  let body: RequestBody | undefined
  if (options.body !== undefined) {
    if (isRawBody(options.body)) {
      body = options.body
    } else {
      body = JSON.stringify(options.body)
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    }
  }

  const init: RequestInit & { duplex?: 'half' } = {
    method: options.method ?? 'GET',
    headers,
    body: body as any,
  }
  if (options.body instanceof ReadableStream) init.duplex = 'half'
  return app.fetch(new Request(`http://localhost${urlPath}`, init))
}

async function responseJson<T = any>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

async function createBoard(body: unknown = {}): Promise<BoardJson> {
  const response = await request('/api/board', { method: 'POST', body })
  expect(response.status).toBe(201)
  return responseJson<BoardJson>(response)
}

async function uploadAsset(
  assetId = randomUUID(),
  data: Uint8Array | ReadableStream<Uint8Array> = PNG_A,
  mimeType = 'image/png',
  headers: RequestHeaders = {},
): Promise<Response> {
  const requestHeaders: RequestHeaders = { 'Content-Type': mimeType, ...headers }
  if (data instanceof Uint8Array
    && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'content-length')) {
    requestHeaders['Content-Length'] = String(data.byteLength)
  }
  return request(`/api/assets/${assetId}`, {
    method: 'PUT',
    body: data,
    headers: requestHeaders,
  })
}

function scene(assetRefs: readonly string[] = []) {
  const fileMap = Object.fromEntries(assetRefs.map((assetId, index) => [`file-${index}`, assetId]))
  return {
    engineData: {
      elements: assetRefs.map((_, index) => ({
        id: `image-${index}`,
        type: 'image',
        fileId: `file-${index}`,
        isDeleted: false,
      })),
      fileMap,
    },
    persistentAppState: {},
    assetRefs,
  }
}

beforeAll(async () => {
  db.pragma('foreign_keys = ON')
  applyMigrations(db)
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuvyn-board-b2-api-'))
  storage = new AssetStorage(path.join(root, 'assets'))
  boards = new BoardService(db, { storage, now: () => now })
  materials = new BoardMaterialService(db, { now: () => now })
  auth = createAuthenticatedTestContext({ db, now: () => now })
  __setBoardServiceForTesting(boards)
  __setAssetServiceForTesting(boards.assets)
  __setBoardMaterialServiceForTesting(materials)
})

beforeEach(async () => {
  now = BASE_TIME
  db.exec('DELETE FROM asset_references; DELETE FROM board_scenes; DELETE FROM boards; DELETE FROM board_folders; DELETE FROM assets; DELETE FROM board_materials;')
  await fs.rm(root, { recursive: true, force: true })
})

afterEach(() => {
  __setDurableArtifactTestHooksForTesting(null)
})

afterAll(async () => {
  __setDurableArtifactTestHooksForTesting(null)
  __setBoardServiceForTesting(null)
  __setAssetServiceForTesting(null)
  __setBoardMaterialServiceForTesting(null)
  closeAuthTestContext(auth)
  db.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('Board V1 HTTP authentication boundary', () => {
  it('protects Board and binary Asset APIs with the existing auth boundary', async () => {
    const board = await request('/api/board', { authenticated: false })
    expect(board.status).toBe(401)
    expect(await responseJson(board)).toMatchObject({ code: 'auth-session-required' })

    const asset = await request(`/api/assets/${randomUUID()}`, {
      method: 'PUT',
      body: PNG_A,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(PNG_A.byteLength),
      },
      authenticated: false,
    })
    expect(asset.status).toBe(401)
    expect(await responseJson(asset)).toMatchObject({ code: 'auth-session-required' })
  })
})

describe('Board HTTP API', () => {
  it('lists, creates, gets, and renames Boards through the mounted routes', async () => {
    const emptyList = await request('/api/board')
    expect(emptyList.status).toBe(200)
    expect(await responseJson(emptyList)).toEqual([])

    const created = await createBoard({})
    expect(created.metadata).toMatchObject({
      title: 'Untitled Board',
      thumbnailAssetId: null,
      folderId: null,
      lastOpenedAt: null,
    })
    expect(created.sceneRecord).toMatchObject({
      boardId: created.metadata.id,
      engine: 'excalidraw',
      sceneVersion: 1,
      revision: 0,
      scene: {
        engineData: { elements: [], fileMap: {} },
        persistentAppState: {},
        assetRefs: [],
      },
    })

    const whitespace = await createBoard({ title: '   ' })
    expect(whitespace.metadata.title).toBe('Untitled Board')

    const listed = await request('/api/board')
    expect(await responseJson(listed)).toHaveLength(2)
    expect(JSON.stringify(await responseJson(await request('/api/board')))).not.toContain('sceneRecord')

    const got = await request(`/api/board/${created.metadata.id}`)
    expect(got.status).toBe(200)
    const opened = await responseJson<BoardJson>(got)
    expect(opened).toMatchObject({
      ...created,
      metadata: {
        ...created.metadata,
        lastOpenedAt: now,
      },
    })
    expect(opened.metadata.updatedAt).toBe(created.metadata.updatedAt)

    const metadataOnly = await request(`/api/board/${created.metadata.id}/metadata`)
    expect(metadataOnly.status).toBe(200)
    expect(await responseJson(metadataOnly)).toMatchObject({
      id: created.metadata.id,
      title: created.metadata.title,
      lastOpenedAt: now,
      updatedAt: created.metadata.updatedAt,
    })

    const renamed = await request(`/api/board/${created.metadata.id}`, {
      method: 'PATCH',
      body: { title: '  New Title  ' },
    })
    expect(renamed.status).toBe(200)
    expect(await responseJson(renamed)).toMatchObject({ title: 'New Title' })

    const resetTitle = await request(`/api/board/${created.metadata.id}`, {
      method: 'PATCH',
      body: { title: '   ' },
    })
    expect(resetTitle.status).toBe(200)
    expect(await responseJson(resetTitle)).toMatchObject({ title: 'Untitled Board' })

    const missing = await request(`/api/board/${randomUUID()}`)
    expect(missing.status).toBe(404)
    expect(await responseJson(missing)).toMatchObject({ code: 'BOARD_NOT_FOUND' })
  })

  it('creates folders, creates and moves Boards within them, and deletes folders without deleting Boards', async () => {
    const rootBoard = await createBoard({ title: 'Root board' })
    const folderAResponse = await request('/api/board-folders', {
      method: 'POST',
      body: { name: '  Work  ' },
    })
    expect(folderAResponse.status).toBe(201)
    const folderA = await responseJson<{ id: string; name: string; boardCount: number }>(folderAResponse)
    expect(folderA).toMatchObject({ name: 'Work', boardCount: 0 })

    const folderBResponse = await request('/api/board-folders', {
      method: 'POST',
      body: { name: 'Learning' },
    })
    expect(folderBResponse.status).toBe(201)
    const folderB = await responseJson<{ id: string; name: string; boardCount: number }>(folderBResponse)

    const inA = await createBoard({ title: 'In A', folderId: folderA.id })
    expect(inA.metadata.folderId).toBe(folderA.id)
    const originalUpdatedAt = inA.metadata.updatedAt

    const renamed = await request(`/api/board-folders/${folderA.id}`, {
      method: 'PATCH',
      body: { name: '  Projects  ' },
    })
    expect(renamed.status).toBe(200)
    expect(await responseJson(renamed)).toMatchObject({ id: folderA.id, name: 'Projects', boardCount: 1 })

    const movedIntoA = await request(`/api/board/${rootBoard.metadata.id}/folder`, {
      method: 'PATCH',
      body: { folderId: folderA.id },
    })
    expect(movedIntoA.status).toBe(200)
    expect(await responseJson(movedIntoA)).toMatchObject({ id: rootBoard.metadata.id, folderId: folderA.id })

    const movedIntoB = await request(`/api/board/${inA.metadata.id}/folder`, {
      method: 'PATCH',
      body: { folderId: folderB.id },
    })
    expect(movedIntoB.status).toBe(200)
    expect(await responseJson(movedIntoB)).toMatchObject({ folderId: folderB.id, updatedAt: originalUpdatedAt })

    const movedToRoot = await request(`/api/board/${inA.metadata.id}/folder`, {
      method: 'PATCH',
      body: { folderId: null },
    })
    expect(movedToRoot.status).toBe(200)
    expect(await responseJson(movedToRoot)).toMatchObject({ folderId: null, updatedAt: originalUpdatedAt })

    const invalidMove = await request(`/api/board/${inA.metadata.id}/folder`, {
      method: 'PATCH',
      body: { folderId: randomUUID() },
    })
    expect(invalidMove.status).toBe(404)
    expect(await responseJson(invalidMove)).toMatchObject({ code: 'BOARD_FOLDER_NOT_FOUND' })

    const folders = await responseJson<Array<{ id: string; boardCount: number }>>(await request('/api/board-folders'))
    expect(folders.find((folder) => folder.id === folderA.id)?.boardCount).toBe(1)
    expect(folders.find((folder) => folder.id === folderB.id)?.boardCount).toBe(0)

    const beforeDelete = await responseJson<BoardJson>(await request(`/api/board/${rootBoard.metadata.id}`))
    const deleted = await request(`/api/board-folders/${folderA.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    const afterDelete = await responseJson<BoardJson>(await request(`/api/board/${rootBoard.metadata.id}`))
    expect(afterDelete.metadata.folderId).toBeNull()
    expect(afterDelete.sceneRecord).toEqual(beforeDelete.sceneRecord)
    const foldersAfterDelete = await responseJson<Array<{ id: string }>>(await request('/api/board-folders'))
    expect(foldersAfterDelete.some((folder) => folder.id === folderA.id)).toBe(false)
    expect((await request(`/api/board/${inA.metadata.id}`)).status).toBe(200)
  })

  it('rejects invalid folder names and creates a root Board when folderId is null', async () => {
    const empty = await request('/api/board-folders', { method: 'POST', body: { name: '   ' } })
    expect(empty.status).toBe(400)
    expect(await responseJson(empty)).toMatchObject({ code: 'BOARD_VALIDATION_ERROR' })

    const tooLong = await request('/api/board-folders', { method: 'POST', body: { name: 'x'.repeat(81) } })
    expect(tooLong.status).toBe(400)

    const nested = await request('/api/board-folders', { method: 'POST', body: { name: 'Nested', parentId: randomUUID() } })
    expect(nested.status).toBe(400)

    const root = await createBoard({ title: 'Explicit root', folderId: null })
    expect(root.metadata.folderId).toBeNull()
  })

  it('saves scenes, enforces revision CAS, ignores client-owned fields, and fails atomically for missing Assets', async () => {
    const board = await createBoard()
    const assetId = randomUUID()
    expect((await uploadAsset(assetId)).status).toBe(200)

    now += 100
    const saved = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: 0,
        revision: 999,
        serverRevision: 999,
        owner_type: 'attacker-controlled',
        owner_id: 'attacker-controlled',
        purpose: 'attacker-controlled',
        updatedAt: 1,
        createdAt: 1,
        scene: scene([assetId]),
      },
    })
    expect(saved.status).toBe(200)
    expect(await responseJson(saved)).toEqual({ revision: 1, updatedAt: now })

    const stale = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: 0,
        scene: scene([]),
      },
    })
    expect(stale.status).toBe(409)
    expect(await responseJson(stale)).toMatchObject({ code: 'BOARD_SCENE_REVISION_CONFLICT' })

    const before = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    const missingAssetId = randomUUID()
    const missing = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: 1,
        scene: scene([missingAssetId]),
      },
    })
    expect(missing.status).toBe(404)
    expect(await responseJson(missing)).toMatchObject({ code: 'ASSET_NOT_FOUND' })

    const after = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    expect(after.sceneRecord).toEqual(before.sceneRecord)
    expect(after.metadata.updatedAt).toBe(before.metadata.updatedAt)
  })

  it('rejects an invalid Scene asset invariant without changing revision or references', async () => {
    const board = await createBoard()
    const assetId = randomUUID()
    expect((await uploadAsset(assetId)).status).toBe(200)

    const saved = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: 0,
        scene: scene([assetId]),
      },
    })
    expect(saved.status).toBe(200)
    const before = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))

    const invalid = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: 1,
        scene: {
          engineData: {
            elements: [{ id: 'image-invalid', type: 'image', fileId: 'file-a', isDeleted: false }],
            fileMap: { 'file-a': assetId },
          },
          persistentAppState: {},
          assetRefs: [],
        },
      },
    })
    expect(invalid.status).toBe(400)
    expect(await responseJson(invalid)).toMatchObject({ code: 'BOARD_VALIDATION_ERROR' })

    const after = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    expect(after.sceneRecord).toEqual(before.sceneRecord)
    expect(after.metadata.updatedAt).toBe(before.metadata.updatedAt)
    expect((await request(`/api/assets/${assetId}`)).status).toBe(200)
  })

  it('persists a material-instantiated SVG Asset through reload after the source Material is deleted', async () => {
    const board = await createBoard({ title: 'Material lifecycle' })
    const materialResponse = await request('/api/board-materials', {
      method: 'POST',
      body: { name: 'MySQL', svg: SVG.toString('utf8') },
    })
    expect(materialResponse.status).toBe(201)
    const material = await responseJson<{ id: string; name: string; svg: string }>(materialResponse)
    expect(material).toMatchObject({ name: 'MySQL', svg: SVG.toString('utf8') })

    const assetId = randomUUID()
    expect((await uploadAsset(assetId, SVG, 'image/svg+xml')).status).toBe(200)
    const engineFileId = 'material-file-1'
    const persistedScene = {
      engineData: {
        elements: [{ id: 'material-image-1', type: 'image', fileId: engineFileId, isDeleted: false, version: 1 }],
        fileMap: { [engineFileId]: assetId },
      },
      persistentAppState: {},
      assetRefs: [assetId],
    }

    now += 100
    const saved = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: 0,
        scene: persistedScene,
      },
    })
    expect(saved.status).toBe(200)
    expect(await responseJson(saved)).toEqual({ revision: 1, updatedAt: now })

    const firstReload = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    const firstSceneJson = JSON.stringify(firstReload.sceneRecord.scene)
    expect(firstReload.sceneRecord.revision).toBe(1)
    expect(firstReload.sceneRecord.scene.assetRefs).toEqual([assetId])
    expect(firstReload.sceneRecord.scene.engineData).toMatchObject({
      elements: [expect.objectContaining({ type: 'image', fileId: engineFileId })],
      fileMap: { [engineFileId]: assetId },
    })
    expect(firstSceneJson).not.toContain(material.id)
    expect(firstSceneJson).not.toMatch(/materialId|boardMaterialId|sourceMaterialId/)

    const asset = await request(`/api/assets/${assetId}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('Content-Type')).toBe('image/svg+xml')
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array(SVG))

    expect((await request(`/api/board-materials/${material.id}/archive`, { method: 'POST' })).status).toBe(200)
    expect((await request(`/api/board-materials/${material.id}`, { method: 'DELETE' })).status).toBe(204)

    now += 100
    const afterSourceDelete = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    expect(afterSourceDelete.sceneRecord).toEqual(firstReload.sceneRecord)
    expect(JSON.stringify(afterSourceDelete.sceneRecord.scene)).not.toContain(material.id)
    const assetAfterSourceDelete = await request(`/api/assets/${assetId}`)
    expect(assetAfterSourceDelete.status).toBe(200)
    expect(assetAfterSourceDelete.headers.get('Content-Type')).toBe('image/svg+xml')
  })

  it('keeps Board revision, updatedAt, and thumbnail stable across Material mutations and upload', async () => {
    const board = await createBoard({ title: 'Material isolation' })
    const sceneAssetId = randomUUID()
    const thumbnailAssetId = randomUUID()
    expect((await uploadAsset(sceneAssetId, PNG_A)).status).toBe(200)
    expect((await uploadAsset(thumbnailAssetId, PNG_B)).status).toBe(200)

    now += 100
    const saved = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: {
        engine: 'excalidraw',
        sceneVersion: 1,
        expectedRevision: 0,
        scene: {
          engineData: {
            elements: [{ id: 'scene-image-1', type: 'image', fileId: 'scene-file-1', isDeleted: false }],
            fileMap: { 'scene-file-1': sceneAssetId },
          },
          persistentAppState: {},
          assetRefs: [sceneAssetId],
        },
      },
    })
    expect(saved.status).toBe(200)
    now += 100
    const thumbnail = await request(`/api/board/${board.metadata.id}/thumbnail`, {
      method: 'PUT',
      body: { assetId: thumbnailAssetId },
    })
    expect(thumbnail.status).toBe(200)

    const baseline = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    const stableMetadata = {
      revision: baseline.sceneRecord.revision,
      updatedAt: baseline.metadata.updatedAt,
      thumbnailAssetId: baseline.metadata.thumbnailAssetId,
    }
    const expectStableBoard = async (): Promise<void> => {
      const current = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
      expect({
        revision: current.sceneRecord.revision,
        updatedAt: current.metadata.updatedAt,
        thumbnailAssetId: current.metadata.thumbnailAssetId,
      }).toEqual(stableMetadata)
    }

    const materialResponse = await request('/api/board-materials', {
      method: 'POST',
      body: { name: 'Isolation', svg: SVG.toString('utf8') },
    })
    const material = await responseJson<{ id: string }>(materialResponse)
    await expectStableBoard()

    now += 100
    expect((await request(`/api/board-materials/${material.id}`, {
      method: 'PATCH',
      body: { name: 'Renamed isolation' },
    })).status).toBe(200)
    await expectStableBoard()

    now += 100
    expect((await request(`/api/board-materials/${material.id}/archive`, { method: 'POST' })).status).toBe(200)
    await expectStableBoard()

    now += 100
    expect((await request(`/api/board-materials/${material.id}/restore`, { method: 'POST' })).status).toBe(200)
    await expectStableBoard()

    now += 100
    expect((await request(`/api/board-materials/${material.id}/archive`, { method: 'POST' })).status).toBe(200)
    expect((await request(`/api/board-materials/${material.id}`, { method: 'DELETE' })).status).toBe(204)
    await expectStableBoard()
  })

  it('sets and clears thumbnails without changing Board updatedAt', async () => {
    const board = await createBoard()
    const firstId = randomUUID()
    const secondId = randomUUID()
    expect((await uploadAsset(firstId, PNG_A)).status).toBe(200)
    expect((await uploadAsset(secondId, PNG_B)).status).toBe(200)

    now += 100
    const first = await request(`/api/board/${board.metadata.id}/thumbnail`, {
      method: 'PUT',
      body: { assetId: firstId },
    })
    expect(first.status).toBe(200)
    expect(await responseJson(first)).toEqual({ thumbnailAssetId: firstId })
    const afterFirst = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    expect(afterFirst.metadata).toMatchObject({
      thumbnailAssetId: firstId,
      updatedAt: board.metadata.updatedAt,
    })

    now += 100
    const second = await request(`/api/board/${board.metadata.id}/thumbnail`, {
      method: 'PUT',
      body: { assetId: secondId },
    })
    expect(second.status).toBe(200)
    expect(await responseJson(second)).toEqual({ thumbnailAssetId: secondId })
    expect((await request(`/api/assets/${firstId}`)).status).toBe(404)

    const cleared = await request(`/api/board/${board.metadata.id}/thumbnail`, {
      method: 'PUT',
      body: { assetId: null },
    })
    expect(cleared.status).toBe(200)
    expect(await responseJson(cleared)).toEqual({ thumbnailAssetId: null })
    const afterClear = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    expect(afterClear.metadata).toMatchObject({
      thumbnailAssetId: null,
      updatedAt: board.metadata.updatedAt,
    })
    expect((await request(`/api/assets/${secondId}`)).status).toBe(404)
  })

  it('deletes Boards through the service and retains shared Assets until the last reference is gone', async () => {
    const first = await createBoard({ title: 'First' })
    const second = await createBoard({ title: 'Second' })
    const assetId = randomUUID()
    expect((await uploadAsset(assetId)).status).toBe(200)

    for (const boardId of [first.metadata.id, second.metadata.id]) {
      const saved = await request(`/api/board/${boardId}/scene`, {
        method: 'PUT',
        body: {
          engine: 'excalidraw',
          sceneVersion: 1,
          expectedRevision: 0,
          scene: scene([assetId]),
        },
      })
      expect(saved.status).toBe(200)
    }

    expect((await request(`/api/board/${first.metadata.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await request(`/api/board/${first.metadata.id}`)).status).toBe(404)
    expect((await request(`/api/assets/${assetId}`)).status).toBe(200)

    expect((await request(`/api/board/${second.metadata.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await request(`/api/board/${second.metadata.id}`)).status).toBe(404)
    expect((await request(`/api/assets/${assetId}`)).status).toBe(404)
  })
})

describe('Asset HTTP API', () => {
  it.each([
    ['image/png', PNG_A],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
    ['image/avif', AVIF],
    ['image/svg+xml', SVG],
  ] as const)('accepts a valid %s signature and returns exact bytes', async (mimeType, data) => {
    const assetId = randomUUID()
    const uploaded = await uploadAsset(assetId, data, `${mimeType}; charset=binary`)
    expect(uploaded.status).toBe(200)
    const metadata = await responseJson<Record<string, unknown>>(uploaded)
    expect(metadata).toMatchObject({
      id: assetId,
      mimeType,
      byteSize: data.byteLength,
    })
    expect(metadata).not.toHaveProperty('storageKey')
    expect(metadata).not.toHaveProperty('createdAt')

    const read = await request(`/api/assets/${assetId}`)
    expect(read.status).toBe(200)
    expect(read.headers.get('Content-Type')).toBe(mimeType)
    expect(read.headers.get('Content-Length')).toBe(String(data.byteLength))
    expect(read.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
    expect(read.headers.get('ETag')).toMatch(/^"[0-9a-f]{64}"$/)
    if (mimeType === 'image/svg+xml') {
      expect(read.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:")
    } else {
      expect(read.headers.get('Content-Security-Policy')).toBeNull()
    }
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array(data))
  })

  it('cleans only unreferenced Assets and treats missing Assets as already clean', async () => {
    const orphanId = randomUUID()
    expect((await uploadAsset(orphanId)).status).toBe(200)
    expect((await request(`/api/assets/${orphanId}/unreferenced`, { method: 'DELETE' })).status).toBe(204)
    expect((await request(`/api/assets/${orphanId}`)).status).toBe(404)
    expect((await request(`/api/assets/${orphanId}/unreferenced`, { method: 'DELETE' })).status).toBe(204)

    const sceneBoard = await createBoard({ title: 'Referenced scene asset' })
    const sceneAssetId = randomUUID()
    expect((await uploadAsset(sceneAssetId)).status).toBe(200)
    expect((await request(`/api/board/${sceneBoard.metadata.id}/scene`, {
      method: 'PUT',
      body: { engine: 'excalidraw', sceneVersion: 1, expectedRevision: 0, scene: scene([sceneAssetId]) },
    })).status).toBe(200)
    expect((await request(`/api/assets/${sceneAssetId}/unreferenced`, { method: 'DELETE' })).status).toBe(204)
    expect((await request(`/api/assets/${sceneAssetId}`)).status).toBe(200)

    const thumbnailBoard = await createBoard({ title: 'Referenced thumbnail asset' })
    const thumbnailAssetId = randomUUID()
    expect((await uploadAsset(thumbnailAssetId, PNG_B)).status).toBe(200)
    expect((await request(`/api/board/${thumbnailBoard.metadata.id}/thumbnail`, {
      method: 'PUT',
      body: { assetId: thumbnailAssetId },
    })).status).toBe(200)
    expect((await request(`/api/assets/${thumbnailAssetId}/unreferenced`, { method: 'DELETE' })).status).toBe(204)
    expect((await request(`/api/assets/${thumbnailAssetId}`)).status).toBe(200)
  })

  it('rejects invalid IDs before persistence', async () => {
    const persist = vi.spyOn(boards.assets, 'persistAsset')
    const response = await request('/api/assets/not-a-uuid', {
      method: 'PUT',
      body: PNG_A,
      headers: { 'Content-Type': 'image/png' },
    })
    expect(response.status).toBe(400)
    expect(await responseJson(response)).toMatchObject({ code: 'INVALID_ASSET_ID' })
    expect(persist).not.toHaveBeenCalled()
    persist.mockRestore()
  })

  it('rejects MIME mismatches, unsupported MIME types, and empty bodies', async () => {
    const mismatch = await uploadAsset(randomUUID(), JPEG, 'image/png')
    expect(mismatch.status).toBe(415)
    expect(await responseJson(mismatch)).toMatchObject({ code: 'ASSET_MIME_MISMATCH' })

    const svgMismatch = await uploadAsset(randomUUID(), Buffer.from('plain text, not SVG'), 'image/svg+xml')
    expect(svgMismatch.status).toBe(415)
    expect(await responseJson(svgMismatch)).toMatchObject({ code: 'ASSET_MIME_MISMATCH' })

    const unsupported = await uploadAsset(randomUUID(), PNG_A, 'image/bmp')
    expect(unsupported.status).toBe(415)
    expect(await responseJson(unsupported)).toMatchObject({ code: 'UNSUPPORTED_ASSET_MIME' })

    const empty = await uploadAsset(randomUUID(), Buffer.alloc(0), 'image/png')
    expect(empty.status).toBe(400)
    expect(await responseJson(empty)).toMatchObject({ code: 'ASSET_EMPTY_BODY' })
  })

  it('supports idempotent replay but never overwrites different content', async () => {
    const assetId = randomUUID()
    const first = await uploadAsset(assetId, PNG_A)
    const firstBody = await responseJson(first)
    expect(first.status).toBe(200)

    const replay = await uploadAsset(assetId, PNG_A, 'image/png')
    expect(replay.status).toBe(200)
    expect(await responseJson(replay)).toEqual(firstBody)

    const conflict = await uploadAsset(assetId, PNG_B)
    expect(conflict.status).toBe(409)
    expect(await responseJson(conflict)).toMatchObject({ code: 'ASSET_ID_CONFLICT' })
    expect(new Uint8Array(await (await request(`/api/assets/${assetId}`)).arrayBuffer())).toEqual(new Uint8Array(PNG_A))
  })

  it('rejects known and unknown oversized request bodies before persistence', async () => {
    const knownId = randomUUID()
    const known = await uploadAsset(knownId, PNG_A, 'image/png', {
      'Content-Length': String(BOARD_ASSET_MAX_BYTES + 1),
    })
    expect(known.status).toBe(413)
    expect(await responseJson(known)).toMatchObject({ code: 'ASSET_TOO_LARGE' })
    expect(boards.assets.getAssetMetadata(knownId)).toBeNull()

    const unknownId = randomUUID()
    const unknownBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(BOARD_ASSET_MAX_BYTES))
        controller.enqueue(new Uint8Array([0]))
        controller.close()
      },
    })
    const unknown = await uploadAsset(unknownId, unknownBody, 'image/png')
    expect(unknown.status).toBe(413)
    expect(await responseJson(unknown)).toMatchObject({ code: 'ASSET_TOO_LARGE' })
    expect(boards.assets.getAssetMetadata(unknownId)).toBeNull()
  })

  it('keeps an orphan binary fail-closed at the HTTP boundary', async () => {
    const assetId = randomUUID()
    await storage.createAssetBinary(assetId, PNG_A)

    const response = await uploadAsset(assetId, PNG_A)
    expect(response.status).toBe(409)
    expect(await responseJson(response)).toMatchObject({ code: 'ASSET_BINARY_CONFLICT' })
    expect(boards.assets.getAssetMetadata(assetId)).toBeNull()
    expect(await fs.readFile(storage.pathForAssetId(assetId))).toEqual(PNG_A)
  })

  it('fails closed when GET finds metadata without a physical binary', async () => {
    const assetId = randomUUID()
    expect((await uploadAsset(assetId)).status).toBe(200)
    await fs.unlink(storage.pathForAssetId(assetId))

    const response = await request(`/api/assets/${assetId}`)
    expect(response.status).toBe(500)
    const body = await responseJson(response)
    expect(body).toEqual({ error: 'Asset binary is unavailable.', code: 'ASSET_BINARY_MISSING' })
    expect(JSON.stringify(body)).not.toContain(root)
  })

  it('returns success when post-commit Asset cleanup fails', async () => {
    const board = await createBoard()
    const assetId = randomUUID()
    expect((await uploadAsset(assetId)).status).toBe(200)
    expect((await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: { engine: 'excalidraw', sceneVersion: 1, expectedRevision: 0, scene: scene([assetId]) },
    })).status).toBe(200)

    __setDurableArtifactTestHooksForTesting({
      beforeDurableArtifactUnlink: () => { throw new Error('cleanup unavailable') },
    })
    const response = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: { engine: 'excalidraw', sceneVersion: 1, expectedRevision: 1, scene: scene([]) },
    })
    expect(response.status).toBe(200)
    const body = await responseJson(response)
    expect(body).toMatchObject({ revision: 2 })
    expect(body).not.toHaveProperty('cleanupFailures')
    expect(await responseJson(await request(`/api/board/${board.metadata.id}`))).toMatchObject({
      sceneRecord: { revision: 2, scene: { assetRefs: [] } },
    })
    expect((await request(`/api/assets/${assetId}`)).status).toBe(404)
    expect(await fs.readFile(storage.pathForAssetId(assetId))).toEqual(PNG_A)
  })

  it('maps malformed JSON and enforces the Scene JSON body limit before parsing', async () => {
    const board = await createBoard()
    const malformed = await request(`/api/board/${board.metadata.id}/thumbnail`, {
      method: 'PUT',
      body: '{not-json',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(malformed.status).toBe(400)
    expect(await responseJson(malformed)).toMatchObject({ code: 'INVALID_JSON' })

    const oversized = await request(`/api/board/${board.metadata.id}/scene`, {
      method: 'PUT',
      body: '{also-not-parsed',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(BOARD_SCENE_MAX_JSON_BYTES + 1),
      },
    })
    expect(oversized.status).toBe(413)
    expect(await responseJson(oversized)).toMatchObject({ code: 'BOARD_SCENE_TOO_LARGE' })
    const current = await responseJson<BoardJson>(await request(`/api/board/${board.metadata.id}`))
    expect(current.sceneRecord.revision).toBe(0)
  })
})
