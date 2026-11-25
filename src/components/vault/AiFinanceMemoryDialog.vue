<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NIcon, NModal } from 'naive-ui'
import { Check, Edit, Plus, Trash, X } from '@vicons/tabler'
import {
  addFinanceMemory,
  clearFinanceMemory,
  deleteFinanceMemory,
  getFinanceMemory,
  updateFinanceMemory,
  type FinanceMemoryItem,
  type FinanceMemoryUsage,
} from '../../lib/ai-api'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{ open: boolean; busy: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const items = ref<FinanceMemoryItem[]>([])
const usage = ref<FinanceMemoryUsage | null>(null)
const loading = ref(false)
const pending = ref(false)
const error = ref('')
const editingId = ref<number | null>(null)
const editContent = ref('')
const confirmClear = ref(false)
const conflict = ref<{ id: number; latest: FinanceMemoryItem | null; preservedDraft: boolean } | null>(null)
const adding = ref(false)
const newKind = ref<'user' | 'agent'>('user')
const newContent = ref('')
const locked = computed(() => props.busy || pending.value)
const userItems = computed(() => items.value.filter(item => item.kind === 'user'))
const agentItems = computed(() => items.value.filter(item => item.kind === 'agent'))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const state = await getFinanceMemory()
    items.value = state.items
    usage.value = state.usage
  } catch {
    error.value = t('ai.finance_memory_load_failed')
  } finally {
    loading.value = false
  }
}

watch(() => props.open, open => {
  if (open) {
    editingId.value = null
    adding.value = false
    newKind.value = 'user'
    newContent.value = ''
    confirmClear.value = false
    conflict.value = null
    items.value = []
    usage.value = null
    void load()
  }
}, { immediate: true })

watch(() => props.busy, (busy, wasBusy) => {
  if (props.open && wasBusy && !busy) void load()
})

function beginEdit(item: FinanceMemoryItem): void {
  if (locked.value) return
  adding.value = false
  editingId.value = item.id
  editContent.value = item.content
  conflict.value = null
  error.value = ''
}

function beginAdd(): void {
  if (locked.value) return
  editingId.value = null
  adding.value = true
  newKind.value = 'user'
  newContent.value = ''
  error.value = ''
}

function cancelAdd(): void {
  adding.value = false
  newContent.value = ''
}

async function saveAdd(): Promise<void> {
  if (locked.value || !adding.value || !newContent.value.trim() || [...newContent.value].length > 300) return
  pending.value = true
  error.value = ''
  try {
    const result = await addFinanceMemory(newKind.value, newContent.value)
    items.value = [...items.value, result.memory]
    usage.value = result.usage
    cancelAdd()
  } catch {
    error.value = t('ai.finance_memory_add_failed')
  } finally {
    pending.value = false
  }
}

function cancelEdit(): void {
  editingId.value = null
  editContent.value = ''
}

async function saveEdit(item: FinanceMemoryItem): Promise<void> {
  if (locked.value || editingId.value !== item.id) return
  pending.value = true
  error.value = ''
  try {
    const result = await updateFinanceMemory(item.id, editContent.value, item.revision)
    items.value = items.value.map(existing => existing.id === item.id ? result.memory : existing)
    usage.value = result.usage
    conflict.value = null
    cancelEdit()
  } catch (cause) {
    if (typeof cause === 'object' && cause && 'status' in cause && cause.status === 409) {
      await refreshConflict(item.id, true)
    } else error.value = t('ai.finance_memory_save_failed')
  } finally {
    pending.value = false
  }
}

async function remove(item: FinanceMemoryItem): Promise<void> {
  if (locked.value) return
  pending.value = true
  error.value = ''
  try {
    const result = await deleteFinanceMemory(item.id, item.revision)
    items.value = items.value.filter(existing => existing.id !== item.id)
    usage.value = result.usage
    conflict.value = null
    if (editingId.value === item.id) cancelEdit()
  } catch (cause) {
    if (typeof cause === 'object' && cause && 'status' in cause && cause.status === 409) {
      await refreshConflict(item.id, false)
    } else error.value = t('ai.finance_memory_delete_failed')
  } finally {
    pending.value = false
  }
}

