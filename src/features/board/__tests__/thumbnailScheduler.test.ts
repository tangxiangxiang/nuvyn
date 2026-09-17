import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBoardThumbnailScheduler } from '../thumbnailScheduler'

interface Runtime {
  id: string
  empty?: boolean
}

function createHarness() {
  const generateThumbnail = vi.fn(async (runtime: Runtime) => (
    runtime.empty ? null : new Blob([runtime.id], { type: 'image/png' })
  ))
  const upload = vi.fn(async () => ({
    id: 'generated-asset',
    mimeType: 'image/png' as const,
    byteSize: 1,
    sha256: 'hash',
  }))
  const attach = vi.fn(async (_boardId: string, assetId: string | null) => ({ thumbnailAssetId: assetId }))
  const cleanup = vi.fn(async () => {})
  const onSuccess = vi.fn()
  const onFailure = vi.fn()
  const scheduler = createBoardThumbnailScheduler<Runtime>({
    boardId: 'board-1',
    adapter: { generateThumbnail },
    debounceMs: 3000,
    upload,
    cleanup,
    attach,
    createAssetId: () => 'thumbnail-asset',
    onSuccess,
    onFailure,
  })
  return { scheduler, generateThumbnail, upload, cleanup, attach, onSuccess, onFailure }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('board thumbnail scheduler', () => {
  it('uses a trailing three-second debounce and coalesces saved snapshots', async () => {
    vi.useFakeTimers()
    const harness = createHarness()

    harness.scheduler.schedule({ runtimeScene: { id: 'a' }, revision: 4 })
    await vi.advanceTimersByTimeAsync(2999)
    expect(harness.generateThumbnail).not.toHaveBeenCalled()

    harness.scheduler.schedule({ runtimeScene: { id: 'b' }, revision: 5 })
    await vi.advanceTimersByTimeAsync(2999)
    expect(harness.generateThumbnail).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await vi.runOnlyPendingTimersAsync()
    expect(harness.generateThumbnail).toHaveBeenCalledOnce()
    expect(harness.generateThumbnail).toHaveBeenCalledWith({ id: 'b' })
    expect(harness.onSuccess).toHaveBeenCalledWith(expect.objectContaining({
      input: { runtimeScene: { id: 'b' }, revision: 5 },
    }))
  })

  it('keeps only one job in flight and lets a newer saved snapshot win', async () => {
    vi.useFakeTimers()
    const first = deferred<Blob>()
    const harness = createHarness()
    harness.generateThumbnail
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(new Blob(['b'], { type: 'image/png' }))

    harness.scheduler.schedule({ runtimeScene: { id: 'a' }, revision: 4 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(harness.generateThumbnail).toHaveBeenCalledTimes(1)

    harness.scheduler.schedule({ runtimeScene: { id: 'b' }, revision: 5 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(harness.generateThumbnail).toHaveBeenCalledTimes(1)

    first.resolve(new Blob(['a'], { type: 'image/png' }))
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()
    expect(harness.upload).toHaveBeenCalledTimes(1)
    expect(harness.generateThumbnail).toHaveBeenLastCalledWith({ id: 'b' })
    expect(harness.attach).toHaveBeenCalledWith('board-1', 'thumbnail-asset')
    expect(harness.onSuccess).toHaveBeenLastCalledWith(expect.objectContaining({
      input: { runtimeScene: { id: 'b' }, revision: 5 },
    }))
  })

  it('does not attach an uploaded artifact after a newer saved snapshot arrives', async () => {
    vi.useFakeTimers()
    const uploadA = deferred<{
      id: string
      mimeType: 'image/png'
      byteSize: number
      sha256: string
    }>()
    const harness = createHarness()
    harness.upload.mockReturnValueOnce(uploadA.promise)

    harness.scheduler.schedule({ runtimeScene: { id: 'a' }, revision: 4 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(harness.upload).toHaveBeenCalledOnce()

    harness.scheduler.schedule({ runtimeScene: { id: 'b' }, revision: 5 })
    uploadA.resolve({ id: 'thumbnail-asset', mimeType: 'image/png', byteSize: 1, sha256: 'hash' })
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.attach).not.toHaveBeenCalled()
    expect(harness.cleanup).toHaveBeenCalledWith('thumbnail-asset')

    await vi.advanceTimersByTimeAsync(3000)
    await vi.runOnlyPendingTimersAsync()
    expect(harness.attach).toHaveBeenCalledOnce()
  })

  it('clears an old thumbnail for a saved empty scene without uploading PNG', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.scheduler.schedule({ runtimeScene: { id: 'empty', empty: true }, revision: 6 })
    await vi.advanceTimersByTimeAsync(3000)
    await vi.runOnlyPendingTimersAsync()

    expect(harness.upload).not.toHaveBeenCalled()
    expect(harness.attach).toHaveBeenCalledWith('board-1', null)
    expect(harness.onSuccess).toHaveBeenCalledWith(expect.objectContaining({
      input: { runtimeScene: { id: 'empty', empty: true }, revision: 6 },
      response: { thumbnailAssetId: null },
    }))
  })

  it.each([
    ['generation', () => Promise.reject(new Error('render failed'))],
    ['upload', () => Promise.reject(new Error('upload failed'))],
    ['attach', () => Promise.reject(new Error('attach failed'))],
  ])('isolates %s failures from the scene save lifecycle', async (_label, failure) => {
    vi.useFakeTimers()
    const harness = createHarness()
    if (_label === 'generation') harness.generateThumbnail.mockImplementationOnce(failure as () => Promise<Blob | null>)
    if (_label === 'upload') harness.upload.mockImplementationOnce(failure as () => Promise<never>)
    if (_label === 'attach') harness.attach.mockImplementationOnce(failure as () => Promise<never>)

    harness.scheduler.schedule({ runtimeScene: { id: 'a' }, revision: 4 })
    await vi.advanceTimersByTimeAsync(3000)
    await vi.runOnlyPendingTimersAsync()

    expect(harness.onFailure).toHaveBeenCalledOnce()
    if (_label === 'attach') expect(harness.cleanup).toHaveBeenCalledWith('thumbnail-asset')
  })

  it('stops future work on dispose while allowing the current job to finish without UI callbacks', async () => {
    vi.useFakeTimers()
    const upload = deferred<{
      id: string
      mimeType: 'image/png'
      byteSize: number
      sha256: string
    }>()
    const harness = createHarness()
    harness.upload.mockReturnValueOnce(upload.promise)
    harness.scheduler.schedule({ runtimeScene: { id: 'a' }, revision: 4 })
    await vi.advanceTimersByTimeAsync(3000)
    harness.scheduler.dispose()
    harness.scheduler.schedule({ runtimeScene: { id: 'b' }, revision: 5 })
    upload.resolve({ id: 'thumbnail-asset', mimeType: 'image/png', byteSize: 1, sha256: 'hash' })
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.attach).toHaveBeenCalledWith('board-1', 'thumbnail-asset')
    expect(harness.onSuccess).not.toHaveBeenCalled()
  })

  it('drains a pending saved snapshot on dispose without waiting for navigation', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.scheduler.schedule({ runtimeScene: { id: 'a' }, revision: 4 })
    harness.scheduler.dispose()
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.generateThumbnail).toHaveBeenCalledWith({ id: 'a' })
    expect(harness.attach).toHaveBeenCalledWith('board-1', 'thumbnail-asset')
    expect(harness.onSuccess).not.toHaveBeenCalled()
  })

  it('does not retain a synchronous idle fallback handle', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    const requestIdle = vi.fn((callback: () => void) => {
      callback()
      return 1
    })
    const scheduler = createBoardThumbnailScheduler<Runtime>({
      boardId: 'board-1',
      adapter: { generateThumbnail: harness.generateThumbnail },
      debounceMs: 3000,
      requestIdle,
      upload: harness.upload,
      attach: harness.attach,
      createAssetId: () => 'thumbnail-asset',
    })

    scheduler.schedule({ runtimeScene: { id: 'a' }, revision: 4 })
    await vi.advanceTimersByTimeAsync(3000)
    await Promise.resolve()
    await Promise.resolve()

    expect(requestIdle).toHaveBeenCalledOnce()
    expect(harness.generateThumbnail).toHaveBeenCalledWith({ id: 'a' })
    scheduler.dispose({ drain: false })
  })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}
