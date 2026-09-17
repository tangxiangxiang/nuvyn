// Shared type + injection key for the vault's view-mode toggle
// (edit / read). Lives in its own module so App.vue (which provides)
// and NavBar / VaultView (which inject) can all import the same symbol
// without circular imports and without each redeclaring the union.

import type { InjectionKey, Ref } from 'vue'

export type VaultViewMode = 'edit' | 'read'

export interface VaultViewModeApi {
  mode: Ref<VaultViewMode>
  set: (m: VaultViewMode) => void
  toggle: () => void
}

export const VaultViewModeKey: InjectionKey<VaultViewModeApi> = Symbol('vaultViewMode')
