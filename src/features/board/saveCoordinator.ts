import {
  saveBoardScene,
  type BoardApiError,
  type SaveBoardSceneResponse,
} from './api'
import type { BoardScene } from '../../../shared/boardProtocol'

export type BoardSaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'uncertain'

export interface BoardSaveState {
  readonly currentServerRevision: number
  readonly baseRevision: number
  readonly localRevision: number
  readonly lastSavedLocalRevision: number
  readonly dirty: boolean
  readonly saveInFlight: boolean
  readonly status: BoardSaveStatus
  readonly conflict: boolean
  readonly revisionUncertain: boolean
  readonly lastError: unknown | null
}

export type BoardFlushResult =
  | { ok: true; status: 'saved' }
  | { ok: false; status: 'error' | 'conflict' | 'uncertain'; error: unknown | null }

export interface BoardSaveCoordinatorOptions<TRuntimeScene> {
  boardId: string
  engine: 'excalidraw'
  sceneVersion: number
  currentServerRevision: number
  initialRuntimeScene: TRuntimeScene
  initialFingerprint: string
  initialBaseRevision?: number
  initialLocalRevision?: number
  initialLastSavedLocalRevision?: number
  initialDirty?: boolean
  initialConflict?: boolean
  serialize: (runtimeScene: TRuntimeScene) => BoardScene
  prepareSave?: (runtimeScene: TRuntimeScene, localRevision: number, baseRevision: number) => Promise<void>
  save?: typeof saveBoardScene
  debounceMs?: number
  onStateChange?: (state: BoardSaveState) => void
  onMeaningfulChange?: (event: {
    runtimeScene: TRuntimeScene
    localRevision: number
    baseRevision: number
  }) => void
  onSaveSucceeded?: (event: {
    revision: number
    savedLocalRevision: number
    currentLocalRevision: number
    runtimeScene: TRuntimeScene
  }) => void
  onMetadataUpdated?: (updatedAt: number) => void
}

export interface BoardSaveCoordinator<TRuntimeScene> {
  recordChange(runtimeScene: TRuntimeScene, fingerprint: string): void
  schedule(): void
  flush(): Promise<BoardFlushResult>
  retry(): Promise<BoardFlushResult>
  dispose(): void
  getSnapshot(): BoardSaveState
}

function isConflict(error: unknown): boolean {
  const apiError = error as Partial<BoardApiError> | null
  return apiError?.status === 409 || apiError?.code === 'BOARD_SCENE_REVISION_CONFLICT'
}

function isUncertain(error: unknown): boolean {
  return (error as Partial<BoardApiError> | null)?.uncertain === true
}

