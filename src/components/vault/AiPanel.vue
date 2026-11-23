<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { History, MessagePlus, X } from '@vicons/tabler'
import { useAiHistory } from '../../composables/vault/useAiHistory'
import type { AiLiveContextCapture } from '../../composables/vault/aiLiveContext'
import { AppShellContextKey } from '../../composables/appShellContext'
import { useI18n } from '../../composables/useI18n'
import { displayContextForCapture } from './aiContextPaths'
import AiChatMessages from './AiChatMessages.vue'
import AiComposer from './AiComposer.vue'
import AiSessionPicker from './AiSessionPicker.vue'
import { readStorageKey, writeStorageKey } from '../../technicalNamespace'

const props = withDefaults(defineProps<{
  open: boolean
  positionStorageKey?: string | null
}>(), {
  positionStorageKey: null,
})

const emit = defineEmits<{ close: [] }>()
const appShell = inject(AppShellContextKey, null)
const history = useAiHistory()
const { t } = useI18n()
const draft = ref('')
const composer = ref<InstanceType<typeof AiComposer> | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const showSessionPicker = ref(false)
const isDragging = ref(false)
const isMobileViewport = ref(typeof window !== 'undefined' && window.innerWidth <= 640)
const blockingOverlay = ref(false)
const position = ref<{ left: number; top: number } | null>(null)

let drag: {
  pointerId: number
  originX: number
  originY: number
  left: number
  top: number
  element: HTMLElement
} | null = null
let resizeObserver: ResizeObserver | null = null
let overlayObserver: MutationObserver | null = null

function captureNoteContext(): AiLiveContextCapture {
  return appShell?.noteAiContext?.value?.capture() ?? { status: 'none' }
}

const displayContext = computed(() => displayContextForCapture(captureNoteContext()))
const displayPath = computed(() => displayContext.value?.path ?? null)
const noteLinkContext = computed(() => {
  const bridge = appShell?.noteAiContext?.value
  if (!bridge || !displayPath.value) return null
  return {
    paths: bridge.linkPaths(),
    openLink: bridge.openLink,
  }
})

const quickPrompts = computed(() => {
  const hasNote = displayPath.value !== null
  return hasNote
    ? [
        { label: t('quick_prompts.with_note.summarize.label'), text: t('quick_prompts.with_note.summarize.text') },
        { label: t('quick_prompts.with_note.find_related.label'), text: t('quick_prompts.with_note.find_related.text') },
        { label: t('quick_prompts.with_note.suggest_tidy.label'), text: t('quick_prompts.with_note.suggest_tidy.text') },
      ]
    : [
        { label: t('quick_prompts.no_note.browse.label'), text: t('quick_prompts.no_note.browse.text') },
        { label: t('quick_prompts.no_note.find_unprocessed.label'), text: t('quick_prompts.no_note.find_unprocessed.text') },
        { label: t('quick_prompts.no_note.suggest_tidy.label'), text: t('quick_prompts.no_note.suggest_tidy.text') },
      ]
})

const panelStyle = computed(() => {
  if (isMobileViewport.value || !position.value) return undefined
  return {
    left: `${position.value.left}px`,
    top: `${position.value.top}px`,
    '--ai-floating-chrome-bottom': `${workspaceChromeBottom()}px`,
  }
})

function readSavedPosition(): { left: number; top: number } | null {
  const key = props.positionStorageKey
  if (!key) return null
  try {
    const raw = readStorageKey(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown }
    if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return null
    if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null
    if (Math.abs(parsed.left) > 100_000 || Math.abs(parsed.top) > 100_000) return null
    return { left: parsed.left, top: parsed.top }
  } catch {
    return null
  }
}

function workspaceChromeBottom(): number {
  const navbar = document.querySelector<HTMLElement>('.navbar')
  const navRect = navbar?.getBoundingClientRect()
  const immersiveTrigger = document.querySelector<HTMLElement>('.global-ai-immersive-trigger')
  const triggerRect = immersiveTrigger?.getBoundingClientRect()
  return Math.max(
    navRect && navRect.height > 0 ? navRect.bottom : 0,
    triggerRect && triggerRect.height > 0 ? triggerRect.bottom : 0,
  )
}

function defaultPosition(): { left: number; top: number } {
  const width = Math.min(460, Math.max(280, window.innerWidth - 24))
  return {
    left: Math.max(12, window.innerWidth - width - 16),
    top: Math.max(12, workspaceChromeBottom() + 12),
  }
}

