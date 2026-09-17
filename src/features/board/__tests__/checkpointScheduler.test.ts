import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryBoardCheckpointStore } from '../checkpointStore'
import { createBoardCheckpointScheduler } from '../checkpointScheduler'
import type { BoardScene } from '../../../../shared/boardProtocol'

interface RuntimeScene { id: number }

function scene(runtime: RuntimeScene): BoardScene {
  return { engineData: { elements: [{ id: runtime.id }], fileMap: {} }, persistentAppState: {}, assetRefs: [] }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('Board checkpoint scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function createScheduler(store = createMemoryBoardCheckpointStore()) {
    const scheduler = createBoardCheckpointScheduler<RuntimeScene>({
      boardId: 'board-a',
      sceneVersion: 1,
      initialRuntimeScene: { id: 0 },
      initialBaseRevision: 3,
      serialize: scene,
      store,
    })
    return { scheduler, store }
  }

  it('trails changes by 250ms and coalesces the latest scene', async () => {
    const { scheduler, store } = createScheduler()
    scheduler.schedule({ id: 1 }, 1, 3)
    scheduler.schedule({ id: 2 }, 2, 3)
    await vi.advanceTimersByTimeAsync(249)
    expect(await store.get('board-a')).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(async () => expect(await store.get('board-a')).toMatchObject({ localRevision: 2, scene: scene({ id: 2 }) }))
    scheduler.dispose()
  })

  it('captures a pending checkpoint when disposed before its debounce fires', async () => {
    const { scheduler, store } = createScheduler()
    scheduler.schedule({ id: 7 }, 7, 3)

    scheduler.dispose()

    await vi.waitFor(async () => expect(await store.get('board-a')).toMatchObject({
      localRevision: 7,
      scene: scene({ id: 7 }),
    }))
  })

  it('serializes checkpoint writes and catches up after editing during a write', async () => {
    const first = deferred<void>()
    const puts: BoardScene[] = []
    const store = {
      ...createMemoryBoardCheckpointStore(),
      put: vi.fn(async (checkpoint: { scene: BoardScene }) => {
        puts.push(checkpoint.scene)
        if (puts.length === 1) await first.promise
      }),
    }
    const { scheduler } = createScheduler(store)
    scheduler.schedule({ id: 1 }, 1, 3)
    await vi.advanceTimersByTimeAsync(250)
    scheduler.schedule({ id: 2 }, 2, 3)
    scheduler.schedule({ id: 3 }, 3, 3)
    first.resolve()
    await vi.waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toEqual(scene({ id: 3 }))
    scheduler.dispose()
  })

  it('advances the checkpoint base after a server save and deletes only when caught up', async () => {
    const { scheduler, store } = createScheduler()
    scheduler.schedule({ id: 1 }, 1, 3)
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(async () => expect(await store.get('board-a')).not.toBeNull())

    scheduler.onServerSaveSucceeded({ revision: 4, savedLocalRevision: 1, currentLocalRevision: 2 })
    scheduler.schedule({ id: 2 }, 2, 4)
    await vi.waitFor(async () => expect(await store.get('board-a')).toMatchObject({ baseRevision: 4, localRevision: 2 }))

    scheduler.onServerSaveSucceeded({ revision: 5, savedLocalRevision: 2, currentLocalRevision: 2 })
    await vi.waitFor(async () => expect(await store.get('board-a')).toBeNull())
    scheduler.dispose()
  })

  it('does not let an old write regress a server-advanced checkpoint', async () => {
    const first = deferred<void>()
    const realStore = createMemoryBoardCheckpointStore()
    const controlledStore = {
      ...realStore,
      put: vi.fn(async (checkpoint: Parameters<typeof realStore.put>[0]) => {
        if (checkpoint.baseRevision === 3) await first.promise
        await realStore.put(checkpoint)
      }),
    }
    const { scheduler } = createScheduler(controlledStore)
    scheduler.schedule({ id: 1 }, 1, 3)
    await vi.advanceTimersByTimeAsync(250)
    scheduler.onServerSaveSucceeded({ revision: 4, savedLocalRevision: 0, currentLocalRevision: 1 })
    first.resolve()
    await vi.waitFor(async () => expect(await realStore.get('board-a')).toMatchObject({ baseRevision: 4, localRevision: 1 }))
    scheduler.dispose()
  })

  it('drains a fully-saved delete after dispose', async () => {
    const first = deferred<void>()
    const realStore = createMemoryBoardCheckpointStore()
    let putStarted = false
    const controlledStore = {
      ...realStore,
      put: vi.fn(async (checkpoint: Parameters<typeof realStore.put>[0]) => {
        putStarted = true
        await first.promise
        await realStore.put(checkpoint)
      }),
    }
    const { scheduler } = createScheduler(controlledStore)

    scheduler.schedule({ id: 1 }, 1, 3)
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(putStarted).toBe(true))

    scheduler.onServerSaveSucceeded({ revision: 4, savedLocalRevision: 1, currentLocalRevision: 1 })
    scheduler.dispose()
    first.resolve()

    await vi.waitFor(async () => expect(await realStore.get('board-a')).toBeNull())
    expect(controlledStore.put).toHaveBeenCalledOnce()
  })

  it('drains a rebased put after dispose', async () => {
    const first = deferred<void>()
    const realStore = createMemoryBoardCheckpointStore()
    const putBases: number[] = []
    const controlledStore = {
      ...realStore,
      put: vi.fn(async (checkpoint: Parameters<typeof realStore.put>[0]) => {
        putBases.push(checkpoint.baseRevision)
        if (putBases.length === 1) await first.promise
        await realStore.put(checkpoint)
      }),
    }
    const { scheduler } = createScheduler(controlledStore)

    scheduler.schedule({ id: 2 }, 2, 3)
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(putBases).toEqual([3]))

    scheduler.onServerSaveSucceeded({ revision: 4, savedLocalRevision: 1, currentLocalRevision: 2 })
    scheduler.dispose()
    first.resolve()

    await vi.waitFor(async () => expect(await realStore.get('board-a')).toMatchObject({
      baseRevision: 4,
      localRevision: 2,
    }))
    expect(putBases).toEqual([3, 4])
  })

  it('lets a fully-saved delete supersede a queued rebase after dispose', async () => {
    const first = deferred<void>()
    const realStore = createMemoryBoardCheckpointStore()
    const putBases: number[] = []
    const controlledStore = {
      ...realStore,
      put: vi.fn(async (checkpoint: Parameters<typeof realStore.put>[0]) => {
        putBases.push(checkpoint.baseRevision)
        if (putBases.length === 1) await first.promise
        await realStore.put(checkpoint)
      }),
    }
    const { scheduler } = createScheduler(controlledStore)

    scheduler.schedule({ id: 2 }, 2, 3)
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(putBases).toEqual([3]))

    scheduler.onServerSaveSucceeded({ revision: 4, savedLocalRevision: 1, currentLocalRevision: 2 })
    scheduler.onServerSaveSucceeded({ revision: 5, savedLocalRevision: 2, currentLocalRevision: 2 })
    scheduler.dispose()
    first.resolve()

    await vi.waitFor(async () => expect(await realStore.get('board-a')).toBeNull())
    expect(putBases).toEqual([3])
  })
})
