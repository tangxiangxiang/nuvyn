import { isBoardAssetMimeType } from '../../../shared/assetProtocol'
import type { BoardScene } from '../../../shared/boardProtocol'
import type {
  BoardRuntimeAsset,
  ExcalidrawRuntimeScene,
  ResolvedBoardAsset,
} from './engine/types'
import {
  BOARD_ASSET_MAX_BYTES,
  BoardAssetError,
  fetchAssetBlob,
  uploadAsset,
  type BoardAssetErrorCode,
  type AssetUploadResult,
} from './assetClient'
import type { BoardCheckpointStore } from './checkpointStore'
import type { PendingBoardAsset } from './recoveryTypes'

export type BoardAssetState = 'pending' | 'uploading' | 'uploaded' | 'error'

interface SessionAssetRecord {
  readonly engineFileId: string
  readonly assetId: string
  mimeType: string
  blob?: Blob
  state: BoardAssetState
  pendingPromise: Promise<void> | null
  uploadPromise: Promise<AssetUploadResult> | null
  pendingDurable: boolean
  pendingError: unknown | null
  uploadError: unknown | null
}

export interface BoardAssetSessionOptions {
  boardId: string
  store: BoardCheckpointStore
  upload?: typeof uploadAsset
  fetch?: typeof fetchAssetBlob
  now?: () => number
  createAssetId?: () => string
  maxBytes?: number
}

export interface BoardAssetSession {
  seedScene(scene: BoardScene): void
  observeRuntimeAssets(assets: readonly BoardRuntimeAsset[]): Promise<void>
  ensureCheckpointAssetsDurable(runtimeScene: ExcalidrawRuntimeScene): Promise<void>
  ensureAssetReady(assetId: string): Promise<void>
  ensureSceneAssetsReady(scene: BoardScene): Promise<void>
  resolveSceneAssets(scene: BoardScene): Promise<ResolvedBoardAsset[]>
  getFileMap(): Readonly<Record<string, string>>
  dispose(): void
}

function isBlob(value: unknown): value is Blob {
  return Boolean(value)
    && typeof (value as Blob).size === 'number'
    && typeof (value as Blob).arrayBuffer === 'function'
}

function normalizeMimeType(value: string): string {
  return value.trim().toLowerCase()
}

interface AssetErrorContext {
  status?: number
  uncertain?: boolean
  assetId?: string
  engineFileId?: string
  mimeType?: string
  transient?: boolean
}

function assetError(
  code: BoardAssetErrorCode,
  message: string,
  cause?: unknown,
  context: AssetErrorContext = {},
): BoardAssetError {
  const { status = 500, ...options } = context
  return new BoardAssetError(code, message, status, { cause, ...options })
}

function activeImageFileIds(runtimeScene: ExcalidrawRuntimeScene): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const element of runtimeScene.elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue
    const value = element as { type?: unknown; isDeleted?: unknown; fileId?: unknown }
    if (value.type !== 'image' || value.isDeleted === true) continue
    if (typeof value.fileId !== 'string' || value.fileId.length === 0) {
      throw assetError('ASSET_PENDING_INVALID', 'Image element has no valid Excalidraw file ID.')
    }
    if (seen.has(value.fileId)) continue
    seen.add(value.fileId)
    result.push(value.fileId)
  }
  return result
}

function sceneFileMap(scene: BoardScene): Record<string, string> {
  const engineData = scene.engineData
  if (!engineData || typeof engineData !== 'object' || Array.isArray(engineData)) {
    throw assetError('ASSET_PENDING_INVALID', 'Board scene engine data is invalid.')
  }
  const value = (engineData as { fileMap?: unknown }).fileMap
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw assetError('ASSET_PENDING_INVALID', 'Board scene file map is invalid.')
  }
  const result: Record<string, string> = {}
  for (const [engineFileId, assetId] of Object.entries(value)) {
    if (!engineFileId || typeof assetId !== 'string' || assetId.length === 0) {
      throw assetError('ASSET_PENDING_INVALID', 'Board scene file map contains an invalid mapping.')
    }
    result[engineFileId] = assetId
  }
  return result
}

