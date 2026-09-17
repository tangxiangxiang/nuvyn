import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Database as DatabaseT } from 'better-sqlite3'
import { diaryDateFromPath, isManagedDiaryPath } from '../../shared/diaryProtocol.js'
import {
  createDocumentMetadata,
  getDocumentMetadata,
} from '../documentMetadata.js'
import { getVaultId as defaultVaultId } from '../vaultIdentity.js'
import { withVaultMutation } from '../vaultMutation.js'
import { withDocumentWriteLock, withVaultStructureLock } from '../documentWriteLock.js'
import { isEncryptedDiaryBody, type DiaryBodyCryptoError } from '../diaryAccess/body.js'
import { DiaryAccessServiceError } from '../diaryAccess/service.js'
import { run as runGit, isRepo } from '../history/git.js'
import {
  countStates,
  createRun,
  encodeAuxiliaryItemKey,
  encodeItemKey,
  getItem,
  getRun,
  grantConsent,
  hasConsent,
  insertItem,
  invalidateConsents,
  itemSetFingerprint,
  latestRun,
  listItems,
  nextInventoryRevision,
  setRunState,
  updateItem,
} from './ledger.js'
import {
  DiaryMigrationFs,
  DiaryMigrationFsError,
  fingerprintCiphertext,
  isMigrationCandidateName,
} from './fs.js'
import {
  ACTION_SCOPES,
  type GenerationRecord,
  type MigrationActionScope,
  type MigrationBodyOperation,
  type MigrationClassification,
  type MigrationItemDTO,
  type MigrationItemRecord,
  type MigrationResolveAction,
  type MigrationScanResult,
  type MigrationStartScope,
  type MigrationStatusDTO,
  DiaryMigrationError,
} from './types.js'

type ServiceOptions = {
  db: DatabaseT
  rootDir: string
  vaultId?: () => string
  now?: () => number
}

type InventoryDraft = Pick<MigrationItemRecord,
  | 'itemKey'
  | 'vaultId'
  | 'documentId'
  | 'canonicalPath'
  | 'inventoryRevision'
  | 'classification'
  | 'state'
  | 'finalizeCapability'
> & Partial<Omit<MigrationItemRecord,
  | 'itemKey'
  | 'runId'
  | 'vaultId'
  | 'documentId'
  | 'canonicalPath'
  | 'inventoryRevision'
  | 'classification'
  | 'state'
  | 'finalizeCapability'
  | 'createdAt'
  | 'updatedAt'
>>
type InventoryItem = Omit<MigrationItemRecord, 'runId' | 'createdAt' | 'updatedAt'>

function asGeneration(value: GenerationRecord | null, parent: GenerationRecord | null): GenerationRecord | null {
  if (!value) return null
  return parent ? { ...value, parentDev: parent.dev, parentIno: parent.ino } : value
}

function sameGeneration(left: GenerationRecord | null, right: GenerationRecord | null): boolean {
  if (!left || !right) return false
  return left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.fileId === right.fileId
    && left.parentDev === right.parentDev
    && left.parentIno === right.parentIno
    && (left.mtimeNs ?? left.mtimeMs) === (right.mtimeNs ?? right.mtimeMs)
}

function safeClassificationFromCrypto(error: unknown): MigrationClassification {
  const code = (error as DiaryBodyCryptoError)?.code
  if (code === 'unsupported-envelope') return 'ENCRYPTED_UNKNOWN_VERSION'
  if (code === 'identity-mismatch') return 'ENCRYPTED_IDENTITY_MISMATCH'
  return 'ENCRYPTED_MALFORMED'
}

function isBodyLeaseLifecycleError(error: unknown): boolean {
  return error instanceof DiaryAccessServiceError
}

