import type { AttachmentResourceKey, ManagedAttachment } from '../../shared/attachmentProtocol'
import { authFetch } from './auth-session'
import { getBoardMaterial } from '../features/board/api'
import { fetchAssetPreviewBlob } from '../features/board/assetClient'

const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024
const MARKDOWN_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'])
const PREVIEW_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
])

export function isCanonicalVaultImagePath(path: string): boolean {
  const segments = path.split('/')
  const fileName = segments.at(-1) ?? ''
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return path.length <= 1024
    && !path.startsWith('/')
    && !path.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && segments.length > 0
    && segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment) && !segment.startsWith('.'))
    && segments[0]?.toLowerCase() !== 'diary'
    && MARKDOWN_IMAGE_EXTENSIONS.has(extension)
}

function validatePreviewBlob(blob: Blob, maxBytes = MAX_IMAGE_PREVIEW_BYTES): Blob {
  const mimeType = blob.type.trim().toLowerCase().split(';', 1)[0] ?? ''
  if (blob.size <= 0 || blob.size > maxBytes || !PREVIEW_MIME_TYPES.has(mimeType)) {
    throw new Error('Attachment preview is unavailable.')
  }
  return new Blob([blob], { type: mimeType })
}

async function fetchVaultImage(path: string, signal: AbortSignal): Promise<Blob> {
  if (!isCanonicalVaultImagePath(path)) throw new Error('Attachment preview is unavailable.')
  const query = new URLSearchParams({ kind: 'image', path })
  const response = await authFetch(`/api/markdown-resources?${query.toString()}`, { signal })
  if (!response.ok) throw new Error('Attachment preview is unavailable.')
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!PREVIEW_MIME_TYPES.has(mimeType)) throw new Error('Attachment preview is unavailable.')
  const blob = await response.blob()
  return validatePreviewBlob(new Blob([blob], { type: mimeType }))
}

export async function fetchAttachmentPreview(
  item: ManagedAttachment,
  signal: AbortSignal,
): Promise<Blob> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const key: AttachmentResourceKey = item.key
  if (key.kind === 'asset') return validatePreviewBlob(await fetchAssetPreviewBlob(key.id, signal))
  if (key.kind === 'vault-file') return fetchVaultImage(key.path, signal)
  const material = await getBoardMaterial(key.id, signal)
  if (material.archived || material.kind !== 'svg') throw new Error('Attachment preview is unavailable.')
  return validatePreviewBlob(new Blob([material.svg], { type: 'image/svg+xml' }), 2 * 1024 * 1024)
}
