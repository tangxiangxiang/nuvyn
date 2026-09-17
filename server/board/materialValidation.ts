import { randomUUID } from 'node:crypto'
import { isAssetId } from '../../shared/assetProtocol.js'
import { matchesSvgText } from '../../shared/svgValidation.js'
import { BoardMaterialError } from './materialErrors.js'

export const BOARD_MATERIAL_MAX_SVG_BYTES = 2 * 1024 * 1024

export function assertBoardMaterialId(value: unknown): string {
  if (!isAssetId(value)) {
    throw new BoardMaterialError('BOARD_MATERIAL_VALIDATION_ERROR', 400, 'Board material ID must be a UUID')
  }
  return value
}

export function createBoardMaterialId(): string {
  return assertBoardMaterialId(randomUUID())
}

export function normalizeBoardMaterialName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BoardMaterialError('BOARD_MATERIAL_VALIDATION_ERROR', 400, 'Board material name must be a string')
  }
  const name = value.trim()
  if (!name) {
    throw new BoardMaterialError('BOARD_MATERIAL_VALIDATION_ERROR', 400, 'Board material name cannot be empty')
  }
  if (name.length > 80) {
    throw new BoardMaterialError('BOARD_MATERIAL_VALIDATION_ERROR', 400, 'Board material name must be at most 80 characters')
  }
  return name
}

export function normalizeBoardMaterialSvg(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BoardMaterialError('BOARD_MATERIAL_SVG_INVALID', 400, 'Board material SVG must not be empty')
  }
  const byteLength = new TextEncoder().encode(value).byteLength
  if (byteLength > BOARD_MATERIAL_MAX_SVG_BYTES) {
    throw new BoardMaterialError('BOARD_MATERIAL_SVG_TOO_LARGE', 413, 'Board material SVG exceeds the size limit')
  }
  if (!matchesSvgText(value)) {
    throw new BoardMaterialError('BOARD_MATERIAL_SVG_INVALID', 415, 'Board material SVG content is invalid')
  }
  return value
}

export function assertBoardMaterialTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BoardMaterialError('BOARD_MATERIAL_STORAGE_ERROR', 500, 'Board material timestamp is invalid')
  }
  return value
}
