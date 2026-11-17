import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiaryTaskApiError, DiaryTaskConflictError, diaryTasksApi } from '../diary-tasks-api'
import { resetDiaryCapabilityForTesting, setDiaryCapability } from '../diary-capability'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDiaryCapabilityForTesting()
})

describe('Diary task API client', () => {
  it('uses the unlocked Diary capability, no-store requests, and client-generated task IDs', async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []
    setDiaryCapability('test-diary-capability')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init })
      return Response.json({ task: { id: 'server-task' } })
    }))

    await diaryTasksApi.createTask({ title: '  Task  ', description: '', dueDate: null, dueTime: null })

    const call = calls[0]!
    expect(String(call.input)).toMatch(/^\/api\/diary\/life\/tasks\/[0-9a-f-]{36}$/)
    expect(call.init).toMatchObject({ method: 'PUT', cache: 'no-store' })
    expect(new Headers(call.init?.headers).get('X-Nuvyn-Diary-Capability')).toBe('test-diary-capability')
    expect(JSON.parse(String(call.init?.body))).toEqual({ title: '  Task  ', description: '', dueDate: null, dueTime: null, expectedVersion: 0 })
  })

  it('passes AbortSignal for list reads and exposes every CRUD and lifecycle endpoint', async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init })
      return Response.json({ items: [], next: null })
    }))
    const controller = new AbortController()
    await diaryTasksApi.listTasks(200, controller.signal)
    await diaryTasksApi.tasksInRange('2026-01-01', '2026-01-31', 20, controller.signal)
    await diaryTasksApi.getTask('task-id', controller.signal)
    await diaryTasksApi.updateTask('task-id', { title: 'Task', description: '', dueDate: null, dueTime: null }, 1)
    await diaryTasksApi.completeTask('task-id', 2)
    await diaryTasksApi.reopenTask('task-id', 3)
    await diaryTasksApi.deleteTask('task-id', 4)

    expect(calls.map(call => `${call.init?.method ?? 'GET'} ${call.input}`)).toEqual([
      'GET /api/diary/life/tasks/list?offset=200',
      'GET /api/diary/life/tasks?start=2026-01-01&end=2026-01-31&offset=20',
      'GET /api/diary/life/tasks/task-id',
      'PUT /api/diary/life/tasks/task-id',
      'POST /api/diary/life/tasks/task-id/complete',
      'POST /api/diary/life/tasks/task-id/reopen',
      'DELETE /api/diary/life/tasks/task-id',
    ])
    expect(calls[0]?.init?.signal).toBe(controller.signal)
    expect(calls[1]?.init?.signal).toBe(controller.signal)
    expect(calls[2]?.init?.signal).toBe(controller.signal)
    expect(calls.every(call => call.init?.cache === 'no-store')).toBe(true)
  })

  it('surfaces version conflicts separately from other API errors', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 'diary-conflict' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ code: 'diary-locked' }, { status: 423 })))

    await expect(diaryTasksApi.completeTask('task-id', 1)).rejects.toBeInstanceOf(DiaryTaskConflictError)
    await expect(diaryTasksApi.listTasks()).rejects.toMatchObject({
      status: 423,
      code: 'diary-locked',
    } satisfies Partial<DiaryTaskApiError>)
  })
})
