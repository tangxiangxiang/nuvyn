import { diaryAuthFetch } from './auth-session'
import type { DiaryDay, DiaryDaySummary, DiaryEvent, DayFields, EventFields } from '../../shared/diaryLife'
import type { DiaryAttachment } from '../../shared/diaryAttachments'

export function createDiaryEventId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Web Crypto still provides random bytes on HTTP origins where randomUUID is absent.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await diaryAuthFetch(`/api/diary/life${path}`, {
    method, signal, cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(response.status === 409 ? '记录已更新，请重新打开后再编辑。' : '操作失败，请重试。')
  return response.json()
}
export const diaryLifeApi = {
  async countdowns(today: string, signal?: AbortSignal): Promise<DiaryEvent[]> {
    const items: DiaryEvent[] = []
    let offset: number | null = 0
    do {
      const result: { items: DiaryEvent[]; next: number | null } = await request(`/countdowns?today=${today}&offset=${offset}`, 'GET', undefined, signal)
      items.push(...result.items)
      offset = result.next
    } while (offset !== null)
    return items
  },
  days: (start: string, end: string, signal?: AbortSignal) => request<{ days: DiaryDaySummary[] }>(`/days?start=${start}&end=${end}`, 'GET', undefined, signal),
  day: (date: string, signal?: AbortSignal) => request<{ day: DiaryDay | null; version: number; attachments: DiaryAttachment[] }>(`/days/${date}`, 'GET', undefined, signal),
  saveDay: (date: string, fields: DayFields, expectedVersion: number, attachments?: string[]) => request<{ day: DiaryDay; version: number; attachments: DiaryAttachment[] }>(`/days/${date}`, 'PUT', { ...fields, expectedVersion, ...(attachments === undefined ? {} : { attachments }) }),
  deleteDay: (date: string, expectedVersion: number) => request(`/days/${date}`, 'DELETE', { expectedVersion }),
  async events(start: string, end: string, signal?: AbortSignal): Promise<DiaryEvent[]> {
    const items: DiaryEvent[] = []
    let offset: number | null = 0
    do {
      const result: { items: DiaryEvent[]; next: number | null } = await request(`/events?start=${start}&end=${end}&offset=${offset}`, 'GET', undefined, signal)
      items.push(...result.items)
      offset = result.next
    } while (offset !== null)
    return items
  },
  eventListPage: (offset = 0, signal?: AbortSignal) => request<{ items: DiaryEvent[]; next: number | null }>(`/events/list?offset=${offset}`, 'GET', undefined, signal),
  saveEvent: (id: string, fields: EventFields, expectedVersion: number) => request<{ event: DiaryEvent }>(`/events/${id}`, 'PUT', { ...fields, expectedVersion }),
  deleteEvent: (id: string, expectedVersion: number) => request(`/events/${id}`, 'DELETE', { expectedVersion }),
}
