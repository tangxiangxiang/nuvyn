const internalWriteTails = new Map<string, Promise<void>>()
const internalWriteWaiters = new Map<string, number>()

/**
 * Reserved sentinel that identifies the vault structure lock in the
 * testing probes. Every operation that changes vault tree membership
 * (file/folder create, delete, rename/move, recovery create) acquires
 * this lock FIRST, then the sorted document path locks — one global
 * acquisition order, so a folder lifecycle transaction can never
 * interleave with a child being created or removed underneath it.
 * Content-only writes (body PUT, AI write/patch, metadata/frontmatter)
 * take document path locks only, so they never contend with structural
 * operations except on the exact documents they touch.
 *
 * The lock table itself keys the two lock classes in SEPARATE
 * namespaces: the structure lock under STRUCTURE_LOCK_KEY, every
 * document under `document:<path>`. No user-supplied path — valid or
 * not — can ever collide with the structure lock. In particular an AI
 * tool call whose unnormalizable path (e.g. this very spelling, which
 * is not a valid vault segment: SEGMENT_RE is `[a-z0-9-]`) falls back
 * to its raw string as the DOCUMENT lock key still cannot self-deadlock
 * against the structure lock it holds, nor jam every later membership
 * operation behind a stuck lock — the executor's assertSafePath rejects
 * the path before any side effect.
 */
export const VAULT_STRUCTURE_LOCK = '@@vault-structure'

const STRUCTURE_LOCK_KEY = 'structure'
const documentLockKey = (path: string): string => `document:${path}`

export function withVaultStructureLock<T>(operation: () => Promise<T>): Promise<T> {
  return withInternalWriteLock(STRUCTURE_LOCK_KEY, operation)
}

/**
 * Serialize document write transactions by Vault-relative path while allowing
 * unrelated documents to proceed independently.
 */
export function withDocumentWriteLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withInternalWriteLock(documentLockKey(path), operation)
}

async function withInternalWriteLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = internalWriteTails.get(key) ?? Promise.resolve()
  const queued = internalWriteTails.has(key)
  if (queued) internalWriteWaiters.set(key, (internalWriteWaiters.get(key) ?? 0) + 1)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => {}).then(() => current)
  internalWriteTails.set(key, tail)

  await previous.catch(() => {})
  if (queued) {
    const remaining = (internalWriteWaiters.get(key) ?? 1) - 1
    if (remaining > 0) internalWriteWaiters.set(key, remaining)
    else internalWriteWaiters.delete(key)
  }
  try {
    return await operation()
  } finally {
    release()
    if (internalWriteTails.get(key) === tail) {
      internalWriteTails.delete(key)
    }
  }
}

/** Acquire a mutation footprint in one global order to avoid deadlocks. */
export function withDocumentWriteLocks<T>(
  paths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const lockPaths = [...new Set(paths)].sort()
  const locked = lockPaths.reduceRight(
    (next, lockPath) => () => withDocumentWriteLock(lockPath, next),
    operation,
  )
  return locked()
}

export function pendingDocumentWriteLocksForTesting(): number {
  return internalWriteTails.size
}

/**
 * How many operations are currently queued behind the lock for `path`.
 * Pass VAULT_STRUCTURE_LOCK to inspect the structure lock itself.
 */
export function documentWriteLockWaitersForTesting(path: string): number {
  const key = path === VAULT_STRUCTURE_LOCK ? STRUCTURE_LOCK_KEY : documentLockKey(path)
  return internalWriteWaiters.get(key) ?? 0
}
