import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { markdownFoldingRanges, MARKDOWN_FOLDING_LIMIT } from '../../lib/markdownFolding'

interface ProviderContext {
  completion: monaco.languages.CompletionItemProvider
  hover: monaco.languages.HoverProvider
}

const contexts = new Map<string, ProviderContext>()
const foldingCache = new WeakMap<monaco.editor.ITextModel, { version: number; ranges: monaco.languages.FoldingRange[] }>()
let registered = false
const key = (model: monaco.editor.ITextModel) => model.uri.toString()

export function ensureMarkdownProvidersRegistered(): void {
  if (registered) return
  registered = true
  monaco.languages.registerFoldingRangeProvider('markdown', {
    provideFoldingRanges(model, _context, token) {
      if (token.isCancellationRequested || !contexts.has(key(model)) || model.getValueLength() >= MARKDOWN_FOLDING_LIMIT) return []
      const version = model.getVersionId()
      const cached = foldingCache.get(model)
      if (cached?.version === version) return cached.ranges
      const ranges = markdownFoldingRanges(model.getValue()).map(({ start, end }) => ({
        start, end, kind: monaco.languages.FoldingRangeKind.Region,
      }))
      foldingCache.set(model, { version, ranges })
      return ranges
    },
  })
  monaco.languages.registerCompletionItemProvider('markdown', {
    triggerCharacters: ['[', '`', '/', ':'],
    provideCompletionItems(model, position, context, token) {
      return contexts.get(key(model))?.completion.provideCompletionItems(model, position, context, token) ?? { suggestions: [] }
    },
  })
  monaco.languages.registerHoverProvider('markdown', {
    provideHover(model, position, token, context) {
      return contexts.get(key(model))?.hover.provideHover(model, position, token, context) ?? null
    },
  })
}

export function bindMarkdownProviderContext(model: monaco.editor.ITextModel, context: ProviderContext): void {
  ensureMarkdownProvidersRegistered()
  contexts.set(key(model), context)
}

export function unbindMarkdownProviderContext(model: monaco.editor.ITextModel): void {
  contexts.delete(key(model))
  foldingCache.delete(model)
}
