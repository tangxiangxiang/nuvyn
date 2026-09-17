import {
  nextTick,
  onBeforeUnmount,
  readonly,
  ref,
  watch,
  type Ref,
} from 'vue'
import {
  moveWorkspaceTab,
  type WorkspaceTabDropPosition,
} from '../../../components/vault/workspaceTabOrder'
import { readDataTransfer, nuvynWorkspaceTabMime } from '../../../technicalNamespace'

const WORKSPACE_TAB_MIME_KEY = nuvynWorkspaceTabMime()
export const WORKSPACE_TAB_MIME = WORKSPACE_TAB_MIME_KEY

export interface WorkspaceTabReorderRequest {
  orderedIds: string[]
  movedId: string
  input: 'pointer' | 'keyboard'
}

export interface UseWorkspaceTabReorderOptions {
  tabIds: Readonly<Ref<readonly string[]>>
  container: Readonly<Ref<HTMLElement | null>>
  displayTitle: (id: string) => string
  announce: (title: string, position: number, count: number) => string
  onReorder: (request: WorkspaceTabReorderRequest) => void
}

export function useWorkspaceTabReorder({
  tabIds,
  container,
  displayTitle,
  announce,
  onReorder,
}: UseWorkspaceTabReorderOptions) {
  const draggedId = ref<string | null>(null)
  const dropTargetId = ref<string | null>(null)
  const dropPosition = ref<WorkspaceTabDropPosition | null>(null)
  const liveAnnouncement = ref('')
  let dragSignature = ''
  let suppressClick = false
  let suppressClickTimer: ReturnType<typeof setTimeout> | null = null
  let autoScrollFrame: number | null = null
  let autoScrollDirection: -1 | 0 | 1 = 0
  let blockedDragTabId: string | null = null
  let announcementGeneration = 0
  let disposed = false

  function signature(): string {
    return tabIds.value.join('\u0000')
  }

  function clearBlockedDrag(): void {
    blockedDragTabId = null
    window.removeEventListener('pointerup', clearBlockedDrag)
    window.removeEventListener('pointercancel', clearBlockedDrag)
  }

  function blockCloseButtonDrag(tabId: string, event: PointerEvent): void {
    if (disposed) return
    event.stopPropagation()
    clearBlockedDrag()
    blockedDragTabId = tabId
    window.addEventListener('pointerup', clearBlockedDrag)
    window.addEventListener('pointercancel', clearBlockedDrag)
  }

  function hasWorkspacePayload(
    dataTransfer: DataTransfer | null,
    validateValue = false,
  ): boolean {
    if (!dataTransfer || !draggedId.value) return false
    if (!Array.from(dataTransfer.types).some((type) => type === WORKSPACE_TAB_MIME_KEY)) return false
    return !validateValue
      || readDataTransfer(dataTransfer, WORKSPACE_TAB_MIME_KEY) === draggedId.value
  }

  function clearSuppressClickSoon(): void {
    if (suppressClickTimer) clearTimeout(suppressClickTimer)
    suppressClick = true
    suppressClickTimer = setTimeout(() => {
      suppressClick = false
      suppressClickTimer = null
    }, 0)
  }

  function consumeSuppressedClick(): boolean {
    return suppressClick
  }

  function stopAutoScroll(): void {
    autoScrollDirection = 0
    if (autoScrollFrame !== null) cancelAnimationFrame(autoScrollFrame)
    autoScrollFrame = null
  }

  function autoScrollStep(): void {
    autoScrollFrame = null
    const element = container.value
    if (!element || autoScrollDirection === 0 || !draggedId.value) return
    const previous = element.scrollLeft
    element.scrollLeft += autoScrollDirection * 8
    if (element.scrollLeft === previous) {
      autoScrollDirection = 0
      return
    }
    autoScrollFrame = requestAnimationFrame(autoScrollStep)
  }

  function updateAutoScroll(event: DragEvent): void {
    const element = container.value
    if (!element || !hasWorkspacePayload(event.dataTransfer)) {
      stopAutoScroll()
      return
    }
    const rect = element.getBoundingClientRect()
    const edge = Math.min(32, rect.width / 3)
    const direction = event.clientX <= rect.left + edge
      ? -1
      : event.clientX >= rect.right - edge ? 1 : 0
    if (direction === autoScrollDirection) return
    stopAutoScroll()
    autoScrollDirection = direction
    if (direction !== 0) autoScrollFrame = requestAnimationFrame(autoScrollStep)
  }

  function cancel(suppressSyntheticClick = false): void {
    if (suppressSyntheticClick && draggedId.value) clearSuppressClickSoon()
    draggedId.value = null
    dragSignature = ''
    dropTargetId.value = null
    dropPosition.value = null
    stopAutoScroll()
  }

  function start(event: DragEvent, tabId: string): boolean {
    if (
      disposed
      || !event.dataTransfer
      || blockedDragTabId === tabId
      || (event.target instanceof Element && event.target.closest('.tab-close'))
    ) {
      event.preventDefault()
      clearBlockedDrag()
      return false
    }
    clearBlockedDrag()
    draggedId.value = tabId
    dragSignature = signature()
    dropTargetId.value = null
    dropPosition.value = null
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(WORKSPACE_TAB_MIME, tabId)
    return true
  }

  function over(event: DragEvent, targetId: string): void {
    if (
      !hasWorkspacePayload(event.dataTransfer)
      || dragSignature !== signature()
      || !tabIds.value.includes(targetId)
    ) {
      cancel()
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    dropTargetId.value = targetId
    dropPosition.value = event.clientX < rect.left + rect.width / 2
      ? 'before'
      : 'after'
    updateAutoScroll(event)
  }

  function overStrip(event: DragEvent): void {
    if (event.target === container.value) updateAutoScroll(event)
  }

  function leaveStrip(event: DragEvent): void {
    const next = event.relatedTarget
    if (!(next instanceof Node) || !container.value?.contains(next)) stopAutoScroll()
  }

  function drop(event: DragEvent, targetId: string): void {
    const sourceId = draggedId.value
    const position = dropPosition.value
    const valid = Boolean(
      sourceId
      && position
      && dropTargetId.value === targetId
      && dragSignature === signature()
      && hasWorkspacePayload(event.dataTransfer, true)
      && tabIds.value.includes(sourceId)
      && tabIds.value.includes(targetId),
    )
    if (valid) {
      event.preventDefault()
      const orderedIds = moveWorkspaceTab(
        tabIds.value,
        sourceId!,
        targetId,
        position!,
      )
      if (orderedIds.some((id, index) => id !== tabIds.value[index])) {
        onReorder({ orderedIds, movedId: sourceId!, input: 'pointer' })
      }
    }
    cancel(true)
  }

  function end(): void {
    clearBlockedDrag()
    cancel(true)
  }

  function moveByKeyboard(tabId: string, direction: -1 | 1): void {
    if (disposed) return
    const index = tabIds.value.indexOf(tabId)
    const targetIndex = index + direction
    const targetId = tabIds.value[targetIndex]
    if (index < 0 || !targetId) return
    const announcementTitle = displayTitle(tabId)
    const orderedIds = moveWorkspaceTab(
      tabIds.value,
      tabId,
      targetId,
      direction < 0 ? 'before' : 'after',
    )
    onReorder({ orderedIds, movedId: tabId, input: 'keyboard' })
    liveAnnouncement.value = ''
    const generation = ++announcementGeneration
    void nextTick(() => {
      if (disposed || generation !== announcementGeneration) return
      liveAnnouncement.value = announce(
        announcementTitle,
        targetIndex + 1,
        tabIds.value.length,
      )
    })
  }

  watch(tabIds, (ids) => {
    if (draggedId.value && ids.join('\u0000') !== dragSignature) cancel()
  })

  onBeforeUnmount(() => {
    disposed = true
    announcementGeneration++
    cancel()
    clearBlockedDrag()
    suppressClick = false
    if (suppressClickTimer) clearTimeout(suppressClickTimer)
    suppressClickTimer = null
  })

  return {
    draggedId: readonly(draggedId),
    dropTargetId: readonly(dropTargetId),
    dropPosition: readonly(dropPosition),
    liveAnnouncement: readonly(liveAnnouncement),
    blockCloseButtonDrag,
    clearBlockedDrag,
    consumeSuppressedClick,
    start,
    over,
    overStrip,
    leaveStrip,
    drop,
    end,
    cancel,
    moveByKeyboard,
  }
}
