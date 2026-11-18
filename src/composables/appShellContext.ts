import type { InjectionKey, Ref } from 'vue'

/**
 * Small bridge between the global app chrome and the Vault-owned settings
 * surface.  SettingsModal still belongs to VaultView because its Tags section
 * uses the live Vault context; the shell only signals that the modal should
 * open.
 */
export interface AppShellContext {
  readonly settingsRequestTick: Readonly<Ref<number>>
  /** Open the single App-level search surface from global chrome. */
  readonly openGlobalSearch?: () => void
  /** Current Note's full-text read-aloud action. */
  readonly noteSpeechReadAllCommand?: Ref<(() => void) | null>
  /** Phone menu shortcut for the current editor's selection action. */
  readonly noteSpeechReadSelectionCommand?: Ref<(() => void) | null>
  /** Capability owned by the active Note tablet editor. */
  readonly noteTabletImageCommand?: Ref<(() => void) | null>
  /** Ledger module lifecycle owns availability; the export feature owns data. */
  readonly ledgerAnalysisExportCommand?: Ref<(() => Promise<void>) | null>
  /** Switch Note/Diary presentation while preserving each scope's document context. */
  readonly vaultScopeChangeCommand?: Ref<((scope: 'note' | 'diary') => Promise<boolean>) | null>
  /** Diary-owned presentation toggle, exposed to the global workspace chrome. */
  readonly diaryViewToggleCommand?: Ref<(() => void) | null>
  /** Read-only mirror of the Diary view mode used for the toggle affordance. */
  readonly diaryViewMode?: Ref<'diary' | 'events'>
  /** Vault-owned capability for the decorative brand animation to enter Zen Mode. */
  readonly zenModeBrandEntry?: Ref<{
    canEnter: () => boolean
    enter: () => boolean
  } | null>
  /** Keeps the brand transition mounted while Zen Mode is revealed underneath it. */
  readonly zenModeBrandTransitioning?: Ref<boolean>
}

export const AppShellContextKey: InjectionKey<AppShellContext> = Symbol('nuvyn.app-shell')
