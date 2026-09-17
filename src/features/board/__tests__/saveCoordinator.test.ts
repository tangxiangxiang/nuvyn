import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardScene } from '../../../../shared/boardProtocol'
import { BoardApiError, type SaveBoardSceneRequest, type SaveBoardSceneResponse } from '../api'
import { createBoardSaveCoordinator } from '../saveCoordinator'

interface RuntimeScene { id: number }

function scene(runtime: RuntimeScene): BoardScene {
  return {
    engineData: { elements: [{ id: runtime.id }], fileMap: {} },
    persistentAppState: {},
    assetRefs: [],
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Board Save Coordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function createSave(save: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ revision: 1, updatedAt: 10 })) {
    return { save, coordinator: createBoardSaveCoordinator<RuntimeScene>({
      boardId: 'board-1',
      engine: 'excalidraw',
      sceneVersion: 1,
      currentServerRevision: 3,
      initialRuntimeScene: { id: 0 },
      initialFingerprint: '0',
      serialize: scene,
      save: save as unknown as (boardId: string, request: SaveBoardSceneRequest) => Promise<SaveBoardSceneResponse>,
    }) }
  }

  it('uses an 800ms trailing debounce and captures only when saving', async () => {
    const { save, coordinator } = createSave()
    coordinator.recordChange({ id: 1 }, '1')
    coordinator.recordChange({ id: 2 }, '2')

    await vi.advanceTimersByTimeAsync(799)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save).toHaveBeenCalledWith('board-1', {
      expectedRevision: 3,
      engine: 'excalidraw',
      sceneVersion: 1,
      scene: scene({ id: 2 }),
    })
    expect(coordinator.getSnapshot()).toMatchObject({
      currentServerRevision: 1,
      localRevision: 2,
      lastSavedLocalRevision: 2,
      dirty: false,
      status: 'saved',
    })
  })

  it('serializes saves and drains the latest edit immediately after success', async () => {
    const first = deferred<{ revision: number; updatedAt: number }>()
    const second = deferred<{ revision: number; updatedAt: number }>()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { coordinator } = createSave(save)
    coordinator.recordChange({ id: 1 }, '1')
    await vi.advanceTimersByTimeAsync(800)
    expect(save).toHaveBeenCalledTimes(1)

    coordinator.recordChange({ id: 2 }, '2')
    first.resolve({ revision: 4, updatedAt: 11 })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1][1]).toMatchObject({
      expectedRevision: 4,
      scene: scene({ id: 2 }),
    })
    expect(coordinator.getSnapshot()).toMatchObject({ currentServerRevision: 4, localRevision: 2, dirty: true, status: 'saving' })

    second.resolve({ revision: 5, updatedAt: 12 })
    await vi.waitFor(() => expect(coordinator.getSnapshot()).toMatchObject({ currentServerRevision: 5, dirty: false, status: 'saved' }))
  })

  it('keeps definite failures retryable without automatic retry loops', async () => {
    const save = vi.fn().mockRejectedValueOnce(new BoardApiError('bad request', 400, 'BOARD_VALIDATION_ERROR', false))
    const { coordinator } = createSave(save)
    coordinator.recordChange({ id: 1 }, '1')
    await vi.advanceTimersByTimeAsync(800)
    await vi.waitFor(() => expect(coordinator.getSnapshot()).toMatchObject({ status: 'error', dirty: true }))
    expect(save).toHaveBeenCalledOnce()
    expect(await coordinator.flush()).toMatchObject({ ok: false, status: 'error' })
  })

  it('stops on conflicts and uncertain outcomes without blind retries', async () => {
    const save = vi.fn().mockRejectedValueOnce(new BoardApiError('conflict', 409, 'BOARD_SCENE_REVISION_CONFLICT', false))
    const { coordinator } = createSave(save)
    coordinator.recordChange({ id: 1 }, '1')
    await vi.advanceTimersByTimeAsync(800)
    await vi.waitFor(() => expect(coordinator.getSnapshot()).toMatchObject({ status: 'conflict', conflict: true, dirty: true }))
    coordinator.recordChange({ id: 2 }, '2')
    await vi.advanceTimersByTimeAsync(1600)
    expect(save).toHaveBeenCalledOnce()
    expect(await coordinator.flush()).toMatchObject({ ok: false, status: 'conflict' })

    const uncertainSave = vi.fn().mockRejectedValueOnce(new BoardApiError('network', 500, 'BOARD_API_ERROR', true))
    const uncertain = createSave(uncertainSave).coordinator
    uncertain.recordChange({ id: 1 }, '1')
    await vi.advanceTimersByTimeAsync(800)
    await vi.waitFor(() => expect(uncertain.getSnapshot()).toMatchObject({ status: 'uncertain', revisionUncertain: true }))
    expect(await uncertain.flush()).toMatchObject({ ok: false, status: 'uncertain' })
    expect(uncertainSave).toHaveBeenCalledOnce()
  })

  it('flushes pending and in-flight edits until the latest revision is saved', async () => {
    const save = vi.fn().mockResolvedValue({ revision: 4, updatedAt: 11 })
    const { coordinator } = createSave(save)
    coordinator.recordChange({ id: 1 }, '1')
    const first = coordinator.flush()
    const second = coordinator.flush()
    await expect(first).resolves.toMatchObject({ ok: true, status: 'saved' })
    await expect(second).resolves.toMatchObject({ ok: true, status: 'saved' })
    expect(save).toHaveBeenCalledOnce()
  })

  it('restores an initial local revision and emits save lifecycle events', async () => {
    const save = vi.fn().mockResolvedValue({ revision: 4, updatedAt: 11 })
    const onChange = vi.fn()
    const onSaved = vi.fn()
    const coordinator = createBoardSaveCoordinator<RuntimeScene>({
      boardId: 'board-1',
      engine: 'excalidraw',
      sceneVersion: 1,
      currentServerRevision: 3,
      initialBaseRevision: 3,
      initialLocalRevision: 8,
      initialLastSavedLocalRevision: 0,
      initialDirty: true,
      initialRuntimeScene: { id: 8 },
      initialFingerprint: '8',
      serialize: scene,
      save: save as unknown as (boardId: string, request: SaveBoardSceneRequest) => Promise<SaveBoardSceneResponse>,
      onMeaningfulChange: onChange,
      onSaveSucceeded: onSaved,
    })

    expect(coordinator.getSnapshot()).toMatchObject({ localRevision: 8, baseRevision: 3, dirty: true })
    coordinator.schedule()
    await vi.advanceTimersByTimeAsync(800)
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      revision: 4,
      savedLocalRevision: 8,
      currentLocalRevision: 8,
      runtimeScene: { id: 8 },
    }))
    expect(save).toHaveBeenCalledWith('board-1', expect.objectContaining({ expectedRevision: 3 }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('waits for asset readiness before issuing the Scene request', async () => {
    const gate = deferred<void>()
    const save = vi.fn().mockResolvedValue({ revision: 4, updatedAt: 11 })
    const prepareSave = vi.fn(() => gate.promise)
    const coordinator = createBoardSaveCoordinator<RuntimeScene>({
      boardId: 'board-1',
      engine: 'excalidraw',
      sceneVersion: 1,
      currentServerRevision: 3,
      initialRuntimeScene: { id: 0 },
      initialFingerprint: '0',
      serialize: scene,
      prepareSave,
      save: save as unknown as (boardId: string, request: SaveBoardSceneRequest) => Promise<SaveBoardSceneResponse>,
    })

    coordinator.recordChange({ id: 1 }, '1')
    const flush = coordinator.flush().then(() => undefined)
    await Promise.resolve()
    expect(prepareSave).toHaveBeenCalledWith({ id: 1 }, 1, 3)
    expect(save).not.toHaveBeenCalled()

    gate.resolve()
    await flush
    expect(save).toHaveBeenCalledWith('board-1', expect.objectContaining({ scene: scene({ id: 1 }) }))
  })

  it('blocks the Scene request and preserves dirty state when asset readiness fails', async () => {
    const error = new Error('asset upload failed')
    const save = vi.fn().mockResolvedValue({ revision: 4, updatedAt: 11 })
    const coordinator = createBoardSaveCoordinator<RuntimeScene>({
      boardId: 'board-1',
      engine: 'excalidraw',
      sceneVersion: 1,
      currentServerRevision: 3,
      initialRuntimeScene: { id: 0 },
      initialFingerprint: '0',
      serialize: scene,
      prepareSave: vi.fn().mockRejectedValue(error),
      save: save as unknown as (boardId: string, request: SaveBoardSceneRequest) => Promise<SaveBoardSceneResponse>,
    })

    coordinator.recordChange({ id: 1 }, '1')
    await expect(coordinator.flush()).resolves.toEqual({ ok: false, status: 'error', error })
    expect(save).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({ dirty: true, status: 'error', lastError: error })
  })

  it('coalesces an edit that arrives while asset readiness is pending', async () => {
    const firstGate = deferred<void>()
    const save = vi.fn().mockResolvedValue({ revision: 4, updatedAt: 11 })
    const prepareSave = vi.fn()
      .mockReturnValueOnce(firstGate.promise)
      .mockResolvedValue(undefined)
    const coordinator = createBoardSaveCoordinator<RuntimeScene>({
      boardId: 'board-1',
      engine: 'excalidraw',
      sceneVersion: 1,
      currentServerRevision: 3,
      initialRuntimeScene: { id: 0 },
      initialFingerprint: '0',
      serialize: scene,
      prepareSave,
      save: save as unknown as (boardId: string, request: SaveBoardSceneRequest) => Promise<SaveBoardSceneResponse>,
    })

    coordinator.recordChange({ id: 1 }, '1')
    const flush = coordinator.flush()
    await Promise.resolve()
    coordinator.recordChange({ id: 2 }, '2')
    firstGate.resolve()

    await expect(flush).resolves.toMatchObject({ ok: true, status: 'saved' })
    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith('board-1', expect.objectContaining({
      expectedRevision: 3,
      scene: scene({ id: 2 }),
    }))
    expect(prepareSave).toHaveBeenLastCalledWith({ id: 2 }, 2, 3)
  })
})
