/**
 * AI live workspace context contract (Edit-10.1).
 *
 * When the user presses Send in the AI panel, the client captures ONE
 * immutable snapshot of the active workspace tab — the exact content the
 * user is looking at plus its stable same-moment identity — and that
 * snapshot (never a later re-read) is what the AI receives for the turn.
 *
 * This module is the pure contract: types + a synchronous resolver. It has
 * no Vue imports, no HTTP, no `nextTick`; Edit-10.2 wires it into
 * `VaultContext.ai.capture()` and Edit-10.3 transports it to the server.
 */

import type { ExternalChangeKind, SaveStatus } from '../../components/vault/tabs'
import type { DraftRecoveryDecisionKind } from './draft-recovery/draftRecoveryDecision'
import { isManagedDiaryPath } from '../../../shared/diaryProtocol'

// ─── Snapshot types (client → server wire contract, v: 1) ──────────

export interface AiDocumentContext {
  v: 1
  kind: 'document'
  capturedAt: number
  vaultId: string
  workspaceTabId: string

  /** documentId, path and raw are copied from the SAME tab snapshot. */
  identity: {
    documentId: string
    path: string
  }

  title: string
  /** Live editor buffer. The empty string is a legal body. */
  raw: string

  revision: number
  savedRevision: number
  dirty: boolean
  saveStatus: SaveStatus

  /** Present while an external change conflicts with the buffer. */
  external?: {
    kind: ExternalChangeKind
    raw: string | null
  }
}

export interface AiDiffContext {
  v: 1
  kind: 'diff'
  capturedAt: number
  vaultId: string
  workspaceTabId: string
  readOnly: true

  identity: {
    path: string
    revisionId: string
    revisionTime: number
    /** The live editor tab's documentId for the same path, or null. */
    currentDocumentId: string | null
  }

  title: string

  before: {
    raw: string
    source: 'history'
  }

  after: {
    raw: string
    source: 'live-editor' | 'comparison-snapshot'
    dirty: boolean
  }
}

export interface AiRecoveryContext {
  v: 1
  kind: 'recovery'
  capturedAt: number
  vaultId: string
  workspaceTabId: string
  readOnly: true

  /**
   * identity.documentId is the DRAFT's documentId. On identity-mismatch the
   * disk side carries its own documentId in `disk.documentId` — both are
   * preserved so the model can see that the path now belongs to someone
   * else.
   */
  identity: {
    recoveryId: string
    documentId: string
    path: string
    source: 'primary' | 'conflict'
  }

  title: string
  decisionKind: DraftRecoveryDecisionKind
  view: 'content' | 'diff'

  draft: {
    raw: string
  }

  /**
   * Present only when the effective view is 'diff'. Content view shows
   * the draft alone, so no disk body travels with it; a diff view whose
   * disk side is not readable downgrades to content and drops this block.
   */
  disk?: {
    documentId: string | null
    raw: string
  }
}

export type AiLiveContextSnapshot =
  | AiDocumentContext
  | AiDiffContext
  | AiRecoveryContext

// ─── Capture result ────────────────────────────────────────────────

export type AiLiveContextUnavailableReason =
  | 'loading'
  | 'load-error'
  | 'missing-identity'
  | 'stale-workspace'

export type AiLiveContextCapture =
  | { status: 'ready'; context: AiLiveContextSnapshot }
  | { status: 'none' }
  | { status: 'unavailable'; reason: AiLiveContextUnavailableReason }

// ─── Resolver inputs (plain data — no reactive objects) ────────────
//
// Each source interface is a structural subset of the corresponding
// workspace type (Tab, HistoryComparison, DraftRecoveryTab), so
// Edit-10.2's capture() can pass plain copies straight through without
// per-field mapping.

export interface AiDocumentSource {
  path: string
  documentId?: string | null
  title: string
  raw: string
  revision: number
  savedRevision: number
  saveStatus: SaveStatus
  loading: boolean
  loadError: string | null
  externalKind?: ExternalChangeKind | null
  externalRaw?: string | null
}

export interface AiDiffSource {
  tabId: string
  documentPath: string
  documentTitle: string
  mode: 'commit-change' | 'revision-to-worktree'
  revisionId: string
  revisionTime: number
  beforeRaw: string
  afterRaw: string
  currentDirty: boolean
  status: 'loading' | 'ready' | 'error'
}