async function refreshConflict(id: number, preservedDraft: boolean): Promise<void> {
  try {
    const state = await getFinanceMemory()
    items.value = state.items
    usage.value = state.usage
    conflict.value = { id, latest: state.items.find(item => item.id === id) ?? null, preservedDraft }
  } catch {
    error.value = t('ai.finance_memory_conflict_reload_failed')
  }
}

async function clearAll(): Promise<void> {
  if (locked.value || !confirmClear.value) return
  pending.value = true
  error.value = ''
  try {
    const result = await clearFinanceMemory()
    items.value = []
    usage.value = result.usage
    editingId.value = null
    editContent.value = ''
    confirmClear.value = false
  } catch {
    error.value = t('ai.finance_memory_clear_failed')
  } finally {
    pending.value = false
  }
}

function renderGroup(group: FinanceMemoryItem[], kind: 'user' | 'agent') {
  return { entries: group, title: t(kind === 'user' ? 'ai.finance_memory_user' : 'ai.finance_memory_agent') }
}

const groups = computed(() => [
  ...(userItems.value.length ? [renderGroup(userItems.value, 'user')] : []),
  ...(agentItems.value.length ? [renderGroup(agentItems.value, 'agent')] : []),
])
</script>

<template>
  <NModal :show="open" :mask-closable="true" :close-on-esc="true" @update:show="value => !value && emit('close')">
    <section class="ai-finance-memory-dialog" role="dialog" aria-modal="true" :aria-label="t('ai.finance_memory_title')" :aria-busy="loading || pending">
      <header class="ai-finance-memory-header">
        <h2>{{ t('ai.finance_memory_title') }}</h2>
        <button v-if="!adding" type="button" :aria-label="t('ai.finance_memory_add')" :title="t('ai.finance_memory_add')" :disabled="locked" @click="beginAdd">
          <NIcon :size="18" aria-hidden="true"><Plus /></NIcon>
        </button>
        <button type="button" :aria-label="t('ai.close')" @click="emit('close')">
          <NIcon :size="18" aria-hidden="true"><X /></NIcon>
        </button>
      </header>

      <div class="ai-finance-memory-body">
        <p v-if="error" class="ai-finance-memory-error" role="alert">{{ error }}</p>
        <p v-if="loading" class="ai-finance-memory-muted" role="status">{{ t('ai.loading') }}</p>
        <p v-else-if="!items.length && !error" class="ai-finance-memory-muted">{{ t('ai.finance_memory_empty') }}</p>
        <form v-if="adding" class="ai-finance-memory-add-form" @submit.prevent="saveAdd">
          <select v-model="newKind" :aria-label="t('ai.finance_memory_kind')" :disabled="locked">
            <option value="user">{{ t('ai.finance_memory_user') }}</option>
            <option value="agent">{{ t('ai.finance_memory_agent') }}</option>
          </select>
          <textarea v-model="newContent" :aria-label="t('ai.finance_memory_add')" :maxlength="600" rows="3" :disabled="locked" />
          <div class="ai-finance-memory-entry-actions is-visible">
            <small>{{ [...newContent].length }}/300</small>
            <button type="submit" :disabled="locked || !newContent.trim() || [...newContent].length > 300">
              <NIcon :size="16" aria-hidden="true"><Check /></NIcon>{{ t('ai.finance_memory_save') }}
            </button>
            <button type="button" :disabled="pending" @click="cancelAdd">{{ t('ai.finance_memory_cancel') }}</button>
          </div>
        </form>
        <section v-for="group in groups" :key="group.title" class="ai-finance-memory-group" :aria-label="group.title">
          <h3>{{ group.title }}</h3>
          <article v-for="item in group.entries" :key="item.id" class="ai-finance-memory-entry" :class="{ 'is-editing': editingId === item.id }">
            <p v-if="conflict?.id === item.id" class="ai-finance-memory-conflict" role="status">
              {{ t(conflict.preservedDraft ? 'ai.finance_memory_conflict' : 'ai.finance_memory_conflict_delete') }}
              <span v-if="conflict.latest">{{ t('ai.finance_memory_latest') }} {{ conflict.latest.content }}</span>
            </p>
            <template v-if="editingId === item.id">
              <textarea
                v-model="editContent"
                :aria-label="t('ai.finance_memory_edit')"
                :maxlength="600"
                rows="3"
                :disabled="locked"
              />
              <div class="ai-finance-memory-entry-actions">
                <small>{{ [...editContent].length }}/300</small>
                <button type="button" :disabled="locked || !editContent.trim() || [...editContent].length > 300" @click="saveEdit(item)">
                  <NIcon :size="16" aria-hidden="true"><Check /></NIcon>{{ t('ai.finance_memory_save') }}
                </button>
                <button type="button" :disabled="pending" @click="cancelEdit">{{ t('ai.finance_memory_cancel') }}</button>
              </div>
            </template>
            <template v-else>
              <p>{{ item.content }}</p>
              <div class="ai-finance-memory-entry-actions">
                <button type="button" :aria-label="`${t('ai.finance_memory_edit')}: ${item.content}`" :disabled="locked" @click="beginEdit(item)">
                  <NIcon :size="16" aria-hidden="true"><Edit /></NIcon>
                </button>
                <button type="button" :aria-label="`${t('ai.finance_memory_delete_entry')}: ${item.content}`" :disabled="locked" @click="remove(item)">
                  <NIcon :size="16" aria-hidden="true"><Trash /></NIcon>
                </button>
              </div>
            </template>
          </article>
        </section>
      </div>

      <footer class="ai-finance-memory-footer">
        <div v-if="usage" class="ai-finance-memory-usage">
          <span>{{ t('ai.finance_memory_user_usage', usage.user) }}</span>
          <span>{{ t('ai.finance_memory_agent_usage', usage.agent) }}</span>
          <span>{{ t('ai.finance_memory_total_usage', usage.total) }}</span>
        </div>
        <div v-if="confirmClear" class="ai-finance-memory-confirm" role="group" :aria-label="t('ai.finance_memory_clear_confirm')">
          <span>{{ t('ai.finance_memory_clear_confirm') }} {{ t('ai.finance_memory_clear_detail') }}</span>
          <button type="button" :disabled="locked" @click="confirmClear = false">{{ t('ai.finance_memory_cancel') }}</button>
          <button type="button" class="is-danger" :disabled="locked" @click="clearAll">{{ t('ai.finance_memory_clear_all') }}</button>
        </div>
        <button v-else type="button" class="ai-finance-memory-clear" :disabled="locked || !items.length" @click="confirmClear = true">
          {{ t('ai.finance_memory_clear_all') }}
        </button>
      </footer>
    </section>
  </NModal>