export function createBoardSaveCoordinator<TRuntimeScene>(
  options: BoardSaveCoordinatorOptions<TRuntimeScene>,
): BoardSaveCoordinator<TRuntimeScene> {
  const save = options.save ?? saveBoardScene
  const debounceMs = options.debounceMs ?? 800
  let latestRuntimeScene = options.initialRuntimeScene
  let latestFingerprint = options.initialFingerprint
  let currentServerRevision = options.currentServerRevision
  let baseRevision = options.initialBaseRevision ?? options.currentServerRevision
  let localRevision = options.initialLocalRevision ?? 0
  let lastSavedLocalRevision = options.initialLastSavedLocalRevision ?? 0
  let dirty = options.initialDirty ?? localRevision > lastSavedLocalRevision
  let saveInFlight = false
  let conflict = options.initialConflict ?? false
  let status: BoardSaveStatus = conflict ? 'conflict' : dirty ? 'dirty' : 'saved'
  let revisionUncertain = false
  let lastError: unknown | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let drainPromise: Promise<BoardFlushResult> | null = null
  let disposed = false

  function snapshot(): BoardSaveState {
    return {
      currentServerRevision,
      baseRevision,
      localRevision,
      lastSavedLocalRevision,
      dirty,
      saveInFlight,
      status,
      conflict,
      revisionUncertain,
      lastError,
    }
  }

  function publish(): void {
    if (!disposed) options.onStateChange?.(snapshot())
  }

  function clearTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function resultForState(): BoardFlushResult {
    if (!dirty && !saveInFlight && status === 'saved') return { ok: true, status: 'saved' }
    if (status === 'conflict' || conflict) return { ok: false, status: 'conflict', error: lastError }
    if (status === 'uncertain' || revisionUncertain) return { ok: false, status: 'uncertain', error: lastError }
    return { ok: false, status: 'error', error: lastError }
  }

  function schedule(): void {
    if (disposed || conflict || revisionUncertain) return
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      void startDrain()
    }, debounceMs)
  }

  async function runDrain(): Promise<BoardFlushResult> {
    while (!disposed && dirty && !conflict && !revisionUncertain) {
      const capturedRuntimeScene = latestRuntimeScene
      const capturedLocalRevision = localRevision
      const capturedExpectedRevision = currentServerRevision
      saveInFlight = true
      status = 'saving'
      publish()
      let capturedScene: BoardScene
      try {
        await options.prepareSave?.(capturedRuntimeScene, capturedLocalRevision, baseRevision)
        // Asset preparation can take long enough for another Excalidraw
        // change to arrive. Never send the pre-gate scene in that case; loop
        // back through the latest runtime snapshot and its asset set.
        if (capturedLocalRevision !== localRevision) {
          saveInFlight = false
          status = 'dirty'
          publish()
          continue
        }
        capturedScene = options.serialize(capturedRuntimeScene)
      } catch (error) {
        saveInFlight = false
        lastError = error
        status = 'error'
        dirty = true
        publish()
        return resultForState()
      }
      if (disposed) {
        saveInFlight = false
        return { ok: false, status: 'error', error: null }
      }

      try {
        const response: SaveBoardSceneResponse = await save(options.boardId, {
          expectedRevision: capturedExpectedRevision,
          engine: options.engine,
          sceneVersion: options.sceneVersion,
          scene: capturedScene,
        })
        if (disposed) {
          saveInFlight = false
          return { ok: false, status: 'error', error: null }
        }
        currentServerRevision = response.revision
        baseRevision = response.revision
        lastSavedLocalRevision = capturedLocalRevision
        options.onMetadataUpdated?.(response.updatedAt)
        lastError = null
        if (localRevision === capturedLocalRevision) {
          dirty = false
          status = 'saved'
        } else {
          dirty = true
          status = 'dirty'
        }
        saveInFlight = false
        publish()
        options.onSaveSucceeded?.({
          revision: response.revision,
          savedLocalRevision: capturedLocalRevision,
          currentLocalRevision: localRevision,
          runtimeScene: capturedRuntimeScene,
        })
      } catch (error) {
        saveInFlight = false
        lastError = error
        dirty = true
        if (isConflict(error)) {
          conflict = true
          status = 'conflict'
        } else if (isUncertain(error)) {
          revisionUncertain = true
          status = 'uncertain'
        } else {
          status = 'error'
        }
        publish()
        return resultForState()
      }
    }
    return resultForState()
  }

  function startDrain(): Promise<BoardFlushResult> {
    if (drainPromise) return drainPromise
    drainPromise = runDrain().finally(() => {
      drainPromise = null
    })
    return drainPromise
  }

  function recordChange(runtimeScene: TRuntimeScene, fingerprint: string): void {
    if (disposed || fingerprint === latestFingerprint) return
    latestRuntimeScene = runtimeScene
    latestFingerprint = fingerprint
    localRevision += 1
    dirty = true
    options.onMeaningfulChange?.({ runtimeScene, localRevision, baseRevision })
    if (!conflict && !revisionUncertain) {
      status = 'dirty'
      schedule()
    }
    publish()
  }

  async function flush(): Promise<BoardFlushResult> {
    if (disposed) return { ok: false, status: 'error', error: null }
    clearTimer()
    if (conflict || revisionUncertain) return resultForState()
    if (!dirty && !drainPromise) return resultForState()
    return startDrain()
  }

  async function retry(): Promise<BoardFlushResult> {
    if (disposed || conflict || revisionUncertain) return resultForState()
    clearTimer()
    return startDrain()
  }

  function scheduleAutosave(): void {
    if (!dirty || conflict || revisionUncertain) return
    schedule()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    clearTimer()
  }

  return { recordChange, schedule: scheduleAutosave, flush, retry, dispose, getSnapshot: snapshot }
}
