import { diaryAuthFetch } from './auth-session'
import type { DiaryTask, DiaryTaskPage, TaskFields } from '../../shared/diaryTasks'
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
    if (response.status === 409) throw new DiaryTaskConflictError()
    throw new DiaryTaskApiError(response.status, code, '任务操作失败，请重试。')
  }
  return response.json() as Promise<T>
}

export const diaryTasksApi = {
  createTask(fields: TaskFields): Promise<{ task: DiaryTask }> {
    return request(`/tasks/${createDiaryTaskId()}`, 'PUT', { ...fields, expectedVersion: 0 })
  },
  getTask(id: string, signal?: AbortSignal): Promise<{ task: DiaryTask }> {
    return request(`/tasks/${encodeURIComponent(id)}`, 'GET', undefined, signal)
  },
  listTasks(cursor?: string, signal?: AbortSignal): Promise<DiaryTaskPage> {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
    return request(`/tasks/list${query}`, 'GET', undefined, signal)
  },
  tasksInRange(start: string, end: string, cursor?: string, signal?: AbortSignal): Promise<DiaryTaskPage> {
    const query = new URLSearchParams({ start, end })
    if (cursor !== undefined) query.set('cursor', cursor)
    return request(`/tasks?${query}`, 'GET', undefined, signal)
  },
  updateTask(id: string, fields: TaskFields, expectedVersion: number): Promise<{ task: DiaryTask }> {
    return request(`/tasks/${encodeURIComponent(id)}`, 'PUT', { ...fields, expectedVersion })
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
}
