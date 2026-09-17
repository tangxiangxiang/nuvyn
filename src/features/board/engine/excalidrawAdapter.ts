import type { BinaryFileData, DataURL } from '@excalidraw/excalidraw/types'
import type { FileId } from '@excalidraw/excalidraw/element/types'
import {
  BOARD_ENGINE_EXCALIDRAW,
  CURRENT_BOARD_SCENE_VERSION,
  type BoardPersistentAppState,
  type BoardScene,
} from '../../../../shared/boardProtocol'
import {
  BoardEngineCompatibilityError,
  type BoardEngineAdapter,
  type ExcalidrawRuntimeScene,
  type ResolvedBoardAsset,
} from './types'
import {
  EXCALIDRAW_THUMBNAIL_MAX_EDGE,
  exportExcalidrawPng,
  exportExcalidrawSvg,
} from './excalidraw/export'

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is RecordValue {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(message: string): never {
  throw new BoardEngineCompatibilityError('BOARD_SCENE_INVALID', message)
}

function finiteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${field} must be a finite number`)
  return value
}

function validatePersistentAppState(value: unknown): BoardPersistentAppState {
  if (!isPlainRecord(value)) invalid('persistentAppState must be a plain object')
  const allowed = new Set(['zoom', 'scrollX', 'scrollY', 'gridSize', 'viewBackgroundColor'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`Unsupported persistentAppState field: ${key}`)
  }
  const state: BoardPersistentAppState = {}
  const zoom = finiteNumber(value.zoom, 'persistentAppState.zoom')
  const scrollX = finiteNumber(value.scrollX, 'persistentAppState.scrollX')
  const scrollY = finiteNumber(value.scrollY, 'persistentAppState.scrollY')
  const gridSize = value.gridSize
  if (zoom !== undefined) state.zoom = zoom
  if (scrollX !== undefined) state.scrollX = scrollX
  if (scrollY !== undefined) state.scrollY = scrollY
  if (gridSize !== undefined) {
    if (gridSize !== null && (typeof gridSize !== 'number' || !Number.isFinite(gridSize))) {
      invalid('persistentAppState.gridSize must be a finite number or null')
    }
    state.gridSize = gridSize as number | null
  }
  if (value.viewBackgroundColor !== undefined) {
    if (typeof value.viewBackgroundColor !== 'string') invalid('persistentAppState.viewBackgroundColor must be a string')
    state.viewBackgroundColor = value.viewBackgroundColor
  }
  return state
}

function imageFileIds(elements: readonly unknown[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const element of elements) {
    if (!isRecord(element) || element.type !== 'image' || element.isDeleted === true) continue
    if (typeof element.fileId !== 'string' || element.fileId.length === 0) {
      invalid('Non-deleted image elements must reference an Excalidraw file ID')
    }
    if (seen.has(element.fileId)) continue
    seen.add(element.fileId)
    result.push(element.fileId)
  }
  return result
}

function validateScene(scene: BoardScene): {
  elements: readonly unknown[]
  fileMap: RecordValue
  persistentAppState: BoardPersistentAppState
  assetRefs: readonly string[]
  imageFileIds: readonly string[]
} {
  if (!isRecord(scene)) invalid('Board scene must be an object')
  const engineData = scene.engineData
  if (!isPlainRecord(engineData)) invalid('engineData must be a plain object')
  if (!Array.isArray(engineData.elements)) invalid('engineData.elements must be an array')
  if (!isPlainRecord(engineData.fileMap)) invalid('engineData.fileMap must be a plain object')
  if (!Array.isArray(scene.assetRefs)) invalid('assetRefs must be an array')

  const assetRefs: string[] = []
  const seenAssetRefs = new Set<string>()
  for (const assetRef of scene.assetRefs) {
    if (typeof assetRef !== 'string' || assetRef.length === 0) invalid('assetRefs must contain non-empty strings')
    if (seenAssetRefs.has(assetRef)) invalid('assetRefs must be unique')
    seenAssetRefs.add(assetRef)
    assetRefs.push(assetRef)
  }

  const fileMap: RecordValue = {}
  const fileMapAssetRefs: string[] = []
  for (const [fileId, assetRef] of Object.entries(engineData.fileMap)) {
    if (typeof assetRef !== 'string' || assetRef.length === 0) invalid(`fileMap.${fileId} must be a non-empty Asset ID`)
    fileMap[fileId] = assetRef
    if (!fileMapAssetRefs.includes(assetRef)) fileMapAssetRefs.push(assetRef)
  }
  if (fileMapAssetRefs.length !== assetRefs.length || fileMapAssetRefs.some((assetRef) => !seenAssetRefs.has(assetRef))) {
    invalid('assetRefs must equal the unique values of engineData.fileMap')
  }

  const requiredImageFileIds = imageFileIds(engineData.elements)
  for (const fileId of requiredImageFileIds) {
    if (!Object.prototype.hasOwnProperty.call(fileMap, fileId)) {
      invalid(`Image element ${fileId} has no fileMap asset mapping`)
    }
  }
  for (const fileId of Object.keys(fileMap)) {
    if (!requiredImageFileIds.includes(fileId)) {
      invalid(`fileMap contains an unused Excalidraw file ID: ${fileId}`)
    }
  }

  return {
    elements: engineData.elements,
    fileMap,
    persistentAppState: validatePersistentAppState(scene.persistentAppState),
    assetRefs,
    imageFileIds: requiredImageFileIds,
  }
}

function runtimeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (isRecord(value) && typeof value.value === 'number' && Number.isFinite(value.value)) return value.value
  invalid(`${field} must be a finite number or a runtime zoom object`)
}

function persistentAppStateFromRuntime(value: unknown): BoardPersistentAppState {
  if (!isPlainRecord(value)) invalid('runtime appState must be a plain object')
  const state: BoardPersistentAppState = {}
  const zoom = runtimeNumber(value.zoom, 'runtime appState.zoom')
  const scrollX = finiteNumber(value.scrollX, 'runtime appState.scrollX')
  const scrollY = finiteNumber(value.scrollY, 'runtime appState.scrollY')
  const gridSize = value.gridSize
  if (zoom !== undefined) state.zoom = zoom
  if (scrollX !== undefined) state.scrollX = scrollX
  if (scrollY !== undefined) state.scrollY = scrollY
  if (gridSize !== undefined) {
    if (gridSize !== null && (typeof gridSize !== 'number' || !Number.isFinite(gridSize))) {
      invalid('runtime appState.gridSize must be a finite number or null')
    }
    state.gridSize = gridSize as number | null
  }
  if (value.viewBackgroundColor !== undefined) {
    if (typeof value.viewBackgroundColor !== 'string') invalid('runtime appState.viewBackgroundColor must be a string')
    state.viewBackgroundColor = value.viewBackgroundColor
  }
  return state
}

function exportableRuntime(runtime: ExcalidrawRuntimeScene): ExcalidrawRuntimeScene {
  if (!isRecord(runtime)) invalid('runtime scene must be an object')
  if (!Array.isArray(runtime.elements)) invalid('runtime elements must be an array')
  if (!isPlainRecord(runtime.files)) invalid('runtime files must be a plain object')
  if (!isPlainRecord(runtime.appState)) invalid('runtime appState must be a plain object')
  return runtime
}

function fingerprintValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return String(value)
  if (Array.isArray(value)) return `[${value.map(fingerprintValue).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${key}:${fingerprintValue(value[key])}`).join(',')}}`
  return String(value)
}

/**
 * A cheap persistence-only signal for high-frequency Excalidraw changes.
 * This deliberately does not serialize a BoardScene or stringify binary
 * image data. Full domain serialization happens only when a save is captured.
 */
export function runtimePersistenceFingerprint(runtime: ExcalidrawRuntimeScene): string {
  // Element styling and binding fields are persisted too. A hand-picked
  // subset can silently treat a real edit (for example a color or font
  // change) as a no-op and skip the save entirely, so fingerprint the full
  // JSON-shaped element collection while still excluding BinaryFile data.
  const elements = fingerprintValue(runtime.elements)
  const appState = runtime.appState
  const zoom = isRecord(appState.zoom) ? appState.zoom.value : appState.zoom
  // Excalidraw fills these defaults into its first onChange payload even
  // when the hydrated domain scene omitted them. Treating them as absent
  // keeps initial hydration from becoming a false user mutation.
  const persistentAppState = fingerprintValue({
    zoom: zoom === 1 ? undefined : zoom,
    scrollX: appState.scrollX === 0 ? undefined : appState.scrollX,
    scrollY: appState.scrollY === 0 ? undefined : appState.scrollY,
    gridSize: appState.gridSize === 20 ? undefined : appState.gridSize,
    viewBackgroundColor: appState.viewBackgroundColor === '#ffffff' ? undefined : appState.viewBackgroundColor,
  })
  const files = Object.keys(runtime.files).sort().join('|')
  return `${elements}#${persistentAppState}#${files}`
}

export function assertSupportedExcalidrawScene(engine: unknown, sceneVersion: unknown): void {
  if (engine !== BOARD_ENGINE_EXCALIDRAW) {
    throw new BoardEngineCompatibilityError('BOARD_ENGINE_UNSUPPORTED', `Unsupported Board engine: ${String(engine)}`)
  }
  if (sceneVersion !== CURRENT_BOARD_SCENE_VERSION) {
    throw new BoardEngineCompatibilityError(
      'BOARD_SCENE_VERSION_UNSUPPORTED',
      `Unsupported Board scene version: ${String(sceneVersion)}`,
    )
  }
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa !== 'function') throw new Error('Browser base64 support is unavailable')
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function blobToDataUrl(blob: Blob, mimeType: string): Promise<DataURL> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return `data:${mimeType};base64,${toBase64(bytes)}` as DataURL
}

function binaryFile(
  asset: ResolvedBoardAsset,
  dataURL: DataURL,
): BinaryFileData {
  const retrievedAt = Date.now()
  return {
    id: asset.engineFileId as FileId,
    dataURL,
    mimeType: asset.mimeType as BinaryFileData['mimeType'],
    created: retrievedAt,
    lastRetrieved: retrievedAt,
  }
}

export const excalidrawAdapter: BoardEngineAdapter<ExcalidrawRuntimeScene> = {
  validate(scene) {
    validateScene(scene)
  },

  async hydrate(scene, resolvedAssets = []) {
    const validated = validateScene(scene)
    const resolvedByFileId = new Map<string, ResolvedBoardAsset>()
    for (const asset of resolvedAssets) {
      if (resolvedByFileId.has(asset.engineFileId)) invalid(`Duplicate resolved asset for ${asset.engineFileId}`)
      resolvedByFileId.set(asset.engineFileId, asset)
    }
    if (resolvedByFileId.size !== Object.keys(validated.fileMap).length) {
      invalid('Every persisted image file must have exactly one resolved asset')
    }

    const files: Record<string, BinaryFileData> = {}
    for (const [engineFileId, assetId] of Object.entries(validated.fileMap)) {
      const asset = resolvedByFileId.get(engineFileId)
      if (!asset || asset.assetId !== assetId || !asset.blob || asset.blob.size <= 0) {
        invalid(`Resolved asset is missing for Excalidraw file ID ${engineFileId}`)
      }
      const dataURL = await blobToDataUrl(asset.blob, asset.mimeType)
      files[engineFileId] = binaryFile(asset, dataURL)
    }

    const appState: Record<string, unknown> = {}
    if (validated.persistentAppState.zoom !== undefined) {
      // Excalidraw 0.18.1 represents zoom as { value }, while the Nuvyn
      // domain intentionally stores the portable numeric value.
      appState.zoom = { value: validated.persistentAppState.zoom }
    }
    for (const key of ['scrollX', 'scrollY', 'gridSize', 'viewBackgroundColor'] as const) {
      const value = validated.persistentAppState[key]
      if (value !== undefined) appState[key] = value
    }
    return {
      elements: [...validated.elements],
      appState,
      files,
    }
  },

  serialize(runtime, mapping = {}) {
    if (!isRecord(runtime)) invalid('runtime scene must be an object')
    if (!Array.isArray(runtime.elements)) invalid('runtime elements must be an array')
    if (!isPlainRecord(runtime.files)) invalid('runtime files must be a plain object')
    if (!isPlainRecord(mapping)) invalid('runtime asset mapping must be a plain object')

    const requiredFileIds = imageFileIds(runtime.elements)
    const fileMap: Record<string, string> = {}
    const assetRefs: string[] = []
    const seenAssetRefs = new Set<string>()
    for (const engineFileId of requiredFileIds) {
      const assetId = mapping[engineFileId]
      if (typeof assetId !== 'string' || assetId.length === 0) {
        invalid(`Image element ${engineFileId} has no Nuvyn asset mapping`)
      }
      if (!Object.prototype.hasOwnProperty.call(runtime.files, engineFileId)) {
        invalid(`Runtime BinaryFile is missing for Excalidraw file ID ${engineFileId}`)
      }
      fileMap[engineFileId] = assetId
      if (!seenAssetRefs.has(assetId)) {
        seenAssetRefs.add(assetId)
        assetRefs.push(assetId)
      }
    }

    return {
      engineData: {
        elements: [...runtime.elements],
        fileMap,
      },
      persistentAppState: persistentAppStateFromRuntime(runtime.appState),
      assetRefs,
    }
  },

  async generateThumbnail(runtime) {
    const prepared = exportableRuntime(runtime)
    if (prepared.elements.every((element) => !isRecord(element) || element.isDeleted === true)) return null
    return exportExcalidrawPng(prepared, { maxWidthOrHeight: EXCALIDRAW_THUMBNAIL_MAX_EDGE })
  },

  async exportPng(runtime) {
    return exportExcalidrawPng(exportableRuntime(runtime))
  },

  async exportSvg(runtime) {
    return exportExcalidrawSvg(exportableRuntime(runtime))
  },
}
