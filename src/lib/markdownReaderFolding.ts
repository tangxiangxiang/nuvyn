import { activateCodeGroupTab } from '../composables/useCodeGroupMount'

interface Fold {
  host: HTMLElement
  targets: HTMLElement[]
  label: string
  button: HTMLButtonElement
  collapsed: boolean
}

export interface FoldingLabels {
  expand: string
  collapse: string
}

export interface ReaderFolding {
  reveal(target: HTMLElement): void
  updateLabels(labels: FoldingLabels): void
  dispose(): void
}

const readers = new WeakMap<HTMLElement, ReaderFolding>()
let sequence = 0

/** Navigation can reveal content without trusting source-authored attributes. */
export function revealMarkdownTarget(root: HTMLElement, target: HTMLElement): void {
  readers.get(root)?.reveal(target)
  for (let parent = target.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
    if (parent.getAttribute('role') === 'tabpanel') {
      const group = parent.closest<HTMLElement>('.nuvyn-code-group')
      const tab = Array.from(group?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
        .find((candidate) => candidate.getAttribute('aria-controls') === parent.id)
      if (group && tab) activateCodeGroupTab(group, tab)
    }
  }
}

/**
 * Enhance the sanitized, semantic block DOM, never HTML strings or author
 * data-fold attributes. No content is moved/wrapped: Flex direct children,
 * code-group panels and mounted widgets keep their identity and lifecycle.
 */
export function enhanceMarkdownFolding(root: HTMLElement, initialLabels: FoldingLabels): ReaderFolding {
  readers.get(root)?.dispose()
  let labels = initialLabels
  let disposed = false
  const prefix = `nuvyn-fold-${++sequence}-`
  const folds: Fold[] = []
  const byButton = new WeakMap<HTMLElement, Fold>()
  const hiddenBy = new Map<HTMLElement, Set<Fold>>()
  const originalHidden = new Map<HTMLElement, boolean>()
  const addedIds = new Map<HTMLElement, string>()
  const plans: Array<{ host: HTMLElement; targets: HTMLElement[]; label: string }> = []
  const headingLevel = (el: Element) => /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : 0
  const insideWidget = (el: Element) => Boolean(el.closest('.mermaid-widget-host,.markmap-widget-host,.board-embed-host'))
  const summary = (el: HTMLElement) => el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? ''
  function plan(host: HTMLElement, targets: HTMLElement[], label: string) {
    if (targets.length) plans.push({ host, targets, label })
  }

  // Sections are sibling ranges. A heading inside a Flex child, quote or
  // details never consumes siblings outside its own semantic container.
  // Only a leading document H1 is treated as the non-foldable main title.
  const documentTitle = root.firstElementChild?.tagName === 'H1' ? root.firstElementChild : null
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    if (heading === documentTitle || insideWidget(heading)) continue
    const targets: HTMLElement[] = []
    for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
      const level = headingLevel(el)
      if (level && level <= headingLevel(heading)) break
      targets.push(el as HTMLElement)
    }
    plan(heading, targets, summary(heading))
  }

  function updateButton(fold: Fold) {
    fold.button.setAttribute('aria-expanded', String(!fold.collapsed))
    const label = fold.label
    fold.button.setAttribute('aria-label', `${fold.collapsed ? labels.expand : labels.collapse}: ${label}`)
    fold.button.title = fold.button.getAttribute('aria-label')!
  }
  function setCollapsed(fold: Fold, collapsed: boolean) {
    fold.collapsed = collapsed
    for (const target of fold.targets) {
      let owners = hiddenBy.get(target)
      if (!owners) {
        owners = new Set()
        hiddenBy.set(target, owners)
        originalHidden.set(target, Boolean(target.hidden))
      }
      if (collapsed) owners.add(fold)
      else owners.delete(fold)
      target.hidden = Boolean(originalHidden.get(target) || owners.size)
      target.classList.toggle('nuvyn-fold-hidden', owners.size > 0)
    }
    fold.host.classList.toggle('nuvyn-fold-collapsed', collapsed)
    updateButton(fold)
  }
  for (const { host, targets, label } of plans) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'nuvyn-fold-toggle'
    const ids = targets.map((target) => {
      if (!target.id) {
        let id = `${prefix}${addedIds.size}`
        while (document.getElementById(id) || root.querySelector(`[id="${id}"]`)) id += '-x'
        target.id = id
        addedIds.set(target, id)
      }
      return target.id
    })
    button.setAttribute('aria-controls', ids.join(' '))
    const fold: Fold = { host, targets, label, button, collapsed: false }
    folds.push(fold)
    byButton.set(button, fold)
    host.classList.add('nuvyn-fold-host')
    host.prepend(button)
    updateButton(fold)
  }
  const onClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null
    const fold = button && byButton.get(button)
    if (!fold || disposed) return
    event.preventDefault()
    event.stopPropagation()
    setCollapsed(fold, !fold.collapsed)
    root.dispatchEvent(new Event('nuvyn-fold-change', { bubbles: true }))
  }
  root.addEventListener('click', onClick)
  const controller: ReaderFolding = {
    reveal(target) {
      if (disposed) return
      for (const fold of folds) {
        if (fold.collapsed && fold.targets.some((el) => el === target || el.contains(target))) setCollapsed(fold, false)
      }
      root.dispatchEvent(new Event('nuvyn-fold-change', { bubbles: true }))
    },
    updateLabels(next) {
      labels = next
      folds.forEach(updateButton)
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.removeEventListener('click', onClick)
      for (const fold of folds) {
        fold.button.remove()
        fold.host.classList.remove('nuvyn-fold-host', 'nuvyn-fold-collapsed')
      }
      for (const [target, hidden] of originalHidden) {
        target.hidden = hidden
        target.classList.remove('nuvyn-fold-hidden')
      }
      for (const [target, id] of addedIds) if (target.id === id) target.removeAttribute('id')
      hiddenBy.clear()
      originalHidden.clear()
      addedIds.clear()
      folds.length = 0
      if (readers.get(root) === controller) readers.delete(root)
    },
  }
  readers.set(root, controller)
  return controller
}
