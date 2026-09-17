import type { PostSummary } from './api'
import type { DocumentSearchSource } from './documentSearchSource'
import { buildIndex, captureSearchEpoch, invalidateSearchState, primeBody, rebuildIndex, search } from './search'
import { isManagedDiaryPath } from '../../shared/diaryProtocol'

export type SearchResultType = 'file' | 'heading' | 'tag' | 'alias' | 'command' | 'ai' | 'recent-file' | 'board'
export interface SearchResult<T = unknown> { id: string; type: SearchResultType; title: string; subtitle?: string; icon?: string; score: number; payload: T }
export interface SearchResultSection { id: string; label: string; results: SearchResult[] }
export type SearchProvider = (query: string) => SearchResultSection | Promise<SearchResultSection>
export interface DocumentSearchPayload { path: string; match: 'title' | 'path' | 'tag' | 'summary' | 'body'; snippet?: string }

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
  let priming: Promise<void> | null = null

  return async (query) => {
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
    }

    if (!query.trim()) {
      const displayTitle = (post: PostSummary): string =>
        isManagedDiaryPath(post.path) ? (post.path.split('/').pop() ?? post.path) : post.title
      const results = [...posts].sort((a, b) => displayTitle(a).localeCompare(displayTitle(b))).slice(0, 12).map<SearchResult<DocumentSearchPayload>>((post) => ({
        id: `file:${post.path}`, type: 'file',
        title: displayTitle(post),
        subtitle: post.path, score: 0,
        payload: { path: post.path, match: 'title' },
      }))
      return { id: 'files', label: 'Files', results }
    }

    if (!priming) priming = primeBody(posts)
    await priming
    if (requestEpoch !== captureSearchEpoch()) {
      return { id: 'files', label: 'Files', results: [] }
    }
    const results = search(query, 12).map<SearchResult<DocumentSearchPayload>>((hit) => ({
      id: `file:${hit.path}`, type: 'file', title: hit.title, subtitle: hit.path, score: hit.score,
      payload: { path: hit.path, match: hit.match, snippet: hit.snippet },
    }))
    return { id: 'files', label: 'Files', results }
  }
}

export async function searchEverywhere(query: string, providers: SearchProvider[]): Promise<SearchResultSection[]> {
  const results = await Promise.allSettled(providers.map((provider) => provider(query)))
  return results
    .filter((result): result is PromiseFulfilledResult<SearchResultSection> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((section) => section.results.length > 0)
}

export function createLatestSearchRunner(
  getProviders: () => SearchProvider[],
  apply: (sections: SearchResultSection[]) => void,
) {
  let version = 0
  return async (query: string): Promise<void> => {
    const requestVersion = ++version
    const requestEpoch = captureSearchEpoch()
    const sections = await searchEverywhere(query, getProviders())
    if (requestVersion === version && requestEpoch === captureSearchEpoch()) apply(sections)
  }
}

/** Public teardown seam used by VaultView/session coordination. */
export function invalidateDocumentSearchState(): void {
  invalidateSearchState()
}
