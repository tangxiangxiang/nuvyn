import { onBeforeUnmount, watch, type Ref } from 'vue'

const GROUP_SELECTOR = '.nuvyn-code-group'
const TAB_SELECTOR = '[role="tab"]'
const PANEL_SELECTOR = '[role="tabpanel"]'

interface CodeGroupParts {
  tabs: HTMLElement[]
  panels: HTMLElement[]
  panelById: Map<string, HTMLElement>
}
function isOwnedBy(group: HTMLElement, element: Element): boolean {
  return element.closest(GROUP_SELECTOR) === group
}

function getGroupParts(group: HTMLElement): CodeGroupParts {
  const tabs = Array.from(group.querySelectorAll<HTMLElement>(TAB_SELECTOR))
    .filter((tab) => isOwnedBy(group, tab))
  const panels = Array.from(group.querySelectorAll<HTMLElement>(PANEL_SELECTOR))
    .filter((panel) => isOwnedBy(group, panel))
  const panelById = new Map<string, HTMLElement>()

  for (const panel of panels) {
    const id = panel.id
    if (id && !panelById.has(id)) panelById.set(id, panel)
  }

  return { tabs, panels, panelById }
}

function getPanelForTab(tab: HTMLElement, parts: CodeGroupParts): HTMLElement | null {
  const panelId = tab.getAttribute('aria-controls')
  return panelId ? parts.panelById.get(panelId) ?? null : null
}

function setActiveTab(group: HTMLElement, tab: HTMLElement, focus = false): void {
  const parts = getGroupParts(group)
  if (!parts.tabs.includes(tab)) return

  const panel = getPanelForTab(tab, parts)
  if (!panel) return

  for (const candidate of parts.tabs) {
    const active = candidate === tab
    candidate.setAttribute('aria-selected', String(active))
    candidate.setAttribute('tabindex', active ? '0' : '-1')
    candidate.classList.toggle('is-active', active)
  }

  for (const candidate of parts.panels) {
    const active = candidate === panel
    candidate.setAttribute('aria-hidden', String(!active))
    candidate.classList.toggle('is-active', active)
  }

  if (focus) tab.focus()
}

function syncGroup(group: HTMLElement): void {
  const parts = getGroupParts(group)
  if (parts.tabs.length === 0 || parts.panels.length === 0) return

  const existing = parts.tabs.find((tab) => (
    tab.getAttribute('aria-selected') === 'true' && getPanelForTab(tab, parts)
  ))
  setActiveTab(group, existing ?? parts.tabs[0])
}

function findGroupTarget(root: HTMLElement, target: EventTarget | null): {
  group: HTMLElement
  tab: HTMLElement
} | null {
  if (!(target instanceof Element)) return null
  const tab = target.closest<HTMLElement>(TAB_SELECTOR)
  if (!tab || !root.contains(tab)) return null
  const group = tab.closest<HTMLElement>(GROUP_SELECTOR)
  if (!group || !root.contains(group)) return null
  if (!isOwnedBy(group, tab)) return null
  return { group, tab }
}

export function activateCodeGroupTab(
  group: HTMLElement,
  tab: HTMLElement,
  focus = false,
): void {
  setActiveTab(group, tab, focus)
}

export function enhanceCodeGroups(root: HTMLElement): number {
  const groups = Array.from(root.querySelectorAll<HTMLElement>(GROUP_SELECTOR))
  groups.forEach(syncGroup)
  return groups.length
}

function handleClick(root: HTMLElement, event: MouseEvent): void {
  const target = findGroupTarget(root, event.target)
  if (!target) return
  event.preventDefault()
  activateCodeGroupTab(target.group, target.tab)
}

function handleKeydown(root: HTMLElement, event: KeyboardEvent): void {
  const target = findGroupTarget(root, event.target)
  if (!target) return

  const parts = getGroupParts(target.group)
  const tabIndex = parts.tabs.indexOf(target.tab)
  if (tabIndex === -1) return

  let nextIndex: number | null = null
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      nextIndex = (tabIndex + 1) % parts.tabs.length
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      nextIndex = (tabIndex - 1 + parts.tabs.length) % parts.tabs.length
      break
    case 'Home':
      nextIndex = 0
      break
    case 'End':
      nextIndex = parts.tabs.length - 1
      break
    case 'Enter':
    case ' ':
    case 'Spacebar':
      event.preventDefault()
      activateCodeGroupTab(target.group, target.tab)
      return
    default:
      return
  }

  event.preventDefault()
  const nextTab = parts.tabs[nextIndex ?? tabIndex]
  activateCodeGroupTab(target.group, nextTab, true)
}

export function useCodeGroupMount(articleEl: Ref<HTMLElement | null>): void {
  let observer: MutationObserver | null = null
  let attachedRoot: HTMLElement | null = null
  let disposed = false

  const onClick = (event: MouseEvent) => {
    if (attachedRoot) handleClick(attachedRoot, event)
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (attachedRoot) handleKeydown(attachedRoot, event)
  }

  function detach(): void {
    observer?.disconnect()
    observer = null
    if (attachedRoot) {
      attachedRoot.removeEventListener('click', onClick)
      attachedRoot.removeEventListener('keydown', onKeydown)
    }
    attachedRoot = null
  }

  function attach(root: HTMLElement): void {
    detach()
    attachedRoot = root
    enhanceCodeGroups(root)
    root.addEventListener('click', onClick)
    root.addEventListener('keydown', onKeydown)
    observer = new MutationObserver(() => {
      if (!disposed && attachedRoot === root) enhanceCodeGroups(root)
    })
    observer.observe(root, { childList: true, subtree: true })
  }

  watch(articleEl, (root, _previous, onCleanup) => {
    if (root) attach(root)
    else detach()
    onCleanup(detach)
  }, { immediate: true, flush: 'post' })

  onBeforeUnmount(() => {
    disposed = true
    detach()
  })
}
