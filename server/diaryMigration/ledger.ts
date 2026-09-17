import { createHash, randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import type {
  CandidateDurability,
  GenerationRecord,
  MigrationActionScope,
  MigrationClassification,
  MigrationFinalizeCapability,
  MigrationItemRecord,
  MigrationItemState,
  MigrationRunState,
} from './types.js'

type ItemRow = {
  item_key: string
  run_id: string
  vault_id: string
  document_id: string | null
  canonical_path: string
  inventory_revision: number
  schema_version: number
  classification: MigrationClassification
  state: MigrationItemState
  finalize_capability: MigrationFinalizeCapability
  source_generation_json: string | null
  source_parent_generation_json: string | null
  reviewed_source_generation_json: string | null
  candidate_name: string | null
  candidate_generation_json: string | null
  candidate_parent_generation_json: string | null
  candidate_durability: CandidateDurability
  target_generation_json: string | null
  transaction_id: string | null
  ciphertext_fingerprint: string | null
  ai_session_id: number | null
  ai_message_ids_json: string | null
  frontmatter_row_cas_json: string | null
  envelope_version: number | null
  attention_code: string | null
  user_residual_state: 'NONE' | 'USER_CONTROLLED_PLAINTEXT_RESIDUAL' | null
  last_action_scope: MigrationActionScope | null
  created_at: number
  updated_at: number
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null
  try { return JSON.parse(value) as T } catch { return null }
}

export function encodeItemKey(vaultId: string, documentId: string | null, canonicalPath: string): string {
  return `${vaultId}\u0000${documentId ?? 'UNRESOLVED'}\u0000${canonicalPath}\u0000${1}`
}

export function encodeAuxiliaryItemKey(vaultId: string, kind: string, identity: string): string {
  return `${vaultId}\u0000${kind}\u0000${identity}\u0000${1}`
}

export function itemSetFingerprint(items: Array<{
  itemKey: string
  classification: string
  sourceGeneration?: GenerationRecord | null
  aiMessageIds?: number[]
}>): string {
  const stable = [...items]
    .sort((a, b) => a.itemKey.localeCompare(b.itemKey))
    .map((item) => [
      item.itemKey,
      item.classification,
      item.sourceGeneration ?? null,
      item.aiMessageIds ?? [],
    ])
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

function rowToItem(row: ItemRow): MigrationItemRecord {
  return {
    itemKey: row.item_key,
    runId: row.run_id,
    vaultId: row.vault_id,
    documentId: row.document_id,
    canonicalPath: row.canonical_path,
    inventoryRevision: row.inventory_revision,
    classification: row.classification,
    state: row.state,
    finalizeCapability: row.finalize_capability,
    sourceGeneration: parseJson<GenerationRecord>(row.source_generation_json),
    sourceParentGeneration: parseJson<GenerationRecord>(row.source_parent_generation_json),
    reviewedSourceGeneration: parseJson<GenerationRecord>(row.reviewed_source_generation_json),
    candidateName: row.candidate_name,
    candidateGeneration: parseJson<GenerationRecord>(row.candidate_generation_json),
    candidateParentGeneration: parseJson<GenerationRecord>(row.candidate_parent_generation_json),
    candidateDurability: row.candidate_durability,
    targetGeneration: parseJson<GenerationRecord>(row.target_generation_json),
    transactionId: row.transaction_id,
    ciphertextFingerprint: row.ciphertext_fingerprint,
    aiSessionId: row.ai_session_id,
    aiMessageIds: parseJson<number[]>(row.ai_message_ids_json) ?? [],
    frontmatterRowCas: parseJson<Record<string, unknown>>(row.frontmatter_row_cas_json),
    envelopeVersion: row.envelope_version,
    attentionCode: row.attention_code,
    userResidualState: row.user_residual_state ?? 'NONE',
    lastActionScope: row.last_action_scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function nextInventoryRevision(db: DatabaseT, vaultId: string): number {
  const row = db.prepare('SELECT MAX(inventory_revision) AS revision FROM diary_migration_runs WHERE vault_id = ?').get(vaultId) as { revision?: number | null }
  return Number(row?.revision ?? 0) + 1
}

export function createRun(
  db: DatabaseT,
  input: { vaultId: string; inventoryRevision: number; state?: MigrationRunState },
): string {
  const runId = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO diary_migration_runs (
      run_id, vault_id, schema_version, inventory_revision, reviewed_revision,
      state, created_at, updated_at
    ) VALUES (?, ?, 1, ?, NULL, ?, ?, ?)
  `).run(runId, input.vaultId, input.inventoryRevision, input.state ?? 'INVENTORIED', now, now)
  return runId
}

export function setRunState(db: DatabaseT, runId: string, state: MigrationRunState, reviewedRevision?: number | null): void {
  db.prepare('UPDATE diary_migration_runs SET state = ?, reviewed_revision = COALESCE(?, reviewed_revision), updated_at = ? WHERE run_id = ?')
    .run(state, reviewedRevision ?? null, Date.now(), runId)
}

export function getRun(db: DatabaseT, runId: string, vaultId?: string): {
  run_id: string
  vault_id: string
  schema_version: number
  inventory_revision: number
  reviewed_revision: number | null
  state: MigrationRunState
  created_at: number
  updated_at: number
} | null {
  const row = (vaultId === undefined
    ? db.prepare('SELECT * FROM diary_migration_runs WHERE run_id = ?').get(runId)
    : db.prepare('SELECT * FROM diary_migration_runs WHERE run_id = ? AND vault_id = ?').get(runId, vaultId)) as any
  return row ?? null
}

export function latestRun(db: DatabaseT, vaultId: string): ReturnType<typeof getRun> {
  return db.prepare('SELECT * FROM diary_migration_runs WHERE vault_id = ? ORDER BY inventory_revision DESC, created_at DESC LIMIT 1').get(vaultId) as any ?? null
}

export function insertItem(db: DatabaseT, item: MigrationItemRecord): void {
  db.prepare(`
    INSERT INTO diary_migration_items (
      item_key, run_id, vault_id, document_id, canonical_path,
      inventory_revision, schema_version, classification, state,
      finalize_capability, source_generation_json, source_parent_generation_json,
      reviewed_source_generation_json, candidate_name, candidate_generation_json,
      candidate_parent_generation_json, candidate_durability,
      quarantine_name, quarantine_generation_json, quarantine_parent_generation_json,
      quarantine_durability, target_generation_json, transaction_id,
      ciphertext_fingerprint, ai_session_id, ai_message_ids_json,
      frontmatter_row_cas_json, envelope_version, attention_code,
      user_residual_state, last_action_scope, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
      'NOT_STARTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.itemKey,
    item.runId,
    item.vaultId,
    item.documentId,
    item.canonicalPath,
    item.inventoryRevision,
    item.classification,
    item.state,
    item.finalizeCapability,
    item.sourceGeneration ? JSON.stringify(item.sourceGeneration) : null,
    item.sourceParentGeneration ? JSON.stringify(item.sourceParentGeneration) : null,
    item.reviewedSourceGeneration ? JSON.stringify(item.reviewedSourceGeneration) : null,
    item.candidateName,
    item.candidateGeneration ? JSON.stringify(item.candidateGeneration) : null,
    item.candidateParentGeneration ? JSON.stringify(item.candidateParentGeneration) : null,
    item.candidateDurability,
    item.targetGeneration ? JSON.stringify(item.targetGeneration) : null,
    item.transactionId,
    item.ciphertextFingerprint,
    item.aiSessionId,
    item.aiMessageIds.length ? JSON.stringify(item.aiMessageIds) : null,
    item.frontmatterRowCas ? JSON.stringify(item.frontmatterRowCas) : null,
    item.envelopeVersion,
    item.attentionCode,
    item.userResidualState,
    item.lastActionScope,
    item.createdAt,
    item.updatedAt,
  )
}

export function getItem(db: DatabaseT, runId: string, revision: number, itemKey: string): MigrationItemRecord | null {
  const row = db.prepare('SELECT * FROM diary_migration_items WHERE run_id = ? AND inventory_revision = ? AND item_key = ?')
    .get(runId, revision, itemKey) as ItemRow | undefined
  return row ? rowToItem(row) : null
}

export function listItems(db: DatabaseT, runId: string, revision?: number): MigrationItemRecord[] {
  const rows = (revision === undefined
    ? db.prepare('SELECT * FROM diary_migration_items WHERE run_id = ? ORDER BY canonical_path, item_key').all(runId)
    : db.prepare('SELECT * FROM diary_migration_items WHERE run_id = ? AND inventory_revision = ? ORDER BY canonical_path, item_key').all(runId, revision)) as ItemRow[]
  return rows.map(rowToItem)
}

export type ItemPatch = Partial<{
  documentId: string | null
  canonicalPath: string
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
  itemKey: string
}>

const patchColumns: Record<keyof ItemPatch, string> = {
  documentId: 'document_id',
  canonicalPath: 'canonical_path',
  classification: 'classification',
  state: 'state',
  finalizeCapability: 'finalize_capability',
  sourceGeneration: 'source_generation_json',
  sourceParentGeneration: 'source_parent_generation_json',
  reviewedSourceGeneration: 'reviewed_source_generation_json',
  candidateName: 'candidate_name',
  candidateGeneration: 'candidate_generation_json',
  candidateParentGeneration: 'candidate_parent_generation_json',
  candidateDurability: 'candidate_durability',
  targetGeneration: 'target_generation_json',
  transactionId: 'transaction_id',
  ciphertextFingerprint: 'ciphertext_fingerprint',
  aiSessionId: 'ai_session_id',
  aiMessageIds: 'ai_message_ids_json',
  frontmatterRowCas: 'frontmatter_row_cas_json',
  envelopeVersion: 'envelope_version',
  attentionCode: 'attention_code',
  userResidualState: 'user_residual_state',
  lastActionScope: 'last_action_scope',
  itemKey: 'item_key',
}

function encodePatchValue(key: keyof ItemPatch, value: unknown): unknown {
  if (['sourceGeneration', 'sourceParentGeneration', 'reviewedSourceGeneration', 'candidateGeneration', 'candidateParentGeneration', 'targetGeneration', 'frontmatterRowCas'].includes(key)) {
    return value === null || value === undefined ? null : JSON.stringify(value)
  }
  if (key === 'aiMessageIds') return value && Array.isArray(value) && value.length ? JSON.stringify(value) : null
  return value
}

export function updateItem(db: DatabaseT, runId: string, revision: number, currentItemKey: string, patch: ItemPatch): void {
  const updates: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch) as Array<[keyof ItemPatch, unknown]>) {
    if (value === undefined || key === 'itemKey') continue
    updates.push(`${patchColumns[key]} = ?`)
    values.push(encodePatchValue(key, value))
  }
  if (!updates.length) return
  updates.push('updated_at = ?')
  values.push(Date.now(), runId, revision, currentItemKey)
  db.prepare(`UPDATE diary_migration_items SET ${updates.join(', ')} WHERE run_id = ? AND inventory_revision = ? AND item_key = ?`).run(...values)
}

export function grantConsent(
  db: DatabaseT,
  input: {
    runId: string
    vaultId: string
    inventoryRevision: number
    itemKey: string
    actionScope: MigrationActionScope
    reviewedGeneration: GenerationRecord | null
    reviewedItemSetFingerprint: string
  },
): string {
  const consentId = randomUUID()
  db.prepare(`
    INSERT INTO diary_migration_consents (
      consent_id, run_id, vault_id, inventory_revision, item_key,
      action_scope, reviewed_generation_json, reviewed_item_set_fingerprint,
      consented_at, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'GRANTED')
  `).run(
    consentId,
    input.runId,
    input.vaultId,
    input.inventoryRevision,
    input.itemKey,
    input.actionScope,
    input.reviewedGeneration ? JSON.stringify(input.reviewedGeneration) : null,
    input.reviewedItemSetFingerprint,
    Date.now(),
  )
  return consentId
}

export function hasConsent(
  db: DatabaseT,
  input: { runId: string; vaultId: string; inventoryRevision: number; itemKey: string; actionScope: MigrationActionScope; reviewedItemSetFingerprint: string },
): boolean {
  const row = db.prepare(`
    SELECT 1 FROM diary_migration_consents
    WHERE run_id = ? AND vault_id = ? AND inventory_revision = ? AND item_key = ?
      AND action_scope = ? AND reviewed_item_set_fingerprint = ? AND state = 'GRANTED'
    LIMIT 1
  `).get(input.runId, input.vaultId, input.inventoryRevision, input.itemKey, input.actionScope, input.reviewedItemSetFingerprint)
  return Boolean(row)
}

export function invalidateConsents(db: DatabaseT, runId: string, revision: number, itemKey: string): void {
  db.prepare("UPDATE diary_migration_consents SET state = 'INVALIDATED' WHERE run_id = ? AND inventory_revision = ? AND item_key = ? AND state = 'GRANTED'")
    .run(runId, revision, itemKey)
}

export function countStates(db: DatabaseT, runId: string, revision: number): Record<string, number> {
  const rows = db.prepare(`
    SELECT classification, state, COUNT(*) AS count
    FROM diary_migration_items
    WHERE run_id = ? AND inventory_revision = ?
    GROUP BY classification, state
  `).all(runId, revision) as Array<{ classification: string; state: string; count: number }>
  const counts: Record<string, number> = {}
  for (const row of rows) {
    counts[row.classification] = (counts[row.classification] ?? 0) + Number(row.count)
    counts[`state:${row.state}`] = Number(row.count) + (counts[`state:${row.state}`] ?? 0)
  }
  counts.total = rows.reduce((sum, row) => sum + Number(row.count), 0)
  return counts
}
