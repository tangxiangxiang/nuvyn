import MiniSearch from 'minisearch'
import type { PostSummary } from './api'
import { authFetchForPath } from './diary-request'
import { isManagedDiaryPath } from '../../shared/diaryProtocol'

/**
 * 客户端搜索:基于 minisearch,索引 PostSummary(path/title/tags/summary),
 * 搜索时会再拉一次正文做正文匹配,小规模(<500 篇)直接一次性全量索引。
 *
 * 设计: index 是普通对象,load 一次性 addAll;rebuild 用于重命名/删除后重建。
 */
export interface SearchDoc {
  id: string
  path: string
  title: string
  tags: string
  summary: string
}

export interface SearchHit {
  path: string
  title: string
  score: number
  match: 'title' | 'path' | 'tag' | 'summary' | 'body'
  snippet?: string
}

let mini: MiniSearch<SearchDoc> | null = null
interface BodyCacheEntry {
  body: string
  mtime: number
}
let bodyCache: Map<string, BodyCacheEntry> = new Map()
let searchEpoch = 0

function managedTitle(path: string): string {
  return path.split('/').pop() ?? path
}

/** Capture/invalidate the search lifecycle token at the existing Diary
 * session teardown seam. This is a subordinate cache token, never a second
 * authorization/session owner. */
export function captureSearchEpoch(): number { return searchEpoch }

export function invalidateSearchState(): void {
  searchEpoch += 1
  // Body search is ordinary-Note state.  Managed Diary bodies are never
  // admitted to this cache, but remove any legacy/test residue by
  // classification rather than clearing every Note entry on a Diary lock.
  // The epoch still drops stale provider results; preserving the Note cache
  // keeps the shared search surface behavior unchanged after teardown.
  for (const key of [...bodyCache.keys()]) {
    if (isManagedDiaryPath(key)) bodyCache.delete(key)
  }
}

export function bodyCachePathsForTesting(): string[] {
  return [...bodyCache.keys()]
}

function makeIndex(): MiniSearch<SearchDoc> {
  return new MiniSearch<SearchDoc>({
    fields: ['title', 'path', 'tags', 'summary'],
    storeFields: ['path', 'title', 'tags', 'summary'],
    idField: 'id',
    searchOptions: {
      boost: { title: 3, path: 2.5, tags: 2, summary: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  })
}

export function buildIndex(posts: PostSummary[]): void {
  const docs: SearchDoc[] = posts.map((p) => ({
    id: p.path,
    path: p.path,
    // Managed Diary contributes structural path/date only. Private title,
    // tags, and summary stay out of MiniSearch even while unlocked.
    title: isManagedDiaryPath(p.path) ? managedTitle(p.path) : p.title,
    tags: isManagedDiaryPath(p.path) ? '' : (p.tags ?? []).join(' '),
    summary: isManagedDiaryPath(p.path) ? '' : (p.summary ?? ''),
  }))
  mini = makeIndex()
  mini.addAll(docs)
  for (const key of [...bodyCache.keys()]) {
    if (isManagedDiaryPath(key) || !docs.some((doc) => doc.path === key)) bodyCache.delete(key)
  }
}

/** 重建索引(在 posts 列表变化后调用) */
export function rebuildIndex(posts: PostSummary[]): void {
  buildIndex(posts)
  // body 缓存里失效不存在的 path
  const valid = new Set(posts.map((p) => p.path))
  for (const k of Array.from(bodyCache.keys())) {
    if (!valid.has(k)) bodyCache.delete(k)
  }
}

/** 拉正文并缓存(供 body 搜索用) */
export async function primeBody(posts: PostSummary[]): Promise<void> {
  const capturedEpoch = searchEpoch
  const stale = posts.filter((post) => {
    if (isManagedDiaryPath(post.path)) return false
    const cached = bodyCache.get(post.path)
    return !cached || cached.mtime !== post.mtime
  })
  await Promise.all(
    stale.map(async (p) => {
      try {
        // encodeURI (not encodeURIComponent) — the splat route
        // /api/posts/* expects the path segments to be raw, not %2F
        // encoded. encodeURIComponent converts `/` to `%2F`, which makes
        // the splat path invalid server-side (filePathFor rejects it as
        // a syntax error) and the response is 400. encodeURI leaves
        // the `/` segments alone but still escapes unsafe characters
        // in the kebab segments (the path regex already restricts them
        // to [a-z0-9-] so escaping is a no-op in practice, but we
        // still call it to be defensive against a future loosening of
        // the path syntax). This matches what useEditorTabs.doSave
        // does at useEditorTabs.ts:155.
        const res = await authFetchForPath(p.path, `/api/posts/${encodeURI(p.path)}`)
        if (!res.ok) return
        const data = (await res.json()) as { content: string }
        if (capturedEpoch !== searchEpoch || isManagedDiaryPath(p.path)) return
        // A slower request for an older revision must not overwrite a
        // newer body that finished first.
        const current = bodyCache.get(p.path)
        if (!current || current.mtime <= p.mtime) {
          bodyCache.set(p.path, { body: data.content ?? '', mtime: p.mtime })
        }
      } catch {
        /* ignore */
      }
    }),
  )
}

/** 简单 snippet:命中关键字前后各取 40 字符 */
function snippet(body: string, q: string): string {
  const i = body.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return body.slice(0, 80)
  const start = Math.max(0, i - 40)
  const end = Math.min(body.length, i + q.length + 40)
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
}

export function search(query: string, limit = 12): SearchHit[] {
  if (!mini || !query.trim()) return []
  const q = query.trim()
  const needle = q.toLowerCase()
  // MiniSearch fuzzy matching is useful for ordinary Notes, but it can make
  // an unrelated query hit a managed Diary basename.  Managed entries may
  // only match the structural path/date projection that we intentionally
  // indexed; never let fuzzy scoring turn that projection into a broad
  // private-metadata side channel.
  const titleHits = mini.search(q).filter((h) => {
    if (!isManagedDiaryPath(String(h.path ?? ''))) return true
    const path = String(h.path ?? '').toLowerCase()
    const title = String(h.title ?? '').toLowerCase()
    return path.includes(needle) || title.includes(needle)
  }).slice(0, limit)
  const seen = new Set(titleHits.map((h) => h.path))
  const hits: SearchHit[] = titleHits.map((h) => {
    const title = String(h.title ?? '')
    const path = String(h.path ?? '')
    const tags = String(h.tags ?? '')
    const summary = String(h.summary ?? '')
    const match: SearchHit['match'] = title.toLowerCase().includes(needle) ? 'title'
      : path.toLowerCase().includes(needle) ? 'path'
      : tags.toLowerCase().includes(needle) ? 'tag'
      : 'summary'
    return { path, title, score: h.score, match, ...(match === 'summary' && summary ? { snippet: snippet(summary, q) } : {}) }
  })

  // 正文补充:在 title 没吃饱时去 body 找
  if (hits.length < limit) {
    for (const [path, cached] of bodyCache) {
      if (isManagedDiaryPath(path)) continue
      if (seen.has(path)) continue
      const body = cached.body
      if (body.toLowerCase().includes(q.toLowerCase())) {
        hits.push({ path, title: mini.getStoredFields(path)?.title as string || path, score: 0.1, match: 'body', snippet: snippet(body, q) })
        seen.add(path)
        if (hits.length >= limit) break
      }
    }
  }
  return hits
}

/** 释放全部(用于测试 / 热重载场景) */
export function dispose(): void {
  searchEpoch += 1
  mini = null
  bodyCache.clear()
}
