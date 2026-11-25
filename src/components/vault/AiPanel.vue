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
import { getAiProfiles, runLedgerAiCommand, type AiModelOption, type LedgerAiCommand, type LedgerAiCommandOutcome } from '../../lib/ai-api'
import { displayContextForCapture } from './aiContextPaths'
import { resolveAiQuickPrompts } from './aiQuickPrompts'
import AiChatMessages from './AiChatMessages.vue'
import AiComposer from './AiComposer.vue'
import AiSessionPicker from './AiSessionPicker.vue'
import AiFinanceMemoryDialog from './AiFinanceMemoryDialog.vue'
import AiFinanceSkillsDialog from './AiFinanceSkillsDialog.vue'
import { readStorageKey, writeStorageKey } from '../../technicalNamespace'

const props = withDefaults(defineProps<{
  open: boolean
  workspaceKind?: WorkspaceKind
  diaryViewMode?: DiaryCalendarMode
  positionStorageKey?: string | null
  modelPreferenceStorageKey?: string | null
}>(), {
  workspaceKind: null,
  diaryViewMode: 'diary',
  positionStorageKey: null,
  modelPreferenceStorageKey: null,
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
  { command: 'compact' as const, label: t('ai.ledger_compact'), description: t('ai.finance_compact_detail') },
  { command: 'clear' as const, label: t('ai.ledger_clear'), description: t('ai.finance_clear_detail') },
  { command: 'memory' as const, label: t('ai.ledger_memory'), description: t('ai.finance_memory_title') },
  { command: 'skills' as const, label: t('ai.ledger_skills'), description: t('ai.finance_skills_title') },
])
const commandStatus = ref<LedgerAiCommandOutcome | 'compacting' | 'failed' | 'unknown' | null>(null)
let commandController: AbortController | null = null
const commandPending = ref(false)
const ledgerLoadFailed = ref(false)
const composer = ref<InstanceType<typeof AiComposer> | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const showSessionPicker = ref(false)
const showFinanceMemory = ref(false)
const showFinanceSkills = ref(false)
const isDragging = ref(false)
const isMobileViewport = ref(typeof window !== 'undefined' && window.innerWidth <= 640)
const blockingOverlay = ref(false)
const panelObscured = computed(() => blockingOverlay.value || showSessionPicker.value || showFinanceMemory.value)
const visualViewport = ref<{ top: number; height: number } | null>(null)
const panelWidth = computed(() => isLedger.value ? 720 : 460)
const position = ref<{ left: number; top: number } | null>(null)
const aiProfiles = ref<AiModelOption[]>([])
const profilesLoaded = ref(false)
const profilesLoading = ref(false)
const profileListFailed = ref(false)
const defaultProfileId = ref<string | null>(null)
const selectedProfileId = ref<string | null>(null)
const hasSavedProfileSelection = ref(false)
const workspaceModelPreferenceKey = computed(() => props.modelPreferenceStorageKey
  ? `${props.modelPreferenceStorageKey}:${props.workspaceKind ?? 'vault'}`
  : null)
const availableModelOptions = computed(() => aiProfiles.value)
const selectedModel = computed(() => aiProfiles.value.find(option => option.profileId === selectedProfileId.value) ?? null)
const modelUnavailable = computed(() => profilesLoaded.value && !selectedModel.value)
const modelName = computed(() => selectedModel.value?.model
  ?? t(selectedProfileId.value ? 'ai.model_unavailable' : 'ai.model_choose'))
const agentBusy = computed(() => ordinaryHistory.busy.value || ledgerHistory.busy.value || commandPending.value)

function restoreWorkspaceModelSelection(): void {
  const key = workspaceModelPreferenceKey.value
  const stored = key ? readStorageKey(key) : null
  hasSavedProfileSelection.value = stored !== null && stored.length > 0
  selectedProfileId.value = hasSavedProfileSelection.value ? stored : defaultProfileId.value
}

watch(workspaceModelPreferenceKey, restoreWorkspaceModelSelection, { immediate: true })

async function loadAiModelOptions(): Promise<void> {
  if (profilesLoading.value) return
  profilesLoading.value = true
  profileListFailed.value = false
  try {
    const result = await getAiProfiles()
    aiProfiles.value = result.profiles
      .filter(profile => profile.configured && !profile.credentialError)
      .filter(profile => profile.provider === 'anthropic' || profile.provider === 'openai')
      .map(profile => ({
        profileId: profile.id,
        name: profile.name,
        provider: profile.provider,
        model: profile.model,
      }))
    defaultProfileId.value = result.activeProfileId
    profilesLoaded.value = true
    if (!hasSavedProfileSelection.value) selectedProfileId.value = result.activeProfileId
  } catch {
    profileListFailed.value = true
  } finally {
    profilesLoading.value = false
  }
}

