import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'

interface ProviderContext {
  completion: monaco.languages.CompletionItemProvider
  hover: monaco.languages.HoverProvider
}

const contexts = new Map<string, ProviderContext>()
let registered = false
const key = (model: monaco.editor.ITextModel) => model.uri.toString()

export function ensureMarkdownProvidersRegistered(): void {
  if (registered) return
  registered = true
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
}
