import type { DiaryBodyOperation } from '../diaryAccess/service.js'

export const MIGRATION_SCHEMA_VERSION = 1 as const

export const ITEM_CLASSIFICATIONS = [
  'ALREADY_ENCRYPTED_VALID',
  'LEGACY_PLAINTEXT',
  'ENCRYPTED_MALFORMED',
  'ENCRYPTED_UNKNOWN_VERSION',
  'ENCRYPTED_IDENTITY_MISMATCH',
  'METADATA_MISSING',
  'METADATA_AMBIGUOUS',
  'PRIMARY_MISSING',
  'EXTERNAL_PATH_CONFLICT',
  'MIGRATION_IN_PROGRESS',
  'CLEANUP_PENDING',
  'RECOVERY_AUTH_REQUIRED',
  'DURABILITY_PENDING',
  'CONSENT_REQUIRED',
  'USER_FINALIZE_REQUIRED',
  'UNSUPPORTED',
  'LEGACY_DIARY_AI_HISTORY',
  'FRONTMATTER_IDENTITY_UNRESOLVED',
  'NEEDS_ATTENTION',
] as const

export type MigrationClassification = typeof ITEM_CLASSIFICATIONS[number]

export const ITEM_STATES = [
  'DISCOVERED',
  'NEEDS_UNLOCK',
  'READY',
  'PREPARING',
  'ENCRYPTED_VERIFIED',
  'PUBLISHING',
  'USER_FINALIZE_REQUIRED',
  'RECOVERY_AUTH_REQUIRED',
  'DURABILITY_PENDING',
  'CONSENT_REQUIRED',
  'PUBLISHED',
  'CLEANUP_PENDING',
  'COMPLETE',
  'NEEDS_ATTENTION',
] as const

export type MigrationItemState = typeof ITEM_STATES[number]

export const RUN_STATES = [
  'NOT_STARTED',
  'INVENTORIED',
  'NEEDS_UNLOCK',
  'RUNNING',
  'ATTENTION_REQUIRED',
  'COMPLETE',
  'FAILED',
] as const

export type MigrationRunState = typeof RUN_STATES[number]

export const FINALIZE_CAPABILITIES = [
  'AUTOMATIC_HANDLE_BOUND',
  'USER_FINALIZE_REQUIRED',
  'UNSUPPORTED',
] as const

export type MigrationFinalizeCapability = typeof FINALIZE_CAPABILITIES[number]

export const ACTION_SCOPES = [
  'MIGRATE_PRIMARY',
  'REMOVE_VERIFIED_LEGACY_PRIMARY',
  'CLEAN_PRIVATE_SQLITE',
  'IMPORT_DRAFT',
  'DISCARD_DRAFT',
  'DISCARD_AI_SESSION',
  'RETAIN_AI_HISTORY',
  'BIND_FRONTMATTER_IDENTITY',
  'ACKNOWLEDGE_GIT_RETENTION',
] as const

export type MigrationActionScope = typeof ACTION_SCOPES[number]

export type CandidateDurability = 'NOT_STARTED' | 'UNKNOWN' | 'DURABLE' | 'FAILED'

export type GenerationRecord = {
  readonly type: 'file'
  readonly dev?: number
  readonly ino?: number
  readonly fileId?: string
  readonly parentDev?: number
  readonly parentIno?: number
  readonly mtimeMs?: number
  readonly mtimeNs?: string
}
export type MigrationItemRecord = {
  itemKey: string
  runId: string
  vaultId: string
  documentId: string | null
  canonicalPath: string
  inventoryRevision: number
  classification: MigrationClassification
  state: MigrationItemState
  finalizeCapability: MigrationFinalizeCapability
  sourceGeneration: GenerationRecord | null
  sourceParentGeneration: GenerationRecord | null
  reviewedSourceGeneration: GenerationRecord | null
  candidateName: string | null
  candidateGeneration: GenerationRecord | null
  candidateParentGeneration: GenerationRecord | null
  candidateDurability: CandidateDurability
  targetGeneration: GenerationRecord | null
  transactionId: string | null
  ciphertextFingerprint: string | null
  aiSessionId: number | null
  aiMessageIds: number[]
  frontmatterRowCas: Record<string, unknown> | null
  envelopeVersion: number | null
  attentionCode: string | null
  userResidualState: 'NONE' | 'USER_CONTROLLED_PLAINTEXT_RESIDUAL'
  lastActionScope: MigrationActionScope | null
  createdAt: number
  updatedAt: number
}

export type MigrationItemDTO = {
  itemKey: string
  documentId?: string
  canonicalPath: string
  classification: MigrationClassification
  state: MigrationItemState
  migrationFinalizeCapability: MigrationFinalizeCapability
  attentionCode?: string
  userResidualState?: 'USER_CONTROLLED_PLAINTEXT_RESIDUAL'
  aiSessionId?: number
}

export type MigrationCounts = Record<string, number>

export type MigrationStatusDTO = {
  runId: string | null
  vaultId?: string
  inventoryRevision?: number
  state: MigrationRunState
  counts: MigrationCounts
  items: MigrationItemDTO[]
  migrationFinalizeCapability: MigrationFinalizeCapability | null
  residuals: {
    gitRetentionAcknowledged: boolean
    userControlledPlaintextResidual: number
    policyRetainedAiHistory: number
  }
}

export type MigrationBodyOperation = DiaryBodyOperation

export type MigrationScanResult = {
  runId: string
  inventoryRevision: number
  state: MigrationRunState
  counts: MigrationCounts
}

export type MigrationStartScope = {
  itemKey?: string
  scope: MigrationActionScope
}

export type MigrationResolveAction =
  | 'adopt-metadata'
  | 'import-to-primary'
  | 'discard-draft'
  | 'discard-ai-session'
  | 'retain-ai-history'
  | 'bind-frontmatter-identity'
  | 'retry-item'
  | 'acknowledge-attention'

export class DiaryMigrationError extends Error {
  readonly code: string
  readonly status: 400 | 401 | 404 | 409 | 422 | 423 | 503
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    status: DiaryMigrationError['status'],
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DiaryMigrationError'
    this.code = code
    this.status = status
    this.details = details
  }
}
