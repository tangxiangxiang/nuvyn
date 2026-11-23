import type { InjectionKey, Ref } from 'vue'
import type { FileChangeEvent } from '../lib/ai-api'
import type { AiLiveContextCapture } from './vault/aiLiveContext'

/**
 * Small bridge between the global app chrome and the Vault-owned settings
 * surface.  SettingsModal still belongs to VaultView because its Tags section
 * uses the live Vault context; the shell only signals that the modal should
 * open.
 */
export type DiaryCalendarMode = 'diary' | 'events' | 'tasks'

export interface NoteAiContextBridge {
  /** Capture one immutable Note workspace snapshot at the moment of send. */
  capture: () => AiLiveContextCapture
  /** Publish tool-driven file changes to the Note editor bus captured for this turn. */
  publishFileChange: (event: FileChangeEvent) => void
  /** Resolve AI Markdown links only against the active Note workspace. */
  linkPaths: () => string[]
  /** Open a resolved AI Markdown link through the active Note editor. */
  openLink: (path: string, anchor?: string) => Promise<void>
}

export interface AppShellContext {
  readonly settingsRequestTick: Readonly<Ref<number>>
  /** Global AI panel visibility and toolbar actions. */
  readonly globalAiOpen?: Readonly<Ref<boolean>>
  readonly toggleGlobalAi?: () => void
  readonly closeGlobalAi?: () => void
  /** The active Note workspace registers its context only while mounted. */
  readonly noteAiContext?: Readonly<Ref<NoteAiContextBridge | null>>
  readonly registerNoteAiContext?: (context: NoteAiContextBridge) => () => void
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
  readonly diaryViewToggleCommand?: Ref<((mode: DiaryCalendarMode) => void) | null>
  /** Read-only mirror of the Diary view mode used for the toggle affordance. */
  readonly diaryViewMode?: Ref<DiaryCalendarMode>
  /** Vault-owned capability for the decorative brand animation to enter Zen Mode. */
  readonly zenModeBrandEntry?: Ref<{
    canEnter: () => boolean
    enter: () => boolean
  } | null>
  /** Keeps the brand transition mounted while Zen Mode is revealed underneath it. */
  readonly zenModeBrandTransitioning?: Ref<boolean>
}

export const AppShellContextKey: InjectionKey<AppShellContext> = Symbol('nuvyn.app-shell')
