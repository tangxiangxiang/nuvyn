import type { PostSummary } from './api'
import type { DocumentSearchSource } from './documentSearchSource'
import { buildIndex, captureSearchEpoch, invalidateSearchState, needsBodyPrime, primeBody, rebuildIndex, search } from './search'
import { isManagedDiaryPath } from '../../shared/diaryProtocol'

export type SearchResultType = 'file' | 'heading' | 'tag' | 'alias' | 'command' | 'ai' | 'recent-file' | 'board' | 'diary-day' | 'diary-event' | 'diary-task'
export interface SearchResult<T = unknown> { id: string; type: SearchResultType; title: string; subtitle?: string; icon?: string; score: number; payload: T }
export interface SearchResultSection { id: string; label: string; results: SearchResult[]; error?: boolean; showLabel?: boolean; hasMore?: boolean }
export type SearchProvider = ((query: string) => SearchResultSection | Promise<SearchResultSection>) & {
  subscribe?: (listener: () => void) => () => void
  loadMore?: (query: string) => Promise<SearchResultSection | null>
  clear?: () => void
}
export type LatestSearchRunner = ((query: string) => Promise<void>) & { cancel: () => void }
export interface DocumentSearchPayload { path: string; match: 'title' | 'path' | 'tag' | 'summary' | 'body'; snippet?: string; bodyQuery?: string }

function postsSignature(posts: readonly PostSummary[]): string {
  return posts.map((post) => `${post.path}\0${isManagedDiaryPath(post.path) ? '' : post.title}\0${post.mtime}\0${isManagedDiaryPath(post.path) ? '' : (post.summary ?? '')}\0${isManagedDiaryPath(post.path) ? '' : post.tags.join(',')}`).join('\u0001')
}

type DocumentPostsInput =
  | (() => readonly PostSummary[] | Promise<readonly PostSummary[]>)
  | Pick<DocumentSearchSource, 'ensureLoaded' | 'getSnapshot'>

async function resolvePosts(input: DocumentPostsInput): Promise<PostSummary[]> {
  if (typeof input === 'function') return [...await input()]
  await input.ensureLoaded()
  return [...input.getSnapshot()]
}

export function createDocumentSearchProvider(input: DocumentPostsInput): SearchProvider {
  let indexed = false
  let signature = ''
  let priming: Promise<boolean> | null = null
  let retryAfter = 0
  const listeners = new Set<() => void>()

  const provider: SearchProvider = async (query) => {
    if (!query.trim()) return { id: 'files', label: 'Files', results: [] }

    const requestEpoch = captureSearchEpoch()
    const posts = await resolvePosts(input)
    const nextSignature = postsSignature(posts)
    if (!indexed) {
      buildIndex(posts)
      indexed = true
      signature = nextSignature
    } else if (signature !== nextSignature) {
      rebuildIndex(posts)
      signature = nextSignature
      priming = null
      retryAfter = 0
    }

    if (requestEpoch !== captureSearchEpoch()) {
      return { id: 'files', label: 'Files', results: [] }
    }

    // Return metadata hits immediately. Body requests are started in the
    // background and bounded inside primeBody; completion notifies the
    // palette so it can merge body-only hits into the current query.
    if (!priming && Date.now() >= retryAfter && needsBodyPrime(posts)) {
      const attemptSignature = nextSignature
      const attempt = primeBody(posts)
      priming = attempt
      const finish = (succeeded: boolean) => {
        if (priming !== attempt || signature !== attemptSignature) return
        priming = null
        retryAfter = succeeded ? 0 : Date.now() + 1500
        for (const listener of listeners) listener()
      }
      void attempt.then(finish, () => finish(false))
    }

    const results = search(query, 12).map<SearchResult<DocumentSearchPayload>>((hit) => ({
      id: `file:${hit.path}`, type: 'file', title: hit.title, subtitle: hit.path, score: hit.score,
      payload: {
        path: hit.path,
        match: hit.match,
        snippet: hit.snippet,
        ...(hit.bodyQuery ? { bodyQuery: hit.bodyQuery } : {}),
      },
    }))
    return { id: 'files', label: 'Files', results }
  }

  provider.subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return provider
}

export async function searchEverywhere(query: string, providers: SearchProvider[]): Promise<SearchResultSection[]> {
  if (!query.trim()) return []
  const results = await Promise.allSettled(providers.map((provider) => provider(query)))
  return results
    .filter((result): result is PromiseFulfilledResult<SearchResultSection> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((section) => section.results.length > 0 || section.error === true || section.hasMore === true)
}

export function createLatestSearchRunner(
  getProviders: () => SearchProvider[],
  apply: (sections: SearchResultSection[]) => void,
): LatestSearchRunner {
  let version = 0
  const run = async (query: string): Promise<void> => {
    const requestVersion = ++version
    const requestEpoch = captureSearchEpoch()
    const sections = await searchEverywhere(query, getProviders())
    if (requestVersion === version && requestEpoch === captureSearchEpoch()) apply(sections)
  }
  return Object.assign(run, { cancel: () => { version += 1 } })
}

/** Public teardown seam used by VaultView/session coordination. */
export function invalidateDocumentSearchState(): void {
  invalidateSearchState()
}
