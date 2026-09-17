// Pure tab UI presentation layer.
//
// Source of truth for everything the tab strip renders about a
// WorkspaceTab: the title shown in the strip, the optional filename
// shown in the tooltip, the full path, the save status text the user
// sees, and the aria-label.
//
// Edit-07A round 4 inverts the round-3 split:
//
//   - `displayTitle` is the metadata / frontmatter title when the
//     upstream `tab.title` is meaningful. It is what the tab strip
//     shows. When the title is missing, equals the path, or otherwise
//     useless, the strip falls back to the file basename. This is the
//     "标签栏：文档 title 优先, 只有加载中/缺失/无效时才回退文件名"
//     rule from the review.
//
//   - `filenameLabel` is the file basename and is the optional line in
//     the tooltip that tells the user which file the tab is for. It is
//     suppressed whenever it would just duplicate displayTitle.
//
// All status text is derived from DocumentSavePresentation (Edit-04)
// — no raw SaveStatus enum or `savingRevision`/`revision`/
// `savedRevision` fields are read here.

import type { WorkspaceTab } from '../../../components/vault/tabs'
import type {
  DocumentSavePresentation,
  SavePresentationStatus,
} from './savePresentation'

export type TabUiStatusKind =
  | 'none'
  | 'dirty'
  | 'saving'
  | 'error'
  | 'offline'
  | 'external'

export interface TabUiPresentation {
  /** Title shown in the tab strip and as the strong line in the tooltip.
   *  Comes from `tab.title` when meaningful; otherwise the file
   *  basename (path with .md stripped). */
  displayTitle: string
  /** Filename / basename. Surfaced only in the tooltip as an optional
   *  supplementary line. null when it would duplicate `displayTitle`. */
  filenameLabel: string | null
  /** Full path shown as a line in the tooltip; null for history/diff. */
  fullPath: string | null
  /** Save status word shown on its own line in the tooltip; null when
   *  the tab is read-only (history/diff). */
  statusText: string | null
  /** Status kind used to pick a glyph and tooltip row styling. */
  statusKind: TabUiStatusKind
  /** Short aria-label for the tab. */
  ariaLabel: string
}

/**
 * Translate a presentation status into a user-facing word.
 *
 * `idle` and `saved` collapse to "Saved" so the UI never has to
 * differentiate "no save ever" from "save succeeded" — both are
 * the steady state the user is looking for.
 */
export function statusText(
  presentationStatus: SavePresentationStatus,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (presentationStatus) {
    case 'idle':
    case 'saved':
      return t('status.saved')
    case 'dirty':
      return t('status.unsaved')
    case 'saving':
      return t('status.saving')
    case 'saving-dirty':
      return t('status.saving_dirty')
    case 'error':
      return t('status.error')
    case 'offline':
      return t('status.offline')
    case 'external':
      return t('status.external')
  }
}

function statusKindFor(presentationStatus: SavePresentationStatus): TabUiStatusKind {
  switch (presentationStatus) {
    case 'idle':
    case 'saved':
      return 'none'
    case 'dirty':
      return 'dirty'
    case 'saving':
    case 'saving-dirty':
      return 'saving'
    case 'error':
      return 'error'
    case 'offline':
      return 'offline'
    case 'external':
      return 'external'
  }
}

function stripMarkdownExtension(segment: string): string {
  return segment.endsWith('.md') ? segment.slice(0, -3) : segment
}

function basenameOf(path: string): string {
  const lastSegment = path.split('/').pop() ?? ''
  return lastSegment ? stripMarkdownExtension(lastSegment) : path
}

/**
 * Decide whether the upstream `tab.title` (metadata / frontmatter)
 * is meaningful enough to use as the tab strip's primary label. The
 * title is rejected when:
 *
 *   - empty / whitespace-only,
 *   - equals the full path,
 *   - equals the basename (with or without .md) — at that point the
 *     title would just repeat the filename and the basename fallback
 *     already conveys the same information.
 *
 * Returns null when the title should be ignored and the basename
 * fallback used instead.
 */
