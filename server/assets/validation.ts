import { isAssetId, isBoardAssetMimeType } from '../../shared/assetProtocol.js'
import { matchesSvgText } from '../../shared/svgValidation.js'
import { AssetError } from './errors.js'

import { TextDecoder } from 'node:util'

export function assertAssetId(value: unknown): string {
  if (!isAssetId(value)) {
    throw new AssetError('INVALID_ASSET_ID', 400, 'Asset ID must be a UUID')
  }
  return value
}

export function assertBoardAssetMimeType(value: unknown): string {
  if (!isBoardAssetMimeType(value)) {
    throw new AssetError('UNSUPPORTED_ASSET_MIME', 400, 'Asset MIME type is not supported by Board V1')
  }
  return value
}

export function normalizeAssetIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AssetError('INVALID_ASSET_REFERENCES', 400, 'Asset references must be an array')
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const assetId = assertAssetId(item)
    if (seen.has(assetId)) continue
    seen.add(assetId)
    result.push(assetId)
  }
  return result
}

/**
 * SVG has no binary magic header. Decode strictly and then apply the shared
 * document-boundary check used by Board Materials.
 */
export function matchesSvgContent(data: Uint8Array): boolean {
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return false
  }
  return matchesSvgText(value)
}
