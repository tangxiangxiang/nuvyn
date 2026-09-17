<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import type { WorkspaceTab } from './tabs'
import {
  deriveTabUiPresentation,
  type TabUiPresentation,
} from '../../composables/vault/editor-tabs/tabPresentation'
import {
  useWorkspaceTabMenu,
  type WorkspaceTabMenuAction,
  type WorkspaceTabMenuIntent,
} from '../../composables/vault/workspace-tabs/useWorkspaceTabMenu'
import {
  useWorkspaceTabReorder,
  type WorkspaceTabReorderRequest,
} from '../../composables/vault/workspace-tabs/useWorkspaceTabReorder'
import { useWorkspaceTabFocus } from '../../composables/vault/workspace-tabs/useWorkspaceTabFocus'

export type { WorkspaceTabReorderRequest }

const props = withDefaults(defineProps<{
  tabs: WorkspaceTab[]
  activePath: string | null
  contextActionsVisible?: boolean
}>(), {
  contextActionsVisible: true,
})
const emit = defineEmits<{
  select: [path: string]
  close: [path: string]
  'close-many': [paths: string[]]
  'copy-path': [path: string]
  'reveal-in-tree': [path: string]
  reorder: [request: WorkspaceTabReorderRequest]
}>()
const { t: translate } = useI18n()

// One presentation per tab — the source of truth for title, status
// text, status kind, and aria-label. The same object feeds the tab
// row and aria-label, so they cannot drift.
const tabPresentations = computed<TabUiPresentation[]>(() =>
  props.tabs.map((tab) => deriveTabUiPresentation(tab, translate)),
)

const tabsRef = ref<HTMLElement | null>(null)
const tabIds = computed(() => props.tabs.map((t) => t.id))
const { focusTab } = useWorkspaceTabFocus({ container: tabsRef })

const {
  draggedId,
  dropTargetId,
  dropPosition,
  liveAnnouncement,
  blockCloseButtonDrag,
  clearBlockedDrag,
  consumeSuppressedClick,
  start: startReorder,
  over: updateDropTarget,
  overStrip: updateStripAutoScroll,
  leaveStrip: stopAutoScrollOutsideStrip,
  drop: dropReorder,
  end: endReorder,
  cancel: cancelReorder,
  moveByKeyboard,
} = useWorkspaceTabReorder({
  tabIds,
  container: tabsRef,
  displayTitle: (id) => {
    const index = tabIds.value.indexOf(id)
    return tabPresentations.value[index]?.displayTitle
      ?? props.tabs[index]?.title
      ?? id
  },
  announce: (title, position, count) => translate(
    'workspace_tab.moved_announcement',
    { title, position, count },
  ),
  onReorder: (request) => emit('reorder', request),
})

defineExpose({ focusTab })

const activePathRef = computed(() => props.activePath)
function onTabKeydown(event: KeyboardEvent, tab: WorkspaceTab) {
  if (
    event.altKey
    && event.shiftKey
    && !event.ctrlKey
    && !event.metaKey
    && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    event.preventDefault()
    event.stopPropagation()
    if (menuVisible.value) return
    moveTabByKeyboard(tab, event.key === 'ArrowLeft' ? -1 : 1)
    return
  }
  if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
    event.preventDefault()
    event.stopPropagation()
    const anchor = event.currentTarget as HTMLElement
    const rect = anchor.getBoundingClientRect()
    openMenu(tab.id, rect.left, rect.bottom, anchor)
  }
}

function onCloseClick(tab: WorkspaceTab) {
  clearBlockedDrag()
  emit('close', tab.id)
}

// --- workspace tab reordering ---------------------------------------------
function onClosePointerDown(tabId: string, event: PointerEvent): void {
  blockCloseButtonDrag(tabId, event)
}

function onDragStart(event: DragEvent, tab: WorkspaceTab): void {
  if (!startReorder(event, tab.id)) return
  closeMenu(false)
}

function onDragOver(event: DragEvent, targetId: string): void {
  updateDropTarget(event, targetId)
}

function onTabsDragOver(event: DragEvent): void {
  updateStripAutoScroll(event)
}

function onTabsDragLeave(event: DragEvent): void {
  stopAutoScrollOutsideStrip(event)
}

function onDrop(event: DragEvent, targetId: string): void {
  dropReorder(event, targetId)
}

function onDragEnd(): void {
  endReorder()
}

function onTabClick(tab: WorkspaceTab): void {
  if (consumeSuppressedClick()) return
  emit('select', tab.id)
}

function moveTabByKeyboard(tab: WorkspaceTab, direction: -1 | 1): void {
  moveByKeyboard(tab.id, direction)
}

// --- right-click / keyboard context menu ---
const tabsInput = computed<readonly WorkspaceTab[]>(() => props.tabs)
const menuLabelKeys: Record<WorkspaceTabMenuAction, string> = {
  close: 'workspace_tab.close',
  'close-others': 'workspace_tab.close_others',
  'close-left': 'workspace_tab.close_left',
  'close-right': 'workspace_tab.close_right',
  'close-all': 'workspace_tab.close_all',
  'copy-path': 'workspace_tab.copy_path',
  'reveal-in-tree': 'workspace_tab.reveal_in_tree',
}

