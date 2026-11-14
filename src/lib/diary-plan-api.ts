import type { DiaryDate } from '../../shared/diaryProtocol'
import type { DiaryPlanDaySummary, DiaryPlanFields, DiaryPlanItem } from '../../shared/diaryPlan'
import { diaryAuthFetch } from './auth-session'

const base = '/api/diary/plans'

export class DiaryPlanRequestError extends Error {
  readonly status: number

  constructor(status: number) {
    super('Diary plan request failed')
    this.status = status
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await diaryAuthFetch(url, init)
  if (!response.ok) throw new DiaryPlanRequestError(response.status)
  return response.status === 204 ? undefined as T : response.json()
}

function json(method: string, body: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export const diaryPlanApi = {
  async month(month: string, signal?: AbortSignal) {
    return (await request<{ days: DiaryPlanDaySummary[] }>(`${base}/calendar?month=${month}`, { signal })).days
  },
  async list(date: DiaryDate, signal?: AbortSignal) {
    return (await request<{ items: DiaryPlanItem[] }>(`${base}?date=${date}`, { signal })).items
  },
  create(id: string, date: DiaryDate, fields: DiaryPlanFields) {
    return request<{ item: DiaryPlanItem }>(base, json('POST', { id, date, ...fields }))
  },
  update(item: DiaryPlanItem, fields: Partial<DiaryPlanFields> & { completed?: boolean }) {
    return request<{ item: DiaryPlanItem }>(`${base}/${item.id}`, json('PATCH', { version: item.version, ...fields }))
  },
  remove(item: DiaryPlanItem) {
    return request<void>(`${base}/${item.id}?version=${item.version}`, { method: 'DELETE' })
  },
}

export function newDiaryPlanId(): string {
  // getRandomValues also works when a self-hosted installation uses HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
