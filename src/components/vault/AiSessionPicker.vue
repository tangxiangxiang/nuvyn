<script setup lang="ts">
// AI session picker — modal Dialog (not a popover). Renders a
// centered overlay with a backdrop, focuses a known entry point on
// open, traps Tab inside, and restores focus to the trigger on
// close. Replaces the older top-anchored popover so the user gets a
// spacious, scrollable list regardless of AI-panel width.
//
// Mounted by the parent (AiPanel) via v-if, so presence == open.
// Closes on: backdrop click, × button, Esc (unless renaming).
// Delete uses the shared useConfirm composable so the confirmation
// matches the rest of the app's destructive prompts instead of the
// jarring jump to a native window.confirm.
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useAiHistory } from '../../composables/vault/useAiHistory'
import { useConfirm } from '../../composables/useConfirm'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { useI18n } from '../../composables/useI18n'

const emit = defineEmits<{ close: [] }>()

const history = useAiHistory()
const { confirm } = useConfirm()
const trap = useFocusTrap()
const { t } = useI18n()

const dialogRef = ref<HTMLElement | null>(null)
const editingId = ref<number | null>(null)
const editingTitle = ref('')

function startEdit(id: number, currentTitle: string) {
  editingId.value = id
  editingTitle.value = currentTitle
}

function commitEdit() {
  if (editingId.value === null) return
  const id = editingId.value
  const trimmed = editingTitle.value.trim()
  editingId.value = null
  editingTitle.value = ''
  if (trimmed.length === 0) return // empty after trim → no-op
  history.renameSession(id, trimmed)
}

function cancelEdit() {
  editingId.value = null
  editingTitle.value = ''
}

function onEditingKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') commitEdit()
  else if (event.key === 'Escape') cancelEdit()
}

async function onDelete(id: number, title: string) {
  const label = title.trim() || t('ai.new_session')
  const ok = await confirm(
    t('ai.delete_session_title', { title: label }),
    t('ai.delete_session_detail'),
  )
  if (!ok) return
  await history.deleteSession(id)
}

async function onSwitch(id: number) {
  await history.switchSession(id)
  emit('close')
}

async function onNewSession() {
  await history.createSession()
  await history.refreshSessions()
  emit('close')
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Tab' && dialogRef.value) {
    trap.onTab(() => dialogRef.value, e)
    return
  }
  if (e.key === 'Escape') {
    if (editingId.value !== null) {
      cancelEdit()
    } else {
      emit('close')
    }
  }
}

onMounted(async () => {
  await history.refreshSessions()
  // Capture focus BEFORE the dialog paints so deactivate() can
  // restore it to the history button in the AI header.
  trap.activate()
  document.addEventListener('keydown', onKeyDown)
  await nextTick()
  // Default focus: the dialog itself (tabindex=-1 on the box). This
  // keeps the user inside the trap without biasing them toward
  // either the destructive delete or the new-session button.
  dialogRef.value?.focus()
})

onBeforeUnmount(async () => {
  document.removeEventListener('keydown', onKeyDown)
  await trap.deactivate()
})
</script>

