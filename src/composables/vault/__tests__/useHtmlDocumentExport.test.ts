// @vitest-environment jsdom
import { effectScope } from 'vue'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { useHtmlDocumentExport } from '../useHtmlDocumentExport'

afterEach(() => vi.useRealTimers())
const snapshot = { path: 'inbox/a', raw: 'body', title: 'A', filename: 'a.md' }
describe('HTML export surface lifecycle', () => {
  it('resolves a completed surface and removes its deadline', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const exportSurface = scope.run(useHtmlDocumentExport)!
    const pending = exportSurface.run(snapshot, new AbortController().signal)
    expect(exportSurface.request.value?.snapshot).toBe(snapshot)
    exportSurface.complete('html')
    await expect(pending).resolves.toBe('html')
    expect(exportSurface.request.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    scope.stop()
  })
  it('rejects aborted work and ignores a late completion', async () => {
    const scope = effectScope()
    const exportSurface = scope.run(useHtmlDocumentExport)!
    const controller = new AbortController()
    const pending = exportSurface.run(snapshot, controller.signal)
    controller.abort()
    exportSurface.complete('late')
    await expect(pending).rejects.toThrow('cancelled')
    expect(exportSurface.request.value).toBeNull()
    scope.stop()
  })
  it('unmount rejects a pending render and clears its timer', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const exportSurface = scope.run(useHtmlDocumentExport)!
    const pending = exportSurface.run(snapshot, new AbortController().signal)
    scope.stop()
    await expect(pending).rejects.toThrow('cancelled')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a renderer which never emits a result', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const exportSurface = scope.run(useHtmlDocumentExport)!
    const pending = exportSurface.run(snapshot, new AbortController().signal)
    const rejection = expect(pending).rejects.toThrow('TIMEOUT')
    await vi.advanceTimersByTimeAsync(45_000)
    await rejection
    expect(exportSurface.request.value).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    scope.stop()
  })
})
