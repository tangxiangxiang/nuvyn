<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NIcon } from 'naive-ui'
import { History, MessagePlus, X } from '@vicons/tabler'
import { useAiHistory, useLedgerAiHistory } from '../../composables/vault/useAiHistory'
import type { AiLiveContextCapture } from '../../composables/vault/aiLiveContext'
import { AppShellContextKey } from '../../composables/appShellContext'
import { useI18n } from '../../composables/useI18n'
import type { DiaryCalendarMode } from '../../composables/appShellContext'
import type { WorkspaceKind } from '../../lib/workspace'
import { runLedgerAiCommand, type LedgerAiCommand, type LedgerAiCommandOutcome } from '../../lib/ai-api'
import { displayContextForCapture } from './aiContextPaths'
import { resolveAiQuickPrompts } from './aiQuickPrompts'
import AiChatMessages from './AiChatMessages.vue'
import AiComposer from './AiComposer.vue'
import AiSessionPicker from './AiSessionPicker.vue'
import { readStorageKey, writeStorageKey } from '../../technicalNamespace'

const props = withDefaults(defineProps<{
  open: boolean
  workspaceKind?: WorkspaceKind
  diaryViewMode?: DiaryCalendarMode
  positionStorageKey?: string | null
}>(), {
  workspaceKind: null,
  diaryViewMode: 'diary',
  positionStorageKey: null,
})

const emit = defineEmits<{ close: [] }>()
const appShell = inject(AppShellContextKey, null)
const ordinaryHistory = useAiHistory()
const ledgerHistory = useLedgerAiHistory(ordinaryHistory)
const isLedger = computed(() => props.workspaceKind === 'ledger')
const history = computed(() => isLedger.value ? ledgerHistory : ordinaryHistory)
const title = computed(() => t(isLedger.value ? 'ai.finance' : 'ai.assistant'))
const { t } = useI18n()
const ordinaryDraft = ref('')
const ledgerDraft = ref('')
const draft = computed({
  get: () => isLedger.value ? ledgerDraft.value : ordinaryDraft.value,
  set: (value: string) => {
    if (isLedger.value) ledgerDraft.value = value
    else ordinaryDraft.value = value
  },
})
const ledgerCommands = computed(() => [
  { command: 'compact' as const, label: t('ai.ledger_compact') },
  { command: 'clear' as const, label: t('ai.ledger_clear') },
])
const commandStatus = ref<LedgerAiCommandOutcome | 'compacting' | 'failed' | 'unknown' | null>(null)
let commandController: AbortController | null = null
const commandPending = ref(false)
const ledgerLoadFailed = ref(false)
const composer = ref<InstanceType<typeof AiComposer> | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const showSessionPicker = ref(false)
const isDragging = ref(false)
const isMobileViewport = ref(typeof window !== 'undefined' && window.innerWidth <= 640)
const blockingOverlay = ref(false)
const panelObscured = computed(() => blockingOverlay.value || showSessionPicker.value)
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
let historyTrigger: HTMLElement | null = null

function captureNoteContext(): AiLiveContextCapture {
  if (props.workspaceKind !== 'vault') return { status: 'none' }
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

const quickPromptState = computed(() => resolveAiQuickPrompts({
  workspace: props.workspaceKind,
  diaryViewMode: props.diaryViewMode,
  hasActiveNote: props.workspaceKind === 'vault' && displayPath.value !== null,
  t,
}))
const quickPrompts = computed(() => quickPromptState.value.prompts)
const emptyHint = computed(() => quickPromptState.value.emptyHint)

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
  const active = history.value
  if (!text || active.busy.value || active.isLoading.value) return
  if (isLedger.value && text.startsWith('/')) {
    if (text === '/compact' || text === '/clear') await onLedgerCommand(text === '/compact' ? 'compact' : 'clear')
    else commandStatus.value = 'unknown'
    return
  }
  if (!active.configured.value || (isLedger.value && (commandPending.value || !active.activeSession.value))) return
  if (isLedger.value) commandStatus.value = null

  // Snapshot both the Note context and its file-change bus synchronously.
  // A later route change cannot replace this request's security boundary.
  const noteBridge = props.workspaceKind === 'vault' ? appShell?.noteAiContext?.value ?? null : null
  const capture = noteBridge?.capture() ?? { status: 'none' as const }
  const snapshot = capture.status === 'ready' ? capture.context : undefined
  const publishFileChange = noteBridge?.publishFileChange
  draft.value = ''
  await active.sendAndStream(text, {
    ...(props.workspaceKind === 'ledger' ? { ledgerAnalysis: true } : {}),
    ...(snapshot ? { liveContext: snapshot } : {}),
    ...(publishFileChange ? { publishFileChange } : {}),
  })
}

