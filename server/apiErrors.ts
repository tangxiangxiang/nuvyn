import { isAssetError } from './assets/errors.js'
import { isBoardError } from './board/errors.js'
import { isBoardMaterialError } from './board/materialErrors.js'

export class ApiRequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.status = status
  }
}

function safeStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
}

function safeServerMessage(code: string, fallback: string): string {
  switch (code) {
    case 'BOARD_SCENE_CORRUPT':
      return 'Board scene is unavailable.'
    case 'BOARD_STORAGE_ERROR':
      return 'Board storage is temporarily unavailable.'
    case 'ASSET_BINARY_MISSING':
      return 'Asset binary is unavailable.'
    case 'ASSET_BINARY_UNREADABLE':
      return 'Asset binary is unavailable.'
    case 'ASSET_BINARY_CORRUPT':
      return 'Asset binary failed integrity validation.'
    case 'ASSET_STORAGE_ERROR':
      return 'Asset storage is temporarily unavailable.'
    case 'ASSET_METADATA_PERSIST_FAILED':
      return 'Asset could not be stored.'
    case 'BOARD_MATERIAL_STORAGE_ERROR':
      return 'Board material storage is temporarily unavailable.'
    default:
      return fallback
  }
}

export function apiErrorResponse(
  c: any,
  error: unknown,
  fallback: { readonly code: string; readonly message: string },
): Response {
  const known = isBoardError(error) || isAssetError(error) || isBoardMaterialError(error) || error instanceof ApiRequestError
  const code = known ? error.code : fallback.code
  const status = known ? safeStatus(error.status) : 500
  const message = known && status < 500
    ? error.message
    : safeServerMessage(code, fallback.message)
  c.header('Cache-Control', 'no-store')
  return c.json({ error: message, code }, status)
}
