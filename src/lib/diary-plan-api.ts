import type { DiaryPlanDaySummary } from '../../shared/diaryPlan'
import { diaryAuthFetch } from './auth-session'

const base = '/api/diary/plans'

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await diaryAuthFetch(`${base}${path}`, init)
  if (!response.ok) throw new Error(`Diary plan request failed (${response.status})`)
  return response.json()
}

export const diaryPlanApi = {
  async month(month: string, signal?: AbortSignal) {
    return (await request<{ days: DiaryPlanDaySummary[] }>(`/calendar?month=${month}`, { signal })).days
  },
  migrate(offset: number, signal: AbortSignal) {
    return request<{ migrated: number; failures: Array<{ date: string; code: string }>; next: number | null }>(
      `/migrate?offset=${offset}`, { method: 'POST', signal },
    )
  },
}
