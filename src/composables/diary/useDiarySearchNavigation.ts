import { readonly, ref } from 'vue'

export interface DiarySearchOpenIntent {
  id: number
  date: string
  entryId?: string
  entryIndex?: number
}

const intent = ref<DiarySearchOpenIntent | null>(null)
let nextId = 0

export const diarySearchOpenIntent = readonly(intent)

export function requestDiarySearchOpen(value: Omit<DiarySearchOpenIntent, 'id'>): DiarySearchOpenIntent {
  const next = { ...value, id: ++nextId }
  intent.value = next
  return next
}

export function consumeDiarySearchOpen(id: number): void {
  if (intent.value?.id === id) intent.value = null
}

export function clearDiarySearchOpen(): void {
  intent.value = null
}
