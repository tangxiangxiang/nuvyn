import { authFetch, diaryAuthFetch } from './auth-session'
import { jsonOrThrow } from './api'

export type MigrationFinalizeCapability = 'AUTOMATIC_HANDLE_BOUND' | 'USER_FINALIZE_REQUIRED' | 'UNSUPPORTED'
export type MigrationActionScope =
  | 'MIGRATE_PRIMARY'
  | 'REMOVE_VERIFIED_LEGACY_PRIMARY'
  | 'CLEAN_PRIVATE_SQLITE'
  | 'IMPORT_DRAFT'
  | 'DISCARD_DRAFT'
  | 'DISCARD_AI_SESSION'
  | 'RETAIN_AI_HISTORY'
  | 'BIND_FRONTMATTER_IDENTITY'
  | 'ACKNOWLEDGE_GIT_RETENTION'

export type MigrationItem = {
  itemKey: string
  documentId?: string
  canonicalPath: string
  classification: string
  state: string
  migrationFinalizeCapability: MigrationFinalizeCapability
  attentionCode?: string
  userResidualState?: 'USER_CONTROLLED_PLAINTEXT_RESIDUAL'
  aiSessionId?: number
}

export type MigrationStatus = {
  runId: string | null
  vaultId?: string
  inventoryRevision?: number
  state: string
  counts: Record<string, number>
  items: MigrationItem[]
  migrationFinalizeCapability: MigrationFinalizeCapability | null
  residuals: {
    gitRetentionAcknowledged: boolean
    userControlledPlaintextResidual: number
    policyRetainedAiHistory: number
  }
}

export async function getDiaryMigrationStatus(): Promise<MigrationStatus> {
  return jsonOrThrow<MigrationStatus>(await authFetch('/api/diary/migration/status'))
}

export async function scanDiaryMigration(): Promise<{
  runId: string
  inventoryRevision: number
  state: string
  counts: Record<string, number>
}> {
  return jsonOrThrow(await authFetch('/api/diary/migration/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
}

export async function startDiaryMigration(
  runId: string,
  inventoryRevision: number,
  requestedScopes: Array<{ itemKey?: string; scope: MigrationActionScope }>,
): Promise<MigrationStatus> {
  return jsonOrThrow(await diaryAuthFetch('/api/diary/migration/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, inventoryRevision, requestedScopes }),
  }))
}

export async function resumeDiaryMigration(runId: string, inventoryRevision: number): Promise<MigrationStatus> {
  return jsonOrThrow(await diaryAuthFetch('/api/diary/migration/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId, inventoryRevision }),
  }))
}

export async function resolveDiaryMigrationItem(
  runId: string,
  itemKey: string,
  inventoryRevision: number,
  action: 'adopt-metadata' | 'import-to-primary' | 'discard-draft' | 'discard-ai-session' | 'retain-ai-history' | 'bind-frontmatter-identity' | 'retry-item' | 'acknowledge-attention',
  confirmation?: string,
): Promise<MigrationStatus> {
  return jsonOrThrow(await diaryAuthFetch(`/api/diary/migration/items/${encodeURIComponent(itemKey)}/resolve?runId=${encodeURIComponent(runId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inventoryRevision, action, ...(confirmation ? { confirmation } : {}) }),
  }))
}
