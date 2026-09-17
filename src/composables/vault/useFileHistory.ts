import { computed, ref, type ComputedRef, type Ref } from 'vue'
import * as api from '../../lib/history-api'
import type { CommitRecord } from '../../lib/history-api'
import type { PostSummary } from '../../lib/api'
import type { HistoryRevisionSelection } from './useHistoryComparisons'
import { fallbackDocumentTitle } from './useHistoryTimeline'

export interface FileHistoryTarget {
  documentPath: string
  documentTitle: string
}

export interface FileHistoryCommitItem {
  id: string
  /** First parent; merge commits intentionally use deterministic first-parent semantics. */
  parentId: string | null
  shortId: string
  message: string
  body: string
  modifiedAt: number
}

export interface FileHistoryDayGroup {
  key: string
  label: string
  commits: FileHistoryCommitItem[]
}

export interface FileHistoryState {
  target: Ref<FileHistoryTarget | null>
  commits: Ref<FileHistoryCommitItem[]>
  dayGroups: ComputedRef<FileHistoryDayGroup[]>
  loading: Ref<boolean>
  loaded: Ref<boolean>
  error: Ref<Error | null>
  expandedDays: Ref<Set<string>>
  selectedCommitId: Ref<string | null>
  open(target: FileHistoryTarget): Promise<void>
  refresh(): Promise<void>
  clear(): void
  toggleDay(key: string): void
  expandNewestDay(): void
  selectCommit(commit: FileHistoryCommitItem): HistoryRevisionSelection | null
}

export function resolveFileHistoryTarget(
  documentPath: string,
  posts: readonly PostSummary[],
): FileHistoryTarget {
  const post = posts.find((item) => item.path === documentPath)
  return {
    documentPath,
    documentTitle: post?.title?.trim() || fallbackDocumentTitle(documentPath),
  }
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function dateLabel(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(timestamp)
}

function requestedMarkdownPath(documentPath: string): string {
  return `${documentPath}.md`
}

/**
 * Phase 1 file history is scoped to the selected current path. Following a
 * document across renames requires explicit server support.
 */
export function normalizeFileHistoryCommits(
  records: readonly CommitRecord[],
  documentPath: string,
): FileHistoryCommitItem[] {
  const requestedPath = requestedMarkdownPath(documentPath)
  const commits: FileHistoryCommitItem[] = []

  for (const record of records) {
    const modifiedAt = Date.parse(record.date)
    if (!record.sha || !Number.isFinite(modifiedAt)) continue
    if (!record.files.some((path) => path.trim() === requestedPath)) continue
    commits.push({
      id: record.sha,
      parentId: record.parents[0] ?? null,
      shortId: record.sha.slice(0, 7),
      message: record.subject,
      body: record.body,
      modifiedAt,
    })
  }

  return commits.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

export function groupFileHistoryCommits(
  commits: readonly FileHistoryCommitItem[],
  locale: string,
): FileHistoryDayGroup[] {
  const groups = new Map<string, FileHistoryDayGroup>()
  for (const commit of commits) {
    const key = localDateKey(commit.modifiedAt)
    const group = groups.get(key) ?? {
      key,
      label: dateLabel(commit.modifiedAt, locale),
      commits: [],
    }
    group.commits.push(commit)
    groups.set(key, group)
  }
  return [...groups.values()].sort((left, right) => right.key.localeCompare(left.key))
}

export function useFileHistory(locale: Ref<string>): FileHistoryState {
  const target = ref<FileHistoryTarget | null>(null)
  const commits = ref<FileHistoryCommitItem[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<Error | null>(null)
  const expandedDays = ref<Set<string>>(new Set())
  const selectedCommitId = ref<string | null>(null)
  const dayGroups = computed(() => groupFileHistoryCommits(commits.value, locale.value))
  let requestId = 0
  let initializedDays = false

  function reconcileState(): void {
    const validDays = new Set(dayGroups.value.map((group) => group.key))
    expandedDays.value = new Set([...expandedDays.value].filter((key) => validDays.has(key)))
    if (!initializedDays) {
      const newest = dayGroups.value[0]?.key
      if (newest) expandedDays.value = new Set([newest])
      initializedDays = true
    }
    if (selectedCommitId.value && !commits.value.some((commit) => commit.id === selectedCommitId.value)) {
      selectedCommitId.value = null
    }
  }

  async function load(loadTarget: FileHistoryTarget): Promise<void> {
    const currentRequest = ++requestId
    loading.value = true
    error.value = null
    try {
      const result = await api.getLog({
        path: requestedMarkdownPath(loadTarget.documentPath),
        limit: 200,
      })
      if (currentRequest !== requestId || target.value?.documentPath !== loadTarget.documentPath) return
      commits.value = normalizeFileHistoryCommits(
        Array.isArray(result?.commits) ? result.commits : [],
        loadTarget.documentPath,
      )
      reconcileState()
    } catch (cause) {
      if (currentRequest !== requestId || target.value?.documentPath !== loadTarget.documentPath) return
      error.value = cause instanceof Error ? cause : new Error(String(cause))
    } finally {
      if (currentRequest !== requestId) return
      loading.value = false
      loaded.value = true
    }
  }

  async function open(nextTarget: FileHistoryTarget): Promise<void> {
    const switched = target.value?.documentPath !== nextTarget.documentPath
    target.value = nextTarget
    if (switched) {
      requestId++
      commits.value = []
      expandedDays.value = new Set()
      selectedCommitId.value = null
      loaded.value = false
      error.value = null
      initializedDays = false
    }
    await load(nextTarget)
  }

  async function refresh(): Promise<void> {
    const currentTarget = target.value
    if (!currentTarget) return
    await load(currentTarget)
  }

  function clear(): void {
    requestId++
    target.value = null
    commits.value = []
    loading.value = false
    loaded.value = false
    error.value = null
    expandedDays.value = new Set()
    selectedCommitId.value = null
    initializedDays = false
  }

  function toggleDay(key: string): void {
    const next = new Set(expandedDays.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expandedDays.value = next
  }

  function expandNewestDay(): void {
    const newest = dayGroups.value[0]?.key
    if (newest && !expandedDays.value.has(newest)) {
      expandedDays.value = new Set([...expandedDays.value, newest])
    }
  }

  function selectCommit(commit: FileHistoryCommitItem): HistoryRevisionSelection | null {
    const currentTarget = target.value
    if (!currentTarget) return null
    selectedCommitId.value = commit.id
    return {
      documentPath: currentTarget.documentPath,
      documentTitle: currentTarget.documentTitle,
      revisionId: commit.id,
      parentRevisionId: commit.parentId,
      revisionTime: commit.modifiedAt,
      summary: commit.message,
    }
  }

  return {
    target,
    commits,
    dayGroups,
    loading,
    loaded,
    error,
    expandedDays,
    selectedCommitId,
    open,
    refresh,
    clear,
    toggleDay,
    expandNewestDay,
    selectCommit,
  }
}
