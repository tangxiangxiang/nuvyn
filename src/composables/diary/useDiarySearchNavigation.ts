import { readonly, ref } from 'vue'

export interface DiaryDiarySearchOpenIntent {
  id: number
  kind: 'diary'
  date: string
  entryId?: string
  entryIndex?: number
}

export interface DiaryEventSearchOpenIntent {
  id: number
  kind: 'event'
  eventId: string
  date: string | null
}

export interface DiaryTaskSearchOpenIntent {
  id: number
  kind: 'task'
  taskId?: string
  seriesId?: string
  date: string | null
}

export type DiarySearchOpenIntent = DiaryDiarySearchOpenIntent | DiaryEventSearchOpenIntent | DiaryTaskSearchOpenIntent

const intent = ref<DiarySearchOpenIntent | null>(null)
let nextId = 0

export const diarySearchOpenIntent = readonly(intent)

export function requestDiarySearchOpen(value: Omit<DiaryDiarySearchOpenIntent, 'id' | 'kind'>): DiaryDiarySearchOpenIntent {
  const next: DiaryDiarySearchOpenIntent = { ...value, kind: 'diary', id: ++nextId }
  intent.value = next
  return next
}

export function requestDiaryEventSearchOpen(value: Omit<DiaryEventSearchOpenIntent, 'id' | 'kind'>): DiaryEventSearchOpenIntent {
  const next: DiaryEventSearchOpenIntent = { ...value, kind: 'event', id: ++nextId }
  intent.value = next
  return next
}

export function requestDiaryTaskSearchOpen(value: Omit<DiaryTaskSearchOpenIntent, 'id' | 'kind'>): DiaryTaskSearchOpenIntent {
  const next: DiaryTaskSearchOpenIntent = { ...value, kind: 'task', id: ++nextId }
  intent.value = next
  return next
}

export function consumeDiarySearchOpen(id: number): void {
  if (intent.value?.id === id) intent.value = null
}

export function clearDiarySearchOpen(): void {
  intent.value = null
}
