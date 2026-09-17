import {
  computed,
  nextTick,
  onBeforeUnmount,
  readonly,
  ref,
  watch,
  type Ref,
} from 'vue'
import type { WorkspaceTab } from '../../../components/vault/tabs'
import { focusConnectedElement } from './useWorkspaceTabFocus'

export type WorkspaceTabMenuAction =
  | 'close'
  | 'close-others'
  | 'close-left'
  | 'close-right'
  | 'close-all'
  | 'copy-path'
  | 'reveal-in-tree'

export type WorkspaceTabMenuIntent =
  | { type: 'close', id: string }
  | { type: 'close-many', ids: string[] }
  | { type: 'copy-path', path: string }
  | { type: 'reveal-in-tree', path: string }

export interface WorkspaceTabMenuItem {
  action: WorkspaceTabMenuAction
  disabled: boolean
}

export interface UseWorkspaceTabMenuOptions {
  tabs: Readonly<Ref<readonly WorkspaceTab[]>>
  activeId: Readonly<Ref<string | null>>
  onIntent: (intent: WorkspaceTabMenuIntent) => void
}

export function useWorkspaceTabMenu({
  tabs,
  activeId,
  onIntent,
}: UseWorkspaceTabMenuOptions) {
  const visible = ref(false)
  const x = ref(0)
  const y = ref(0)
  const targetId = ref<string | null>(null)
  const activeItem = ref(0)
  const menuElement = ref<HTMLElement | null>(null)
  const itemElements = ref<HTMLElement[]>([])
  let sourceElement: HTMLElement | null = null
  let openingSignature = ''
  let generation = 0
  let disposed = false

  const tabIds = computed(() => tabs.value.map((tab) => tab.id))
  const targetIndex = computed(() =>
    targetId.value
      ? tabs.value.findIndex((tab) => tab.id === targetId.value)
      : -1,
  )
  const targetTab = computed(() => tabs.value[targetIndex.value] ?? null)
  const othersIds = computed(() => {
    if (!targetId.value) return []
    return tabs.value
      .filter((tab) => tab.id !== targetId.value)
      .map((tab) => tab.id)
  })
  const leftIds = computed(() => {
    if (targetIndex.value < 0) return []
    return tabs.value.slice(0, targetIndex.value).map((tab) => tab.id)
  })
  const rightIds = computed(() => {
    if (targetIndex.value < 0) return []
    return tabs.value.slice(targetIndex.value + 1).map((tab) => tab.id)
  })
  const allIds = computed(() => tabs.value.map((tab) => tab.id))
  const documentPath = computed<string | null>(() => {
    const tab = targetTab.value
    if (!tab) return null
    return tab.documentPath ?? (tab.kind === 'document' ? tab.id : null)
  })
  const canCloseOthers = computed(() => tabs.value.length > 1)
  const canCloseLeft = computed(() => leftIds.value.length > 0)
  const canCloseRight = computed(() => rightIds.value.length > 0)
  const items = computed<WorkspaceTabMenuItem[]>(() => [
    { action: 'close', disabled: false },
    { action: 'close-others', disabled: !canCloseOthers.value },
    { action: 'close-left', disabled: !canCloseLeft.value },
    { action: 'close-right', disabled: !canCloseRight.value },
    { action: 'close-all', disabled: false },
    { action: 'copy-path', disabled: !documentPath.value },
    { action: 'reveal-in-tree', disabled: !documentPath.value },
  ])

  function signature(): string {
    return tabIds.value.join('\u0000')
  }

  function resolveElement(element: unknown): HTMLElement | null {
    if (element instanceof HTMLElement) return element
    if (!element || typeof element !== 'object') return null
    const root = (element as { $el?: unknown }).$el
    return root instanceof HTMLElement ? root : null
  }

  function setMenuElement(element: unknown): void {
    menuElement.value = resolveElement(element)
  }

  function setItemElement(element: unknown, index: number): void {
    const resolved = resolveElement(element)
    if (resolved) itemElements.value[index] = resolved
    else delete itemElements.value[index]
  }

  function setActiveItem(index: number): void {
    if (!items.value[index]?.disabled) activeItem.value = index
  }

  function firstEnabledItem(): number {
    return items.value.findIndex((item) => !item.disabled)
  }

  function lastEnabledItem(): number {
    for (let index = items.value.length - 1; index >= 0; index--) {
      if (!items.value[index]?.disabled) return index
    }
    return 0
  }

  function focusActiveItem(): void {
    itemElements.value[activeItem.value]?.focus()
  }

  function position(): void {
    const element = menuElement.value
    if (!element) return
    const margin = 8
    const rect = element.getBoundingClientRect()
    x.value = Math.max(
      margin,
      Math.min(x.value, window.innerWidth - margin - rect.width),
    )
    y.value = Math.max(
      margin,
      Math.min(y.value, window.innerHeight - margin - rect.height),
    )
  }

  function addListeners(): void {
    document.addEventListener('pointerdown', onOutsidePointerDown, true)
    document.addEventListener('keydown', onKeydown)
    window.addEventListener('resize', closeWithoutFocus)
    window.addEventListener('scroll', onScroll, true)
  }

  function removeListeners(): void {
    document.removeEventListener('pointerdown', onOutsidePointerDown, true)
    document.removeEventListener('keydown', onKeydown)
    window.removeEventListener('resize', closeWithoutFocus)
    window.removeEventListener('scroll', onScroll, true)
  }

  function open(
    id: string,
    nextX: number,
    nextY: number,
    source: HTMLElement,
  ): void {
    if (disposed) return
    const currentGeneration = ++generation
    removeListeners()
    targetId.value = id
    sourceElement = source
    openingSignature = signature()
    x.value = nextX
    y.value = nextY
    visible.value = true
    void nextTick(() => {
      if (
        currentGeneration !== generation
        || !visible.value
        || !menuElement.value
      ) return
      position()
      activeItem.value = firstEnabledItem()
      focusActiveItem()
      addListeners()
    })
  }

  function close(restoreFocus = false): void {
    generation++
    const source = sourceElement
    visible.value = false
    targetId.value = null
    itemElements.value = []
    removeListeners()
    if (restoreFocus) {
      void nextTick(() => {
        focusConnectedElement(source)
      })
    }
  }

  function closeWithoutFocus(): void {
    close(false)
  }

  function onScroll(event: Event): void {
    const target = event.target
    if (
      menuElement.value
      && target instanceof Node
      && (
        target === menuElement.value
        || menuElement.value.contains(target)
      )
    ) return
    closeWithoutFocus()
  }

  function onOutsidePointerDown(event: PointerEvent): void {
    if (!menuElement.value?.contains(event.target as Node)) close(false)
  }

  function moveFocus(direction: 1 | -1): void {
    let next = activeItem.value
    do {
      next = (next + direction + items.value.length) % items.value.length
    } while (items.value[next]?.disabled)
    activeItem.value = next
    focusActiveItem()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!visible.value) return
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      activeItem.value = event.key === 'Home'
        ? firstEnabledItem()
        : lastEnabledItem()
      focusActiveItem()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const item = items.value[activeItem.value]
      if (item && !item.disabled) void activate(item.action)
    }
  }

  function snapshotIntent(
    action: WorkspaceTabMenuAction,
  ): WorkspaceTabMenuIntent | null {
    if (action === 'close') {
      return targetId.value ? { type: 'close', id: targetId.value } : null
    }
    if (action === 'copy-path' || action === 'reveal-in-tree') {
      if (!documentPath.value) return null
      return { type: action, path: documentPath.value }
    }
    const ids = action === 'close-others'
      ? othersIds.value
      : action === 'close-left'
        ? leftIds.value
        : action === 'close-right'
          ? rightIds.value
          : allIds.value
    if (ids.length === 0) return null
    return { type: 'close-many', ids: [...ids] }
  }

  async function prepareAction(): Promise<void> {
    const source = sourceElement
    close(false)
    await nextTick()
    focusConnectedElement(source)
  }

  async function activate(action: WorkspaceTabMenuAction): Promise<void> {
    if (
      disposed
      || !visible.value
      || !targetId.value
      || !tabIds.value.includes(targetId.value)
      || signature() !== openingSignature
    ) {
      close(false)
      return
    }
    const intent = snapshotIntent(action)
    if (!intent) return
    await prepareAction()
    if (disposed) return
    onIntent(intent)
  }

  watch(activeId, () => {
    if (visible.value) close(false)
  })
  watch(tabIds, () => {
    if (visible.value && signature() !== openingSignature) close(false)
  })
  onBeforeUnmount(() => {
    disposed = true
    close(false)
  })

  return {
    visible: readonly(visible),
    x: readonly(x),
    y: readonly(y),
    targetId: readonly(targetId),
    activeItem: readonly(activeItem),
    items,
    documentPath,
    canCloseOthers,
    canCloseLeft,
    canCloseRight,
    open,
    close,
    activate,
    setMenuElement,
    setItemElement,
    setActiveItem,
  }
}
