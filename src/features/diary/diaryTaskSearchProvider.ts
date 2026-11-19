import type { DiaryTaskSearchItem } from '../../../shared/diaryTasks'
import { diaryTasksApi } from '../../lib/diary-tasks-api'
import type { SearchProvider, SearchResult } from '../../lib/searchResults'
import { createPagedDiarySearchProvider } from './pagedDiarySearchProvider'

export interface DiaryTaskSearchPayload extends DiaryTaskSearchItem { query: string }

function mapTask(item: DiaryTaskSearchItem, query: string): SearchResult<DiaryTaskSearchPayload> {
  const status = item.completedAt === null ? '未完成' : '已完成'
  const subtitle = item.targetDate
    ? `截止 ${item.targetDate} · ${status}`
    : item.kind === 'one-off'
      ? `缺少截止日期 · ${status}`
      : '暂无可定位日期 · 重复待办'
  return {
    id: `diary-task:${item.kind}:${item.seriesId ?? item.id}`,
    type: 'diary-task',
    title: item.title,
    subtitle,
    icon: item.completedAt === null ? '○' : '✓',
    score: item.match === 'title' ? 2 : 1,
    payload: { ...item, query },
  }
}

export function createDiaryTaskSearchProvider(): SearchProvider {
  return createPagedDiarySearchProvider(
    'diary-tasks',
    '待办',
    (query, cursor, signal) => diaryTasksApi.searchTasks(query, 20, cursor, signal),
    mapTask,
  )
}
