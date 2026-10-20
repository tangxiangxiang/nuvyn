import { describe, expect, it, vi } from 'vitest'

const registered = vi.hoisted(() => ({ folding: vi.fn() }))
vi.mock('monaco-editor/esm/vs/editor/editor.api.js', () => ({
  languages: {
    registerFoldingRangeProvider: registered.folding,
    registerCompletionItemProvider: vi.fn(),
    registerHoverProvider: vi.fn(),
    FoldingRangeKind: { Region: 'region' },
  },
}))
import { bindMarkdownProviderContext, ensureMarkdownProvidersRegistered, unbindMarkdownProviderContext } from '../monacoMarkdownProviders'

describe('Markdown folding provider lifetime', () => {
  it('registers once, caches per model version, invalidates and releases unbound models', () => {
    const model = {
      uri: { toString: () => 'test:model' }, getVersionId: () => version,
      getValueLength: () => source.length, getValue: vi.fn(() => source),
    }
    let version = 1
    let source = '# A\nbody'
    bindMarkdownProviderContext(model as any, {} as any)
    ensureMarkdownProvidersRegistered()
    expect(registered.folding).toHaveBeenCalledTimes(1)
    const provider = registered.folding.mock.calls[0][1]
    const token = { isCancellationRequested: false }
    expect(provider.provideFoldingRanges(model, {}, token)).toEqual([{ start: 1, end: 2, kind: 'region' }])
    provider.provideFoldingRanges(model, {}, token)
    expect(model.getValue).toHaveBeenCalledTimes(1)
    source += '\nmore'
    version += 1
    expect(provider.provideFoldingRanges(model, {}, token)[0].end).toBe(3)
    expect(provider.provideFoldingRanges(model, {}, { isCancellationRequested: true })).toEqual([])
    source = 'x'.repeat(500_000)
    expect(provider.provideFoldingRanges(model, {}, token)).toEqual([])
    unbindMarkdownProviderContext(model as any)
    expect(provider.provideFoldingRanges(model, {}, token)).toEqual([])
  })
})