function clampPosition(next: { left: number; top: number }): { left: number; top: number } {
  const rect = panelRef.value?.getBoundingClientRect()
  const width = rect && rect.width > 0
    ? rect.width
    : Math.min(460, Math.max(280, window.innerWidth - 24))
  const height = rect && rect.height > 0
    ? rect.height
    : Math.min(window.innerHeight * 0.8, 720)
  const minTop = Math.max(8, workspaceChromeBottom() + 8)
  const maxLeft = Math.max(8, window.innerWidth - width - 8)
  const maxTop = Math.max(minTop, window.innerHeight - height - 8)
  return {
    left: Math.min(maxLeft, Math.max(8, next.left)),
    top: Math.min(maxTop, Math.max(minTop, next.top)),
  }
}

function persistPosition(): void {
  if (!props.positionStorageKey || !position.value || isMobileViewport.value) return
  try {
    writeStorageKey(props.positionStorageKey, JSON.stringify(position.value))
  } catch {
    // Storage can be unavailable in private browsing; in-memory dragging still works.
  }
}

function restoreDefaultPosition(): void {
  position.value = clampPosition(defaultPosition())
  persistPosition()
}

function syncViewport(): void {
  isMobileViewport.value = window.innerWidth <= 640
  if (isMobileViewport.value) return
  position.value = clampPosition(position.value ?? defaultPosition())
  persistPosition()
}

async function normalizePosition(): Promise<void> {
  await nextTick()
  if (!isMobileViewport.value) {
    position.value = clampPosition(position.value ?? defaultPosition())
    persistPosition()
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]'))
}

function onDragStart(event: PointerEvent): void {
  if (isMobileViewport.value || isInteractiveTarget(event.target)) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  const element = event.currentTarget
  if (!(element instanceof HTMLElement)) return
  event.preventDefault()
  position.value = clampPosition(position.value ?? defaultPosition())
  drag = {
    pointerId: event.pointerId,
    originX: event.clientX,
    originY: event.clientY,
    left: position.value.left,
    top: position.value.top,
    element,
  }
  try { element.setPointerCapture(event.pointerId) } catch { /* capture can fail after browser cancellation */ }
  isDragging.value = true
}

function onDragMove(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return
  position.value = clampPosition({
    left: drag.left + event.clientX - drag.originX,
    top: drag.top + event.clientY - drag.originY,
  })
}

function finishDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return
  const activeDrag = drag
  drag = null
  try {
    if (activeDrag.element.hasPointerCapture(event.pointerId)) {
      activeDrag.element.releasePointerCapture(event.pointerId)
    }
  } catch { /* the browser may already have released pointer capture */ }
  isDragging.value = false
  persistPosition()
}

async function onSend(): Promise<void> {
  const text = draft.value.trim()
  if (!text || history.busy.value || history.isLoading.value || !history.configured.value) return

  // Snapshot both the Note context and its file-change bus synchronously.
  // A later route change cannot replace this request's security boundary.
  const noteBridge = appShell?.noteAiContext?.value ?? null
  const capture = noteBridge?.capture() ?? { status: 'none' as const }
  const snapshot = capture.status === 'ready' ? capture.context : undefined
  const publishFileChange = noteBridge?.publishFileChange
  draft.value = ''
  await history.sendAndStream(text, {
    ...(snapshot ? { liveContext: snapshot } : {}),
    ...(publishFileChange ? { publishFileChange } : {}),
  })
}

async function onNewConversation(): Promise<void> {
  if (history.busy.value || history.isLoading.value) return
  draft.value = ''
  await history.createSession()
  await history.refreshSessions()
}

async function useQuickPrompt(text: string): Promise<void> {
  draft.value = text
  await nextTick()
  await composer.value?.focus()
}

function hasBlockingOverlay(): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[aria-modal="true"], [role="dialog"], .n-modal-mask, .n-drawer-mask, .confirm-backdrop, .prompt-backdrop, .ai-sp-backdrop',
  )
  return [...candidates].some((element) => {
    if (panelRef.value?.contains(element)) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
  })
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (
    event.key !== 'Escape'
    || event.defaultPrevented
    || !props.open
    || showSessionPicker.value
    || blockingOverlay.value
  ) return
  emit('close')
}