function digestStructuralValue(value: unknown): string {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function frontmatterCasFor(row: Record<string, unknown>): Record<string, unknown> {
  return {
    status: row.status,
    updatedAt: row.updated_at,
    documentIdNull: row.document_id === null,
    sourceHash: row.source_hash,
    cleanedHash: row.cleaned_hash,
    frontmatterBackupDigest: digestStructuralValue(row.frontmatter_backup),
    errorDigest: digestStructuralValue(row.error),
  }
}

function codeForClassification(classification: MigrationClassification): string | null {
  switch (classification) {
    case 'METADATA_MISSING': return 'diary-migration-identity-missing'
    case 'METADATA_AMBIGUOUS': return 'diary-migration-identity-ambiguous'
    case 'PRIMARY_MISSING': return 'diary-migration-primary-missing'
    case 'ENCRYPTED_MALFORMED': return 'diary-migration-malformed-envelope'
    case 'ENCRYPTED_UNKNOWN_VERSION': return 'diary-migration-unknown-envelope'
    case 'ENCRYPTED_IDENTITY_MISMATCH': return 'diary-migration-identity-mismatch'
    case 'FRONTMATTER_IDENTITY_UNRESOLVED': return 'diary-migration-identity-unresolved'
    case 'LEGACY_DIARY_AI_HISTORY': return 'diary-migration-ai-decision-required'
    default: return null
  }
}

function initialState(classification: MigrationClassification, operationAvailable: boolean): MigrationItemRecord['state'] {
  if (classification === 'ALREADY_ENCRYPTED_VALID') return 'COMPLETE'
  if (classification === 'LEGACY_PLAINTEXT' && !operationAvailable) return 'NEEDS_UNLOCK'
  if (classification === 'RECOVERY_AUTH_REQUIRED') return 'NEEDS_UNLOCK'
  if (classification === 'CONSENT_REQUIRED') return 'CONSENT_REQUIRED'
  if (classification === 'LEGACY_PLAINTEXT') return 'READY'
  if (classification === 'USER_FINALIZE_REQUIRED') return 'USER_FINALIZE_REQUIRED'
  return 'NEEDS_ATTENTION'
}

function itemDto(item: MigrationItemRecord): MigrationItemDTO {
  return {
    itemKey: item.itemKey,
    ...(item.documentId ? { documentId: item.documentId } : {}),
    canonicalPath: item.canonicalPath,
    classification: item.classification,
    state: item.state,
    migrationFinalizeCapability: item.finalizeCapability,
    ...(item.attentionCode ? { attentionCode: item.attentionCode } : {}),
    ...(item.userResidualState === 'USER_CONTROLLED_PLAINTEXT_RESIDUAL'
      ? { userResidualState: item.userResidualState }
      : {}),
    ...(item.aiSessionId !== null ? { aiSessionId: item.aiSessionId } : {}),
  }
}

/**
 * D8.4's single migration decision owner.  The implementation deliberately
 * keeps all durable state structural and delegates encryption to the existing
 * DiaryBodyOperation lease.
 */
export class DiaryMigrationService {
  readonly db: DatabaseT
  readonly rootDir: string
  readonly vaultId: () => string
  readonly now: () => number
  readonly fs: DiaryMigrationFs
  private controlBusy = false

  constructor(options: ServiceOptions) {
    this.db = options.db
    this.rootDir = path.resolve(options.rootDir)
    this.vaultId = options.vaultId ?? defaultVaultId
    this.now = options.now ?? Date.now
    this.fs = new DiaryMigrationFs(this.rootDir)
  }

  private async withControl<T>(operation: () => Promise<T>): Promise<T> {
    if (this.controlBusy) {
      throw new DiaryMigrationError('diary-migration-in-progress', 409, 'Another migration operation is already running.')
    }
    this.controlBusy = true
    try { return await operation() } finally { this.controlBusy = false }
  }

  private validateRun(runId: string, inventoryRevision: number): NonNullable<ReturnType<typeof getRun>> {
    const run = getRun(this.db, runId, this.vaultId())
    if (!run) throw new DiaryMigrationError('diary-migration-run-not-found', 404, 'Migration run was not found.')
    if (run.inventory_revision !== inventoryRevision) {
      throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Migration inventory revision is stale.', { inventoryRevision: run.inventory_revision })
    }
    return run
  }

  private currentItemFingerprint(runId: string, revision: number): string {
    return itemSetFingerprint(listItems(this.db, runId, revision).map((item) => ({
      itemKey: item.itemKey,
      classification: item.classification,
      sourceGeneration: item.sourceGeneration,
      aiMessageIds: item.aiMessageIds,
    })))
  }

  private makeItem(input: InventoryDraft): Omit<MigrationItemRecord, 'runId' | 'createdAt' | 'updatedAt'> {
    return {
      itemKey: input.itemKey,
      vaultId: input.vaultId,
      documentId: input.documentId,
      canonicalPath: input.canonicalPath,
      inventoryRevision: input.inventoryRevision,
      classification: input.classification,
      state: input.state,
      finalizeCapability: input.finalizeCapability,
      sourceGeneration: input.sourceGeneration ?? null,
      sourceParentGeneration: input.sourceParentGeneration ?? null,
      reviewedSourceGeneration: input.reviewedSourceGeneration ?? input.sourceGeneration ?? null,
      candidateName: input.candidateName ?? null,
      candidateGeneration: input.candidateGeneration ?? null,
      candidateParentGeneration: input.candidateParentGeneration ?? null,
      candidateDurability: input.candidateDurability ?? 'NOT_STARTED',
      targetGeneration: input.targetGeneration ?? null,
      transactionId: input.transactionId ?? null,
      ciphertextFingerprint: input.ciphertextFingerprint ?? null,
      aiSessionId: input.aiSessionId ?? null,
      aiMessageIds: input.aiMessageIds ?? [],
      frontmatterRowCas: input.frontmatterRowCas ?? null,
      envelopeVersion: input.envelopeVersion ?? null,
      attentionCode: input.attentionCode ?? codeForClassification(input.classification),
      userResidualState: input.userResidualState ?? 'NONE',
      lastActionScope: input.lastActionScope ?? null,
    }
  }

  private async enumerateDiaryItems(operation?: MigrationBodyOperation): Promise<InventoryItem[]> {
    const out: InventoryItem[] = []
    const vaultId = this.vaultId()
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await fs.readdir(path.join(this.rootDir, 'diary'), { withFileTypes: true })
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    const seenPaths = new Set<string>()
    for (const entry of entries) {
      const name = String(entry.name)
      if (!name.endsWith('.md')) continue
      const logicalPath = `diary/${name.slice(0, -3)}`
      if (!isManagedDiaryPath(logicalPath)) continue
      seenPaths.add(logicalPath)
      const metadataRow = this.db.prepare('SELECT id FROM documents WHERE path = ?').get(logicalPath) as { id: string } | undefined
      const frontmatterRow = metadataRow
        ? this.db.prepare('SELECT path, document_id, status, source_hash, cleaned_hash, frontmatter_backup, error, updated_at FROM metadata_migrations WHERE path = ? AND document_id = ?').get(logicalPath, metadataRow.id) as Record<string, unknown> | undefined
        : undefined
      let source: Awaited<ReturnType<DiaryMigrationFs['readSource']>> | null = null
      let classification: MigrationClassification
      let attentionCode: string | null = null
      try {
        source = await this.fs.readSource(logicalPath)
        if (!metadataRow) {
          classification = 'METADATA_MISSING'
        } else if (!isEncryptedDiaryBody(source.bytes)) {
          classification = 'LEGACY_PLAINTEXT'
        } else if (!operation) {
          classification = 'RECOVERY_AUTH_REQUIRED'
        } else {
          try {
            const decoded = operation.decrypt(source.bytes, {
              documentId: metadataRow.id,
              logicalPath,
            })
            classification = decoded.encrypted ? 'ALREADY_ENCRYPTED_VALID' : 'LEGACY_PLAINTEXT'
          } catch (error) {
            if (isBodyLeaseLifecycleError(error)) throw error
            classification = safeClassificationFromCrypto(error)
          }
        }
      } catch (error) {
        if (error instanceof DiaryMigrationFsError && error.code === 'UNSAFE_PATH') {
          classification = 'NEEDS_ATTENTION'
          attentionCode = 'diary-migration-unsafe-path'
        } else if (error instanceof DiaryMigrationFsError && error.code === 'SOURCE_MISSING') {
          classification = 'PRIMARY_MISSING'
          attentionCode = 'diary-migration-primary-missing'
        } else {
          throw error
        }
      }
      const capability = this.fs.selectFinalizeCapability()
      const sourceGeneration = source?.generation ?? null
      const parentGeneration = source?.parentGeneration ?? null
      const documentId = metadataRow?.id ?? null
      out.push(this.makeItem({
        itemKey: encodeItemKey(vaultId, documentId, logicalPath),
        vaultId,
        documentId,
        canonicalPath: logicalPath,
        inventoryRevision: 0,
        classification,
        state: initialState(classification, Boolean(operation)),
        finalizeCapability: capability,
        sourceGeneration,
        sourceParentGeneration: parentGeneration,
        reviewedSourceGeneration: asGeneration(sourceGeneration, parentGeneration),
        candidateDurability: 'NOT_STARTED',
        frontmatterRowCas: frontmatterRow ? frontmatterCasFor(frontmatterRow) : null,
        attentionCode: attentionCode ?? codeForClassification(classification),
      }))
    }

    // Metadata rows without a physical primary are inventory items too.  The
    // query is structural and never reads a body.
    const managedRows = this.db.prepare("SELECT id, path FROM documents WHERE path LIKE 'diary/%'").all() as Array<{ id: string; path: string }>
    for (const row of managedRows) {
      if (!isManagedDiaryPath(row.path) || seenPaths.has(row.path)) continue
      out.push(this.makeItem({
        itemKey: encodeItemKey(vaultId, row.id, row.path),
        vaultId,
        documentId: row.id,
        canonicalPath: row.path,
        inventoryRevision: 0,
        classification: 'PRIMARY_MISSING',
        state: 'NEEDS_ATTENTION',
        finalizeCapability: this.fs.selectFinalizeCapability(),
        sourceGeneration: null,
        sourceParentGeneration: null,
        reviewedSourceGeneration: null,
        candidateDurability: 'NOT_STARTED',
        attentionCode: 'diary-migration-primary-missing',
      }))
    }

    // A null-identity frontmatter backup is a first-class attention item.  It
    // is intentionally separate from the primary item and can never authorize
    // a path-only cleanup.
    const nullFrontmatter = this.db.prepare("SELECT path, document_id, status, updated_at, source_hash, cleaned_hash, frontmatter_backup, error FROM metadata_migrations WHERE path LIKE 'diary/%' AND document_id IS NULL").all() as Array<Record<string, unknown>>
    for (const row of nullFrontmatter) {
      const logicalPath = String(row.path)
      if (!isManagedDiaryPath(logicalPath)) continue
      out.push(this.makeItem({
        itemKey: encodeAuxiliaryItemKey(vaultId, 'FRONTMATTER', logicalPath),
        vaultId,
        documentId: null,
        canonicalPath: logicalPath,
        inventoryRevision: 0,
        classification: 'FRONTMATTER_IDENTITY_UNRESOLVED',
        state: 'NEEDS_ATTENTION',
        finalizeCapability: this.fs.selectFinalizeCapability(),
        sourceGeneration: null,
        sourceParentGeneration: null,
        reviewedSourceGeneration: null,
        candidateDurability: 'NOT_STARTED',
        frontmatterRowCas: frontmatterCasFor(row),
        attentionCode: 'diary-migration-identity-unresolved',
      }))
    }

    // Structured AI tool envelopes are inspected only when a body operation
    // is available.  We retain opaque IDs and never persist the message text.
    if (operation) {
      const messages = this.db.prepare('SELECT id, session_id, content FROM messages ORDER BY id').all() as Array<{ id: number; session_id: number; content: string }>
      const bySession = new Map<number, { messageIds: number[]; mixed: boolean }>()
      for (const message of messages) {
        let parsed: any
        try { parsed = JSON.parse(message.content) } catch { continue }
        if (!parsed || !Array.isArray(parsed.toolCalls)) continue
        let matching = false
        let mixed = false
        for (const call of parsed.toolCalls) {
          const inputPath = call?.input?.path
          const isManagedRead = typeof inputPath === 'string'
            && isManagedDiaryPath(inputPath.replace(/\.md$/, ''))
            && typeof call?.name === 'string'
            && call.name === 'read_file'
          if (isManagedRead) matching = true
          else mixed = true
        }
        if (!matching) continue
        const current = bySession.get(message.session_id) ?? { messageIds: [], mixed: false }
        current.messageIds.push(Number(message.id))
        current.mixed ||= mixed
        bySession.set(message.session_id, current)
      }
      for (const [sessionId, details] of bySession) {
        const mixed = details.mixed
        // The disposition is whole-session.  Snapshot every opaque message
        // identity in the session (not only the structured tool-result rows)
        // so a later append/delete cannot inherit the reviewed decision.
        const allSessionMessages = this.db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id').all(sessionId) as Array<{ id: number }>
        out.push(this.makeItem({
          itemKey: encodeAuxiliaryItemKey(vaultId, 'AI_SESSION', String(sessionId)),
          vaultId,
          documentId: null,
          canonicalPath: `@ai/session/${sessionId}`,
          inventoryRevision: 0,
          classification: mixed ? 'NEEDS_ATTENTION' : 'LEGACY_DIARY_AI_HISTORY',
          state: 'NEEDS_ATTENTION',
          finalizeCapability: this.fs.selectFinalizeCapability(),
          sourceGeneration: null,
          sourceParentGeneration: null,
          reviewedSourceGeneration: null,
          candidateDurability: 'NOT_STARTED',
          aiSessionId: sessionId,
          aiMessageIds: allSessionMessages.map((message) => Number(message.id)),
          attentionCode: mixed ? 'diary-migration-ai-mixed-session' : 'diary-migration-ai-decision-required',
        }))
      }
    }

    // Git is disclosed as a read-only residual.  The synthetic item gives the
    // user an action-scoped acknowledgement without exposing blob contents.
    if (await isRepo(this.rootDir).catch(() => false)) {
      out.push(this.makeItem({
        itemKey: encodeAuxiliaryItemKey(vaultId, 'GIT', 'retention'),
        vaultId,
        documentId: null,
        canonicalPath: '@git/retention',
        inventoryRevision: 0,
        classification: 'NEEDS_ATTENTION',
        state: 'NEEDS_ATTENTION',
        finalizeCapability: this.fs.selectFinalizeCapability(),
        sourceGeneration: null,
        sourceParentGeneration: null,
        reviewedSourceGeneration: null,
        candidateDurability: 'NOT_STARTED',
        attentionCode: 'diary-migration-git-decision-required',
      }))
    }
    return out
  }

  async scan(operation?: MigrationBodyOperation): Promise<MigrationScanResult> {
    return this.withControl(async () => withVaultMutation(this.rootDir, async () => {
      const vaultId = this.vaultId()
      const inventoryRevision = nextInventoryRevision(this.db, vaultId)
      const drafts = await this.enumerateDiaryItems(operation)
      // A rescan is a new immutable revision, not an in-place refresh.  If a
      // previously reviewed source generation is still present but its
      // identity/mtime provenance changed, carry the item forward only as a
      // consent gate.  The old revision's grants are invalidated so a stale
      // preparation can never authorize the new bytes.
      const priorRun = latestRun(this.db, vaultId)
      if (priorRun) {
        const priorItems = new Map(listItems(this.db, priorRun.run_id, priorRun.inventory_revision).map((item) => [item.itemKey, item]))
        for (const draft of drafts) {
          const prior = priorItems.get(draft.itemKey)
          const currentGeneration = asGeneration(draft.sourceGeneration ?? null, draft.sourceParentGeneration ?? null)
          if (!prior || !prior.sourceGeneration || !currentGeneration || sameGeneration(prior.sourceGeneration, currentGeneration)) continue
          draft.classification = 'CONSENT_REQUIRED'
          draft.state = 'CONSENT_REQUIRED'
          draft.attentionCode = 'diary-migration-consent-required'
          draft.reviewedSourceGeneration = currentGeneration
          invalidateConsents(this.db, priorRun.run_id, priorRun.inventory_revision, prior.itemKey)
        }
      }
      const now = this.now()
      const runId = createRun(this.db, { vaultId, inventoryRevision })
      const tx = this.db.transaction(() => {
        for (const draft of drafts) {
          insertItem(this.db, {
            ...draft,
            runId,
            inventoryRevision,
            createdAt: now,
            updatedAt: now,
          })
        }
        const hasUnlock = drafts.some((item) => item.state === 'NEEDS_UNLOCK')
        const hasAttention = drafts.some((item) => item.state === 'NEEDS_ATTENTION')
        setRunState(this.db, runId, hasUnlock ? 'NEEDS_UNLOCK' : hasAttention ? 'ATTENTION_REQUIRED' : 'INVENTORIED')
      })
      tx()
      return {
        runId,
        inventoryRevision,
        state: getRun(this.db, runId)!.state,
        counts: countStates(this.db, runId, inventoryRevision),
      }
    }))
  }

  status(runId?: string, inventoryRevision?: number): MigrationStatusDTO {
    const vaultId = this.vaultId()
    const run = runId
      ? getRun(this.db, runId, vaultId)
      : latestRun(this.db, vaultId)
    if (!run) {
      if (runId) throw new DiaryMigrationError('diary-migration-run-not-found', 404, 'Migration run was not found.')
      return {
        runId: null,
        state: 'NOT_STARTED',
        counts: { total: 0 },
        items: [],
        migrationFinalizeCapability: null,
        residuals: { gitRetentionAcknowledged: false, userControlledPlaintextResidual: 0, policyRetainedAiHistory: 0 },
      }
    }
    const revision = inventoryRevision ?? run.inventory_revision
    if (revision !== run.inventory_revision) {
      throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Migration inventory revision is stale.', { inventoryRevision: run.inventory_revision })
    }
    const items = listItems(this.db, run.run_id, revision)
    const fingerprint = this.currentItemFingerprint(run.run_id, revision)
    const gitItem = items.find((item) => item.canonicalPath === '@git/retention')
    const gitAcknowledged = Boolean(gitItem && hasConsent(this.db, {
      runId: run.run_id,
      vaultId,
      inventoryRevision: revision,
      itemKey: gitItem.itemKey,
      actionScope: 'ACKNOWLEDGE_GIT_RETENTION',
      reviewedItemSetFingerprint: fingerprint,
    }))
    return {
      runId: run.run_id,
      vaultId,
      inventoryRevision: revision,
      state: run.state,
      counts: countStates(this.db, run.run_id, revision),
      items: items.map(itemDto),
      migrationFinalizeCapability: items.find((item) => item.finalizeCapability)?.finalizeCapability ?? null,
      residuals: {
        gitRetentionAcknowledged: gitAcknowledged,
        userControlledPlaintextResidual: items.filter((item) => item.userResidualState === 'USER_CONTROLLED_PLAINTEXT_RESIDUAL').length,
        policyRetainedAiHistory: items.filter((item) => item.classification === 'LEGACY_DIARY_AI_HISTORY' && item.lastActionScope === 'RETAIN_AI_HISTORY').length,
      },
    }
  }

  private ensureConsent(run: NonNullable<ReturnType<typeof getRun>>, item: MigrationItemRecord, scope: MigrationActionScope): void {
    const fingerprint = this.currentItemFingerprint(run.run_id, run.inventory_revision)
    if (!hasConsent(this.db, {
      runId: run.run_id,
      vaultId: run.vault_id,
      inventoryRevision: run.inventory_revision,
      itemKey: item.itemKey,
      actionScope: scope,
      reviewedItemSetFingerprint: fingerprint,
    })) {
      throw new DiaryMigrationError('diary-migration-consent-required', 409, 'An explicit action consent is required.', { scope })
    }
  }

  private grantRequestedConsent(run: NonNullable<ReturnType<typeof getRun>>, item: MigrationItemRecord, scope: MigrationActionScope): void {
    const fingerprint = this.currentItemFingerprint(run.run_id, run.inventory_revision)
    if (hasConsent(this.db, {
      runId: run.run_id,
      vaultId: run.vault_id,
      inventoryRevision: run.inventory_revision,
      itemKey: item.itemKey,
      actionScope: scope,
      reviewedItemSetFingerprint: fingerprint,
    })) return
    grantConsent(this.db, {
      runId: run.run_id,
      vaultId: run.vault_id,
      inventoryRevision: run.inventory_revision,
      itemKey: item.itemKey,
      actionScope: scope,
      reviewedGeneration: asGeneration(item.reviewedSourceGeneration, item.sourceParentGeneration),
      reviewedItemSetFingerprint: fingerprint,
    })
  }

  /** Revalidate the structural whole-session snapshot before an AI
   * disposition.  Message bodies are intentionally not retained or returned;
   * a changed/deleted message identity is enough to invalidate a previous
   * whole-session decision and require a fresh unlocked scan. */
  private ensureAiSnapshot(run: NonNullable<ReturnType<typeof getRun>>, item: MigrationItemRecord): void {
    if (item.aiSessionId === null) {
      throw new DiaryMigrationError('diary-migration-attention-required', 409, 'AI session identity is unavailable.')
    }
    const rows = this.db.prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY id').all(item.aiSessionId) as Array<{ id: number }>
    const current = rows.map((row) => Number(row.id))
    const reviewed = [...item.aiMessageIds].map(Number).sort((a, b) => a - b)
    if (current.length !== reviewed.length || current.some((id, index) => id !== reviewed[index])) {
      invalidateConsents(this.db, run.run_id, run.inventory_revision, item.itemKey)
      updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, {
        state: 'CONSENT_REQUIRED',
        classification: 'CONSENT_REQUIRED',
        attentionCode: 'diary-migration-consent-required',
      })
      throw new DiaryMigrationError('diary-migration-consent-required', 409, 'AI session changed after inventory.')
    }
  }

  private async migratePrimary(
    run: NonNullable<ReturnType<typeof getRun>>,
    item: MigrationItemRecord,
    operation: MigrationBodyOperation,
  ): Promise<void> {
    if (!item.documentId) {
      updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, { state: 'NEEDS_ATTENTION', attentionCode: 'diary-migration-identity-missing' })
      throw new DiaryMigrationError('diary-migration-identity-missing', 409, 'Diary metadata identity is required before migration.')
    }
    const source = await this.fs.readSource(item.canonicalPath).catch((error) => {
      if (error instanceof DiaryMigrationFsError && error.code === 'SOURCE_MISSING') {
        updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, { state: 'NEEDS_ATTENTION', classification: 'PRIMARY_MISSING', attentionCode: 'diary-migration-primary-missing' })
        throw new DiaryMigrationError('diary-migration-primary-missing', 409, 'Diary primary is missing.')
      }
      throw error
    })
    if (item.reviewedSourceGeneration && !sameGeneration(item.reviewedSourceGeneration, asGeneration(source.generation, source.parentGeneration))) {
      invalidateConsents(this.db, run.run_id, run.inventory_revision, item.itemKey)
      updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, { state: 'CONSENT_REQUIRED', classification: 'CONSENT_REQUIRED', attentionCode: 'diary-migration-consent-required' })
      throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Diary primary changed since the inventory was reviewed.')
    }
    const context = { documentId: item.documentId, logicalPath: item.canonicalPath }
    let decoded
    try { decoded = operation.decrypt(source.bytes, context) } catch (error) {
      if (isBodyLeaseLifecycleError(error)) throw error
      const classification = safeClassificationFromCrypto(error)
      updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, { state: 'NEEDS_ATTENTION', classification, attentionCode: codeForClassification(classification) })
      throw new DiaryMigrationError(codeForClassification(classification) ?? 'diary-migration-malformed-envelope', 422, 'Diary envelope could not be authenticated.')
    }
    if (decoded.encrypted) {
      updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, {
        classification: 'ALREADY_ENCRYPTED_VALID',
        state: 'COMPLETE',
        envelopeVersion: 1,
        targetGeneration: asGeneration(source.generation, source.parentGeneration),
        attentionCode: null,
      })
      return
    }
    const transactionId = item.transactionId ?? randomUUID()
    updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, {
      state: 'PREPARING',
      transactionId,
      sourceGeneration: source.generation,
      sourceParentGeneration: source.parentGeneration,
      reviewedSourceGeneration: asGeneration(source.generation, source.parentGeneration),
      lastActionScope: 'MIGRATE_PRIMARY',
      attentionCode: null,
    })
    operation.assertCurrent()
    const ciphertext = operation.encrypt(decoded.raw, context)
    const authenticated = operation.decrypt(ciphertext, context)
    if (!authenticated.encrypted || authenticated.raw !== decoded.raw) {
      updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, { state: 'NEEDS_ATTENTION', attentionCode: 'diary-migration-candidate-mismatch' })
      throw new DiaryMigrationError('diary-migration-candidate-mismatch', 409, 'Encrypted candidate verification failed.')
    }
    let candidate
    try {
      candidate = await this.fs.writeCiphertextTemp(item.canonicalPath, transactionId, ciphertext)
      // The candidate write is the first durable migration artifact.  A
      // logout/expiry/capability replacement that lands while the filesystem
      // call is in flight must fence the subsequent ledger publication; the
      // candidate remains resumable, but it is never reported as a prepared
      // result by a stale lease.
      operation.assertCurrent()
    } catch (error) {
      if (error instanceof DiaryMigrationFsError) {
        const code = error.code === 'DURABILITY_UNKNOWN' || error.code === 'DURABILITY_FAILED'
          ? 'diary-migration-durability-pending'
          : error.code === 'TARGET_OCCUPIED'
            ? 'diary-migration-external-mutation'
            : 'diary-migration-filesystem-unsupported'
        updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, {
          state: error.code === 'TARGET_OCCUPIED' ? 'NEEDS_ATTENTION' : 'DURABILITY_PENDING',
          classification: error.code === 'TARGET_OCCUPIED' ? 'EXTERNAL_PATH_CONFLICT' : 'UNSUPPORTED',
          candidateDurability: error.code === 'DURABILITY_UNKNOWN' ? 'UNKNOWN' : 'FAILED',
          attentionCode: code,
        })
        throw new DiaryMigrationError(code, code === 'diary-migration-filesystem-unsupported' ? 503 : 409, 'Ciphertext candidate could not be prepared.')
      }
      throw error
    }
    const stillOwned = await this.fs.sourceGenerationMatches(item.canonicalPath, source.generation, source.parentGeneration)
    operation.assertCurrent()
    if (!stillOwned) {
      invalidateConsents(this.db, run.run_id, run.inventory_revision, item.itemKey)
      updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, {
        state: 'CONSENT_REQUIRED',
        classification: 'CONSENT_REQUIRED',
        candidateName: candidate.name,
        candidateGeneration: candidate.generation,
        candidateParentGeneration: candidate.parentGeneration,
        candidateDurability: candidate.durability,
        ciphertextFingerprint: candidate.fingerprint,
        attentionCode: 'diary-migration-consent-required',
      })
      throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Diary primary changed during preparation.')
    }
    updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, {
      state: 'USER_FINALIZE_REQUIRED',
      classification: 'USER_FINALIZE_REQUIRED',
      candidateName: candidate.name,
      candidateGeneration: candidate.generation,
      candidateParentGeneration: candidate.parentGeneration,
      candidateDurability: candidate.durability,
      ciphertextFingerprint: candidate.fingerprint,
      envelopeVersion: 1,
      attentionCode: 'diary-migration-user-finalize-required',
      finalizeCapability: this.fs.selectFinalizeCapability(),
    })
  }

  private cleanupPrivateSqlite(run: NonNullable<ReturnType<typeof getRun>>, item: MigrationItemRecord): void {
    if (!item.documentId) return
    const publicationVerified = item.classification === 'ALREADY_ENCRYPTED_VALID'
      || item.state === 'PUBLISHED'
      || (['CLEANUP_PENDING', 'COMPLETE'].includes(item.state) && item.targetGeneration !== null)
    if (!publicationVerified) {
      throw new DiaryMigrationError('diary-migration-cleanup-pending', 409, 'Encrypted primary publication must be verified before private cleanup.')
    }
    const date = diaryDateFromPath(item.canonicalPath)
    const title = date ? String(date) : item.canonicalPath.split('/').pop() ?? item.canonicalPath
    const transaction = this.db.transaction(() => {
      const current = this.db.prepare('SELECT id, path FROM documents WHERE id = ? AND path = ?').get(item.documentId, item.canonicalPath) as { id: string; path: string } | undefined
      if (!current) throw new DiaryMigrationError('diary-migration-identity-missing', 409, 'Diary metadata identity changed during cleanup.')
      this.db.prepare("UPDATE documents SET title = ?, summary = '', updated_at = updated_at WHERE id = ? AND path = ?").run(title, item.documentId, item.canonicalPath)
      this.db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(item.documentId)
      this.db.prepare('DELETE FROM document_embeddings WHERE document_id = ?').run(item.documentId)
      const hasHistoryRevisions = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_metadata_revisions'").get()
      if (hasHistoryRevisions) {
        const mixedHistory = this.db.prepare(`
          SELECT 1 FROM history_metadata_revisions
          WHERE path_at_revision = ? AND (document_id IS NULL OR document_id != ?)
          LIMIT 1
        `).get(item.canonicalPath, item.documentId)
        if (mixedHistory) throw new DiaryMigrationError('diary-migration-attention-required', 409, 'History metadata has mixed ownership for this Diary path.')
        this.db.prepare('DELETE FROM history_metadata_revisions WHERE document_id = ? AND path_at_revision = ?').run(item.documentId, item.canonicalPath)
      }
      const hasHistoryRestore = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_metadata_restore_journal'").get()
      if (hasHistoryRestore) {
        const rollback = this.db.prepare('SELECT 1 FROM history_metadata_restore_journal WHERE document_id = ? AND path_at_revision = ? LIMIT 1').get(item.documentId, item.canonicalPath)
        if (rollback) throw new DiaryMigrationError('diary-migration-cleanup-pending', 409, 'A History rollback dependency is still active.')
      }
      const hasMetadata = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata_migrations'").get()
      if (hasMetadata) {
        const metadataMigration = this.db.prepare(`
          SELECT path, document_id, status, source_hash, cleaned_hash,
                 frontmatter_backup, error, updated_at
          FROM metadata_migrations
          WHERE document_id = ? AND path = ?
        `).get(item.documentId, item.canonicalPath) as Record<string, unknown> | undefined
        if (metadataMigration && item.frontmatterRowCas) {
          const cas = item.frontmatterRowCas
          const matches = cas.status === metadataMigration.status
            && Number(cas.updatedAt) === Number(metadataMigration.updated_at)
            && cas.documentIdNull === (metadataMigration.document_id === null)
            && cas.sourceHash === metadataMigration.source_hash
            && cas.cleanedHash === metadataMigration.cleaned_hash
            && cas.frontmatterBackupDigest === digestStructuralValue(metadataMigration.frontmatter_backup)
            && cas.errorDigest === digestStructuralValue(metadataMigration.error)
          if (!matches) throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Frontmatter metadata changed after inventory.')
          if (metadataMigration.status !== 'cleaned') {
            const result = this.db.prepare(`
              UPDATE metadata_migrations
              SET status = 'cleaned', frontmatter_backup = '', source_hash = '', cleaned_hash = '', error = '', updated_at = ?
              WHERE path = ? AND document_id = ? AND status = ? AND source_hash = ?
                AND cleaned_hash = ? AND frontmatter_backup = ? AND error = ? AND updated_at = ?
            `).run(
              this.now(), item.canonicalPath, item.documentId,
              metadataMigration.status, metadataMigration.source_hash,
              metadataMigration.cleaned_hash, metadataMigration.frontmatter_backup,
              metadataMigration.error, metadataMigration.updated_at,
            )
            if (result.changes !== 1) throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Frontmatter metadata changed during cleanup.')
          }
        } else if (metadataMigration && metadataMigration.status !== 'cleaned') {
          throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Frontmatter metadata provenance was not reviewed.')
        }
      }
      const hasTagUndo = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tag_undo_association_deltas'").get()
      if (hasTagUndo) {
        const records = this.db.prepare(`
          SELECT DISTINCT d.record_id, r.operation_json
          FROM tag_undo_association_deltas d
          JOIN tag_undo_records r ON r.record_id = d.record_id
          WHERE d.document_id = ?
        `).all(item.documentId) as Array<{ record_id: string; operation_json: string }>
        for (const record of records) {
          try { JSON.parse(record.operation_json) } catch {
            throw new DiaryMigrationError('diary-migration-attention-required', 409, 'Managed tag undo provenance is malformed.')
          }
          const other = this.db.prepare('SELECT 1 FROM tag_undo_association_deltas WHERE record_id = ? AND document_id != ? LIMIT 1').get(record.record_id, item.documentId)
          if (other) throw new DiaryMigrationError('diary-migration-attention-required', 409, 'Managed tag undo provenance has mixed ownership.')
          this.db.prepare('UPDATE tag_undo_state SET current_record_id = NULL, last_superseded_record_id = ?, updated_at = ? WHERE current_record_id = ?').run(record.record_id, this.now(), record.record_id)
          this.db.prepare('DELETE FROM tag_undo_records WHERE record_id = ?').run(record.record_id)
        }
      }
      const orphanTags = this.db.prepare('SELECT id FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags WHERE document_tags.tag_id = tags.id)').all() as Array<{ id: number }>
      for (const tag of orphanTags) this.db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id)
    })
    transaction.immediate()
    updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, { state: 'COMPLETE', attentionCode: null, lastActionScope: 'CLEAN_PRIVATE_SQLITE' })
  }

  async start(
    runId: string,
    inventoryRevision: number,
    requestedScopes: MigrationStartScope[],
    operation?: MigrationBodyOperation,
  ): Promise<MigrationStatusDTO> {
    return this.withControl(async () => withVaultMutation(this.rootDir, async () => {
      const run = this.validateRun(runId, inventoryRevision)
      if (run.state === 'COMPLETE') throw new DiaryMigrationError('diary-migration-already-complete', 409, 'Migration run is already complete.')
      if (!Array.isArray(requestedScopes) || requestedScopes.length === 0) throw new DiaryMigrationError('diary-migration-invalid-confirmation', 400, 'At least one action scope is required.')
      const items = listItems(this.db, runId, inventoryRevision)
      const byKey = new Map(items.map((item) => [item.itemKey, item]))
      const refresh = () => new Map(listItems(this.db, runId, inventoryRevision).map((item) => [item.itemKey, item]))
      for (const request of requestedScopes) {
        if (!request || !ACTION_SCOPES.includes(request.scope)) throw new DiaryMigrationError('diary-migration-invalid-confirmation', 400, 'Unknown migration action scope.')
        const item = request.itemKey ? byKey.get(request.itemKey) : items.find((candidate) => candidate.canonicalPath === '@git/retention')
        if (!item) throw new DiaryMigrationError('diary-migration-run-not-found', 404, 'Migration item was not found.')
        this.grantRequestedConsent(run, item, request.scope)
        if (request.scope === 'ACKNOWLEDGE_GIT_RETENTION') {
          updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'COMPLETE', attentionCode: null, lastActionScope: request.scope })
          continue
        }
        if (request.scope === 'MIGRATE_PRIMARY') {
          if (!operation) throw new DiaryMigrationError('diary-migration-locked', 423, 'Diary unlock is required for migration.')
          await withVaultStructureLock(() => withDocumentWriteLock(item.canonicalPath, async () => {
            const current = refresh().get(item.itemKey) ?? item
            this.ensureConsent(run, current, request.scope)
            await this.migratePrimary(run, current, operation)
          }))
        } else if (request.scope === 'CLEAN_PRIVATE_SQLITE') {
          const current = refresh().get(item.itemKey) ?? item
          this.ensureConsent(run, current, request.scope)
          if (
            current.state === 'PUBLISHED'
            || current.state === 'CLEANUP_PENDING'
            || current.state === 'COMPLETE'
            || current.classification === 'ALREADY_ENCRYPTED_VALID'
          ) await withDocumentWriteLock(current.canonicalPath, async () => { this.cleanupPrivateSqlite(run, current) })
          else throw new DiaryMigrationError('diary-migration-cleanup-pending', 409, 'Encrypted primary publication must be verified before private cleanup.')
        } else if (request.scope === 'RETAIN_AI_HISTORY') {
          const current = refresh().get(item.itemKey) ?? item
          this.ensureAiSnapshot(run, current)
          updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'COMPLETE', lastActionScope: request.scope, attentionCode: null })
        } else if (request.scope === 'DISCARD_AI_SESSION') {
          const current = refresh().get(item.itemKey) ?? item
          this.ensureAiSnapshot(run, current)
          const tx = this.db.transaction(() => {
            const existing = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(current.aiSessionId)
            if (existing) this.db.prepare('DELETE FROM sessions WHERE id = ?').run(current.aiSessionId)
          })
          tx.immediate()
          updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'COMPLETE', lastActionScope: request.scope, attentionCode: null })
        } else if (request.scope === 'BIND_FRONTMATTER_IDENTITY') {
          await this.bindFrontmatterIdentity(run, item)
        } else if (request.scope === 'REMOVE_VERIFIED_LEGACY_PRIMARY') {
          // POSIX deliberately leaves the user-controlled plaintext alone;
          // after external finalize there is no Nuvyn-owned plaintext object
          // to remove.  This scope is therefore an explicit disclosure and
          // acknowledgment of a retained user copy, never a pathname delete.
          const current = refresh().get(item.itemKey) ?? item
          if (!['PUBLISHED', 'CLEANUP_PENDING', 'COMPLETE'].includes(current.state)) {
            throw new DiaryMigrationError('diary-migration-cleanup-pending', 409, 'Encrypted primary publication must be verified before acknowledging a legacy copy.')
          }
          updateItem(this.db, runId, inventoryRevision, item.itemKey, {
            userResidualState: 'USER_CONTROLLED_PLAINTEXT_RESIDUAL',
            lastActionScope: request.scope,
          })
        } else {
          updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'NEEDS_ATTENTION', attentionCode: 'diary-migration-draft-decision-required', lastActionScope: request.scope })
        }
      }
      const finalItems = listItems(this.db, runId, inventoryRevision)
      const pending = finalItems.some((item) => !['COMPLETE', 'NEEDS_ATTENTION'].includes(item.state))
      const attention = finalItems.some((item) => item.state === 'NEEDS_ATTENTION' && item.attentionCode)
      setRunState(this.db, runId, pending || attention ? (attention ? 'ATTENTION_REQUIRED' : 'RUNNING') : 'COMPLETE', inventoryRevision)
      return this.status(runId, inventoryRevision)
    }))
  }

  private async bindFrontmatterIdentity(run: NonNullable<ReturnType<typeof getRun>>, item: MigrationItemRecord): Promise<void> {
    const metadata = getDocumentMetadata(this.db, item.canonicalPath)
    if (!metadata) throw new DiaryMigrationError('diary-migration-identity-missing', 409, 'A stable document identity is required before binding frontmatter.')
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT path, document_id, status, source_hash, cleaned_hash,
               frontmatter_backup, error, updated_at
        FROM metadata_migrations WHERE path = ?
      `).get(item.canonicalPath) as Record<string, unknown> | undefined
      if (!row || row.document_id !== null || !item.frontmatterRowCas) {
        throw new DiaryMigrationError('diary-migration-identity-ambiguous', 409, 'Frontmatter identity binding is no longer valid.')
      }
      const cas = item.frontmatterRowCas
      const matches = cas.status === row.status
        && Number(cas.updatedAt) === Number(row.updated_at)
        && cas.documentIdNull === true
        && cas.sourceHash === row.source_hash
        && cas.cleanedHash === row.cleaned_hash
        && cas.frontmatterBackupDigest === digestStructuralValue(row.frontmatter_backup)
        && cas.errorDigest === digestStructuralValue(row.error)
      if (!matches) throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Frontmatter metadata changed after inventory.')
      const result = this.db.prepare(`
        UPDATE metadata_migrations SET document_id = ?, updated_at = ?
        WHERE path = ? AND document_id IS NULL AND status = ? AND source_hash = ?
          AND cleaned_hash = ? AND frontmatter_backup = ? AND error = ? AND updated_at = ?
      `).run(
        metadata.id, this.now(), item.canonicalPath, row.status, row.source_hash,
        row.cleaned_hash, row.frontmatter_backup, row.error, row.updated_at,
      )
      if (result.changes !== 1) throw new DiaryMigrationError('diary-migration-consent-required', 409, 'Frontmatter identity changed during binding.')
    })
    transaction.immediate()
    const boundRow = this.db.prepare(`
      SELECT path, document_id, status, source_hash, cleaned_hash,
             frontmatter_backup, error, updated_at
      FROM metadata_migrations WHERE path = ? AND document_id = ?
    `).get(item.canonicalPath, metadata.id) as Record<string, unknown> | undefined
    updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, {
      documentId: metadata.id,
      state: 'CLEANUP_PENDING',
      classification: 'CLEANUP_PENDING',
      attentionCode: 'diary-migration-cleanup-pending',
      frontmatterRowCas: boundRow ? frontmatterCasFor(boundRow) : item.frontmatterRowCas,
      lastActionScope: 'BIND_FRONTMATTER_IDENTITY',
    })
  }

  async resume(runId: string, inventoryRevision: number, operation?: MigrationBodyOperation): Promise<MigrationStatusDTO> {
    return this.withControl(async () => withVaultMutation(this.rootDir, async () => {
      const run = this.validateRun(runId, inventoryRevision)
      const items = listItems(this.db, runId, inventoryRevision)
      for (const item of items) {
        if (!['USER_FINALIZE_REQUIRED', 'RECOVERY_AUTH_REQUIRED', 'CLEANUP_PENDING'].includes(item.state)) continue
        if (!operation) throw new DiaryMigrationError('diary-migration-locked', 423, 'Diary unlock is required to verify migration state.')
        if (!item.documentId) continue
        let source
        try { source = await this.fs.readSource(item.canonicalPath) } catch (error) {
          if (error instanceof DiaryMigrationFsError && error.code === 'SOURCE_MISSING') {
            updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'NEEDS_ATTENTION', classification: 'PRIMARY_MISSING', attentionCode: 'diary-migration-primary-missing' })
            continue
          }
          throw error
        }
        if (!item.ciphertextFingerprint) {
          if (item.state !== 'RECOVERY_AUTH_REQUIRED' && item.classification !== 'RECOVERY_AUTH_REQUIRED') continue
          try {
            const decoded = operation.decrypt(source.bytes, {
              documentId: item.documentId,
              logicalPath: item.canonicalPath,
            })
            updateItem(this.db, runId, inventoryRevision, item.itemKey, decoded.encrypted
              ? {
                  state: 'COMPLETE',
                  classification: 'ALREADY_ENCRYPTED_VALID',
                  envelopeVersion: 1,
                  targetGeneration: asGeneration(source.generation, source.parentGeneration),
                  reviewedSourceGeneration: asGeneration(source.generation, source.parentGeneration),
                  attentionCode: null,
                }
              : {
                  state: 'READY',
                  classification: 'LEGACY_PLAINTEXT',
                  reviewedSourceGeneration: asGeneration(source.generation, source.parentGeneration),
                  attentionCode: null,
                })
          } catch (error) {
            if (isBodyLeaseLifecycleError(error)) throw error
            const classification = safeClassificationFromCrypto(error)
            updateItem(this.db, runId, inventoryRevision, item.itemKey, {
              state: 'NEEDS_ATTENTION',
              classification,
              attentionCode: codeForClassification(classification),
            })
          }
          continue
        }
        if (!isEncryptedDiaryBody(source.bytes)) {
          const unchanged = item.reviewedSourceGeneration
            ? sameGeneration(item.reviewedSourceGeneration, asGeneration(source.generation, source.parentGeneration))
            : false
          if (unchanged) {
            updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'USER_FINALIZE_REQUIRED', classification: 'USER_FINALIZE_REQUIRED', attentionCode: 'diary-migration-user-finalize-required' })
          } else {
            invalidateConsents(this.db, runId, inventoryRevision, item.itemKey)
            updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'CONSENT_REQUIRED', classification: 'CONSENT_REQUIRED', attentionCode: 'diary-migration-consent-required' })
          }
          continue
        }
        const currentFingerprint = fingerprintCiphertext(source.bytes)
        if (currentFingerprint !== item.ciphertextFingerprint) {
          updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'NEEDS_ATTENTION', classification: 'NEEDS_ATTENTION', attentionCode: 'diary-migration-candidate-mismatch' })
          continue
        }
        try {
          const decoded = operation.decrypt(source.bytes, { documentId: item.documentId, logicalPath: item.canonicalPath })
          if (!decoded.encrypted) throw new Error('candidate is not encrypted')
        } catch (error) {
          if (isBodyLeaseLifecycleError(error)) throw error
          updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'NEEDS_ATTENTION', classification: 'ENCRYPTED_MALFORMED', attentionCode: 'diary-migration-malformed-envelope' })
          continue
        }
        const durability = await this.fs.syncDurability(source.absolutePath).catch(() => null)
        if (durability !== 'DURABLE') {
          updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'DURABILITY_PENDING', classification: 'DURABILITY_PENDING', attentionCode: 'diary-migration-durability-pending' })
          continue
        }
        if (item.candidateName && !isMigrationCandidateName(item.candidateName)) {
          updateItem(this.db, runId, inventoryRevision, item.itemKey, {
            state: 'NEEDS_ATTENTION',
            classification: 'NEEDS_ATTENTION',
            attentionCode: 'diary-migration-unsafe-path',
          })
          continue
        }
        updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'PUBLISHED', classification: 'CLEANUP_PENDING', targetGeneration: asGeneration(source.generation, source.parentGeneration), attentionCode: null })
        if (item.candidateName) {
          try {
            const target = path.join(path.dirname(source.absolutePath), item.candidateName)
            await this.fs.removeCiphertextCandidate(target, item.ciphertextFingerprint)
          } catch (error) {
            if (!(error instanceof DiaryMigrationFsError && error.code === 'SOURCE_MISSING')) {
              updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'CLEANUP_PENDING', classification: 'CLEANUP_PENDING', attentionCode: 'diary-migration-cleanup-pending' })
            }
          }
        }
        const refreshed = getItem(this.db, runId, inventoryRevision, item.itemKey)
        if (refreshed && hasConsent(this.db, {
          runId,
          vaultId: run.vault_id,
          inventoryRevision,
          itemKey: item.itemKey,
          actionScope: 'CLEAN_PRIVATE_SQLITE',
          reviewedItemSetFingerprint: this.currentItemFingerprint(runId, inventoryRevision),
        })) await withDocumentWriteLock(refreshed.canonicalPath, async () => { this.cleanupPrivateSqlite(run, refreshed) })
        else updateItem(this.db, runId, inventoryRevision, item.itemKey, { state: 'CLEANUP_PENDING', classification: 'CLEANUP_PENDING', attentionCode: 'diary-migration-cleanup-pending' })
      }
      const finalItems = listItems(this.db, runId, inventoryRevision)
      const pending = finalItems.some((item) => !['COMPLETE', 'NEEDS_ATTENTION'].includes(item.state))
      const attention = finalItems.some((item) => item.state === 'NEEDS_ATTENTION' && item.attentionCode)
      setRunState(this.db, runId, pending || attention ? (attention ? 'ATTENTION_REQUIRED' : 'RUNNING') : 'COMPLETE', inventoryRevision)
      return this.status(runId, inventoryRevision)
    }))
  }

  async resolve(
    runId: string,
    inventoryRevision: number,
    itemKey: string,
    action: MigrationResolveAction,
    confirmation?: string,
    operation?: MigrationBodyOperation,
  ): Promise<MigrationStatusDTO> {
    return this.withControl(async () => withVaultMutation(this.rootDir, async () => {
      const run = this.validateRun(runId, inventoryRevision)
      const item = getItem(this.db, runId, inventoryRevision, itemKey)
      if (!item) throw new DiaryMigrationError('diary-migration-run-not-found', 404, 'Migration item was not found.')
      if (action === 'acknowledge-attention') return this.status(runId, inventoryRevision)
      if (action === 'adopt-metadata') {
        const date = diaryDateFromPath(item.canonicalPath)
        if (!date) throw new DiaryMigrationError('diary-migration-unsafe-path', 409, 'Only canonical Diary paths may adopt metadata.')
        const existing = getDocumentMetadata(this.db, item.canonicalPath)
        if (!existing) {
          createDocumentMetadata(this.db, { path: item.canonicalPath, title: String(date), summary: '', tags: [], mood: null, createdAt: this.now(), updatedAt: this.now() })
        }
        const metadata = getDocumentMetadata(this.db, item.canonicalPath)
        if (!metadata) throw new DiaryMigrationError('diary-migration-identity-missing', 409, 'Metadata adoption did not produce an identity.')
        const resolvedKey = encodeItemKey(run.vault_id, metadata.id, item.canonicalPath)
        let nextClassification: MigrationClassification = 'LEGACY_PLAINTEXT'
        let nextState: MigrationItemRecord['state'] = 'NEEDS_UNLOCK'
        let nextSourceGeneration = item.sourceGeneration
        let nextParentGeneration = item.sourceParentGeneration
        try {
          const source = await this.fs.readSource(item.canonicalPath)
          nextSourceGeneration = source.generation
          nextParentGeneration = source.parentGeneration
          if (isEncryptedDiaryBody(source.bytes)) nextClassification = 'RECOVERY_AUTH_REQUIRED'
        } catch (error) {
          if (error instanceof DiaryMigrationFsError && error.code === 'SOURCE_MISSING') {
            nextClassification = 'PRIMARY_MISSING'
            nextState = 'NEEDS_ATTENTION'
          } else if (error instanceof DiaryMigrationFsError) {
            nextClassification = 'NEEDS_ATTENTION'
            nextState = 'NEEDS_ATTENTION'
          } else throw error
        }
        const currentFrontmatter = this.db.prepare('SELECT path, document_id, status, source_hash, cleaned_hash, frontmatter_backup, error, updated_at FROM metadata_migrations WHERE path = ? AND document_id = ?').get(item.canonicalPath, metadata.id) as Record<string, unknown> | undefined
        try {
          this.db.prepare(`
            UPDATE diary_migration_items
            SET item_key = ?, document_id = ?, classification = ?, state = ?,
                source_generation_json = ?, source_parent_generation_json = ?,
                reviewed_source_generation_json = ?, frontmatter_row_cas_json = ?,
                attention_code = ?, updated_at = ?
            WHERE run_id = ? AND inventory_revision = ? AND item_key = ?
          `).run(
            resolvedKey,
            metadata.id,
            nextClassification,
            nextState,
            nextSourceGeneration ? JSON.stringify(nextSourceGeneration) : null,
            nextParentGeneration ? JSON.stringify(nextParentGeneration) : null,
            asGeneration(nextSourceGeneration, nextParentGeneration) ? JSON.stringify(asGeneration(nextSourceGeneration, nextParentGeneration)) : null,
            currentFrontmatter ? JSON.stringify(frontmatterCasFor(currentFrontmatter)) : null,
            codeForClassification(nextClassification),
            this.now(),
            runId,
            inventoryRevision,
            itemKey,
          )
        } catch {
          throw new DiaryMigrationError('diary-migration-identity-ambiguous', 409, 'Metadata identity is already claimed by another item.')
        }
        return this.status(runId, inventoryRevision)
      }
      if (action === 'bind-frontmatter-identity') {
        this.grantRequestedConsent(run, item, 'BIND_FRONTMATTER_IDENTITY')
        this.ensureConsent(run, item, 'BIND_FRONTMATTER_IDENTITY')
        if (!operation) throw new DiaryMigrationError('diary-migration-locked', 423, 'Diary unlock is required for identity binding.')
        await withDocumentWriteLock(item.canonicalPath, async () => { await this.bindFrontmatterIdentity(run, item) })
        return this.status(runId, inventoryRevision)
      }
      if (action === 'discard-draft') {
        if (confirmation !== 'DISCARD LEGACY DIARY RECOVERY') throw new DiaryMigrationError('diary-migration-invalid-confirmation', 400, 'Typed confirmation is invalid.')
        this.grantRequestedConsent(run, item, 'DISCARD_DRAFT')
        this.ensureConsent(run, item, 'DISCARD_DRAFT')
        updateItem(this.db, runId, inventoryRevision, itemKey, { state: 'COMPLETE', attentionCode: null, lastActionScope: 'DISCARD_DRAFT' })
        return this.status(runId, inventoryRevision)
      }
      if (action === 'import-to-primary') {
        if (!operation) throw new DiaryMigrationError('diary-migration-locked', 423, 'Diary unlock is required for Draft import.')
        this.grantRequestedConsent(run, item, 'IMPORT_DRAFT')
        this.ensureConsent(run, item, 'IMPORT_DRAFT')
        await withDocumentWriteLock(item.canonicalPath, async () => {
          if (!item.documentId) throw new DiaryMigrationError('diary-migration-identity-missing', 409, 'A stable Diary identity is required before Draft import.')
          let source
          try { source = await this.fs.readSource(item.canonicalPath) } catch (error) {
            if (error instanceof DiaryMigrationFsError && error.code === 'SOURCE_MISSING') {
              updateItem(this.db, runId, inventoryRevision, itemKey, { state: 'NEEDS_ATTENTION', classification: 'PRIMARY_MISSING', attentionCode: 'diary-migration-primary-missing' })
              throw new DiaryMigrationError('diary-migration-primary-missing', 409, 'Diary primary is missing.')
            }
            throw error
          }
          try {
            const decoded = operation.decrypt(source.bytes, {
              documentId: item.documentId,
              logicalPath: item.canonicalPath,
            })
            if (!decoded.encrypted) throw new DiaryMigrationError('diary-migration-draft-decision-required', 409, 'Draft import requires an encrypted primary readback.')
          } catch (error) {
            if (error instanceof DiaryMigrationError) throw error
            if (isBodyLeaseLifecycleError(error)) throw error
            const classification = safeClassificationFromCrypto(error)
            updateItem(this.db, runId, inventoryRevision, itemKey, { state: 'NEEDS_ATTENTION', classification, attentionCode: codeForClassification(classification) })
            throw new DiaryMigrationError(codeForClassification(classification) ?? 'diary-migration-malformed-envelope', 422, 'Diary primary authentication failed during Draft import.')
          }
          updateItem(this.db, runId, inventoryRevision, itemKey, {
            state: 'CLEANUP_PENDING',
            classification: 'CLEANUP_PENDING',
            targetGeneration: asGeneration(source.generation, source.parentGeneration),
            envelopeVersion: 1,
            attentionCode: 'diary-migration-cleanup-pending',
            lastActionScope: 'IMPORT_DRAFT',
          })
        })
        return this.status(runId, inventoryRevision)
      }
      if (action === 'discard-ai-session' || action === 'retain-ai-history') {
        const scope = action === 'discard-ai-session' ? 'DISCARD_AI_SESSION' : 'RETAIN_AI_HISTORY'
        this.ensureAiSnapshot(run, item)
        this.grantRequestedConsent(run, item, scope)
        this.ensureConsent(run, item, scope)
        if (action === 'discard-ai-session' && !operation) throw new DiaryMigrationError('diary-migration-locked', 423, 'Diary unlock is required for AI disposition.')
        if (action === 'discard-ai-session' && item.aiSessionId) {
          const tx = this.db.transaction(() => this.db.prepare('DELETE FROM sessions WHERE id = ?').run(item.aiSessionId))
          tx.immediate()
          updateItem(this.db, runId, inventoryRevision, itemKey, { state: 'COMPLETE', attentionCode: null, lastActionScope: scope })
        } else {
          updateItem(this.db, runId, inventoryRevision, itemKey, { state: 'COMPLETE', attentionCode: null, lastActionScope: scope })
        }
        return this.status(runId, inventoryRevision)
      }
      if (action === 'retry-item') {
        if (item.classification === 'LEGACY_PLAINTEXT' || item.classification === 'USER_FINALIZE_REQUIRED') {
          if (!operation) throw new DiaryMigrationError('diary-migration-locked', 423, 'Diary unlock is required to retry migration.')
          this.ensureConsent(run, item, 'MIGRATE_PRIMARY')
          await withVaultStructureLock(() => withDocumentWriteLock(item.canonicalPath, () => this.migratePrimary(run, item, operation)))
        }
      }
      return this.status(runId, inventoryRevision)
    }))
  }

  /** Startup-only structural recovery. It never decrypts or mutates plaintext. */
  async recover(): Promise<{ actions: string[] }> {
    const actions: string[] = []
    const runs = this.db.prepare("SELECT run_id, inventory_revision, vault_id FROM diary_migration_runs WHERE state != 'COMPLETE' ORDER BY inventory_revision").all() as Array<{ run_id: string; inventory_revision: number; vault_id: string }>
    for (const run of runs) {
      const items = listItems(this.db, run.run_id, run.inventory_revision)
      for (const item of items) {
        if (!item.candidateName || !['PREPARING', 'ENCRYPTED_VERIFIED', 'USER_FINALIZE_REQUIRED', 'RECOVERY_AUTH_REQUIRED'].includes(item.state)) continue
        if (!isMigrationCandidateName(item.candidateName)) {
          updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, {
            state: 'NEEDS_ATTENTION',
            classification: 'NEEDS_ATTENTION',
            attentionCode: 'diary-migration-unsafe-path',
          })
          actions.push(`mark unsafe candidate ${item.canonicalPath}`)
          continue
        }
        const candidatePath = path.join(this.rootDir, 'diary', item.candidateName)
        let durable = false
        try {
          durable = Boolean(item.ciphertextFingerprint && await this.fs.verifyCiphertextArtifact(candidatePath, item.ciphertextFingerprint))
        } catch { durable = false }
        if (durable && item.finalizeCapability === 'USER_FINALIZE_REQUIRED') {
          updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, { state: 'USER_FINALIZE_REQUIRED', classification: 'USER_FINALIZE_REQUIRED', candidateDurability: 'DURABLE', attentionCode: 'diary-migration-user-finalize-required' })
          actions.push(`resume user-finalize ${item.canonicalPath}`)
        } else if (!durable && item.state === 'PREPARING') {
          updateItem(this.db, run.run_id, run.inventory_revision, item.itemKey, { state: 'NEEDS_UNLOCK', classification: 'NEEDS_ATTENTION', attentionCode: 'diary-migration-candidate-missing' })
          actions.push(`mark candidate attention ${item.canonicalPath}`)
        }
      }
    }
    return { actions }
  }

  /** Read-only helper for tests and diagnostics; does not expose blob text. */
  async gitExposureSummary(): Promise<{ available: boolean; refs: number; commits: number; unreachable: number }> {
    if (!await isRepo(this.rootDir).catch(() => false)) return { available: false, refs: 0, commits: 0, unreachable: 0 }
    const [refs, commits, fsck] = await Promise.all([
      runGit(this.rootDir, ['for-each-ref', '--format=%(refname)']).catch(() => ({ status: -1, stdout: '', stderr: '' })),
      runGit(this.rootDir, ['rev-list', '--all', '--count']).catch(() => ({ status: -1, stdout: '', stderr: '' })),
      runGit(this.rootDir, ['fsck', '--no-reflogs', '--unreachable']).catch(() => ({ status: -1, stdout: '', stderr: '' })),
    ])
    return {
      available: refs.status === 0,
      refs: refs.stdout.split('\n').filter(Boolean).length,
      commits: Number.parseInt(commits.stdout.trim(), 10) || 0,
      unreachable: fsck.stdout.split('\n').filter((line) => line.includes('unreachable')).length,
    }
  }
}

let singleton: DiaryMigrationService | null = null
let singletonDb: DatabaseT | null = null
let singletonRoot = ''

export function getDiaryMigrationService(db: DatabaseT, rootDir: string): DiaryMigrationService {
  const resolvedRoot = path.resolve(rootDir)
  if (!singleton || singletonDb !== db || singletonRoot !== resolvedRoot) {
    singleton = new DiaryMigrationService({ db, rootDir })
    singletonDb = db
    singletonRoot = resolvedRoot
  }
  return singleton
}

export function resetDiaryMigrationServiceForTesting(): void {
  singleton = null
  singletonDb = null
  singletonRoot = ''
}
