// Edit-10.3: strict server-side validation of the client's send-time
// live workspace snapshot (AiLiveContextSnapshot, sealed in
// src/composables/vault/aiLiveContext.ts).
//
// parseAiLiveContext is the ONLY door through which a request body's
// liveContext field may become a trusted AiLiveContextSnapshot. The
// route layer calls it BEFORE the SSE stream starts:
//
//   ok         → ChatContext { kind: 'live', value } for this run only
//   invalid    → 400 { ok: false, reason: 'invalid-live-context' }
//   oversized  → 413 { ok: false, reason: 'context-too-large' }
//
// A malformed liveContext is a hard reject — it NEVER falls back to
// the legacy currentNotePath hint.
//
// Strictness, on purpose:
//   - size is checked BEFORE structure (oversized + malformed →
//     context-too-large, so the client can surface the right reason)
//   - exact key sets per kind: unknown keys are rejected, so a body
//     cannot smuggle filesystemPath / absolutePath / currentNotePath /
//     currentNoteContent / attachments past this door
//   - vault-relative logical paths only (no absolute paths, Windows
//     drives, "..", backslash bypasses, uppercase, mid-path ".md")
//   - no NUL bytes in any string
//   - cross-field invariants from the sealed capture contract:
//     dirty === (revision !== savedRevision); external kind/raw
//     pairing; diff after.source / currentDocumentId pairing;
//     recovery view / disk pairing
//   - union membership runs through exhaustive Record<Union, true>
//     tables: a client union member missing server-side is a
//     typecheck error, not a silent accept
import type { AiLiveContextSnapshot } from '../../src/composables/vault/aiLiveContext.js'
import type { ExternalChangeKind, SaveStatus } from '../../src/components/vault/tabs.js'
import type { DraftRecoveryDecisionKind } from '../../src/composables/vault/draft-recovery/draftRecoveryDecision.js'
import { normalizeLogicalContentPath } from '../paths.js'

/** Hard cap on the serialized snapshot: UTF-8 bytes of JSON.stringify. */
export const MAX_AI_LIVE_CONTEXT_BYTES = 512 * 1024

const MAX_ID_CHARS = 512
const MAX_TITLE_CHARS = 512
const MAX_PATH_CHARS = 1024

// Built at runtime so the source stays pure ASCII — an embedded
// control character in source is invisible and fragile.
const NUL = String.fromCharCode(0)

export type ParseAiLiveContextResult =
  | { ok: true; value: AiLiveContextSnapshot }
  | { ok: false; reason: 'invalid-live-context' | 'context-too-large' }

const INVALID: ParseAiLiveContextResult = { ok: false, reason: 'invalid-live-context' }
const TOO_LARGE: ParseAiLiveContextResult = { ok: false, reason: 'context-too-large' }

// ── Compile-time union sync ─────────────────────────────────────────
// `satisfies readonly Union[]` rejects EXTRA members at the literal;
// the Record<Union, true> target of exhaustiveTable rejects MISSING
// ones. Client/server union drift fails `npm run typecheck`.
function exhaustiveTable<K extends string>(values: readonly K[]): Record<K, true> {
  const out = {} as Record<K, true>
  for (const v of values) out[v] = true
  return out
}

const SAVE_STATUS_VALUES = ['idle', 'dirty', 'saving', 'saved', 'error', 'offline', 'external'] as const satisfies readonly SaveStatus[]
const EXTERNAL_KIND_VALUES = ['modified', 'deleted', 'unreadable'] as const satisfies readonly ExternalChangeKind[]
const DECISION_KIND_VALUES = ['baseline-match', 'divergent', 'unknown', 'missing-source', 'identity-mismatch'] as const satisfies readonly DraftRecoveryDecisionKind[]

const SAVE_STATUSES: Record<SaveStatus, true> = exhaustiveTable(SAVE_STATUS_VALUES)
const EXTERNAL_KINDS: Record<ExternalChangeKind, true> = exhaustiveTable(EXTERNAL_KIND_VALUES)
const DECISION_KINDS: Record<DraftRecoveryDecisionKind, true> = exhaustiveTable(DECISION_KIND_VALUES)

function inSet<K extends string>(table: Record<K, true>, value: unknown): value is K {
  return typeof value === 'string' && (table as Record<string, true>)[value] === true
}

