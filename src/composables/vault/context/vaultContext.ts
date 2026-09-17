import type { InjectionKey } from 'vue'
import type { VaultContext } from './types'

export const VaultContextKey: InjectionKey<VaultContext> = Symbol('VaultContext')
