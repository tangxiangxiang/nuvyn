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
  /**
   * The Vault-owned Calendar Home is rendered below the global navbar, so the
   * shell exposes its resolved visibility for chrome that lives above the
   * router view. This keeps navbar controls aligned with the actual surface,
   * even when a retained document URL is still active while Calendar Home is
   * displayed.
   */
  readonly diaryCalendarVisible: Ref<boolean>
}

export const AppShellContextKey: InjectionKey<AppShellContext> = Symbol('nuvyn.app-shell')