// ── Structural helpers ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Every own key must be allowlisted; every required key must exist.
// This is what makes the shape strict: unknown keys (filesystemPath,
// currentNoteContent, extra body fields, …) fail here.
function hasExactShape(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set<string>([...required, ...optional])
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false
  }
  return required.every((key) => key in obj)
}

function isCleanString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length <= maxChars && !value.includes(NUL)
}

function isNonEmptyCleanString(value: unknown, maxChars: number): value is string {
  return isCleanString(value, maxChars) && value.length > 0
}

// Markdown bodies: any string (empty is legal) except NUL. Overall
// body size is bounded by MAX_AI_LIVE_CONTEXT_BYTES on the whole
// snapshot; there is no per-body cap.
function isBodyString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes(NUL)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

// Snapshot paths are vault-relative logical paths — either the
// canonical extensionless spelling ("notes/draft") or the history
// system's single-trailing-.md spelling ("notes/draft.md"; see
// contentPathForHistoryPath in routes.ts). The strict file-API
// validator does the real work after one trailing ".md" is stripped:
// it rejects absolute paths, Windows drives, "..", backslash
// bypasses, NUL, and mid-path ".md" segments.
function isValidSnapshotPath(value: unknown): value is string {
  if (!isNonEmptyCleanString(value, MAX_PATH_CHARS)) return false
  // One shared canonicalizer (Edit-10.4): strips one trailing ".md",
  // then applies the strict syntax validator. Behavior is identical
  // to the inline version this replaced.
  return normalizeLogicalContentPath(value) !== null
}

function ok(obj: Record<string, unknown>): ParseAiLiveContextResult {
  // Every key set, field, and cross-field invariant was validated
  // above; this cast is the door's receipt, not a trust-me shortcut.
  return { ok: true, value: obj as unknown as AiLiveContextSnapshot }
}

const COMMON_REQUIRED = ['v', 'kind', 'capturedAt', 'vaultId', 'workspaceTabId'] as const

// ── The door ────────────────────────────────────────────────────────

export function parseAiLiveContext(value: unknown): ParseAiLiveContextResult {
  // Size BEFORE structure: an oversized payload is reported as
  // context-too-large even when it is also malformed.
  let serialized: string
  try {
    const out = JSON.stringify(value)
    if (typeof out !== 'string') return INVALID
    serialized = out
  } catch {
    return INVALID
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AI_LIVE_CONTEXT_BYTES) return TOO_LARGE

  if (!isRecord(value)) return INVALID
  if (value.v !== 1) return INVALID
  if (typeof value.kind !== 'string') return INVALID
  if (!isFiniteNonNegative(value.capturedAt)) return INVALID
  if (!isNonEmptyCleanString(value.vaultId, MAX_ID_CHARS)) return INVALID
  if (!isNonEmptyCleanString(value.workspaceTabId, MAX_ID_CHARS)) return INVALID

  switch (value.kind) {
    case 'document':
      return parseDocument(value)
    case 'diff':
      return parseDiff(value)
    case 'recovery':
      return parseRecovery(value)
    default:
      return INVALID
  }
}

function parseDocument(obj: Record<string, unknown>): ParseAiLiveContextResult {
  if (!hasExactShape(
    obj,
    [...COMMON_REQUIRED, 'identity', 'title', 'raw', 'revision', 'savedRevision', 'dirty', 'saveStatus'],
    ['external'],
  )) return INVALID

  const identity = obj.identity
  if (!isRecord(identity) || !hasExactShape(identity, ['documentId', 'path'])) return INVALID
  if (!isNonEmptyCleanString(identity.documentId, MAX_ID_CHARS)) return INVALID
  if (!isValidSnapshotPath(identity.path)) return INVALID
  // A document tab's workspace id IS its path — one identity, one
  // source. (Only the document kind carries this invariant.)
  if (obj.workspaceTabId !== identity.path) return INVALID

  if (!isCleanString(obj.title, MAX_TITLE_CHARS)) return INVALID
  if (!isBodyString(obj.raw)) return INVALID
  if (!isSafeNonNegativeInteger(obj.revision)) return INVALID
  if (!isSafeNonNegativeInteger(obj.savedRevision)) return INVALID
  if (typeof obj.dirty !== 'boolean') return INVALID
  // Sealed capture contract: dirty is derived, never independent.
  if (obj.dirty !== (obj.revision !== obj.savedRevision)) return INVALID
  if (!inSet(SAVE_STATUSES, obj.saveStatus)) return INVALID

  if ('external' in obj) {
    const external = obj.external
    if (!isRecord(external) || !hasExactShape(external, ['kind', 'raw'])) return INVALID
    if (!inSet(EXTERNAL_KINDS, external.kind)) return INVALID
    // modified carries the external body; deleted/unreadable do not.
    if (external.kind === 'modified') {
      if (!isBodyString(external.raw)) return INVALID
    } else if (external.raw !== null) {
      return INVALID
    }
  }

  return ok(obj)
}