function sceneAssetRefs(scene: BoardScene, fileMap: Readonly<Record<string, string>>): Set<string> {
  if (!Array.isArray(scene.assetRefs)) {
    throw assetError('ASSET_PENDING_INVALID', 'Board scene asset references are invalid.')
  }
  const expected = [...new Set(Object.values(fileMap))]
  const actual = [...scene.assetRefs]
  if (actual.length !== expected.length || expected.some((assetId) => !scene.assetRefs.includes(assetId))) {
    throw assetError('ASSET_PENDING_INVALID', 'Board scene asset references do not match its file map.')
  }
  return new Set(actual)
}

function validatePendingAsset(
  pending: PendingBoardAsset,
  boardId: string,
  assetId: string,
  engineFileIds: readonly string[],
  maxBytes: number,
): void {
  if (pending.assetId !== assetId || pending.boardId !== boardId
    || typeof pending.engineFileId !== 'string'
    || !engineFileIds.includes(pending.engineFileId)
    || typeof pending.mimeType !== 'string'
    || !isBoardAssetMimeType(normalizeMimeType(pending.mimeType))
    || !isBlob(pending.blob)
    || pending.blob.size <= 0
    || pending.blob.size > maxBytes
    || typeof pending.createdAt !== 'number'
    || !Number.isFinite(pending.createdAt)
    || pending.createdAt < 0) {
    throw assetError('ASSET_PENDING_INVALID', `Pending asset ${assetId} does not match the current Board scene.`)
  }
}