export interface AiRecoverySource {
  tabId: string
  recoveryId: string
  source: 'primary' | 'conflict'
  documentId: string
  documentPath: string
  documentTitle: string
  decisionKind: DraftRecoveryDecisionKind
  diskStatus: 'ready' | 'missing' | 'unreadable'
  diskDocumentId: string | null
  view: 'content' | 'diff'
  draftRaw: string
  diskRaw: string | null
  status: 'ready' | 'error'
}

export interface AiLiveEditorDocument {
  raw: string
  dirty: boolean
  documentId: string | null
}

export interface AiLiveContextInput {
  vaultId: string | null
  activeWorkspaceTabId: string | null
  documentTabs: readonly AiDocumentSource[]
  historyComparisons: readonly AiDiffSource[]
  recoveryTabs: readonly AiRecoverySource[]
}

export interface AiLiveContextOptions {
  now?: () => number
  /**
   * Synchronous live-editor lookup for a diff's path. When a document tab
   * for that path is loaded, the diff's after-side must be re-read from it
   * at capture time instead of the comparison's possibly stale `afterRaw`.
   */
  liveDocument?: (path: string) => AiLiveEditorDocument | null
}

/**
 * Resolve the AI context for the active workspace tab.
 *
 * The resolution order mirrors the workspace activation order exactly
 * (VaultView's `activeWorkspaceTabId`):
 *
 *   active Recovery → active Diff → active Document → none
 *
 * The active tab id is matched against each candidate list; this function
 * never re-derives authority from the route.
 *
 * Contract:
 *
 *   - Synchronous. Copies strings and identity fields into fresh plain
 *     objects; never returns a Vue reactive object.
 *   - Never falls back to stale content: `loading`, `loadError`, a missing
 *     documentId, or a non-ready viewer yields `unavailable`, never an
 *     older body.
 *   - `stale-workspace` means the active id matched no candidate (e.g. the
 *     tab closed between render and capture); a null vault or null active
 *     id is simply `none`.
 *
 * Dependency injection (`now`, `liveDocument`) keeps this pure and
 * testable, matching the decideDraftRecovery / createUnsavedDraftPersistence
 * house style.
 */
