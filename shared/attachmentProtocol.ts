/** Read-only Attachment Manager contracts shared by the server and browser. */

export const ATTACHMENT_SOURCES = [
  'board-asset',
  'vault-file',
  'board-material',
] as const

export type AttachmentSource = typeof ATTACHMENT_SOURCES[number]
export type AttachmentResourceType = 'image' | 'file' | 'material'
export type AttachmentReferenceStatus = 'referenced' | 'unreferenced' | 'unknown'

export type AttachmentResourceKey =
  | { kind: 'asset'; id: string }
  | { kind: 'vault-file'; path: string }
  | { kind: 'board-material'; id: string }

export interface ManagedAttachment {
  key: AttachmentResourceKey
  source: AttachmentSource
  type: AttachmentResourceType
  displayName: string | null
  mimeType: string | null
  byteSize: number | null
  createdAt: number | null
  modifiedAt: number | null
  referenceStatus: AttachmentReferenceStatus
  /** A count from the existing Board reference table, not a deletion proof. */
  knownReferenceCount?: number
  archived?: boolean
}

export interface AttachmentSourceStatus {
  state: 'pending' | 'ready' | 'failed'
  itemCount: number
  errorCode?: 'source-unavailable' | 'scan-limited'
}

export interface AttachmentIndexStatus {
  ready: boolean
  refreshing: boolean
  complete: boolean | null
  refreshedAt: number | null
  sources: Record<AttachmentSource, AttachmentSourceStatus>
}

export interface AttachmentSourceSummary {
  count: number
  knownBytes: number
}

export interface AttachmentSummary {
  total: number
  knownBytes: number
  unknownByteSizeCount: number
  unknownReferenceCount: number
  sources: Record<AttachmentSource, AttachmentSourceSummary>
  complete: boolean
}

export interface AttachmentPage {
  items: ManagedAttachment[]
  total: number
  offset: number
  limit: number
  summary: AttachmentSummary
  indexStatus: AttachmentIndexStatus
}

export interface AttachmentListQuery {
  search?: string
  type?: AttachmentResourceType
  source?: AttachmentSource
  referenceStatus?: AttachmentReferenceStatus
  offset?: number
  limit?: number
}
