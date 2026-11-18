import { diaryAuthFetch } from './auth-session'
import type { DiaryRecurringTaskOccurrence, DiaryTask, DiaryTaskItemPage, DiaryTaskListItem, DiaryTaskListStatus, DiaryTaskPage, DiaryTaskSeries, OneOffTaskFields, TaskSeriesFields } from '../../shared/diaryTasks'
export type { DiaryTaskPage } from '../../shared/diaryTasks'

export class DiaryTaskApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.name = 'DiaryTaskApiError'
    this.status = status
    this.code = code
  }
}

export class DiaryTaskConflictError extends DiaryTaskApiError {
  constructor() {
    super(409, 'diary-conflict', '任务已更新，请重新加载后再试。')
    this.name = 'DiaryTaskConflictError'
  }
}

export class DiaryTaskHistoryProtectedError extends DiaryTaskApiError {
  constructor() {
    super(409, 'diary-task-history-protected', '该重复任务已有历史边界或记录，无法安全扩展或改写历史。请从后续日期开始创建新的重复任务。')
    this.name = 'DiaryTaskHistoryProtectedError'
  }
}

export class DiaryTaskListChangedError extends DiaryTaskApiError {
  constructor() {
    super(409, 'diary-task-list-changed', '任务列表已更新，请从第一页重新加载。')
    this.name = 'DiaryTaskListChangedError'
  }
}

function createDiaryTaskId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await diaryAuthFetch(`/api/diary/life${path}`, {
    method,
    signal,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: unknown } | null
    const code = typeof payload?.code === 'string' ? payload.code : null
    if (response.status === 409 && code === 'diary-task-list-changed') throw new DiaryTaskListChangedError()
    if (response.status === 409 && code === 'diary-task-history-protected') throw new DiaryTaskHistoryProtectedError()
    if (response.status === 409) throw new DiaryTaskConflictError()
    throw new DiaryTaskApiError(response.status, code, '任务操作失败，请重试。')
  }
  return response.json() as Promise<T>
}

export const diaryTasksApi = {
  createTask(fields: OneOffTaskFields): Promise<{ task: DiaryTask }> {
    return request(`/tasks/${createDiaryTaskId()}`, 'PUT', {
      ...fields,
      expectedVersion: 0,
    })
  },
  getTask(id: string, signal?: AbortSignal): Promise<{ task: DiaryTask }> {
    return request(`/tasks/${encodeURIComponent(id)}`, 'GET', undefined, signal)
  },
  listTasks(cursor?: string, signal?: AbortSignal, status?: DiaryTaskListStatus): Promise<DiaryTaskPage> {
    const query = new URLSearchParams()
    if (status) query.set('status', status)
    if (cursor !== undefined) query.set('cursor', cursor)
    return request(`/tasks/list${query.size ? `?${query}` : ''}`, 'GET', undefined, signal)
  },
  tasksInRange(start: string, end: string, cursor?: string, signal?: AbortSignal): Promise<DiaryTaskPage> {
    const query = new URLSearchParams({ start, end })
    if (cursor !== undefined) query.set('cursor', cursor)
    return request(`/tasks?${query}`, 'GET', undefined, signal)
  },
  updateTask(id: string, fields: OneOffTaskFields, expectedVersion: number): Promise<{ task: DiaryTask }> {
    return request(`/tasks/${encodeURIComponent(id)}`, 'PUT', {
      ...fields,
      expectedVersion,
    })
  },
  completeTask(id: string, expectedVersion: number): Promise<{ task: DiaryTask }> {
    return request(`/tasks/${encodeURIComponent(id)}/complete`, 'POST', { expectedVersion })
  },
  reopenTask(id: string, expectedVersion: number): Promise<{ task: DiaryTask }> {
    return request(`/tasks/${encodeURIComponent(id)}/reopen`, 'POST', { expectedVersion })
  },
  deleteTask(id: string, expectedVersion: number): Promise<{ ok: true; version: number }> {
    return request(`/tasks/${encodeURIComponent(id)}`, 'DELETE', { expectedVersion })
  },
  taskItemsInRange(start: string, end: string, cursor?: string, signal?: AbortSignal): Promise<DiaryTaskItemPage> {
    const query = new URLSearchParams({ start, end })
    if (cursor !== undefined) query.set('cursor', cursor)
    return request(`/task-occurrences?${query}`, 'GET', undefined, signal)
  },
  listTaskItems(start: string, end: string, cursor?: string, signal?: AbortSignal, status?: DiaryTaskListStatus): Promise<DiaryTaskItemPage> {
    const query = new URLSearchParams({ start, end })
    if (cursor !== undefined) query.set('cursor', cursor)
    if (status !== undefined) query.set('status', status)
    return request(`/task-items?${query}`, 'GET', undefined, signal)
  },
  createSeries(fields: TaskSeriesFields): Promise<{ series: DiaryTaskSeries }> {
    return request(`/task-series/${createDiaryTaskId()}`, 'PUT', { ...fields, expectedVersion: 0 })
  },
  updateSeries(seriesId: string, effectiveDate: string, fields: TaskSeriesFields, expectedVersion: number): Promise<{ series: DiaryTaskSeries }> {
    return request(`/task-series/${encodeURIComponent(seriesId)}`, 'PUT', { ...fields, newSeriesId: createDiaryTaskId(), effectiveDate, expectedVersion })
  },
  getSeries(seriesId: string, signal?: AbortSignal): Promise<{ series: DiaryTaskSeries }> {
    return request(`/task-series/${encodeURIComponent(seriesId)}`, 'GET', undefined, signal)
  },
  getOccurrence(seriesId: string, date: string, signal?: AbortSignal): Promise<{ occurrence: DiaryRecurringTaskOccurrence }> {
    return request(`/task-series/${encodeURIComponent(seriesId)}/occurrences/${encodeURIComponent(date)}`, 'GET', undefined, signal)
  },
  stopSeries(seriesId: string, effectiveDate: string, expectedVersion: number): Promise<{ series: DiaryTaskSeries }> {
    return request(`/task-series/${encodeURIComponent(seriesId)}/stop`, 'POST', { effectiveDate, expectedVersion })
  },
  deleteSeries(seriesId: string, expectedVersion: number): Promise<{ ok: true; version: number }> {
    return request(`/task-series/${encodeURIComponent(seriesId)}`, 'DELETE', { expectedVersion })
  },
  completeOccurrence(seriesId: string, date: string, expectedVersion: number): Promise<{ occurrence: DiaryTaskListItem }> {
    return request(`/task-series/${encodeURIComponent(seriesId)}/occurrences/${encodeURIComponent(date)}/complete`, 'POST', { expectedVersion })
  },
  reopenOccurrence(seriesId: string, date: string, expectedVersion: number): Promise<{ occurrence: DiaryTaskListItem }> {
    return request(`/task-series/${encodeURIComponent(seriesId)}/occurrences/${encodeURIComponent(date)}/reopen`, 'POST', { expectedVersion })
  },
  skipOccurrence(seriesId: string, date: string, expectedVersion: number): Promise<{ occurrence: DiaryTaskListItem }> {
    return request(`/task-series/${encodeURIComponent(seriesId)}/occurrences/${encodeURIComponent(date)}/skip`, 'POST', { expectedVersion })
  },
}
