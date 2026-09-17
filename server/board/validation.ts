import {
  BOARD_ENGINE_EXCALIDRAW,
  CURRENT_BOARD_SCENE_VERSION,
  DEFAULT_BOARD_TITLE,
  type BoardPersistentAppState,
  type BoardScene,
} from '../../shared/boardProtocol.js'
import { isAssetId } from '../../shared/assetProtocol.js'
import { BoardError } from './errors.js'

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is RecordValue {
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validationError(message: string): never {
  throw new BoardError('BOARD_VALIDATION_ERROR', 400, message)
}

export function assertBoardId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    validationError('Board ID must be a non-empty string')
  }
  return value as string
}

export function assertBoardFolderId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    validationError('Board folder ID must be a non-empty string')
  }
  return value as string
}

export function normalizeBoardFolderName(value: unknown): string {
  if (typeof value !== 'string') validationError('Board folder name must be a string')
  const name = value.trim()
  if (name.length === 0) validationError('Board folder name cannot be empty')
  if (name.length > 80) validationError('Board folder name must be at most 80 characters')
  return name
}

export function normalizeNullableBoardFolderId(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return assertBoardFolderId(value)
}

export function normalizeBoardTitle(value: unknown): string {
  if (typeof value !== 'string') validationError('Board title must be a string')
  const title = value.trim()
  return title.length === 0 ? DEFAULT_BOARD_TITLE : title
}

export function assertExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    validationError('Board scene revision must be a non-negative safe integer')
  }
  return value as number
}

export function assertSupportedBoardSceneContract(engine: unknown, sceneVersion: unknown): void {
  if (engine !== BOARD_ENGINE_EXCALIDRAW) {
    throw new BoardError('BOARD_SCENE_ENGINE_UNSUPPORTED', 409, `Unsupported Board engine: ${String(engine)}`)
  }
  if (sceneVersion !== CURRENT_BOARD_SCENE_VERSION) {
    throw new BoardError(
      'BOARD_SCENE_VERSION_UNSUPPORTED',
      409,
      `Unsupported Board scene version: ${String(sceneVersion)}`,
    )
  }
}

export function normalizeAssetReferences(value: unknown): string[] {
  if (!Array.isArray(value)) validationError('Board scene assetRefs must be an array')
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isAssetId(item)) validationError('Board scene assetRefs must contain UUID Asset IDs')
    if (seen.has(item)) validationError('Board scene assetRefs must be unique')
    seen.add(item)
    result.push(item)
  }
  return result
}

type ValidatedEngineData = RecordValue & {
  elements: unknown[]
  fileMap: RecordValue
}

function validateEngineData(value: unknown): ValidatedEngineData {
  if (!isPlainRecord(value) || !Array.isArray(value.elements) || !isPlainRecord(value.fileMap)) {
    validationError('Board scene engineData has an invalid basic shape')
  }

  const activeImageFileIds = new Set<string>()
  for (const element of value.elements) {
    if (!isRecord(element) || element.type !== 'image' || element.isDeleted === true) continue
    if (typeof element.fileId !== 'string' || element.fileId.trim().length === 0) {
      validationError('Non-deleted image elements must contain a non-empty fileId')
    }
    const fileId = element.fileId
    if (!Object.prototype.hasOwnProperty.call(value.fileMap, fileId)) {
      validationError(`Image element ${fileId} has no fileMap asset mapping`)
    }
    activeImageFileIds.add(fileId)
  }

  for (const [fileId, assetId] of Object.entries(value.fileMap)) {
    if (fileId.trim().length === 0) validationError('engineData.fileMap keys must be non-empty Excalidraw file IDs')
    if (!isAssetId(assetId)) validationError(`fileMap.${fileId} must be a UUID Asset ID`)
    if (!activeImageFileIds.has(fileId)) {
      validationError(`fileMap contains an unused Excalidraw file ID: ${fileId}`)
    }
  }

  return value as ValidatedEngineData
}

function validatePersistentAppState(value: unknown): BoardPersistentAppState {
  if (!isRecord(value)) validationError('Board scene persistentAppState must be an object')
  const allowed = new Set(['zoom', 'scrollX', 'scrollY', 'gridSize', 'viewBackgroundColor'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) validationError(`Unsupported persistentAppState field: ${key}`)
  }
  for (const key of ['zoom', 'scrollX', 'scrollY']) {
    if (key in value && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
      validationError(`persistentAppState.${key} must be a finite number`)
    }
  }
  if ('gridSize' in value
    && value.gridSize !== null
    && (typeof value.gridSize !== 'number' || !Number.isFinite(value.gridSize))) {
    validationError('persistentAppState.gridSize must be a finite number or null')
  }
  if ('viewBackgroundColor' in value && typeof value.viewBackgroundColor !== 'string') {
    validationError('persistentAppState.viewBackgroundColor must be a string')
  }
  return value as BoardPersistentAppState
}

export function normalizeBoardScene(value: unknown): BoardScene {
  if (!isRecord(value)) validationError('Board scene must be an object')
  const engineData = validateEngineData(value.engineData)
  const assetRefs = normalizeAssetReferences(value.assetRefs)
  const fileMapAssetIds = new Set(Object.values(engineData.fileMap))
  if (fileMapAssetIds.size !== assetRefs.length || assetRefs.some((assetId) => !fileMapAssetIds.has(assetId))) {
    validationError('Board scene assetRefs must equal the unique values of engineData.fileMap')
  }
  return {
    engineData,
    persistentAppState: validatePersistentAppState(value.persistentAppState),
    assetRefs,
  }
}

export function parseStoredBoardScene(
  engineDataJson: string,
  persistentAppStateJson: string,
  assetRefs: readonly string[],
): BoardScene {
  let engineData: unknown
  let persistentAppState: unknown
  try {
    engineData = JSON.parse(engineDataJson)
    persistentAppState = JSON.parse(persistentAppStateJson)
  } catch (error) {
    throw new BoardError('BOARD_SCENE_CORRUPT', 500, 'Board scene JSON is invalid', { cause: error })
  }

  try {
    return normalizeBoardScene({ engineData, persistentAppState, assetRefs })
  } catch (error) {
    if (error instanceof BoardError && error.code === 'BOARD_VALIDATION_ERROR') {
      throw new BoardError('BOARD_SCENE_CORRUPT', 500, error.message, { cause: error })
    }
    throw error
  }
}

/** Minimal future-version seam; V1 has no migration step yet. */
export function migrateBoardScene(sceneVersion: number, scene: BoardScene): BoardScene {
  if (sceneVersion !== CURRENT_BOARD_SCENE_VERSION) {
    throw new BoardError(
      'BOARD_SCENE_VERSION_UNSUPPORTED',
      409,
      `Unsupported Board scene version: ${String(sceneVersion)}`,
    )
  }
  return scene
}

export function serializeBoardScenePart(value: unknown, fieldName: string): string {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) throw new Error(`${fieldName} serialized to undefined`)
    return json
  } catch (error) {
    throw new BoardError('BOARD_VALIDATION_ERROR', 400, `${fieldName} cannot be serialized`, { cause: error })
  }
}