function emitMenuIntent(intent: WorkspaceTabMenuIntent): void {
  if (intent.type === 'close') emit('close', intent.id)
  else if (intent.type === 'close-many') emit('close-many', intent.ids)
  else if (intent.type === 'copy-path') emit('copy-path', intent.path)
  else emit('reveal-in-tree', intent.path)
}

const {
  visible: menuVisible,
  x: menuX,
  y: menuY,
  targetId: menuTabPath,
  activeItem: activeMenuItem,
  items: menuItems,
  open: openMenu,
  close: closeMenu,
  activate: activateMenuAction,
  setMenuElement,
  setItemElement: setMenuItemRef,
  setActiveItem: setActiveMenuItem,
} = useWorkspaceTabMenu({
  tabs: tabsInput,
  activeId: activePathRef,
  onIntent: emitMenuIntent,
})

function onContextMenu(e: MouseEvent, path: string) {
  e.preventDefault()
  e.stopPropagation()
  openMenu(path, e.clientX, e.clientY, e.currentTarget as HTMLElement)
}

</script>

<template>
  <div class="editor-tabs-shell">
    <div
      ref="tabsRef"
      class="tabs"
      role="tablist"
      @dragover="onTabsDragOver"
      @dragleave="onTabsDragLeave"
      @drop.self="cancelReorder(true)"
    >
      <div
        v-for="(t, i) in tabs"
        :key="t.id"
        role="tab"
        :data-tab-id="t.id"
        :data-save-status="t.kind === 'document' ? t.save.status : undefined"
        :data-status-kind="tabPresentations[i].statusKind"
        :tabindex="t.id === activePath ? 0 : -1"
        :aria-selected="t.id === activePath"
        aria-haspopup="menu"
        :aria-expanded="menuVisible && menuTabPath === t.id ? 'true' : 'false'"
        :aria-label="tabPresentations[i].ariaLabel"
        :aria-roledescription="translate('workspace_tab.draggable')"
        draggable="true"
        class="tab"
        :class="{
          active: t.id === activePath,
          diff: t.kind === 'diff',
          'save-in-flight': t.kind === 'document' && t.save.inFlight,
          'save-attention': t.kind === 'document' && t.save.attention,
          dragging: draggedId === t.id,
          'drop-before': dropTargetId === t.id && dropPosition === 'before',
          'drop-after': dropTargetId === t.id && dropPosition === 'after',
        }"
        @click="onTabClick(t)"
        @auxclick.middle="() => emit('close', t.id)"
        @contextmenu="onContextMenu($event, t.id)"
        @keydown="onTabKeydown($event, t)"
        @dragstart="onDragStart($event, t)"
        @dragover="onDragOver($event, t.id)"
        @drop.stop="onDrop($event, t.id)"
        @dragend="onDragEnd"
      >
        <!-- Dirty marker: independent of the save-status indicator so a
             dirty buffer is still visible when error / offline / external
             colours are painted. Shape (filled dot) is constant; color
             comes from the .tab-dirty-indicator rule. -->
        <span
          v-if="t.kind === 'document' && t.save.dirty"
          class="tab-dirty-indicator"
          :data-newer-changes="t.save.hasNewerChanges ? 'true' : undefined"
          aria-hidden="true"
        />
        <!-- Save-status indicator: distinct per status kind so users
             can tell saving / error / offline / external apart by shape,
             not just by color. Skipped for 'none' and 'dirty' (dirty is
             already covered by the dirty marker above). -->
        <span
          v-if="tabPresentations[i].statusKind !== 'none' && tabPresentations[i].statusKind !== 'dirty'"
          class="tab-status-indicator"
          :data-kind="tabPresentations[i].statusKind"
          aria-hidden="true"
        />
        <span class="tab-title">{{ tabPresentations[i].displayTitle }}</span>
        <NButton
          class="tab-close"
          attr-type="button"
          text
          :bordered="false"
          draggable="false"
          :aria-label="translate('workspace_tab.close_named', { name: tabPresentations[i].displayTitle })"
          @pointerdown="onClosePointerDown(t.id, $event)"
          @dragstart.prevent.stop
          @click.stop="onCloseClick(t)"
        >×</NButton>
      </div>
      <span class="sr-only" aria-live="polite" aria-atomic="true">{{ liveAnnouncement }}</span>
    </div>
    <div
      v-if="$slots['context-actions'] && props.contextActionsVisible !== false"
      class="editor-tabs-context-actions"
    >
      <slot name="context-actions" />
    </div>
    <Teleport to="body">
      <div
        v-if="menuVisible"
        :ref="setMenuElement"
        class="tab-context-menu"
        :style="{ left: menuX + 'px', top: menuY + 'px' }"
        role="menu"
        @click.stop
      >
        <template v-for="(item, index) in menuItems" :key="item.action">
          <div v-if="index === 5" role="separator" />
          <NButton
            attr-type="button"
            text
            :bordered="false"
            :ref="(el) => setMenuItemRef(el, index)"
            role="menuitem"
            :tabindex="activeMenuItem === index ? 0 : -1"
            :disabled="item.disabled"
            @mouseenter="setActiveMenuItem(index)"
            @click="activateMenuAction(item.action)"
          >{{ translate(menuLabelKeys[item.action]) }}</NButton>
        </template>
      </div>
    </Teleport>
  </div>
</template>
