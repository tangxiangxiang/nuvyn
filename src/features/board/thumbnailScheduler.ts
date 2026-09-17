import { setBoardThumbnail, type SaveBoardThumbnailResponse } from './api'
import { BOARD_ASSET_MAX_BYTES, cleanupUnreferencedAsset, uploadAsset } from './assetClient'
import type { BoardEngineAdapter } from './engine/types'

export interface BoardThumbnailInput<TRuntimeScene> {
  readonly runtimeScene: TRuntimeScene
  readonly revision: number
}

export interface BoardThumbnailFailure<TRuntimeScene> {
  readonly error: unknown
  readonly input: BoardThumbnailInput<TRuntimeScene>
}

export interface BoardThumbnailSchedulerOptions<TRuntimeScene> {
  boardId: string
  adapter: Pick<BoardEngineAdapter<TRuntimeScene>, 'generateThumbnail'>
  debounceMs?: number
  upload?: typeof uploadAsset
  cleanup?: typeof cleanupUnreferencedAsset
  attach?: typeof setBoardThumbnail
  createAssetId?: () => string
  requestIdle?: (callback: () => void) => unknown
  cancelIdle?: (handle: unknown) => void
  onSuccess?: (event: {
    readonly input: BoardThumbnailInput<TRuntimeScene>
    readonly response: SaveBoardThumbnailResponse
  }) => void
  onFailure?: (failure: BoardThumbnailFailure<TRuntimeScene>) => void
}

export interface BoardThumbnailScheduler<TRuntimeScene> {
  schedule(input: BoardThumbnailInput<TRuntimeScene>): void
  dispose(options?: { drain?: boolean }): void
}

type IdleHandle = { kind: 'idle'; value: unknown }

function defaultCreateAssetId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== 'function') throw new Error('Secure asset IDs are unavailable')
  return randomUUID.call(globalThis.crypto)
}

function defaultRequestIdle(callback: () => void): IdleHandle | null {
  const idleWindow = typeof window !== 'undefined'
    ? window as Window & {
        requestIdleCallback?: (callback: () => void) => number
      }
    : null
  if (idleWindow?.requestIdleCallback) {
    return { kind: 'idle', value: idleWindow.requestIdleCallback(callback) }
  }
  // The debounce itself is the scheduling boundary in browsers without an
  // idle callback (including Safari). Run directly rather than introducing a
  // second timer that would make the 3000ms contract needlessly fuzzy.
  callback()
  return null
}

function defaultCancelIdle(handle: IdleHandle): void {
  const idleWindow = typeof window !== 'undefined'
    ? window as Window & { cancelIdleCallback?: (handle: number) => void }
    : null
  if (idleWindow?.cancelIdleCallback) idleWindow.cancelIdleCallback(handle.value as number)
}

function validPng(blob: Blob): boolean {
  return blob.size > 0
    && blob.size <= BOARD_ASSET_MAX_BYTES
    && blob.type.trim().toLowerCase() === 'image/png'
}

export function createBoardThumbnailScheduler<TRuntimeScene>(
  options: BoardThumbnailSchedulerOptions<TRuntimeScene>,
): BoardThumbnailScheduler<TRuntimeScene> {
  const debounceMs = options.debounceMs ?? 3000
  const upload = options.upload ?? uploadAsset
  const cleanup = options.cleanup ?? cleanupUnreferencedAsset
  const attach = options.attach ?? setBoardThumbnail
  const createAssetId = options.createAssetId ?? defaultCreateAssetId
  const requestIdle = options.requestIdle
    ? (callback: () => void): IdleHandle => ({ kind: 'idle', value: options.requestIdle?.(callback) })
    : defaultRequestIdle
  let latest: (BoardThumbnailInput<TRuntimeScene> & { sequence: number }) | null = null
  let sequence = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let idleHandle: IdleHandle | null = null
  let inFlight = false
  let disposed = false
  let drainOnDispose = false

  function clearTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function clearIdle(): void {
    if (idleHandle === null) return
    if (options.cancelIdle) options.cancelIdle(idleHandle.value)
    else defaultCancelIdle(idleHandle)
    idleHandle = null
  }

  function isCurrent(input: BoardThumbnailInput<TRuntimeScene> & { sequence: number }): boolean {
    return input.sequence === sequence
  }

  function publicInput(input: BoardThumbnailInput<TRuntimeScene> & { sequence: number }): BoardThumbnailInput<TRuntimeScene> {
    return { runtimeScene: input.runtimeScene, revision: input.revision }
  }

  function notifyFailure(input: BoardThumbnailInput<TRuntimeScene> & { sequence: number }, error: unknown): void {
    if (disposed || !isCurrent(input)) return
    options.onFailure?.({ error, input: publicInput(input) })
  }

  async function run(input: BoardThumbnailInput<TRuntimeScene> & { sequence: number }): Promise<void> {
    try {
      const blob = await options.adapter.generateThumbnail(input.runtimeScene)
      if (!isCurrent(input)) return
      if (blob === null) {
        if (!isCurrent(input)) return
        const response = await attach(options.boardId, null)
        if (isCurrent(input) && !disposed) options.onSuccess?.({ input: publicInput(input), response })
        return
      }
      if (!validPng(blob)) throw new Error('Thumbnail must be a non-empty image/png under the size limit')
      const assetId = createAssetId()
      await upload(assetId, 'image/png', blob)
      // A newer confirmed Scene save may have arrived while the derived Asset
      // was uploading. Do not attach this stale artifact to the Board.
      if (!isCurrent(input)) {
        void cleanup(assetId).catch(() => {})
        return
      }
      let response: SaveBoardThumbnailResponse
      try {
        response = await attach(options.boardId, assetId)
      } catch (error) {
        void cleanup(assetId).catch(() => {})
        throw error
      }
      if (isCurrent(input) && !disposed) options.onSuccess?.({ input: publicInput(input), response })
    } catch (error) {
      notifyFailure(input, error)
    }
  }

  function pump(): void {
    if (inFlight || !latest || (disposed && !drainOnDispose)) return
    const input = latest
    latest = null
    inFlight = true
    void run(input).finally(() => {
      inFlight = false
      // If the debounce elapsed while the prior job was in flight, the latest
      // saved snapshot is already eligible and can start immediately. If its
      // timer/idle handle still exists, those handles retain the trailing edge.
      if ((!disposed || drainOnDispose) && latest && timer === null && idleHandle === null) pump()
    })
  }

  function afterDebounce(): void {
    timer = null
    if (disposed || !latest) return
    if (idleHandle !== null) return
    let calledSynchronously = false
    const handle = requestIdle(() => {
      calledSynchronously = true
      idleHandle = null
      pump()
    })
    if (!calledSynchronously) idleHandle = handle
    if (inFlight) return
  }

  function schedule(input: BoardThumbnailInput<TRuntimeScene>): void {
    if (disposed) return
    sequence += 1
    latest = { ...input, sequence }
    clearTimer()
    clearIdle()
    timer = setTimeout(afterDebounce, debounceMs)
  }

  function dispose(options: { drain?: boolean } = {}): void {
    if (disposed) return
    disposed = true
    clearTimer()
    clearIdle()
    drainOnDispose = options.drain !== false
    if (!drainOnDispose) {
      latest = null
      return
    }
    // Route leave must not await this derived artifact. Start an already
    // confirmed saved snapshot in the background and suppress its UI callback
    // because the owning editor is being disposed.
    if (!inFlight && latest) pump()
  }

  return { schedule, dispose }
}
