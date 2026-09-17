import { Hono } from 'hono'
import { readBoundedBody } from '../apiBody.js'
import { apiErrorResponse, ApiRequestError } from '../apiErrors.js'
import { getDb } from '../db.js'
import { AssetError } from './errors.js'
import { createAssetService, type AssetService } from './service.js'
import { assertAssetId, matchesSvgContent } from './validation.js'
import { isBoardAssetMimeType, type AssetMetadata } from '../../shared/assetProtocol.js'

export const BOARD_ASSET_MAX_BYTES = 20 * 1024 * 1024
export const BOARD_SVG_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:"

export type AssetServiceFactory = () => AssetService

let assetServiceOverride: AssetService | null = null

/** Test-only service injection; production routes always resolve the current DB. */
export function __setAssetServiceForTesting(service: AssetService | null): void {
  assetServiceOverride = service
}

function assetServiceForRequest(): AssetService {
  return assetServiceOverride ?? createAssetService(getDb())
}

function mediaType(value: string | undefined): string | null {
  if (!value) return null
  const parsed = value.split(';', 1)[0]?.trim().toLowerCase()
  return parsed || null
}

function hasBytes(data: Uint8Array, ...bytes: number[]): boolean {
  return data.byteLength >= bytes.length && bytes.every((byte, index) => data[index] === byte)
}

function ascii(data: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...data.subarray(start, start + length))
}

function hasAvifSignature(data: Uint8Array): boolean {
  let offset = 0
  while (offset + 8 <= data.byteLength) {
    const size = (
      (data[offset]! * 0x1000000)
      + (data[offset + 1]! * 0x10000)
      + (data[offset + 2]! * 0x100)
      + data[offset + 3]!
    ) >>> 0
    const type = ascii(data, offset + 4, 4)
    let headerSize = 8
    let boxSize = size
    if (size === 1) {
      if (offset + 16 > data.byteLength) return false
      const extendedSize = (BigInt(data[offset + 8]!) << 56n)
        | (BigInt(data[offset + 9]!) << 48n)
        | (BigInt(data[offset + 10]!) << 40n)
        | (BigInt(data[offset + 11]!) << 32n)
        | (BigInt(data[offset + 12]!) << 24n)
        | (BigInt(data[offset + 13]!) << 16n)
        | (BigInt(data[offset + 14]!) << 8n)
        | BigInt(data[offset + 15]!)
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return false
      boxSize = Number(extendedSize)
      headerSize = 16
    } else if (size === 0) {
      boxSize = data.byteLength - offset
    }
    if (boxSize < headerSize || offset + boxSize > data.byteLength) return false
    if (type === 'ftyp') {
      if (boxSize < headerSize + 8) return false
      const brands = [ascii(data, offset + headerSize, 4)]
      for (let brandOffset = offset + headerSize + 8; brandOffset + 4 <= offset + boxSize; brandOffset += 4) {
        brands.push(ascii(data, brandOffset, 4))
      }
      return brands.includes('avif') || brands.includes('avis')
    }
    offset += boxSize
  }
  return false
}

function matchesAssetSignature(mimeType: string, data: Uint8Array): boolean {
  switch (mimeType) {
    case 'image/png':
      return hasBytes(data, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    case 'image/jpeg':
      return hasBytes(data, 0xff, 0xd8, 0xff)
    case 'image/gif':
      return ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a'
    case 'image/webp':
      return ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP'
    case 'image/avif':
      return hasAvifSignature(data)
    case 'image/svg+xml':
      return matchesSvgContent(data)
    default:
      return false
  }
}

function assetResponse(metadata: AssetMetadata) {
  return {
    id: metadata.id,
    mimeType: metadata.mimeType,
    byteSize: metadata.byteSize,
    sha256: metadata.sha256,
  }
}

export function createAssetRoutes(getService: AssetServiceFactory = assetServiceForRequest): Hono {
  const routes = new Hono()

  routes.put('/:assetId', async (c) => {
    try {
      // Validate the route parameter before reading the body or touching storage.
      const assetId = assertAssetId(c.req.param('assetId'))
      const service = getService()
      const mimeType = mediaType(c.req.header('Content-Type'))
      if (!mimeType || !isBoardAssetMimeType(mimeType)) {
        throw new AssetError(
          'UNSUPPORTED_ASSET_MIME',
          415,
          'Content-Type must be a supported Board image MIME type',
        )
      }
      const data = await readBoundedBody(
        c.req.raw,
        BOARD_ASSET_MAX_BYTES,
        'ASSET_TOO_LARGE',
        'Asset body exceeds the Board V1 size limit',
      )
      if (data.byteLength === 0) {
        throw new ApiRequestError('ASSET_EMPTY_BODY', 400, 'Asset body must not be empty')
      }
      if (!matchesAssetSignature(mimeType, data)) {
        throw new ApiRequestError(
          'ASSET_MIME_MISMATCH',
          415,
          'Asset body does not match Content-Type',
        )
      }
      const metadata = await service.persistAsset({
        assetId,
        mimeType,
        data,
        maxBytes: BOARD_ASSET_MAX_BYTES,
      })
      return c.json(assetResponse(metadata))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ASSET_INTERNAL_ERROR',
        message: 'Asset could not be stored.',
      })
    }
  })

  routes.delete('/:assetId/unreferenced', async (c) => {
    try {
      await getService().tryClaimUnreferencedAssetForDeletion(c.req.param('assetId'))
      return c.body(null, 204)
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ASSET_INTERNAL_ERROR',
        message: 'Asset cleanup failed.',
      })
    }
  })

  routes.get('/:assetId', async (c) => {
    try {
      const service = getService()
      const assetId = c.req.param('assetId')
      const metadata = service.getAssetMetadata(assetId)
      if (!metadata) throw new AssetError('ASSET_NOT_FOUND', 404, 'Asset was not found')
      if (!isBoardAssetMimeType(metadata.mimeType)) {
        throw new AssetError('ASSET_STORAGE_ERROR', 500, 'Asset metadata contains an unsupported MIME type')
      }
      const data = await service.readAssetBinary(assetId)
      c.header('Cache-Control', 'private, max-age=31536000, immutable')
      c.header('Content-Type', metadata.mimeType)
      c.header('Content-Length', String(data.byteLength))
      c.header('ETag', `"${metadata.sha256}"`)
      c.header('X-Content-Type-Options', 'nosniff')
      if (metadata.mimeType === 'image/svg+xml') {
        c.header('Content-Security-Policy', BOARD_SVG_CONTENT_SECURITY_POLICY)
      }
      return c.body(new Uint8Array(data))
    } catch (error) {
      return apiErrorResponse(c, error, {
        code: 'ASSET_INTERNAL_ERROR',
        message: 'Asset could not be loaded.',
      })
    }
  })

  return routes
}

export default createAssetRoutes()
