import type { PostSummary } from '../../lib/api'
import type { Tab } from '../vault/tabs'
import {
  classifyDiaryPath,
  diaryDateFromPath,
  type DiaryDate,
} from '../../../shared/diaryProtocol'

export type NativeDiaryMoodContext = {
  date: DiaryDate
  path: string
  mood: string | null
  documentId?: string
  metadataUpdatedAt?: number
}

/**
 * Resolve the one native Diary metadata context from existing workspace
 * state. This is deliberately a pure projection: it owns no reactive mood
 * value and does not decide whether a special surface should yield.
 */
export function resolveNativeDiaryMoodContext(
  activeTab: Pick<Tab, 'path' | 'loading' | 'loadError'> | null,
  posts: readonly PostSummary[],
  excludedBySurface: boolean,
): NativeDiaryMoodContext | null {
  if (excludedBySurface || !activeTab || activeTab.loading || activeTab.loadError) return null
  if (classifyDiaryPath(activeTab.path) !== 'managed') return null

  const date = diaryDateFromPath(activeTab.path)
  if (!date) return null

  const post = posts.find((candidate) => candidate.path === activeTab.path)
  if (!post) return null

  return {
    date,
    path: activeTab.path,
    mood: post.mood ?? null,
    documentId: post.documentId,
    metadataUpdatedAt: post.metadataUpdatedAt,
  }
}