<template>
  <Teleport to="body">
    <div
      class="ai-sp-backdrop"
      @click.self="emit('close')"
    >
      <div
        ref="dialogRef"
        class="ai-sp-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('ai.sessions')"
        tabindex="-1"
      >
        <header class="ai-sp-header">
          <span class="ai-sp-title">{{ t('ai.sessions') }}</span>
          <NButton
            class="ai-sp-close"
            attr-type="button"
            text
            :bordered="false"
            :title="t('ai.close')"
            :aria-label="t('ai.close')"
            @click="emit('close')"
          >×</NButton>
        </header>

        <ul class="ai-sp-list" role="listbox" :aria-label="t('ai.session_list')">
          <li
            v-for="s in history.sessions.value"
            :key="s.id"
            class="ai-sp-row"
            :class="{ active: history.activeSession.value?.id === s.id }"
            role="option"
            :aria-selected="history.activeSession.value?.id === s.id"
            @click="onSwitch(s.id)"
          >
            <span class="ai-sp-dot" aria-hidden="true" />
            <template v-if="editingId === s.id">
              <NInput
                v-model:value="editingTitle"
                class="ai-sp-input-control"
                type="text"
                size="small"
                :bordered="false"
                :input-props="{ class: 'ai-sp-input' }"
                autofocus
                @keydown="onEditingKeydown"
                @blur="commitEdit"
                @click.stop
              />
            </template>
            <template v-else>
              <span class="ai-sp-name">{{ s.title || t('ai.new_session') }}</span>
              <span class="ai-sp-actions" @click.stop>
                <NButton
                  class="ai-sp-action"
                  attr-type="button"
                  text
                  :bordered="false"
                  :title="t('ai.rename')"
                  :aria-label="t('ai.rename')"
                  @click.stop="startEdit(s.id, s.title)"
                >✎</NButton>
                <NButton
                  class="ai-sp-action danger"
                  attr-type="button"
                  text
                  :bordered="false"
                  :title="t('ai.delete')"
                  :aria-label="t('ai.delete')"
                  @click.stop="onDelete(s.id, s.title)"
                >×</NButton>
              </span>
            </template>
          </li>
          <li v-if="history.sessions.value.length === 0" class="ai-sp-empty">
            {{ t('ai.no_sessions') }}
          </li>
        </ul>

        <footer class="ai-sp-footer">
          <NButton
            class="ai-sp-new"
            attr-type="button"
            :bordered="false"
            @click="onNewSession"
          >+ {{ t('ai.new_session') }}</NButton>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Backdrop + dialog follow the same visual language as
   .confirm-backdrop / .confirm-dialog (style.css ~line 2031) so the
   picker feels like a native part of the app, not a third-party
   modal. Dialog is sized for ~10 rows; the list scrolls past that.
   IMPORTANT: this component is teleported to <body>, so it escapes
   the .vault scope. The vault's --vs-* variables (--vs-bg-1 etc.)
   are defined on .vault and DON'T cascade here — using them would
   resolve to the empty initial value and the dialog would render
   transparent. Use the global --bg / --text / --border / --accent
   tokens instead, the same ones ConfirmHost uses.
   z-index is intentionally BELOW confirm-host / prompt-host: the
   picker can fire confirm() / prompt() and those dialogs must sit
   on top of it, otherwise the confirmation is hidden behind the
   picker's backdrop. With same z-index, the later-rendered element
   (picker, mounted on demand) would cover the earlier-rendered
   confirm. */
.ai-sp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9996;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: ai-sp-fade-in 0.14s ease;
}
.ai-sp-dialog {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  width: min(420px, calc(100vw - 32px));
  max-height: min(80vh, 600px);
  display: flex;
  flex-direction: column;
  outline: none;
  animation: ai-sp-pop-in 0.14s ease;
}
.ai-sp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--border);
}
.ai-sp-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
}
.ai-sp-close {
  background: transparent;
  border: 0;
  color: var(--text-muted);
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ai-sp-close:hover { background: var(--bg-soft); color: var(--text); }

.ai-sp-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.ai-sp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  font-size: 0.88rem;
  color: var(--text);
  cursor: pointer;
}
.ai-sp-row:hover { background: var(--bg-soft); }
.ai-sp-row.active { background: var(--accent-bg); }
.ai-sp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  flex-shrink: 0;
}
.ai-sp-row.active .ai-sp-dot { background: var(--accent); }
.ai-sp-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-sp-actions {
  display: none;
  gap: 4px;
  flex-shrink: 0;
}
.ai-sp-row:hover .ai-sp-actions,
.ai-sp-row.active .ai-sp-actions { display: inline-flex; }
.ai-sp-action {
  background: transparent;
  border: 0;
  color: var(--text-muted);
  width: 22px;
  height: 22px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ai-sp-action:hover { background: var(--bg-soft); color: var(--text); }
.ai-sp-action.danger:hover { color: #e06060; }
.ai-sp-input-control :deep(.ai-sp-input) {
  flex: 1;
  min-width: 0;
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 3px;
  color: var(--text);
  font: inherit;
  font-size: 0.88rem;
  padding: 2px 6px;
  outline: none;
}
.ai-sp-input-control {
  flex: 1;
  min-width: 0;
}
.ai-sp-empty {
  padding: 18px 14px;
  font-size: 0.88rem;
  color: var(--text-muted);
  font-style: italic;
  text-align: left;
}

.ai-sp-footer {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
}
.ai-sp-new {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  padding: 5px 12px;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
}
.ai-sp-new:hover { background: var(--bg-soft); border-color: var(--text-muted); }

@keyframes ai-sp-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes ai-sp-pop-in {
  from { transform: scale(0.96); opacity: 0; }
  to   { transform: scale(1); opacity: 1; }
}
</style>
