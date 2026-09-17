import type { BoardScene } from '../../../shared/boardProtocol'
import type { BoardCheckpointStore } from './checkpointStore'
import type { BoardCheckpoint, BoardRecoveryState } from './recoveryTypes'

export interface BoardCheckpointSchedulerOptions<TRuntimeScene> {
  boardId: string
  sceneVersion: number
  initialRuntimeScene: TRuntimeScene
  initialLocalRevision?: number
  initialBaseRevision?: number
  serialize: (runtimeScene: TRuntimeScene) => BoardScene
  store: BoardCheckpointStore
  debounceMs?: number
  now?: () => number
  onStateChange?: (state: BoardRecoveryState) => void
}

export interface BoardCheckpointSaveSucceeded {
  revision: number
  savedLocalRevision: number
  currentLocalRevision: number
}

export interface BoardCheckpointScheduler<TRuntimeScene> {
  schedule(runtimeScene: TRuntimeScene, localRevision: number, baseRevision: number): void
  onServerSaveSucceeded(event: BoardCheckpointSaveSucceeded): void
  dispose(options?: { drain?: boolean }): void
  waitForIdle(): Promise<void>
  getSnapshot(): BoardRecoveryState
}

type PendingOperation =
  | { kind: 'put'; checkpoint: BoardCheckpoint }
  | { kind: 'delete' }

export function createBoardCheckpointScheduler<TRuntimeScene>(
  options: BoardCheckpointSchedulerOptions<TRuntimeScene>,
): BoardCheckpointScheduler<TRuntimeScene> {
  const debounceMs = options.debounceMs ?? 250
  const now = options.now ?? Date.now
  let latestRuntimeScene = options.initialRuntimeScene
  let currentLocalRevision = options.initialLocalRevision ?? 0
  let baseRevision = options.initialBaseRevision ?? 0
  let checkpointRequested = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let queued: PendingOperation | null = null
  let closed = false
  let state: BoardRecoveryState = { status: 'idle', lastError: null }
  const idleWaiters: Array<() => void> = []

  function publish(nextState: BoardRecoveryState): void {
    state = nextState
    if (!closed) options.onStateChange?.(state)
  }

  function clearTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function latestCheckpoint(): BoardCheckpoint {
    return {
      boardId: options.boardId,
      sceneVersion: options.sceneVersion,
      baseRevision,
      localRevision: currentLocalRevision,
      scene: options.serialize(latestRuntimeScene),
      savedAt: now(),
    }
  }

  async function pump(): Promise<void> {
    if (inFlight || !queued) return
    const operation = queued
    queued = null
    inFlight = true
    publish({ status: operation.kind === 'put' ? 'writing' : 'writing', lastError: null })
    try {
      if (operation.kind === 'put') await options.store.put(operation.checkpoint)
      else await options.store.delete(options.boardId)
      publish({ status: operation.kind === 'put' ? 'available' : 'idle', lastError: null })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      publish({
        status: code === 'BOARD_RECOVERY_UNAVAILABLE' ? 'unavailable' : 'error',
        lastError: error,
      })
    } finally {
      inFlight = false
      if (checkpointRequested && operation.kind === 'put'
        && (operation.checkpoint.localRevision !== currentLocalRevision
          || operation.checkpoint.baseRevision !== baseRevision)) {
        enqueueLatestPut()
      } else if (checkpointRequested && operation.kind === 'delete') {
        enqueueLatestPut()
      }
      void pump().then(resolveIdleWaiters)
    }
  }

  function enqueueLatestPut(): void {
    try {
      queued = { kind: 'put', checkpoint: latestCheckpoint() }
      void pump()
    } catch (error) {
      publish({ status: 'error', lastError: error })
    }
  }

  function resolveIdleWaiters(): void {
    if (inFlight || queued) return
    const waiters = idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  function waitForIdle(): Promise<void> {
    if (!inFlight && !queued) return Promise.resolve()
    return new Promise((resolve) => { idleWaiters.push(resolve) })
  }

  function capture(): void {
    timer = null
    if (closed || !checkpointRequested) return
    try {
      enqueueLatestPut()
    } catch (error) {
      publish({ status: 'error', lastError: error })
    }
  }

  function schedule(runtimeScene: TRuntimeScene, localRevision: number, nextBaseRevision: number): void {
    if (closed) return
    latestRuntimeScene = runtimeScene
    currentLocalRevision = localRevision
    baseRevision = nextBaseRevision
    checkpointRequested = true
    clearTimer()
    publish({ status: 'scheduled', lastError: null })
    timer = setTimeout(capture, debounceMs)
  }

  function onServerSaveSucceeded(event: BoardCheckpointSaveSucceeded): void {
    if (closed) return
    baseRevision = event.revision
    currentLocalRevision = Math.max(currentLocalRevision, event.currentLocalRevision)
    clearTimer()
    if (event.savedLocalRevision >= event.currentLocalRevision) {
      checkpointRequested = false
      queued = { kind: 'delete' }
      void pump()
      return
    }
    checkpointRequested = true
    enqueueLatestPut()
  }

  function dispose(options: { drain?: boolean } = {}): void {
    if (closed) return
    closed = true
    clearTimer()
    if (options.drain === false) {
      checkpointRequested = false
      queued = null
      resolveIdleWaiters()
      return
    }
    if (checkpointRequested && !queued) {
      // A component can unmount before the local recovery debounce fires.
      // Capture the latest scene immediately so a failed server save still
      // leaves a durable recovery copy.
      enqueueLatestPut()
    }
    // Closing stops future editor work and UI callbacks, but durable operations
    // already queued must drain so IndexedDB converges to the latest authority.
    void pump().then(resolveIdleWaiters)
  }

  return {
    schedule,
    onServerSaveSucceeded,
    dispose,
    waitForIdle,
    getSnapshot: () => state,
  }
}
