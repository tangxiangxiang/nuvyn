/** Framework-independent Asset contracts shared by the server and browser. */

export const BOARD_ASSET_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
] as const

export type BoardAssetMimeType = typeof BOARD_ASSET_MIME_TYPES[number]

export interface AssetMetadata {
  id: string
  mimeType: string
  byteSize: number
  sha256: string
  storageKey: string
  createdAt: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Validate the canonical UUID shape used for Nuvyn Asset IDs. */
export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function isBoardAssetMimeType(value: unknown): value is BoardAssetMimeType {
  return typeof value === 'string'
    && (BOARD_ASSET_MIME_TYPES as readonly string[]).includes(value)
}