watch(() => props.positionStorageKey, async () => {
  position.value = readSavedPosition() ?? defaultPosition()
  await normalizePosition()
}, { immediate: true })

watch(() => props.open, (open) => {
  if (open) void normalizePosition()
  else showSessionPicker.value = false
})

onMounted(() => {
  void history.loadActive().catch(() => {})
  void history.refreshModel().catch(() => {})
  window.addEventListener('resize', syncViewport)
  window.visualViewport?.addEventListener('resize', syncViewport)
  document.addEventListener('keydown', onGlobalKeydown)
  blockingOverlay.value = hasBlockingOverlay()
  overlayObserver = new MutationObserver(() => {
    blockingOverlay.value = hasBlockingOverlay()
  })
  overlayObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-modal', 'role'],
  })
  if (typeof ResizeObserver !== 'undefined' && panelRef.value) {
    resizeObserver = new ResizeObserver(() => {
      if (props.open) void normalizePosition()
    })
    resizeObserver.observe(panelRef.value)
  }
  syncViewport()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncViewport)
  window.visualViewport?.removeEventListener('resize', syncViewport)
  document.removeEventListener('keydown', onGlobalKeydown)
  resizeObserver?.disconnect()
  overlayObserver?.disconnect()
  if (drag) {
    try { drag.element.releasePointerCapture(drag.pointerId) } catch { /* already released */ }
    drag = null
  }
  isDragging.value = false
})
</script>

<template>
  <Transition name="ai-floating">
    <aside
      ref="panelRef"
      v-show="props.open"
      class="ai-panel ai-floating-panel"
      :class="{ 'is-dragging': isDragging, 'is-mobile': isMobileViewport, 'is-obscured': blockingOverlay }"
      :style="panelStyle"
      :aria-label="t('ai.assistant')"
      :aria-hidden="blockingOverlay || undefined"
      :inert="blockingOverlay || undefined"
      data-testid="global-ai-panel"
    >
      <header class="ai-header ai-floating-header">
        <div
          class="ai-floating-drag-region"
          :class="{ 'is-dragging': isDragging }"
          @pointerdown="onDragStart"
          @pointermove="onDragMove"
          @pointerup="finishDrag"
          @pointercancel="finishDrag"
          @lostpointercapture="finishDrag"
          @dblclick="!isInteractiveTarget($event.target) && !isMobileViewport && restoreDefaultPosition()"
        >
          <span class="ai-floating-title">{{ t('ai.assistant') }}</span>
        </div>
        <div class="ai-header-actions">
          <NButton
            class="ai-header-btn"
            attr-type="button"
            text
            :bordered="false"
            :title="t('ai.new_session')"
            :aria-label="t('ai.new_session')"
            :disabled="history.busy.value || history.isLoading.value"
            data-testid="global-ai-new-session"
            @click="onNewConversation"
          ><NIcon aria-hidden="true"><MessagePlus /></NIcon></NButton>
          <NButton
            class="ai-header-btn"
            attr-type="button"
            text
            :bordered="false"
            :title="t('ai.sessions')"
            :aria-label="t('ai.sessions')"
            data-testid="global-ai-history"
            @click="showSessionPicker = true"
          ><NIcon aria-hidden="true"><History /></NIcon></NButton>
          <NButton
            class="ai-header-btn ai-floating-close"
            attr-type="button"
            text
            :bordered="false"
            :title="t('ai.close')"
            :aria-label="t('ai.close')"
            data-testid="global-ai-close"
            @click="emit('close')"
          ><NIcon aria-hidden="true"><X /></NIcon></NButton>
        </div>
      </header>

      <div v-if="!history.configured.value" class="ai-no-key-banner" role="status">
        {{ t('ai.not_configured') }}
      </div>

      <AiChatMessages
        :messages="history.messages.value"
        :current-path="displayPath"
        :note-link-context="noteLinkContext"
        :quick-prompts="quickPrompts"
        @prompt="useQuickPrompt"
      />

      <AiComposer
        ref="composer"
        v-model="draft"
        :busy="history.busy.value"
        :configured="history.configured.value"
        :can-send="!history.isLoading.value"
        :model-name="history.model.value"
        :prompts="quickPrompts"
        @send="onSend"
        @stop="history.stop"
      />

      <AiSessionPicker v-if="showSessionPicker" @close="showSessionPicker = false" />
    </aside>
  </Transition>
</template>
