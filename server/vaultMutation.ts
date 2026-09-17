import { AsyncLocalStorage } from 'node:async_hooks'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Whole-Vault, process-local mutation coordinator.
 *
 * Global order:
 *   active process ownership -> this coordinator -> structure lock ->
 *   sorted document locks -> History repo queue -> Git index.lock ->
 *   atomic filesystem commit point.
 *
 * This is deliberately not a replacement for path locks or Git's index lock.
 * It only prevents independently-developed Vault mutation protocols from
 * observing or modifying one another's transitional state.
 */
export type VaultMutationHooks = {
  onWait?: (vaultRoot: string) => void | Promise<void>
}

let hooks: VaultMutationHooks | null = null
const mutationTails = new Map<string, Promise<void>>()
const heldVaults = new AsyncLocalStorage<ReadonlySet<string>>()

export function __setVaultMutationHooksForTesting(
  next: VaultMutationHooks | null,
): void {
  hooks = next
}

async function canonicalVaultRoot(vaultRoot: string): Promise<string> {
  const resolved = path.resolve(vaultRoot)
  try {
    return await fs.realpath(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved
    throw error
  }
}

export class VaultMutationOrderError extends Error {
  constructor(vaultRoot: string) {
    super(`withVaultMutation cannot be acquired recursively for ${vaultRoot}`)
    this.name = 'VaultMutationOrderError'
  }
}

export async function withVaultMutation<T>(
  vaultRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await canonicalVaultRoot(vaultRoot)
  if (heldVaults.getStore()?.has(key)) throw new VaultMutationOrderError(key)

  const previous = mutationTails.get(key) ?? Promise.resolve()
  const queued = mutationTails.has(key)
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => current)
  mutationTails.set(key, tail)
  if (queued) {
    try { await hooks?.onWait?.(key) } catch { /* test observation only */ }
  }

  await previous.catch(() => {})
  try {
    const parent = heldVaults.getStore() ?? new Set<string>()
    return await heldVaults.run(new Set([...parent, key]), operation)
  } finally {
    release()
    if (mutationTails.get(key) === tail) mutationTails.delete(key)
  }
}

export async function pendingVaultMutationsForTesting(
  vaultRoot?: string,
): Promise<number> {
  if (vaultRoot === undefined) return mutationTails.size
  return mutationTails.has(await canonicalVaultRoot(vaultRoot)) ? 1 : 0
}
