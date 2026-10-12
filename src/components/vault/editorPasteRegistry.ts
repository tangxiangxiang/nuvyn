type EditorPasteHandler = (event: ClipboardEvent) => void

type EditorPasteRegistry = {
  handlers: Map<HTMLElement, EditorPasteHandler>
  listener: (event: Event) => void
}

const registries = new WeakMap<Document, EditorPasteRegistry>()

/** Register an editor-scoped callback behind one capture listener per document. */
export function registerEditorPasteHandler(host: HTMLElement, handler: EditorPasteHandler): () => void {
  const ownerDocument = host.ownerDocument
  let registry = registries.get(ownerDocument)
  if (!registry) {
    const handlers = new Map<HTMLElement, EditorPasteHandler>()
    const listener = (event: Event) => {
      const pasteEvent = event as ClipboardEvent
      const path = pasteEvent.composedPath()
      const target = pasteEvent.target
      for (const [registeredHost, registeredHandler] of handlers) {
        if (path.includes(registeredHost)
          || (target && typeof (target as Node).nodeType === 'number' && registeredHost.contains(target as Node))) {
          registeredHandler(pasteEvent)
          return
        }
      }
    }
    registry = { handlers, listener }
    registries.set(ownerDocument, registry)
    ownerDocument.addEventListener('paste', listener, true)
  }

  registry.handlers.set(host, handler)
  return () => {
    const currentRegistry = registries.get(ownerDocument)
    if (!currentRegistry) return
    currentRegistry.handlers.delete(host)
    if (currentRegistry.handlers.size === 0) {
      ownerDocument.removeEventListener('paste', currentRegistry.listener, true)
      registries.delete(ownerDocument)
    }
  }
}
