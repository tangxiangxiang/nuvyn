import { computed, ref, watch, type Ref } from 'vue'
import type { PostSummary } from '../../lib/api'
import type { CommitRecord } from '../../lib/history-api'
import type { HistoryRevisionSelection } from './useHistoryComparisons'

export interface HistoryFileItem {
  path: string
  documentPath: string
  title: string
  parentPath: string | null
}

export interface HistoryCommitItem {
  id: string
  /** First parent; merge commits intentionally use deterministic first-parent semantics. */
  parentId: string | null
  shortId: string
  message: string
  body: string
  modifiedAt: number
  files: HistoryFileItem[]
}

export interface HistoryDayGroup {
  key: string
  label: string
  commits: HistoryCommitItem[]
}

interface HistoryTimelineSource {
  log: Ref<CommitRecord[]>
  logLoaded: Ref<boolean>
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function normalizeMarkdownPath(path: string): string | null {
  const normalized = path.trim()
  if (!normalized.endsWith('.md') || normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('\0')) {
    return null
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return normalized
}

export function fallbackDocumentTitle(path: string): string {
  const documentPath = path.endsWith('.md') ? path.slice(0, -3) : path
  const filename = documentPath.split('/').pop() ?? documentPath
  return filename
    .replace(/^\d+[-_]/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function dateLabel(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(timestamp)
}

/** Pure projection from the Git-native log into Date -> Commit -> Files. */
export function buildHistoryDayGroups(
  records: readonly CommitRecord[],
  posts: readonly PostSummary[],
  locale: string,
): HistoryDayGroup[] {
  const titles = new Map(posts.map((post) => [post.path, post.title]))
  const commits: HistoryCommitItem[] = []

  for (const record of records) {
    const modifiedAt = Date.parse(record.date)
    if (!record.sha || !Number.isFinite(modifiedAt)) continue
    const seen = new Set<string>()
    const files = record.files.flatMap((rawPath): HistoryFileItem[] => {
      const path = normalizeMarkdownPath(rawPath)
      if (!path || seen.has(path)) return []
      seen.add(path)
      const documentPath = path.slice(0, -3)
      const parentPath = documentPath.includes('/')
        ? documentPath.slice(0, documentPath.lastIndexOf('/'))
        : null
      return [{
        path,
        documentPath,
        title: titles.get(documentPath) ?? fallbackDocumentTitle(path),
        parentPath,
      }]
    })
    if (files.length === 0) continue
    commits.push({
      id: record.sha,
      parentId: record.parents[0] ?? null,
      shortId: record.sha.slice(0, 7),
      message: record.subject,
      body: record.body,
      modifiedAt,
      files,
    })
  }

  commits.sort((left, right) => right.modifiedAt - left.modifiedAt)
  const groups = new Map<string, HistoryDayGroup>()
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

export function toHistoryRevisionSelection(
  file: HistoryFileItem,
  commit: HistoryCommitItem,
): HistoryRevisionSelection {
  return {
    documentPath: file.documentPath,
    documentTitle: file.title,
    revisionId: commit.id,
    parentRevisionId: commit.parentId,
    revisionTime: commit.modifiedAt,
    summary: commit.message,
  }
}

export function useHistoryTimeline(
  source: HistoryTimelineSource,
  posts: Ref<PostSummary[]>,
  locale: Ref<string>,
) {
  const expandedDays = ref<Set<string>>(new Set())
  const expandedCommits = ref<Set<string>>(new Set())
  const selectedRevisionKey = ref<string | null>(null)
  const initializedDefaults = ref(false)

  const dayGroups = computed(() => buildHistoryDayGroups(source.log.value, posts.value, locale.value))
  const commits = computed(() => dayGroups.value.flatMap((group) => group.commits))

  watch([dayGroups, source.logLoaded], ([groups]) => {
    const commitIds = new Set(groups.flatMap((group) => group.commits.map((commit) => commit.id)))
    expandedCommits.value = new Set([...expandedCommits.value].filter((id) => commitIds.has(id)))
    if (selectedRevisionKey.value) {
      const commitId = selectedRevisionKey.value.split('\0', 1)[0]!
      if (!commitIds.has(commitId)) selectedRevisionKey.value = null
    }

    if (!initializedDefaults.value && source.logLoaded.value) {
      expandedDays.value = new Set()
      expandedCommits.value = new Set()
      initializedDefaults.value = true
    }
  }, { immediate: true })

  function toggleDay(key: string): void {
    const next = new Set(expandedDays.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expandedDays.value = next
  }

  function toggleCommit(id: string): void {
    const next = new Set(expandedCommits.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expandedCommits.value = next
  }

  function expandNewestDay(): void {
    const key = dayGroups.value[0]?.key
    if (!key || expandedDays.value.has(key)) return
    expandedDays.value = new Set([...expandedDays.value, key])
  }

  function selectFile(file: HistoryFileItem, commit: HistoryCommitItem): HistoryRevisionSelection {
    selectedRevisionKey.value = `${commit.id}\0${file.path}`
    return toHistoryRevisionSelection(file, commit)
  }

  return {
    dayGroups,
    commits,
    expandedDays,
    expandedCommits,
    selectedRevisionKey,
    loading: computed(() => !source.logLoaded.value),
    toggleDay,
    toggleCommit,
    expandNewestDay,
    selectFile,
  }
}
