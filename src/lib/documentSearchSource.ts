import { shallowReadonly, shallowRef, type ShallowRef } from 'vue'
import { listPosts, type PostSummary } from './api'

export interface DocumentSearchSource {
  readonly snapshot: Readonly<ShallowRef<readonly PostSummary[]>>
  ensureLoaded(): Promise<void>
  getSnapshot(): readonly PostSummary[]
  replace(next: readonly PostSummary[]): void
  invalidate(): void
}

type PostFetcher = () => Promise<readonly PostSummary[]>

export function createDocumentSearchSource(fetchPosts: PostFetcher = listPosts): DocumentSearchSource {
  const posts = shallowRef<readonly PostSummary[]>([])
  let loaded = false
  let generation = 0
  let inFlight: Promise<void> | null = null

  function startLoad(): Promise<void> {
    const requestGeneration = generation
    let pending: Promise<void>
    pending = fetchPosts().then((next) => {
      if (requestGeneration !== generation) return
      posts.value = [...next]
      loaded = true
    }).finally(() => {
      if (inFlight === pending) inFlight = null
    })
    inFlight = pending
    return pending
  }

  function ensureLoaded(): Promise<void> {
    if (loaded) return Promise.resolve()
    return inFlight ?? startLoad()
  }

  function replace(next: readonly PostSummary[]): void {
    // A live Vault snapshot is authoritative over any initial load that was
    // started before it arrived. Advance the publication boundary before
    // installing it so the older request can only settle harmlessly.
    generation += 1
    inFlight = null
    posts.value = [...next]
    loaded = true
  }

  function invalidate(): void {
    generation += 1
    loaded = false
    // A request from the previous session must not block the first request
    // in the next session. Its generation fence still prevents publication.
    inFlight = null
    posts.value = []
  }

  return {
    snapshot: shallowReadonly(posts),
    ensureLoaded,
    getSnapshot: () => posts.value,
    replace,
    invalidate,
  }
}

export const documentSearchSource = createDocumentSearchSource()

/** Compatibility getter for existing local palette consumers. */
export function getDocumentSearchPosts(): PostSummary[] {
  return [...documentSearchSource.getSnapshot()]
}

/** Compatibility sync seam for VaultView's live metadata updates. */
export function setDocumentSearchPosts(next: readonly PostSummary[]): void {
  documentSearchSource.replace(next)
}

/** Compatibility teardown seam; invalidation is the single cache lifecycle. */
export function clearDocumentSearchPosts(): void {
  documentSearchSource.invalidate()
}