export function deriveDisplayTitle(title: string, path: string): string {
  const trimmed = (title ?? '').trim()
  if (trimmed) {
    if (trimmed === path) return basenameOf(path)
    const base = basenameOf(path)
    if (trimmed === base) return base
    if (stripMarkdownExtension(trimmed) === base) return base
    return trimmed
  }
  return basenameOf(path)
}

/**
 * Compute the optional filename line for the tooltip. Returns null
 * when the basename would just repeat `displayTitle` (i.e. the
 * metadata title was missing or already equals the basename, so we
 * fell back to the basename — no point in showing the same string
 * twice in the tooltip).
 */
export function deriveFilenameLabel(displayTitle: string, path: string): string | null {
  const base = basenameOf(path)
  if (!base) return null
  if (base === displayTitle) return null
  if (stripMarkdownExtension(displayTitle) === base) return null
  return base
}

/**
 * Build the path shown in the tooltip. Returns null for non-document
 * tabs (history/diff) since they have no document file path to show.
 */
export function deriveFullPath(kind: WorkspaceTab['kind'], path: string): string | null {
  if (kind !== 'document') return null
  return path || null
}

function buildAriaLabel(
  displayTitle: string,
  filenameLabel: string | null,
  statusText: string | null,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const sep = t('workspace_tab.aria_separator')
  if (filenameLabel) {
    const titlePart = t('workspace_tab.aria_title', { name: displayTitle })
    const parts = [titlePart, t('workspace_tab.aria_file', { name: filenameLabel })]
    if (statusText) parts.push(statusText)
    return parts.join(sep)
  }
  const parts = [displayTitle]
  if (statusText) parts.push(statusText)
  return parts.join(sep)
}

/**
 * Compose the full UI presentation for a single workspace tab.
 *
 *   - Document tabs get a title (preferring metadata, falling back to
 *     the file basename), an optional filename line in the tooltip,
 *     a full path line, a status word, and an aria-label.
 *   - History/diff tabs keep their existing label semantics and never
 *     surface document save state.
 *
 * Pass `t` in explicitly so this pure function stays testable
 * without mounting a component.
 */
export function deriveTabUiPresentation(
  tab: WorkspaceTab,
  t: (key: string, params?: Record<string, string | number>) => string,
): TabUiPresentation {
  if (tab.kind === 'document') {
    const displayTitle = deriveDisplayTitle(tab.title ?? '', tab.id)
    const filenameLabel = deriveFilenameLabel(displayTitle, tab.id)
    const fullPath = deriveFullPath('document', tab.id)
    const statusText = tab.save ? statusTextForPresentation(tab.save, t) : null
    return {
      displayTitle,
      filenameLabel,
      fullPath,
      statusText,
      statusKind: tab.save ? statusKindFor(tab.save.status) : 'none',
      ariaLabel: buildAriaLabel(displayTitle, filenameLabel, statusText, t),
    }
  }
  if (tab.kind === 'recovery') {
    const displayTitle = (tab.label ?? tab.title ?? '').trim() || tab.title || ''
    const localOnly = t('draft_recovery.local_only')
    return {
      displayTitle,
      filenameLabel: null,
      fullPath: null,
      statusText: localOnly,
      statusKind: 'none',
      ariaLabel: [displayTitle, localOnly].join(t('workspace_tab.aria_separator')),
    }
  }
  // History / diff tabs keep their existing label semantics — the
  // WorkspaceTab shape provides a separate `label` (the user-facing
  // text shown in the tab strip, e.g. "Redis Notes (History)") and a
  // plain `title`. We surface the label here so the tab strip and
  // aria-label stay aligned with the legacy layout.
  const displayTitle = (tab.label ?? tab.title ?? '').trim() || tab.title || ''
  return {
    displayTitle,
    filenameLabel: null,
    fullPath: null,
    statusText: null,
    statusKind: 'none',
    ariaLabel: displayTitle,
  }
}

function statusTextForPresentation(
  save: DocumentSavePresentation,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return statusText(save.status, t)
}