function parseDiff(obj: Record<string, unknown>): ParseAiLiveContextResult {
  if (!hasExactShape(obj, [...COMMON_REQUIRED, 'readOnly', 'identity', 'title', 'before', 'after'])) return INVALID
  if (obj.readOnly !== true) return INVALID

  const identity = obj.identity
  if (!isRecord(identity) || !hasExactShape(identity, ['path', 'revisionId', 'revisionTime', 'currentDocumentId'])) return INVALID
  if (!isValidSnapshotPath(identity.path)) return INVALID
  if (!isNonEmptyCleanString(identity.revisionId, MAX_ID_CHARS)) return INVALID
  if (!isFiniteNonNegative(identity.revisionTime)) return INVALID

  const before = obj.before
  if (!isRecord(before) || !hasExactShape(before, ['raw', 'source'])) return INVALID
  if (before.source !== 'history') return INVALID
  if (!isBodyString(before.raw)) return INVALID

  const after = obj.after
  if (!isRecord(after) || !hasExactShape(after, ['raw', 'source', 'dirty'])) return INVALID
  if (!isBodyString(after.raw)) return INVALID
  if (typeof after.dirty !== 'boolean') return INVALID
  if (after.source === 'live-editor') {
    // A live buffer must be certified as belonging to this path's
    // document — the capture contract only emits live-editor with a
    // real documentId.
    if (!isNonEmptyCleanString(identity.currentDocumentId, MAX_ID_CHARS)) return INVALID
  } else if (after.source === 'comparison-snapshot') {
    if (identity.currentDocumentId !== null) return INVALID
  } else {
    return INVALID
  }

  return ok(obj)
}

function parseRecovery(obj: Record<string, unknown>): ParseAiLiveContextResult {
  if (!hasExactShape(
    obj,
    [...COMMON_REQUIRED, 'readOnly', 'identity', 'title', 'decisionKind', 'view', 'draft'],
    ['disk'],
  )) return INVALID
  if (obj.readOnly !== true) return INVALID

  const identity = obj.identity
  if (!isRecord(identity) || !hasExactShape(identity, ['recoveryId', 'documentId', 'path', 'source'])) return INVALID
  if (!isNonEmptyCleanString(identity.recoveryId, MAX_ID_CHARS)) return INVALID
  // identity.documentId is the DRAFT's id (always non-empty); on
  // identity-mismatch the disk side carries its own id below.
  if (!isNonEmptyCleanString(identity.documentId, MAX_ID_CHARS)) return INVALID
  if (!isValidSnapshotPath(identity.path)) return INVALID
  if (identity.source !== 'primary' && identity.source !== 'conflict') return INVALID

  if (!isCleanString(obj.title, MAX_TITLE_CHARS)) return INVALID
  if (!inSet(DECISION_KINDS, obj.decisionKind)) return INVALID
  if (obj.view !== 'content' && obj.view !== 'diff') return INVALID

  const draft = obj.draft
  if (!isRecord(draft) || !hasExactShape(draft, ['raw'])) return INVALID
  if (!isBodyString(draft.raw)) return INVALID

  if (obj.view === 'content') {
    // Content view shows the draft alone — no disk body travels.
    if ('disk' in obj) return INVALID
  } else {
    const disk = obj.disk
    if (!isRecord(disk) || !hasExactShape(disk, ['documentId', 'raw'])) return INVALID
    // null = the disk file has no documentId; a string must be a real id.
    if (disk.documentId !== null && !isNonEmptyCleanString(disk.documentId, MAX_ID_CHARS)) return INVALID
    if (!isBodyString(disk.raw)) return INVALID
  }

  return ok(obj)
}
