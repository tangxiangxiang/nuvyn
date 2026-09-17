import { ref, readonly, type Ref } from 'vue'
import { authFetch } from './auth-session'

export type VaultIdentityState = 'unknown' | 'loading' | 'ready' | 'error'

const state = ref<VaultIdentityState>('unknown')
const vaultId = ref<string | null>(null)
let request: Promise<string> | null = null
let generation = 0

function identityError(message: string): Error {
  return new Error(message)
}

function parseVaultId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw identityError('Vault identity returned an invalid response.')
  }
  const id = (value as { vaultId?: unknown }).vaultId
  if (typeof id !== 'string' || id.length === 0) {
    throw identityError('Vault identity returned an invalid response.')
  }
  return id
}

export async function ensureVaultIdentity(): Promise<string> {
  if (state.value === 'ready' && vaultId.value) return vaultId.value
  if (request) return request

  const requestGeneration = ++generation
  state.value = 'loading'
  const pending = authFetch('/api/vault/identity', { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) {
        throw identityError(`Vault identity request failed (${response.status}).`)
      }
      return parseVaultId(await response.json())
    })
    .then((id) => {
      if (requestGeneration === generation) {
        vaultId.value = id
        state.value = 'ready'
      }
      return id
    })
    .catch((error: unknown) => {
      if (requestGeneration === generation) {
        vaultId.value = null
        state.value = 'error'
      }
      throw error
    })
    .finally(() => {
      if (requestGeneration === generation) request = null
    })
  request = pending
  return pending
}

export function resetVaultIdentity(): void {
  generation += 1
  request = null
  vaultId.value = null
  state.value = 'unknown'
}

export function getVaultIdentityState(): {
  readonly state: Readonly<Ref<VaultIdentityState>>
  readonly vaultId: Readonly<Ref<string | null>>
} {
  return { state: readonly(state), vaultId: readonly(vaultId) }
}

export function requireVaultId(): string {
  if (state.value !== 'ready' || !vaultId.value) {
    throw new Error('Vault identity must be resolved before mounting the workspace.')
  }
  return vaultId.value
}

export function resetVaultIdentityForTesting(): void {
  resetVaultIdentity()
}
