import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  getBoardMaterial: vi.fn(),
  fetchAssetPreviewBlob: vi.fn(),
}))

vi.mock('../auth-session', () => ({ authFetch: mocks.authFetch }))
vi.mock('../../features/board/api', () => ({ getBoardMaterial: mocks.getBoardMaterial }))
vi.mock('../../features/board/assetClient', () => ({ fetchAssetPreviewBlob: mocks.fetchAssetPreviewBlob }))

import { fetchAttachmentPreview } from '../attachmentPreview'
import type { ManagedAttachment } from '../../../shared/attachmentProtocol'

const UUID = '550e8400-e29b-41d4-a716-446655440000'

function attachment(key: ManagedAttachment['key'], overrides: Partial<ManagedAttachment> = {}): ManagedAttachment {
  const source = key.kind === 'asset' ? 'board-asset' : key.kind === 'vault-file' ? 'vault-file' : 'board-material'
  return {
    key,
    source,
    type: key.kind === 'board-material' ? 'material' : 'image',
    displayName: 'preview',
    mimeType: key.kind === 'board-material' ? 'image/svg+xml' : 'image/png',
    byteSize: 8,
    createdAt: null,
    modifiedAt: null,
    referenceStatus: 'unknown',
    ...overrides,
  }
}

afterEach(() => vi.clearAllMocks())

describe('attachment preview reads', () => {
  it('uses the authenticated Markdown resource endpoint for a canonical Vault image path', async () => {
    mocks.authFetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'image/png' },
    }))
    const signal = new AbortController().signal
    const result = await fetchAttachmentPreview(
      attachment({ kind: 'vault-file', path: `attachments/images/${UUID}.png` }),
      signal,
    )

    expect(mocks.authFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/markdown-resources?'),
      { signal },
    )
    expect(result.type).toBe('image/png')
    expect(result.size).toBe(3)
  })

  it('supports safe nested Vault image references without opening arbitrary file paths', async () => {
    mocks.authFetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'image/png' },
    }))
    const path = 'inbox/assets/diagram.png'
    await fetchAttachmentPreview(attachment({ kind: 'vault-file', path }), new AbortController().signal)
    expect(mocks.authFetch).toHaveBeenCalledWith(
      expect.stringContaining(`path=${encodeURIComponent(path)}`),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it.each(['diary/2026-10-14/private.png', 'inbox/../private.png', 'inbox/file.txt'])('rejects unsafe or unsupported Vault path %s before reading', async (path) => {
    await expect(fetchAttachmentPreview(
      attachment({ kind: 'vault-file', path }),
      new AbortController().signal,
    )).rejects.toThrow()
    expect(mocks.authFetch).not.toHaveBeenCalled()
  })

  it('uses the dedicated authenticated sanitized preview endpoint for Board Assets', async () => {
    mocks.fetchAssetPreviewBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    const signal = new AbortController().signal
    const result = await fetchAttachmentPreview(attachment({ kind: 'asset', id: UUID }), signal)
    expect(mocks.fetchAssetPreviewBlob).toHaveBeenCalledWith(UUID, signal)
    expect(result.type).toBe('image/png')
  })

  it('uses Board Material read and rejects archived or non-SVG resources', async () => {
    mocks.getBoardMaterial.mockResolvedValue({
      id: UUID,
      name: 'Vector',
      kind: 'svg',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" /></svg>',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    })
    const result = await fetchAttachmentPreview(attachment({ kind: 'board-material', id: UUID }), new AbortController().signal)
    expect(result.type).toBe('image/svg+xml')
    expect(mocks.getBoardMaterial).toHaveBeenCalledWith(UUID, expect.any(AbortSignal))

    mocks.getBoardMaterial.mockResolvedValueOnce({ archived: true, kind: 'svg', svg: '<svg />' })
    await expect(fetchAttachmentPreview(attachment({ kind: 'board-material', id: UUID }), new AbortController().signal))
      .rejects.toThrow()
  })

  it('rejects unsupported MIME types and oversized preview blobs', async () => {
    mocks.fetchAssetPreviewBlob.mockResolvedValueOnce(new Blob(['text'], { type: 'text/plain' }))
    await expect(fetchAttachmentPreview(attachment({ kind: 'asset', id: UUID }), new AbortController().signal))
      .rejects.toThrow()

    mocks.fetchAssetPreviewBlob.mockResolvedValueOnce(new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'image/png' }))
    await expect(fetchAttachmentPreview(attachment({ kind: 'asset', id: UUID }), new AbortController().signal))
      .rejects.toThrow()
  })
})