function selectModelProfile(profileId: string): void {
  if (agentBusy.value || !availableModelOptions.value.some(option => option.profileId === profileId)) return
  selectedProfileId.value = profileId
  history.value.errorState.value = null
  hasSavedProfileSelection.value = true
  const key = workspaceModelPreferenceKey.value
  if (key) writeStorageKey(key, profileId)
}

function onModelMenuOpen(): void {
  if (profileListFailed.value || history.value.errorState.value === 'ai-model-unavailable') {
    void loadAiModelOptions()
  }
}

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
  if (isMobileViewport.value) {
    return isLedger.value && visualViewport.value
      ? { '--ai-viewport-top': `${visualViewport.value.top}px`, '--ai-viewport-height': `${visualViewport.value.height}px` }
      : undefined
  }
  if (!position.value) return undefined
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
  const width = Math.min(panelWidth.value, window.innerWidth - (isLedger.value ? 32 : 24))
  return {
    left: Math.max(12, window.innerWidth - width - 16),
    top: Math.max(12, workspaceChromeBottom() + 12),
  }
}

function clampPosition(next: { left: number; top: number }): { left: number; top: number } {
  const rect = panelRef.value?.getBoundingClientRect()
  const width = rect && rect.width > 0
    ? rect.width
    : Math.min(panelWidth.value, window.innerWidth - (isLedger.value ? 32 : 24))
  const height = rect && rect.height > 0
    ? rect.height
    : Math.min(window.innerHeight * 0.8, isLedger.value ? 860 : 720)
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

function syncVisualViewport(): void {
  if (window.innerWidth > 640) return
  const viewport = window.visualViewport
  visualViewport.value = viewport?.scale === 1
    ? { top: viewport.offsetTop, height: viewport.height }
    : null
}

function syncViewport(): void {
  syncVisualViewport()
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

async function onSend(prompt?: string): Promise<void> {
  const text = (prompt ?? draft.value).trim()
  const active = history.value
  if (!text || active.busy.value || active.isLoading.value) return
  if (isLedger.value && text.startsWith('/')) {
    if (text === '/compact' || text === '/clear' || text === '/memory' || text === '/skills') {
      await onLedgerCommand(text.slice(1) as LedgerAiCommand)
    }
    else commandStatus.value = 'unknown'
    return
  }
  if (!selectedModel.value || (isLedger.value && (commandPending.value || !active.activeSession.value))) return
  if (isLedger.value) commandStatus.value = null

  // Snapshot both the Note context and its file-change bus synchronously.
  // A later route change cannot replace this request's security boundary.
  const noteBridge = props.workspaceKind === 'vault' ? appShell?.noteAiContext?.value ?? null : null
  const capture = noteBridge?.capture() ?? { status: 'none' as const }
  const snapshot = capture.status === 'ready' ? capture.context : undefined
  const publishFileChange = noteBridge?.publishFileChange
  if (prompt === undefined) draft.value = ''
  await active.sendAndStream(text, {
    profileId: selectedModel.value.profileId,
    ...(props.workspaceKind === 'ledger' ? { ledgerAnalysis: true } : {}),
    ...(snapshot ? { liveContext: snapshot } : {}),
    ...(publishFileChange ? { publishFileChange } : {}),
  })
}

async function onLedgerCommand(command: LedgerAiCommand): Promise<void> {
  if (command === 'memory') {
    if (!isLedger.value || ledgerHistory.busy.value || commandPending.value) return
    ledgerDraft.value = ''
    commandStatus.value = null
    showFinanceMemory.value = true
    return
  }
  if (command === 'skills') {
    if (!isLedger.value || ledgerHistory.busy.value || commandPending.value) return
    ledgerDraft.value = ''
    commandStatus.value = null
    showFinanceSkills.value = true
    return
  }
  if (!isLedger.value || !ledgerHistory.activeSession.value || ledgerHistory.busy.value || commandPending.value) return
  const controller = new AbortController()
  commandController = controller
  commandPending.value = true
  commandStatus.value = command === 'compact' ? 'compacting' : null
  const initialDraft = ledgerDraft.value
  try {
    const { outcome } = await runLedgerAiCommand(command, controller.signal, command === 'compact' ? selectedModel.value?.profileId : undefined)
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
  if (props.open) {
    const previousWidth = Math.min(ledger ? 460 : 720, window.innerWidth - (ledger ? 24 : 32))
    if (!position.value || position.value.left === Math.max(12, window.innerWidth - previousWidth - 16)) {
      position.value = defaultPosition()
    }
    void normalizePosition()
  }
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
  if (isLedger.value) {
    await onSend(text)
    return
  }
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
    || event.isComposing
    || event.keyCode === 229
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
  void loadAiModelOptions()
  window.addEventListener('resize', syncViewport)
  window.visualViewport?.addEventListener('resize', syncViewport)
  window.visualViewport?.addEventListener('scroll', syncVisualViewport)
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
  window.visualViewport?.removeEventListener('scroll', syncVisualViewport)
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
      :class="{ 'is-dragging': isDragging, 'is-mobile': isMobileViewport, 'is-obscured': panelObscured, 'is-finance': isLedger }"
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

      <div v-if="profilesLoaded && !availableModelOptions.length" class="ai-no-key-banner" role="status">
        {{ t('ai.models_unavailable') }}
      </div>
      <div v-else-if="profileListFailed" class="ai-no-key-banner" role="status">
        {{ t('ai.models_load_failed') }}
      </div>
      <div v-else-if="modelUnavailable" class="ai-no-key-banner" role="status">
        {{ t(selectedProfileId ? 'ai.model_unavailable' : 'ai.model_choose') }}
      </div>
      <div v-else-if="history.errorState.value === 'ai-model-unavailable'" class="ai-no-key-banner" role="status">
        {{ t('ai.model_unavailable') }}
      </div>

      <KeepAlive>
        <AiChatMessages
          v-if="!isLedger"
          key="ordinary"
          :messages="ordinaryHistory.messages.value"
          :current-path="displayPath"
          :note-link-context="noteLinkContext"
          :quick-prompts="quickPrompts"
          :empty-hint="emptyHint"
          @prompt="useQuickPrompt"
        />

        <AiChatMessages
          v-else
          key="finance"
          finance
          :messages="ledgerHistory.messages.value"
          :current-path="null"
          :quick-prompts="quickPrompts"
          :empty-hint="emptyHint"
          :show-welcome="!!ledgerHistory.activeSession.value && !ledgerHistory.isLoading.value && !ledgerHistory.busy.value"
          :prompts-disabled="!selectedModel || commandPending"
          :finance-phase="ledgerHistory.financePhase.value"
          @prompt="useQuickPrompt"
        />
      </KeepAlive>

      <NAlert
        v-if="history.errorState.value?.startsWith('ledger-analysis-')"
        type="warning"
        :show-icon="false"
        class="ai-ledger-status"
      >{{ t(history.errorState.value === 'ledger-analysis-uninitialized' ? 'ai.ledger_uninitialized' : 'ai.ledger_unavailable') }}</NAlert>
      <p v-if="isLedger && commandStatus" class="ai-ledger-status" role="status">
        {{ t(`ai.ledger_command_${commandStatus}`) }}
      </p>
      <p v-if="isLedger && ledgerLoadFailed" class="ai-ledger-status" role="status">{{ t('ai.ledger_unavailable') }}</p>

      <AiComposer
        ref="composer"
        v-model="draft"
        :busy="history.busy.value"
        :configured="!!selectedModel"
        :can-send="!history.isLoading.value && (!isLedger || (!!history.activeSession.value && !commandPending))"
        :commands="isLedger ? ledgerCommands : undefined"
        :placeholder="isLedger ? t('ai.finance_placeholder') : undefined"
        :model-name="modelName"
        :model-options="availableModelOptions"
        :selected-model-profile-id="selectedProfileId"
        :model-selector-disabled="agentBusy || profilesLoading"
        :prompts="quickPrompts"
        @send="onSend"
        @command="onLedgerCommand"
        @select-model="selectModelProfile"
        @model-menu-open="onModelMenuOpen"
        @stop="history.stop"
      />

      <AiSessionPicker v-if="showSessionPicker" @close="closeSessionPicker" />
      <AiFinanceMemoryDialog :open="showFinanceMemory" :busy="agentBusy" @close="showFinanceMemory = false" />
      <AiFinanceSkillsDialog :open="showFinanceSkills" @close="showFinanceSkills = false" />
    </aside>
  </Transition>
</template>

<style scoped>
.ai-ledger-status {
  flex: none;
  margin: 4px 12px;
}

</style>
