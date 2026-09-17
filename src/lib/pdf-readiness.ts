export type PdfEnhancementState = 'pending' | 'ready' | 'error'

const SETTLED_STATES = new Set<PdfEnhancementState>(['ready', 'error'])

function isSettledState(value: string | undefined): boolean {
  return SETTLED_STATES.has(value as PdfEnhancementState)
}

function widgetsHaveSettledState(
  article: HTMLElement,
  hostSelector: string,
  widgetSelector: string,
  stateKey: 'mathState' | 'mermaidState' | 'markmapState',
): boolean {
  for (const host of article.querySelectorAll<HTMLElement>(hostSelector)) {
    const widget = host.querySelector<HTMLElement>(widgetSelector)
    if (!widget || !isSettledState(widget.dataset[stateKey])) return false
  }
  return true
}

/** Math errors are settled render outcomes, not export-blocking failures. */
export function mathWidgetsReady(article: HTMLElement): boolean {
  for (const placeholder of article.querySelectorAll<HTMLElement>('.math-mount')) {
    if (!isSettledState(placeholder.dataset.mathState)) return false
  }
  return true
}

export function mermaidWidgetsReady(article: HTMLElement): boolean {
  if (article.querySelector('.mermaid-mount')) return false
  return widgetsHaveSettledState(
    article,
    '.mermaid-widget-host',
    '.mermaid-widget',
    'mermaidState',
  )
}

export function markmapWidgetsReady(article: HTMLElement): boolean {
  if (article.querySelector('.markmap-mount')) return false
  return widgetsHaveSettledState(
    article,
    '.markmap-widget-host',
    '.markmap-widget',
    'markmapState',
  )
}

/**
 * A PDF snapshot may start only after every async article enhancement has
 * reached an explicit terminal state. `error` is settled: it preserves the
 * enhancement's fallback/error representation without blocking the export.
 */
export function pdfEnhancementsReady(article: HTMLElement): boolean {
  return (
    mathWidgetsReady(article)
    && mermaidWidgetsReady(article)
    && markmapWidgetsReady(article)
  )
}
