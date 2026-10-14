import type { Database as DatabaseT } from 'better-sqlite3'
import type {
  AttachmentAuditEntry,
  AttachmentAuditOperation,
  AttachmentAuditWorkspace,
} from '../../shared/attachmentProtocol.js'
import { isAssetId } from '../../shared/assetProtocol.js'

const MAX_AUDIT_ENTRIES = 500
const AUDIT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'])

export function isSafeVaultImageIdentity(value: string): boolean {
  if (!value || value.length > 1024 || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) {
    return false
  }
  const segments = value.split('/')
  const fileName = segments.at(-1) ?? ''
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  return segments.length > 0
    && segments[0]?.toLowerCase() !== 'diary'
    && segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))
    && AUDIT_IMAGE_EXTENSIONS.has(extension)
}

export interface AttachmentAuditInput {
  operation: AttachmentAuditOperation
  resourceType: AttachmentAuditEntry['resourceType']
  resourceId: string
  sourceWorkspace: Extract<AttachmentAuditWorkspace, 'local-file' | 'vault-image' | 'board-asset'>
  sourceResourceId?: string | null
  targetWorkspace: AttachmentAuditEntry['targetWorkspace']
  targetWorkspaceId?: string | null
  result: AttachmentAuditEntry['result']
  failureCategory?: AttachmentAuditEntry['failureCategory']
  occurredAt?: number
}

interface AuditRow {
  id: number
  operation: AttachmentAuditOperation
  resource_type: AttachmentAuditEntry['resourceType']
  resource_id: string
  source_workspace: AttachmentAuditInput['sourceWorkspace']
  source_resource_id: string | null
  target_workspace: AttachmentAuditEntry['targetWorkspace']
  target_workspace_id: string | null
  result: AttachmentAuditEntry['result']
  failure_category: AttachmentAuditEntry['failureCategory']
  occurred_at: number
}

export function recordAttachmentOperation(db: DatabaseT, input: AttachmentAuditInput): void {
  if (!isAssetId(input.resourceId)) return
  if (input.sourceResourceId !== undefined && input.sourceResourceId !== null) {
    const safeSource = input.sourceWorkspace === 'board-asset'
      ? isAssetId(input.sourceResourceId)
      : input.sourceWorkspace === 'vault-image'
        && input.sourceResourceId.length <= 128
        && isSafeVaultImageIdentity(input.sourceResourceId)
    if (!safeSource) return
  }
  if (input.targetWorkspaceId !== undefined && input.targetWorkspaceId !== null
    && (input.targetWorkspace !== 'board' || !isAssetId(input.targetWorkspaceId))) return
  const occurredAt = input.occurredAt ?? Date.now()
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return
  db.transaction(() => {
    db.prepare(`
      INSERT INTO attachment_operation_audit (
        operation, resource_type, resource_id, source_workspace, source_resource_id,
        target_workspace, target_workspace_id, result, failure_category, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.operation,
      input.resourceType,
      input.resourceId,
      input.sourceWorkspace,
      input.sourceResourceId?.slice(0, 128) ?? null,
      input.targetWorkspace,
      input.targetWorkspaceId?.slice(0, 128) ?? null,
      input.result,
      input.result === 'success' ? null : input.failureCategory ?? 'unknown',
      occurredAt,
    )
    db.prepare(`
      DELETE FROM attachment_operation_audit
      WHERE id NOT IN (
        SELECT id FROM attachment_operation_audit ORDER BY id DESC LIMIT ?
      )
    `).run(MAX_AUDIT_ENTRIES)
  }).immediate()
}

export function listAttachmentOperations(db: DatabaseT, limit = 50): AttachmentAuditEntry[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const rows = db.prepare(`
    SELECT id, operation, resource_type, resource_id, source_workspace, source_resource_id,
      target_workspace, target_workspace_id, result, failure_category, occurred_at
    FROM attachment_operation_audit
    ORDER BY id DESC
    LIMIT ?
  `).all(safeLimit) as AuditRow[]
  return rows.map((row) => ({
    id: row.id,
    operation: row.operation,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    sourceWorkspace: row.source_workspace,
    sourceResourceId: row.source_resource_id,
    targetWorkspace: row.target_workspace,
    targetWorkspaceId: row.target_workspace_id,
    result: row.result,
    failureCategory: row.failure_category,
    occurredAt: row.occurred_at,
  }))
}

export function attachmentFailureCategory(error: unknown): NonNullable<AttachmentAuditEntry['failureCategory']> {
  const code = String((error as { code?: unknown } | null)?.code ?? '').toUpperCase()
  if (/INVALID|UNSUPPORTED|TOO_LARGE|MISMATCH|VALIDATION/u.test(code)) return 'validation'
  if (/AUTH|SESSION|DIARY|LOCKED/u.test(code)) return 'authorization'
  if (/STORAGE|FILE|IO/u.test(code)) return 'storage'
  if (/NOT_FOUND|STALE|CONFLICT/u.test(code)) return 'stale-target'
  return 'unknown'
}

export const __testing__ = { MAX_AUDIT_ENTRIES }
