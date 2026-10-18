function stripPanZoomViewport(svg: SVGSVGElement): void {
  for (const viewport of svg.querySelectorAll<SVGGElement>('.svg-pan-zoom_viewport')) {
    /* svg-pan-zoom stores the current fit/pan state as both an SVG
       transform attribute and an inline CSS transform. A PDF clone
       has a different width from the reader, so carrying that matrix over
       would make the diagram look offset, tiny, or clipped. */
    viewport.removeAttribute('transform')
    viewport.style.removeProperty('transform')
    if (!viewport.style.cssText.trim()) viewport.removeAttribute('style')
    const classNames = (viewport.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name && name !== 'svg-pan-zoom_viewport')
    if (classNames.length > 0) viewport.setAttribute('class', classNames.join(' '))
    else viewport.removeAttribute('class')
  }
}

export function prepareMermaidSvg(source: SVGSVGElement): SVGSVGElement {
  const svg = source.cloneNode(true) as SVGSVGElement
  const originalViewBox = svg.getAttribute('data-mermaid-viewbox')
    ?? svg.getAttribute('viewBox')
  if (originalViewBox) svg.setAttribute('viewBox', originalViewBox)
  /* Mermaid's live component and svg-pan-zoom both write inline sizing
     metadata. Let the PDF stylesheet size the clone from its viewBox. */
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.removeAttribute('style')
  svg.removeAttribute('data-pan-zoom-bound')
  svg.removeAttribute('data-mermaid-viewbox')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  stripPanZoomViewport(svg)
  return svg
}

export function prepareMarkmapSvg(source: SVGSVGElement): SVGSVGElement {
  const svg = source.cloneNode(true) as SVGSVGElement
  /* MarkMap has no diagram viewBox. Its settled auto-fit lives on the direct
     root <g>; restore the fit captured by the isolated export surface so a
     reader-side pan/zoom can never leak into the PDF clone. */
  const fitTransform = source.getAttribute('data-markmap-fit-transform')
  const rootGroup = Array.from(svg.children).find((child) => child.tagName.toLowerCase() === 'g')
  if (rootGroup?.tagName.toLowerCase() === 'g' && fitTransform) {
    rootGroup.setAttribute('transform', fitTransform)
  }

  /* The live MarkMap SVG is CSS-sized and intentionally has no viewBox. Give
     the clone the export surface's user coordinate system; otherwise canvas
     renderers use SVG's 300x150 fallback and the graph collapses into a tiny
     clipped corner. */
  const viewport = source.getAttribute('data-markmap-viewport')?.trim() ?? ''
  const [width, height] = viewport.split(/\s+/).map(Number)
  if (!svg.getAttribute('viewBox') && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
  }

  svg.removeAttribute('style')
  svg.removeAttribute('data-markmap-fit-transform')
  svg.removeAttribute('data-markmap-viewport')
  const classNames = (svg.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter((name) => name && name !== 'markmap-svg' && !name.startsWith('mm-'))
  if (!classNames.includes('markmap')) classNames.push('markmap')
  svg.setAttribute('class', classNames.join(' '))
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
  svg.setAttribute('data-markmap-static', 'true')
  return svg
}

export function unwrapStandaloneFenceWidget(host: HTMLElement): void {
  /* markdown-it emits custom fences as <pre><code>...</code></pre>. The
     post-mount Vue widget replaces the fence contents but intentionally keeps
     that source wrapper in the reader DOM. A PDF snapshot must remove the
     wrapper: its code-block pagination rule would otherwise separate the
     heading from the static diagram and add an unrelated code background. */
  const code = host.parentElement
  const fence = code?.parentElement
  if (!code || !fence || code.tagName !== 'CODE' || fence.tagName !== 'PRE') return

  const containsOnly = (parent: HTMLElement, child: HTMLElement) =>
    Array.from(parent.childNodes).every((node) => (
      node === child || (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    ))
  if (!containsOnly(code, host) || !containsOnly(fence, code)) return
  fence.replaceWith(host)
}

function isOwnedCodeGroupElement(group: HTMLElement, element: Element): boolean {
  return element.closest('.nuvyn-code-group') === group
}

/**
 * Convert the interactive code-group surface into a complete printable
 * source-order surface. The live reader is never passed to this function;
 * callers invoke it on the already-cloned article. Malformed hand-written
 * lookalikes are left alone rather than losing code content or trusting a
 * source-derived label/ID.
 */
export function prepareStaticCodeGroups(root: HTMLElement): void {
  for (const group of Array.from(root.querySelectorAll<HTMLElement>('.nuvyn-code-group'))) {
    const tabsHost = Array.from(group.querySelectorAll<HTMLElement>('.nuvyn-code-group-tabs'))
      .find((element) => isOwnedCodeGroupElement(group, element))
    const panelsHost = Array.from(group.querySelectorAll<HTMLElement>('.nuvyn-code-group-panels'))
      .find((element) => isOwnedCodeGroupElement(group, element))
    if (!tabsHost || !panelsHost) continue

    const tabs = Array.from(tabsHost.querySelectorAll<HTMLElement>('[role="tab"]'))
      .filter((tab) => isOwnedCodeGroupElement(group, tab))
    const panels = Array.from(panelsHost.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
      .filter((panel) => isOwnedCodeGroupElement(group, panel))
    if (tabs.length === 0 || panels.length === 0) continue

    const tabByPanelId = new Map<string, HTMLElement>()
    let valid = true
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls')
      if (!panelId || tabByPanelId.has(panelId)) {
        valid = false
        break
      }
      tabByPanelId.set(panelId, tab)
    }
    if (
      !valid
      || tabs.length !== panels.length
      || panels.some((panel) => !panel.id || !tabByPanelId.has(panel.id))
    ) continue

    const fragment = group.ownerDocument.createDocumentFragment()
    for (const panel of panels) {
      const tab = tabByPanelId.get(panel.id)
      if (!tab) {
        valid = false
        break
      }

      const item = group.ownerDocument.createElement('div')
      item.className = 'nuvyn-code-group-pdf-item'
      const label = group.ownerDocument.createElement('div')
      label.className = 'nuvyn-code-group-pdf-label'
      // textContent is deliberate: labels are author input and must never
      // become trusted HTML merely because the tab was generated by Nuvyn.
      label.textContent = tab.textContent ?? ''
      panel.classList.add('is-active')
      panel.setAttribute('aria-hidden', 'false')
      panel.removeAttribute('aria-labelledby')
      item.append(label, panel)
      fragment.append(item)
    }
    if (!valid) continue

    panelsHost.replaceChildren(fragment)
    tabsHost.remove()
  }
}
