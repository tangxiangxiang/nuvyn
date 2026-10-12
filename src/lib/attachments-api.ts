import { authFetch } from './auth-session'
import { jsonOrThrow } from './api'
import type {
  AttachmentIndexStatus,
  AttachmentListQuery,
  AttachmentPage,
  AttachmentReferenceIndexStatus,
  AttachmentReferencePage,
  AttachmentCleanupPreview,
  AttachmentResourceKey,
} from '../../shared/attachmentProtocol'

function queryString(query: AttachmentListQuery): string {
  const params = new URLSearchParams()
  if (query.search) params.set('search', query.search)
  if (query.type) params.set('type', query.type)
  if (query.source) params.set('source', query.source)
  if (query.referenceStatus) params.set('referenceStatus', query.referenceStatus)
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const value = params.toString()
  return value ? `?${value}` : ''
}

export async function listAttachments(query: AttachmentListQuery = {}, signal?: AbortSignal): Promise<AttachmentPage> {
  return jsonOrThrow<AttachmentPage>(await authFetch(`/api/attachments${queryString(query)}`, { signal }))
}

export async function getAttachmentIndexStatus(signal?: AbortSignal): Promise<AttachmentIndexStatus> {
  return jsonOrThrow<AttachmentIndexStatus>(await authFetch('/api/attachments/index-status', { signal }))
}

export async function refreshAttachmentIndex(signal?: AbortSignal): Promise<{
  indexStatus: AttachmentIndexStatus
}> {
  return jsonOrThrow(await authFetch('/api/attachments/refresh', { method: 'POST', signal }))
}

export async function getAttachmentReferenceIndexStatus(signal?: AbortSignal): Promise<AttachmentReferenceIndexStatus> {
  return jsonOrThrow<AttachmentReferenceIndexStatus>(await authFetch('/api/attachments/references/status', { signal }))
}

export async function refreshAttachmentReferences(signal?: AbortSignal): Promise<AttachmentReferenceIndexStatus> {
  return jsonOrThrow<AttachmentReferenceIndexStatus>(await authFetch('/api/attachments/references/refresh', {
    method: 'POST',
    signal,
  }))
}

export async function queryAttachmentReferences(
  resource: AttachmentResourceKey,
  options: { offset?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<AttachmentReferencePage> {
  return jsonOrThrow<AttachmentReferencePage>(await authFetch('/api/attachments/references/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource, offset: options.offset, limit: options.limit }),
    signal: options.signal,
  }))
}

export async function previewAttachmentCleanup(
  resource: AttachmentResourceKey,
  signal?: AbortSignal,
): Promise<AttachmentCleanupPreview> {
  return jsonOrThrow<AttachmentCleanupPreview>(await authFetch('/api/attachments/cleanup-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resource }),
    signal,
  }))
}