async function onLedgerCommand(command: LedgerAiCommand): Promise<void> {
  if (!isLedger.value || !ledgerHistory.activeSession.value || ledgerHistory.busy.value || commandPending.value) return
  const controller = new AbortController()
  commandController = controller
  commandPending.value = true
  commandStatus.value = command === 'compact' ? 'compacting' : null
  const initialDraft = ledgerDraft.value
  try {
    const { outcome } = await runLedgerAiCommand(command, controller.signal)
    if (controller.signal.aborted) return
    if (outcome === 'cleared') {
      ledgerHistory.messages.value = []
      ledgerHistory.errorState.value = null
    }
    if (ledgerDraft.value === initialDraft) ledgerDraft.value = ''
    commandStatus.value = outcome
  } catch {
    if (!controller.signal.aborted) commandStatus.value = 'failed'
  } finally {
    commandController = null
    commandPending.value = false
  }
}

watch([isLedger, () => props.open], ([ledger, open]) => {
  if (!ledger || !open || ledgerHistory.activeSession.value || ledgerHistory.isLoading.value) return
  ledgerLoadFailed.value = false
  void ledgerHistory.loadActive().catch(() => { ledgerLoadFailed.value = true })
}, { immediate: true })

watch(isLedger, (ledger) => {
  if (ledger) {
    showSessionPicker.value = false
    historyTrigger = null
  }
})

async function onNewConversation(): Promise<void> {
  if (ordinaryHistory.busy.value || ordinaryHistory.isLoading.value) return
  draft.value = ''
  await ordinaryHistory.createSession()
  await ordinaryHistory.refreshSessions()
}

async function useQuickPrompt(text: string): Promise<void> {
  draft.value = text
  await nextTick()
  await composer.value?.focus()
}

function openSessionPicker(event: MouseEvent): void {
  historyTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  showSessionPicker.value = true
}

async function closeSessionPicker(): Promise<void> {
  showSessionPicker.value = false
  const trigger = historyTrigger
  historyTrigger = null
  await nextTick()
  if (props.open && !panelObscured.value) trigger?.focus()
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
  else {
    showSessionPicker.value = false
    historyTrigger = null
  }
})

// The history picker is already tracked by showSessionPicker. The observer
// only looks for external overlays, and only while the panel is open.
const overlaySelector = '[aria-modal="true"]:not(.ai-sp-dialog), [role="dialog"]:not(.ai-sp-dialog), .n-modal-mask, .n-drawer-mask, .confirm-backdrop, .prompt-backdrop'

watch(() => props.open, (open, _previous, onCleanup) => {
  if (!open) {
    blockingOverlay.value = false
    return
  }
  const overlayAncestors = new Set<Element>()
  function refreshOverlays(): void {
    overlayAncestors.clear()
    let visible = false
    for (const overlay of document.querySelectorAll(overlaySelector)) {
      if (panelRef.value?.contains(overlay)) continue
      for (let node: Element | null = overlay; node; node = node.parentElement) {
        overlayAncestors.add(node)
      }
      // A modal that is fading in already blocks input, even at zero opacity.
      if (overlay.getClientRects().length && getComputedStyle(overlay).visibility === 'visible') visible = true
    }
    blockingOverlay.value = visible
  }
  function containsOverlay(node: Node): boolean {
    return node instanceof Element && (node.matches(overlaySelector) || Boolean(node.querySelector(overlaySelector)))
  }
  const observer = new MutationObserver((records) => {
    if (records.some((record) => {
      if (panelRef.value?.contains(record.target)) return false
      if (record.type === 'attributes') {
        return record.target instanceof Element
          && (overlayAncestors.has(record.target) || record.target.matches(overlaySelector))
      }
      return Array.from(record.addedNodes).some(containsOverlay)
        || Array.from(record.removedNodes).some(containsOverlay)
    })) refreshOverlays()
  })
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-modal', 'role', 'hidden'],
  })
  refreshOverlays()
  onCleanup(() => observer.disconnect())
}, { immediate: true, flush: 'post' })

