/** Read-only Attachment Manager contracts shared by the server and browser. */

export const ATTACHMENT_SOURCES = [
  'board-asset',
  'vault-file',
  'board-material',
] as const

export type AttachmentSource = typeof ATTACHMENT_SOURCES[number]
export type AttachmentResourceType = 'image' | 'file' | 'material'
export type AttachmentReferenceStatus = 'referenced' | 'unreferenced' | 'unknown'

export type AttachmentReferenceKind =
  | 'note-image'
  | 'note-snippet'
  | 'note-include'
  | 'board-scene'
  | 'board-thumbnail'
  | 'board-embed'

export type AttachmentReferenceRelation = 'direct' | 'indirect'

export interface AttachmentReferenceVia {
  kind: 'include' | 'board'
  id: string
  title: string | null
}

export interface AttachmentReference {
  owner: {
    kind: 'note' | 'board'
    id: string
    title: string | null
  }
  kind: AttachmentReferenceKind
  relation: AttachmentReferenceRelation
  /** The Note that contains the actual image, snippet, include, or Board embed. */
  sourcePath?: string
  /** One-based source line when it can be established from Markdown tokens. */
  line?: number
  via?: AttachmentReferenceVia[]
  target: {
    kind: 'vault-file' | 'asset' | 'board'
    id: string
  }
  navigable: boolean
}

export type AttachmentCoverage = 'complete' | 'partial' | 'unknown' | 'not-checked' | 'restricted'

export interface AttachmentReferenceCoverage {
  currentNotes: 'complete' | 'partial' | 'unknown'
  boardReferences: 'complete' | 'partial' | 'unknown'
  historicalVersions: 'not-checked'
  unsavedDrafts: 'not-checked'
  protectedDiary: 'restricted'
  boardCheckpoints: 'not-checked'
  externalChanges: 'not-checked'
}

export interface AttachmentReferenceIndexStatus {
  state: 'pending' | 'building' | 'ready' | 'partial' | 'failed'
  complete: boolean | null
  noteCount: number
  refreshedAt: number | null
  snapshotId: string | null
  coverage: AttachmentReferenceCoverage
}

export interface AttachmentReferenceQuery {
  resource: AttachmentResourceKey
  offset?: number
  limit?: number
}

export interface AttachmentReferencePage {
  resource: AttachmentResourceKey
  references: AttachmentReference[]
  referenceCount: number
  ownerCount: number
  offset: number
  limit: number
  nextOffset: number | null
  currentFinding: 'in-use' | 'no-current-reference' | 'unknown'
  coverage: AttachmentReferenceCoverage
  snapshotId: string | null
  checkedAt: number
}

export interface AttachmentCleanupPreview {
  resource: AttachmentResourceKey
  currentFinding: 'in-use' | 'no-current-reference' | 'unknown'
  riskLevel: 'known-use' | 'review-required' | 'unverified'
  referenceCount: number
  ownerCount: number
  coverage: AttachmentReferenceCoverage
  riskReasons: Array<
    | 'current-references-found'
    | 'current-scan-incomplete'
    | 'historical-versions-not-checked'
    | 'draft-recovery-not-checked'
    | 'unsaved-editor-state-not-observable'
    | 'protected-diary-restricted'
    | 'board-checkpoints-not-checked'
    | 'external-changes-not-checked'
    | 'board-material-usage-unknown'
  >
  deletionAllowed: false
  snapshotId: string | null
  checkedAt: number
}

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
  /** Count of verified direct and indirect relationships in the current snapshot. */
  referenceCount?: number
  /** Number of distinct Note and Board owners in the current snapshot. */
  ownerCount?: number
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