export function createBoardAssetSession(options: BoardAssetSessionOptions): BoardAssetSession {
  const upload = options.upload ?? uploadAsset
  const fetch = options.fetch ?? fetchAssetBlob
  const now = options.now ?? Date.now
  const maxBytes = options.maxBytes ?? BOARD_ASSET_MAX_BYTES
  const createAssetId = options.createAssetId ?? (() => {
    const id = globalThis.crypto?.randomUUID?.()
    if (!id) throw assetError('ASSET_UPLOAD_FAILED', 'The browser cannot create a Board asset ID.')
    return id
  })

  const recordsByFileId = new Map<string, SessionAssetRecord>()
  const recordsByAssetId = new Map<string, SessionAssetRecord>()
  let disposed = false

  function getFileMap(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(
      [...recordsByFileId.entries()].map(([engineFileId, record]) => [engineFileId, record.assetId]),
    ))
  }

  function seedScene(scene: BoardScene): void {
    if (disposed) return
    const fileMap = sceneFileMap(scene)
    sceneAssetRefs(scene, fileMap)
    for (const [engineFileId, assetId] of Object.entries(fileMap)) {
      const existing = recordsByFileId.get(engineFileId)
      if (existing && existing.assetId !== assetId) {
        throw assetError('ASSET_PENDING_INVALID', `Excalidraw file ID ${engineFileId} changed asset identity.`)
      }
      const record = existing ?? {
        engineFileId,
        assetId,
        mimeType: '',
        state: 'pending' as const,
        pendingPromise: null,
        uploadPromise: null,
        pendingDurable: false,
        pendingError: null,
        uploadError: null,
      }
      recordsByFileId.set(engineFileId, record)
      const byAssetId = recordsByAssetId.get(assetId)
      if (byAssetId && byAssetId.engineFileId !== engineFileId) {
        // A shared server asset is valid, but a PendingBoardAsset can only
        // describe one engine file. Resolution validates that boundary.
        recordsByAssetId.set(assetId, byAssetId)
      } else {
        recordsByAssetId.set(assetId, record)
      }
    }
  }

  function ensureRecordForRuntimeAsset(asset: BoardRuntimeAsset): SessionAssetRecord {
    if (!asset || typeof asset.engineFileId !== 'string' || asset.engineFileId.length === 0) {
      throw assetError('ASSET_PENDING_INVALID', 'Runtime image is missing its Excalidraw file ID.')
    }
    const mimeType = normalizeMimeType(asset.mimeType)
    if (!isBlob(asset.blob) || asset.blob.size <= 0) {
      throw assetError('ASSET_EMPTY_BODY', `Runtime image ${asset.engineFileId} has no data.`, undefined, {
        status: 400,
        uncertain: false,
        engineFileId: asset.engineFileId,
        mimeType,
      })
    }
    if (asset.blob.size > maxBytes) {
      throw assetError('ASSET_TOO_LARGE', `Runtime image ${asset.engineFileId} exceeds the Board asset limit.`, undefined, {
        status: 413,
        uncertain: false,
        engineFileId: asset.engineFileId,
        mimeType,
      })
    }
    if (!isBoardAssetMimeType(mimeType)) {
      throw assetError('UNSUPPORTED_ASSET_MIME', `Runtime image ${asset.engineFileId} uses an unsupported MIME type.`, undefined, {
        status: 415,
        uncertain: false,
        engineFileId: asset.engineFileId,
        mimeType,
      })
    }

    const existing = recordsByFileId.get(asset.engineFileId)
    if (existing) {
      if (existing.mimeType && existing.mimeType !== mimeType) {
        throw assetError('ASSET_ID_CONFLICT', `Excalidraw file ID ${asset.engineFileId} changed MIME type.`)
      }
      existing.mimeType = mimeType
      existing.blob ??= asset.blob
      return existing
    }

    const assetId = createAssetId()
    const existingAsset = recordsByAssetId.get(assetId)
    if (existingAsset && existingAsset.engineFileId !== asset.engineFileId) {
      throw assetError('ASSET_ID_CONFLICT', `Generated asset ID ${assetId} is already assigned to another image.`)
    }
    const record: SessionAssetRecord = {
      engineFileId: asset.engineFileId,
      assetId,
      mimeType,
      blob: asset.blob,
      state: 'pending',
      pendingPromise: null,
      uploadPromise: null,
      pendingDurable: false,
      pendingError: null,
      uploadError: null,
    }
    recordsByFileId.set(record.engineFileId, record)
    recordsByAssetId.set(record.assetId, record)
    return record
  }

  function persistPending(record: SessionAssetRecord): Promise<void> {
    if (record.pendingPromise) return record.pendingPromise
    if (!record.blob || !isBlob(record.blob)) {
      const error = assetError('ASSET_PENDING_INVALID', `Runtime asset ${record.assetId} has no Blob.`)
      record.pendingDurable = false
      record.pendingError = error
      return Promise.reject(error)
    }
    record.pendingDurable = false
    record.pendingError = null
    const pending: PendingBoardAsset = {
      assetId: record.assetId,
      boardId: options.boardId,
      engineFileId: record.engineFileId,
      mimeType: record.mimeType,
      blob: record.blob,
      createdAt: now(),
    }
    let write: Promise<void>
    try {
      write = Promise.resolve(options.store.putPendingAsset(pending))
    } catch (error) {
      write = Promise.reject(error)
    }
    const pendingPromise = write.then(
      () => {
        record.pendingDurable = true
        record.pendingError = null
      },
      (error: unknown) => {
        if (record.pendingPromise === pendingPromise) record.pendingPromise = null
        const pendingError = assetError(
          'ASSET_PENDING_INVALID',
          `Pending asset ${record.assetId} could not be stored locally.`,
          error,
        )
        record.pendingDurable = false
        record.pendingError = pendingError
        throw pendingError
      },
    )
    record.pendingPromise = pendingPromise
    void pendingPromise.then(
      () => {
        if (!disposed) void startUpload(record).catch(() => {})
      },
      () => {},
    )
    return pendingPromise
  }

  async function startUpload(record: SessionAssetRecord): Promise<AssetUploadResult> {
    if (record.uploadPromise) return record.uploadPromise
    if (record.state === 'uploaded') {
      return {
        id: record.assetId,
        mimeType: record.mimeType as AssetUploadResult['mimeType'],
        byteSize: record.blob?.size ?? 0,
        sha256: '',
      }
    }
    if (record.pendingPromise) {
      const pendingPromise = record.pendingPromise
      await pendingPromise
      if (record.pendingPromise === pendingPromise) record.pendingPromise = null
      if (record.uploadPromise) return record.uploadPromise
    }
    if (!record.blob) {
      const error = assetError('ASSET_PENDING_INVALID', `Pending asset ${record.assetId} has no Blob.`)
      record.pendingDurable = false
      record.pendingError = error
      throw error
    }

    record.state = 'uploading'
    record.uploadError = null
    const blob = record.blob
    const uploadPromise = (async () => {
      try {
        const result = await upload(record.assetId, record.mimeType, blob!)
        record.state = 'uploaded'
        record.uploadError = null
        try {
          await options.store.deletePendingAsset(record.assetId)
        } catch {
          // Server Asset is now the source of truth. A redundant local Blob
          // must never turn a successful upload into a failed scene save.
        }
        return result
      } catch (error) {
        record.state = 'error'
        // A remote upload failure is recoverable as long as the Pending Blob
        // remains durable. Checkpoint readiness must not treat this as a
        // local persistence failure.
        record.uploadError = error
        throw error
      } finally {
        if (disposed) record.blob = undefined
        record.uploadPromise = null
      }
    })()
    record.uploadPromise = uploadPromise
    void uploadPromise.catch(() => {})
    return uploadPromise
  }

  async function observeRuntimeAssets(assets: readonly BoardRuntimeAsset[]): Promise<void> {
    if (disposed) return
    const pendingWrites: Promise<void>[] = []
    for (const asset of assets) {
      const record = ensureRecordForRuntimeAsset(asset)
      if (record.state !== 'uploaded' && !record.pendingDurable) pendingWrites.push(persistPending(record))
    }
    await Promise.all(pendingWrites)
  }

  /**
   * Checkpoint readiness is deliberately local-only. A failed remote upload
   * leaves a durable Pending Blob behind and must not discard the local Scene
   * mutation; only a Pending persistence failure makes the Scene unsafe to
   * checkpoint.
   */
  async function ensureCheckpointAssetsDurable(runtimeScene: ExcalidrawRuntimeScene): Promise<void> {
    if (disposed) return
    const fileIds = activeImageFileIds(runtimeScene)
    await Promise.all(fileIds.map(async (engineFileId) => {
      const record = recordsByFileId.get(engineFileId)
      if (!record) {
        throw assetError('ASSET_PENDING_INVALID', `Image file ID ${engineFileId} has no Nuvyn asset mapping.`)
      }
      if (record.pendingPromise) await record.pendingPromise
      if (record.state === 'uploaded' || record.pendingDurable) return
      if (record.pendingError) throw record.pendingError
      throw assetError('ASSET_PENDING_INVALID', `Pending asset ${record.assetId} is not durable locally.`)
    }))
  }

  async function loadPendingForAsset(
    assetId: string,
    engineFileIds: readonly string[],
  ): Promise<PendingBoardAsset> {
    let pending: PendingBoardAsset | null
    try {
      pending = await options.store.getPendingAsset(assetId)
    } catch (error) {
      throw assetError('ASSET_PENDING_INVALID', `Pending asset ${assetId} could not be read.`, error)
    }
    if (!pending) throw assetError('ASSET_MISSING', `Asset ${assetId} is missing on the Server and locally.`)
    validatePendingAsset(pending, options.boardId, assetId, engineFileIds, maxBytes)
    return pending
  }

  async function ensureAssetReady(assetId: string): Promise<void> {
    if (disposed) return
    const record = recordsByAssetId.get(assetId)
    if (!record) {
      throw assetError('ASSET_UPLOAD_FAILED', `Asset ${assetId} is not registered in this Board session.`)
    }
    if (record.state === 'uploaded') return
    if (record.pendingPromise) await record.pendingPromise
    if (!record.pendingDurable) await persistPending(record)
    await startUpload(record)
  }

  async function ensureSceneAssetsReady(scene: BoardScene): Promise<void> {
    if (disposed) return
    const fileMap = sceneFileMap(scene)
    const assets = sceneAssetRefs(scene, fileMap)
    await Promise.all([...assets].map(async (assetId) => {
      let record = recordsByAssetId.get(assetId)
      if (!record) {
        const engineFileIds = Object.entries(fileMap)
          .filter(([, mappedAssetId]) => mappedAssetId === assetId)
          .map(([engineFileId]) => engineFileId)
        const pending = await loadPendingForAsset(assetId, engineFileIds)
        record = {
          engineFileId: pending.engineFileId,
          assetId,
          mimeType: normalizeMimeType(pending.mimeType),
          blob: pending.blob,
          state: 'pending',
          pendingPromise: null,
          uploadPromise: null,
          pendingDurable: true,
          pendingError: null,
          uploadError: null,
        }
        recordsByFileId.set(record.engineFileId, record)
        recordsByAssetId.set(assetId, record)
      }
      await ensureAssetReady(record.assetId)
    }))
  }

  async function resolveSceneAssets(scene: BoardScene): Promise<ResolvedBoardAsset[]> {
    if (disposed) return []
    seedScene(scene)
    const fileMap = sceneFileMap(scene)
    sceneAssetRefs(scene, fileMap)
    const fileIdsByAssetId = new Map<string, string[]>()
    for (const [engineFileId, assetId] of Object.entries(fileMap)) {
      const fileIds = fileIdsByAssetId.get(assetId) ?? []
      fileIds.push(engineFileId)
      fileIdsByAssetId.set(assetId, fileIds)
    }

    const resolvedByAssetId = new Map<string, Promise<{ blob: Blob; mimeType: string }>>()
    const resolveAsset = (assetId: string, engineFileIds: readonly string[]): Promise<{ blob: Blob; mimeType: string }> => {
      const existing = resolvedByAssetId.get(assetId)
      if (existing) return existing
      const resolution = (async () => {
        try {
          const blob = await fetch(assetId)
          const mimeType = normalizeMimeType(blob.type)
          if (!isBoardAssetMimeType(mimeType) || blob.size <= 0 || blob.size > maxBytes) {
            throw assetError('ASSET_RESOLVE_FAILED', `Server asset ${assetId} returned invalid binary data.`)
          }
          for (const engineFileId of engineFileIds) {
            const record = recordsByFileId.get(engineFileId)
            if (record) {
              record.mimeType = mimeType
              record.blob = blob
              record.state = 'uploaded'
              record.pendingDurable = false
              record.pendingError = null
              record.uploadError = null
            }
          }
          try {
            const pending = await options.store.getPendingAsset(assetId)
            if (pending?.boardId === options.boardId) await options.store.deletePendingAsset(assetId)
          } catch {
            // A server hit is enough to open the Board; local cleanup is
            // deliberately best effort.
          }
          return { blob, mimeType }
        } catch (error) {
          if (!(error instanceof BoardAssetError) || error.code !== 'ASSET_MISSING') throw error
          const pending = await loadPendingForAsset(assetId, engineFileIds)
          const recordForUpload = recordsByFileId.get(pending.engineFileId)
          if (!recordForUpload) {
            throw assetError('ASSET_PENDING_INVALID', `Pending asset ${assetId} has no matching runtime mapping.`)
          }
          recordForUpload.mimeType = normalizeMimeType(pending.mimeType)
          recordForUpload.blob = pending.blob
          recordForUpload.state = 'pending'
          recordForUpload.pendingPromise = null
          recordForUpload.pendingDurable = true
          recordForUpload.pendingError = null
          recordForUpload.uploadError = null
          await startUpload(recordForUpload)
          for (const engineFileId of engineFileIds) {
            const record = recordsByFileId.get(engineFileId)
            if (record) {
              record.mimeType = recordForUpload.mimeType
              record.blob = pending.blob
              record.state = 'uploaded'
              record.pendingDurable = true
              record.pendingError = null
              record.uploadError = null
            }
          }
          return { blob: pending.blob, mimeType: recordForUpload.mimeType }
        }
      })()
      resolvedByAssetId.set(assetId, resolution)
      return resolution
    }

    const resolved = await Promise.all(Object.entries(fileMap).map(async ([engineFileId, assetId]) => {
      const value = await resolveAsset(assetId, fileIdsByAssetId.get(assetId) ?? [engineFileId])
      return {
        assetId,
        engineFileId,
        mimeType: value.mimeType,
        blob: value.blob,
      } satisfies ResolvedBoardAsset
    }))
    return resolved
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const record of recordsByFileId.values()) record.blob = undefined
    // A checkpoint scheduler may still be draining a serialized runtime
    // snapshot after the route has left. Keep the lightweight file mapping
    // available to that serializer; the detached session becomes collectible
    // once the durable operation completes, while no new runtime work is
    // accepted after this point.
  }

  return {
    seedScene,
    observeRuntimeAssets,
    ensureCheckpointAssetsDurable,
    ensureAssetReady,
    ensureSceneAssetsReady,
    resolveSceneAssets,
    getFileMap,
    dispose,
  }
}
