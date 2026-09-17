import { afterEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/auth-session', () => ({ authFetch }))

import { BoardAssetError, cleanupUnreferencedAsset, fetchAssetBlob, uploadAsset } from '../assetClient'

const assetId = '11111111-1111-4111-8111-111111111111'

afterEach(() => authFetch.mockReset())

describe('Board asset client', () => {
  it('uploads a Blob with the supported MIME type and no manual Content-Length', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: assetId,
      mimeType: 'image/png',
      byteSize: 3,
      sha256: 'hash',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const blob = new Blob(['png'], { type: 'image/png' })

    await expect(uploadAsset(assetId, 'image/png', blob)).resolves.toMatchObject({ id: assetId, mimeType: 'image/png' })
    expect(authFetch).toHaveBeenCalledWith(`/api/assets/${assetId}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: blob,
    })
  })

  it('classifies only HTTP 404 as a missing asset', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'missing', code: 'ASSET_NOT_FOUND' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(fetchAssetBlob(assetId)).rejects.toMatchObject({ code: 'ASSET_MISSING', status: 404 })

    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'broken', code: 'ASSET_INTERNAL_ERROR' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(fetchAssetBlob(assetId)).rejects.toMatchObject({ code: 'ASSET_RESOLVE_FAILED', status: 500 })
  })

  it('maps an asset ID conflict without changing the client asset ID', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'conflict', code: 'ASSET_ID_CONFLICT' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(uploadAsset(assetId, 'image/png', new Blob(['png'], { type: 'image/png' }))).rejects.toMatchObject({
      code: 'ASSET_ID_CONFLICT',
      status: 409,
    } satisfies Partial<BoardAssetError>)
  })

  it('rejects unsupported MIME and oversized blobs before making a request', async () => {
    await expect(uploadAsset(assetId, 'image/bmp', new Blob(['bmp']))).rejects.toMatchObject({ code: 'UNSUPPORTED_ASSET_MIME', status: 415 })
    await expect(uploadAsset(assetId, 'image/png', new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]))).rejects.toMatchObject({ code: 'ASSET_TOO_LARGE', status: 413 })
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('uploads SVG without changing its MIME type', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      id: assetId,
      mimeType: 'image/svg+xml',
      byteSize: 7,
      sha256: 'hash',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const blob = new Blob(['<svg />'], { type: 'image/svg+xml' })

    await expect(uploadAsset(assetId, 'image/svg+xml', blob)).resolves.toMatchObject({
      id: assetId,
      mimeType: 'image/svg+xml',
    })
    expect(authFetch).toHaveBeenCalledWith(`/api/assets/${assetId}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/svg+xml' },
      body: blob,
    })
  })

  it('uses the narrow idempotent endpoint for unreferenced cleanup', async () => {
    authFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(cleanupUnreferencedAsset(assetId)).resolves.toBeUndefined()
    expect(authFetch).toHaveBeenCalledWith(`/api/assets/${assetId}/unreferenced`, { method: 'DELETE' })
  })

  it('does not request cleanup for an invalid Asset ID', async () => {
    await expect(cleanupUnreferencedAsset('not-a-uuid')).rejects.toMatchObject({
      code: 'ASSET_CLEANUP_FAILED',
      status: 400,
      uncertain: false,
    })
    expect(authFetch).not.toHaveBeenCalled()
  })
})
