import { getCurrentInstance, inject, provide } from 'vue'
import type { VaultContext } from './types'
import { VaultContextKey } from './vaultContext'

export function provideVaultContext(context: VaultContext): VaultContext {
  provide(VaultContextKey, context)
  return context
}

export function useVaultContext(): VaultContext {
  const context = inject(VaultContextKey)
  if (!context) throw new Error('Vault context is not available')
  return context
}

export function useOptionalVaultContext(): VaultContext | null {
  if (!getCurrentInstance()) return null
  return inject(VaultContextKey, null)
}
