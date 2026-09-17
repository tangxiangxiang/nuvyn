export type AssetErrorCode =
  | 'INVALID_ASSET_ID'
  | 'UNSUPPORTED_ASSET_MIME'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_ID_CONFLICT'
  | 'ASSET_BINARY_CONFLICT'
  | 'INVALID_ASSET_REFERENCES'
  | 'ASSET_BINARY_MISSING'
  | 'ASSET_BINARY_UNREADABLE'
  | 'ASSET_BINARY_CORRUPT'
  | 'ASSET_STORAGE_ERROR'
  | 'ASSET_METADATA_PERSIST_FAILED'

export class AssetError extends Error {
  readonly code: AssetErrorCode
  readonly status: number

  constructor(code: AssetErrorCode, status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AssetError'
    this.code = code
    this.status = status
  }
}

export function isAssetError(error: unknown): error is AssetError {
  return error instanceof AssetError
}