export function captureAiLiveContext(
  input: AiLiveContextInput,
  options: AiLiveContextOptions = {},
): AiLiveContextCapture {
  if (!input.vaultId || input.activeWorkspaceTabId === null) {
    return { status: 'none' }
  }

  const vaultId = input.vaultId
  const activeId = input.activeWorkspaceTabId
  const capturedAt = (options.now ?? (() => Date.now()))()

  // Priority 1: Recovery viewer.
  const recovery = input.recoveryTabs.find((tab) => tab.tabId === activeId)
  if (recovery) {
    if (isManagedDiaryPath(recovery.documentPath.replace(/\.md$/, ''))) {
      // Never copy managed Diary draft/disk bytes into the AI wire snapshot;
      // the server-side Diary access service is the sole DEK/body owner.
      return { status: 'unavailable', reason: 'stale-workspace' }
    }
    if (recovery.status !== 'ready') {
      return { status: 'unavailable', reason: 'load-error' }
    }
    // Send exactly what the tab shows. The disk side is visible only in
    // diff view, so the disk block travels only with an effective diff
    // view; a diff view without a readable disk body downgrades to
    // content (defense in depth — useDraftRecoveryTabs already
    // normalizes view on open).
    const readableDisk = recovery.diskStatus === 'ready' && recovery.diskRaw !== null
    const view = recovery.view === 'diff' && readableDisk ? 'diff' : 'content'
    const context: AiRecoveryContext = {
      v: 1,
      kind: 'recovery',
      capturedAt,
      vaultId,
      workspaceTabId: recovery.tabId,
      readOnly: true,
      identity: {
        recoveryId: recovery.recoveryId,
        documentId: recovery.documentId,
        path: recovery.documentPath,
        source: recovery.source,
      },
      title: recovery.documentTitle,
      decisionKind: recovery.decisionKind,
      view,
      draft: { raw: recovery.draftRaw },
      ...(view === 'diff' && recovery.diskRaw !== null
        ? { disk: { documentId: recovery.diskDocumentId, raw: recovery.diskRaw } }
        : {}),
    }
    return { status: 'ready', context }
  }

  // Priority 2: Diff (history comparison) viewer.
  const comparison = input.historyComparisons.find((tab) => tab.tabId === activeId)
  if (comparison) {
    if (isManagedDiaryPath(comparison.documentPath.replace(/\.md$/, ''))) {
      return { status: 'unavailable', reason: 'stale-workspace' }
    }
    if (comparison.status === 'loading') {
      return { status: 'unavailable', reason: 'loading' }
    }
    if (comparison.status !== 'ready') {
      return { status: 'unavailable', reason: 'load-error' }
    }
    // Only a revision → working-tree comparison has a live editor as its
    // after side. Commit-change mode must remain a historical snapshot so
    // unsaved editor content cannot alter the meaning of the selected commit.
    const live = comparison.mode === 'revision-to-worktree'
      ? options.liveDocument?.(comparison.documentPath) ?? null
      : null
    // A live buffer without a stable documentId cannot be certified as
    // belonging to this path's document (metadata missing, stale tab
    // restore, path reuse in flight). Fail closed — never fall back to
    // the comparison's possibly stale afterRaw, which would re-introduce
    // exactly the expired body this contract forbids.
    if (live && !live.documentId) {
      return { status: 'unavailable', reason: 'missing-identity' }
    }
    const after = live
      ? { raw: live.raw, source: 'live-editor' as const, dirty: live.dirty }
      : {
          raw: comparison.afterRaw,
          source: 'comparison-snapshot' as const,
          dirty: comparison.currentDirty,
        }
    const context: AiDiffContext = {
      v: 1,
      kind: 'diff',
      capturedAt,
      vaultId,
      workspaceTabId: comparison.tabId,
      readOnly: true,
      identity: {
        path: comparison.documentPath,
        revisionId: comparison.revisionId,
        revisionTime: comparison.revisionTime,
        currentDocumentId: live?.documentId ?? null,
      },
      title: comparison.documentTitle,
      before: { raw: comparison.beforeRaw, source: 'history' },
      after,
    }
    return { status: 'ready', context }
  }

  // Priority 3: Document editor tab (id === path).
  const doc = input.documentTabs.find((tab) => tab.path === activeId)
  if (doc) {
    if (isManagedDiaryPath(doc.path.replace(/\.md$/, ''))) {
      return { status: 'unavailable', reason: 'stale-workspace' }
    }
    if (doc.loading) {
      return { status: 'unavailable', reason: 'loading' }
    }
    if (doc.loadError) {
      return { status: 'unavailable', reason: 'load-error' }
    }
    if (!doc.documentId) {
      return { status: 'unavailable', reason: 'missing-identity' }
    }
    const context: AiDocumentContext = {
      v: 1,
      kind: 'document',
      capturedAt,
      vaultId,
      workspaceTabId: doc.path,
      identity: { documentId: doc.documentId, path: doc.path },
      title: doc.title,
      raw: doc.raw,
      revision: doc.revision,
      savedRevision: doc.savedRevision,
      // revision (the in-memory buffer), never savingRevision (the
      // in-flight server write).
      dirty: doc.revision !== doc.savedRevision,
      saveStatus: doc.saveStatus,
      ...(doc.externalKind
        ? { external: { kind: doc.externalKind, raw: doc.externalRaw ?? null } }
        : {}),
    }
    return { status: 'ready', context }
  }

  return { status: 'unavailable', reason: 'stale-workspace' }
}

/**
 * Look up the live editor buffer for a path.
 *
 * Mirrors useHistoryComparisons' `getLoadedEditorDocument`, additionally
 * surfacing `documentId` so a diff context can certify which document the
 * after-side belongs to. Edit-10.2 passes this as `options.liveDocument`.
 *
 * Loading or errored tabs are NOT live documents: returning them would
 * re-introduce the stale-content fallback this contract forbids.
 */
export function liveEditorForPath(
  tabs: readonly AiDocumentSource[],
  path: string,
): AiLiveEditorDocument | null {
  if (isManagedDiaryPath(path.replace(/\.md$/, ''))) return null
  const tab = tabs.find((candidate) => candidate.path === path)
  if (!tab || tab.loading || tab.loadError) return null
  return {
    raw: tab.raw,
    dirty: tab.revision !== tab.savedRevision,
    documentId: tab.documentId ?? null,
  }
}
