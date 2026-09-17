import { ref } from 'vue'

export function toMutationPath(path: string): string {
  return path.endsWith('.md') ? path : `${path}.md`
}

export function toMutationPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean).map(toMutationPath))]
}

// Vault-scoped, in-memory exclusion for workflows that mutate document bytes.
// Paths use the History API's exact `.md` representation.
export function createPathMutationLock() {
  const paths = ref<Set<string>>(new Set())
  const global = ref(false)

  function canAcquire(requestedPaths: readonly string[]): boolean {
    return !global.value && requestedPaths.every((path) => !paths.value.has(path))
  }

  function acquire(requestedPaths: readonly string[]): (() => void) | null {
    if (!canAcquire(requestedPaths)) return null
    const next = new Set(paths.value)
    for (const path of requestedPaths) next.add(path)
    paths.value = next

    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = new Set(paths.value)
      for (const path of requestedPaths) remaining.delete(path)
      paths.value = remaining
    }
  }

  function has(path: string): boolean {
    return global.value || paths.value.has(path)
  }

  function acquireAll(): (() => void) | null {
    if (!canAcquireAll()) return null
    global.value = true
    let released = false
    return () => {
      if (released) return
      released = true
      global.value = false
    }
  }

  function canAcquireAll(): boolean {
    return !global.value && paths.value.size === 0
  }

  return { paths, global, canAcquire, canAcquireAll, acquire, acquireAll, has }
}
