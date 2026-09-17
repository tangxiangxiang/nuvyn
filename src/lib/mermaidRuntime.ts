export interface MermaidRenderResult {
  svg: string
  bindFunctions?: (element: HTMLElement) => void
}

export interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void
  render: (id: string, code: string) => Promise<MermaidRenderResult | string>
}

interface MermaidRuntimeContext {
  initialize: (theme: string) => void
  nextId: (attempt: number) => string
}

let mermaidPromise: Promise<MermaidApi> | null = null
let renderQueue: Promise<void> = Promise.resolve()
let lastInitKey = ''
let renderCount = 0

function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => mermaid as unknown as MermaidApi)
  }
  return mermaidPromise
}

function initializeMermaid(mermaid: MermaidApi, theme: string): void {
  const key = `${theme}|strict`
  if (lastInitKey === key) return
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
  })
  lastInitKey = key
}

/**
 * Mermaid keeps initialize()/render() configuration in process-global state.
 * Serialize the complete async render pass so two visible widgets cannot
 * change that state while a sibling's layout is still awaiting Mermaid.
 */
export function runMermaidExclusive<T>(
  task: (mermaid: MermaidApi, context: MermaidRuntimeContext) => Promise<T> | T,
): Promise<T> {
  const run = renderQueue.then(async () => {
    const mermaid = await getMermaid()
    return task(mermaid, {
      initialize: (theme) => initializeMermaid(mermaid, theme),
      nextId: (attempt) => `mermaid-${++renderCount}-${Date.now()}-${attempt}`,
    })
  })
  // A failed render must not poison the queue for every later widget.
  renderQueue = run.then(() => undefined, () => undefined)
  return run
}

export const __testing__ = {
  reset(): void {
    lastInitKey = ''
    renderCount = 0
  },
}
