export type BoardErrorCode =
  | 'BOARD_NOT_FOUND'
  | 'BOARD_FOLDER_NOT_FOUND'
  | 'BOARD_VALIDATION_ERROR'
  | 'BOARD_SCENE_CORRUPT'
  | 'BOARD_SCENE_VERSION_UNSUPPORTED'
  | 'BOARD_SCENE_ENGINE_UNSUPPORTED'
  | 'BOARD_SCENE_REVISION_CONFLICT'
  | 'BOARD_ASSET_REFERENCE_CONFLICT'
  | 'BOARD_STORAGE_ERROR'

export class BoardError extends Error {
  readonly code: BoardErrorCode
  readonly status: number

  constructor(code: BoardErrorCode, status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BoardError'
    this.code = code
    this.status = status
  }
}

export function isBoardError(error: unknown): error is BoardError {
  return error instanceof BoardError
}
