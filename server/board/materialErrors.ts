export type BoardMaterialErrorCode =
  | 'BOARD_MATERIAL_NOT_FOUND'
  | 'BOARD_MATERIAL_VALIDATION_ERROR'
  | 'BOARD_MATERIAL_SVG_INVALID'
  | 'BOARD_MATERIAL_SVG_TOO_LARGE'
  | 'BOARD_MATERIAL_NOT_ARCHIVED'
  | 'BOARD_MATERIAL_STORAGE_ERROR'

export class BoardMaterialError extends Error {
  readonly code: BoardMaterialErrorCode
  readonly status: number

  constructor(code: BoardMaterialErrorCode, status: number, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BoardMaterialError'
    this.code = code
    this.status = status
  }
}

export function isBoardMaterialError(error: unknown): error is BoardMaterialError {
  return error instanceof BoardMaterialError
}