onMounted(() => {
  void ordinaryHistory.loadActive().catch(() => {})
  void ordinaryHistory.refreshModel().catch(() => {})
  window.addEventListener('resize', syncViewport)
  window.visualViewport?.addEventListener('resize', syncViewport)
  document.addEventListener('keydown', onGlobalKeydown)
  if (typeof ResizeObserver !== 'undefined' && panelRef.value) {
    resizeObserver = new ResizeObserver(() => {
      if (props.open) void normalizePosition()
    })
    resizeObserver.observe(panelRef.value)
  }
  syncViewport()
})

onBeforeUnmount(() => {
  ledgerHistory.stop()
  commandController?.abort()
  window.removeEventListener('resize', syncViewport)
  window.visualViewport?.removeEventListener('resize', syncViewport)
  document.removeEventListener('keydown', onGlobalKeydown)
  resizeObserver?.disconnect()
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
      :class="{ 'is-dragging': isDragging, 'is-mobile': isMobileViewport, 'is-obscured': panelObscured }"
      :style="panelStyle"
      :aria-label="title"
      :aria-hidden="panelObscured || undefined"
      :inert="panelObscured || undefined"
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
          <span class="ai-floating-title">{{ title }}</span>
        </div>
        <div class="ai-header-actions">
          <NButton
            v-if="!isLedger"
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
            v-if="!isLedger"
            class="ai-header-btn"
            attr-type="button"
            text
            :bordered="false"
            :title="t('ai.sessions')"
            :aria-label="t('ai.sessions')"
            data-testid="global-ai-history"
            @click="openSessionPicker"
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

      <div v-if="!history.configured.value && !history.isLoading.value" class="ai-no-key-banner" role="status">
        {{ t('ai.not_configured') }}
      </div>

      <AiChatMessages
        :messages="history.messages.value"
        :current-path="displayPath"
        :note-link-context="noteLinkContext"
        :quick-prompts="quickPrompts"
        :empty-hint="emptyHint"
        @prompt="useQuickPrompt"
      />

      <NAlert
        v-if="history.errorState.value?.startsWith('ledger-analysis-')"
        type="warning"
        :show-icon="false"
        class="ai-ledger-status"
      >{{ t(history.errorState.value === 'ledger-analysis-uninitialized' ? 'ai.ledger_uninitialized' : 'ai.ledger_unavailable') }}</NAlert>
      <p v-else-if="isLedger && ledgerHistory.financePhase.value" class="ai-ledger-status" role="status" data-testid="finance-agent-progress">
        {{ t(`ai.finance_phase_${ledgerHistory.financePhase.value}`) }}
      </p>

      <p v-if="isLedger && commandStatus" class="ai-ledger-status" role="status">
        {{ t(`ai.ledger_command_${commandStatus}`) }}
      </p>
      <p v-if="isLedger && ledgerLoadFailed" class="ai-ledger-status" role="status">{{ t('ai.ledger_unavailable') }}</p>

      <AiComposer
        ref="composer"
        v-model="draft"
        :busy="history.busy.value"
        :configured="history.configured.value"
        :can-send="!history.isLoading.value && (!isLedger || (!!history.activeSession.value && !commandPending))"
        :commands="isLedger ? ledgerCommands : undefined"
        :model-name="history.model.value"
        :prompts="quickPrompts"
        @send="onSend"
        @command="onLedgerCommand"
        @stop="history.stop"
      />

      <AiSessionPicker v-if="showSessionPicker" @close="closeSessionPicker" />
    </aside>
  </Transition>
</template>

<style scoped>
.ai-ledger-status {
  flex: none;
  margin: 4px 12px;
}

</style>