</template>

<style scoped>
.ai-finance-memory-dialog {
  width: min(560px, calc(100vw - 28px));
  max-height: min(78vh, 760px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--nuvyn-border);
  border-radius: 18px;
  background: var(--nuvyn-surface-1);
  color: var(--nuvyn-text-1);
  box-shadow: 0 24px 72px rgb(0 0 0 / 22%);
}
.ai-finance-memory-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; padding: 18px 20px 14px; border-bottom: 1px solid var(--nuvyn-border); }
.ai-finance-memory-header h2 { margin: 0; font-size: 1.1rem; font-weight: 650; }
.ai-finance-memory-header button, .ai-finance-memory-entry-actions button, .ai-finance-memory-clear, .ai-finance-memory-confirm button { border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.ai-finance-memory-header button { width: 34px; height: 34px; display: grid; place-items: center; color: var(--nuvyn-text-2); }
.ai-finance-memory-body { min-height: 0; flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; padding: 12px 20px; scrollbar-width: none; }
.ai-finance-memory-body::-webkit-scrollbar { display: none; }
.ai-finance-memory-group + .ai-finance-memory-group { margin-top: 20px; }
.ai-finance-memory-group h3 { margin: 0 0 8px; color: var(--nuvyn-text-2); font-size: .82rem; font-weight: 600; }
.ai-finance-memory-entry { display: flex; align-items: flex-start; gap: 10px; padding: 9px 8px; border-radius: 10px; }
.ai-finance-memory-entry:hover { background: color-mix(in srgb, var(--nuvyn-accent) 5%, var(--nuvyn-surface-1)); }
.ai-finance-memory-entry p { flex: 1; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.ai-finance-memory-entry textarea { width: 100%; resize: vertical; border: 1px solid var(--nuvyn-border); border-radius: 8px; padding: 9px 10px; background: var(--nuvyn-surface-2); color: var(--nuvyn-text-1); font: inherit; line-height: 1.5; }
.ai-finance-memory-add-form { display: grid; gap: 8px; margin-bottom: 12px; padding: 10px; border: 1px solid var(--nuvyn-border); border-radius: 10px; }
.ai-finance-memory-add-form select { width: fit-content; max-width: 100%; border: 1px solid var(--nuvyn-border); border-radius: 7px; padding: 6px 8px; background: var(--nuvyn-surface-2); color: var(--nuvyn-text-1); font: inherit; }
.ai-finance-memory-add-form textarea { width: 100%; resize: vertical; border: 1px solid var(--nuvyn-border); border-radius: 8px; padding: 9px 10px; background: var(--nuvyn-surface-2); color: var(--nuvyn-text-1); font: inherit; line-height: 1.5; }
.ai-finance-memory-entry-actions.is-visible { opacity: 1; }
.ai-finance-memory-entry-actions { display: flex; align-items: center; gap: 5px; opacity: 0; transition: opacity 120ms ease; }
.ai-finance-memory-entry:hover .ai-finance-memory-entry-actions, .ai-finance-memory-entry:focus-within .ai-finance-memory-entry-actions, .ai-finance-memory-entry.is-editing .ai-finance-memory-entry-actions { opacity: 1; }
.ai-finance-memory-entry-actions button { min-width: 30px; min-height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; color: var(--nuvyn-text-2); }
.ai-finance-memory-entry-actions button:hover:not(:disabled), .ai-finance-memory-header button:hover { background: color-mix(in srgb, var(--nuvyn-accent) 10%, var(--nuvyn-surface-1)); color: var(--nuvyn-text-1); }
button:disabled { opacity: .45; cursor: not-allowed; }
.ai-finance-memory-muted { margin: 10px 0; color: var(--nuvyn-text-2); }
.ai-finance-memory-error { margin: 0 0 10px; color: var(--nuvyn-negative); }
.ai-finance-memory-footer { display: flex; flex: 0 0 auto; flex-direction: column; gap: 10px; border-top: 1px solid var(--nuvyn-border); padding: 12px 20px 16px; }
.ai-finance-memory-usage { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--nuvyn-text-3); font-size: .72rem; }
.ai-finance-memory-clear { align-self: flex-end; padding: 6px 9px; color: var(--nuvyn-text-2); font-size: .82rem; }
.ai-finance-memory-confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; color: var(--nuvyn-text-2); font-size: .82rem; }
.ai-finance-memory-confirm span { flex: 1 1 100%; }
.ai-finance-memory-confirm button { padding: 7px 10px; background: color-mix(in srgb, var(--nuvyn-text-1) 7%, var(--nuvyn-surface-1)); }
.ai-finance-memory-confirm .is-danger { color: var(--nuvyn-negative); }
@media (max-width: 640px) {
  .ai-finance-memory-dialog { width: calc(100vw - 24px); max-height: min(82vh, 760px); border-radius: 16px; }
  .ai-finance-memory-header, .ai-finance-memory-body, .ai-finance-memory-footer { padding-left: 15px; padding-right: 15px; }
}
@media (hover: none) {
  .ai-finance-memory-entry-actions { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .ai-finance-memory-entry-actions { transition: none; }
}
</style>
