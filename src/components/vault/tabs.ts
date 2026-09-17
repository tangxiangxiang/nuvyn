import type { DocumentSavePresentation } from '../../composables/vault/editor-tabs/savePresentation'

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'offline' | 'external'
export type ExternalChangeKind = 'modified' | 'deleted' | 'unreadable'

export interface Tab {
  path: string
  /** Stable server metadata identity. Draft persistence must not substitute path. */
  documentId?: string | null
  title: string
  raw: string
  originalRaw: string
  revision: number
  savedRevision: number
  savingRevision: number | null
  saveStatus: SaveStatus
  error: string | null
  loadError: string | null
  loading: boolean
  externalRaw?: string | null
  externalKind?: ExternalChangeKind | null
  // mtime of the file on disk at the last load/save. Used to detect
  // external changes (the AI file-change bus drives refreshes
  // off this). v1 doesn't strictly compare mtimes — `dirty` is
  // the only conflict signal — but the field is kept uniform so
  // a future mtime-based check is a one-line change.
  serverMtime: number
}

/** Navigation-only tab shape. Editable documents and read-only diff /
 * recovery viewers map into this at the workspace boundary without sharing
 * state. */
export interface WorkspaceTab {
  id: string
  label: string
  title: string
  save: DocumentSavePresentation
  kind: 'document' | 'diff' | 'recovery'
  documentPath?: string | null
}
