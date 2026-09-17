import type { ComputedRef, Ref } from 'vue'
import type { Tab } from '../../../components/vault/tabs'
import type { AiLiveContextCapture } from '../aiLiveContext'
import type { VaultFileChanges } from './fileChanges'
import type { VaultTocState } from '../useTocState'
import type { DocumentLifecycle } from '../useDocumentLifecycle'

export interface VaultEditorContext {
  tabs: Ref<Tab[]>
  activePath: Ref<string | null>
  activeTab: ComputedRef<Tab | null>
  openPost: (path: string) => Promise<void>
  getLiveContent: (path: string) => string | null
}

/**
 * AI live workspace context access (Edit-10.2).
 *
 * The AI context belongs to the WHOLE workspace, not the editor alone:
 * the active workspace tab may be a Document, a History comparison
 * (diff), or a draft Recovery viewer, and only the
 * workspace knows which. `capture()` returns one immutable snapshot of
 * exactly what that tab is showing right now.
 *
 * Contract:
 *
 * - Synchronous. Returns plain data; never a Vue reactive object.
 * - Fresh on every call: no caching — each call re-reads call-instant
 *   workspace state.
 * - No HTTP, no `nextTick`, no route inspection, no `getPost`, and no
 *   async re-read of the active tab in any later stage.
 */
export interface VaultAiContext {
  capture(): AiLiveContextCapture
}

export interface VaultContext {
  vaultId: Ref<string | null>
  fileChanges: VaultFileChanges
  editor: VaultEditorContext
  ai: VaultAiContext
  toc: VaultTocState
  lifecycle?: DocumentLifecycle
  onDispose: (cleanup: () => void) => () => void
  dispose: () => void
}
