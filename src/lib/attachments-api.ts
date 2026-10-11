import { authFetch } from './auth-session'
import { jsonOrThrow } from './api'
import type {
  AttachmentIndexStatus,
  AttachmentListQuery,
  AttachmentPage,
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

export async function listAttachments(query: AttachmentListQuery = {}): Promise<AttachmentPage> {
  return jsonOrThrow<AttachmentPage>(await authFetch(`/api/attachments${queryString(query)}`))
}

export async function getAttachmentIndexStatus(): Promise<AttachmentIndexStatus> {
  return jsonOrThrow<AttachmentIndexStatus>(await authFetch('/api/attachments/index-status'))
}

export async function refreshAttachmentIndex(): Promise<{
  indexStatus: AttachmentIndexStatus
}> {
  return jsonOrThrow(await authFetch('/api/attachments/refresh', { method: 'POST' }))
}
