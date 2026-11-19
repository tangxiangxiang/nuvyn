import type { DiaryEventSearchItem } from '../../../shared/diaryLife'
import { diaryLifeApi } from '../../lib/diary-life-api'
import type { SearchProvider, SearchResult } from '../../lib/searchResults'
import { createPagedDiarySearchProvider } from './pagedDiarySearchProvider'

export interface DiaryEventSearchPayload extends DiaryEventSearchItem { query: string }

function mapEvent(item: DiaryEventSearchItem, query: string): SearchResult<DiaryEventSearchPayload> {
  return {
    id: `diary-event:${item.id}`,
    type: 'diary-event',
    title: item.title,
    subtitle: item.subtitle,
    icon: item.emoji,
    score: item.match === 'title' ? 2 : 1,
    payload: { ...item, query },
  }
}

export function createDiaryEventSearchProvider(): SearchProvider {
  return createPagedDiarySearchProvider(
    'diary-events',
    '事件',
    (query, cursor, signal) => diaryLifeApi.searchEvents(query, 20, cursor, signal),
    mapEvent,
  )
}
