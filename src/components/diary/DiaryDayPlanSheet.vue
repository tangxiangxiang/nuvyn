<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NCheckbox, NModal } from 'naive-ui'
import { compareDiaryPlanItems, parseDiaryPlanFields, type DiaryPlanDaySummary, type DiaryPlanItem } from '../../../shared/diaryPlan'
import { parseDiaryDate, type DiaryDate } from '../../../shared/diaryProtocol'
import { useI18n } from '../../composables/useI18n'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent } from '../../composables/diary/useDiaryAccessSession'
import { diaryPlanApi, DiaryPlanRequestError, newDiaryPlanId } from '../../lib/diary-plan-api'
import { localCalendarDateForDiaryDate } from './diaryCalendarAdapter'

const props = defineProps<{ date: DiaryDate; chooseDate: boolean }>()
const emit = defineEmits<{ close: []; changed: [date: DiaryDate, summary?: DiaryPlanDaySummary]; 'date-change': [date: DiaryDate] }>()
const { t, locale } = useI18n()
const items = ref<DiaryPlanItem[]>([])
const loading = ref(false)
const busy = ref(false)
const loadError = ref(false)
const mutationError = ref('')
const editor = ref<{ id: string; original?: DiaryPlanItem } | null>(null)
const title = ref('')
const time = ref('')
const deleting = ref<string | null>(null)
const titleInput = ref<HTMLInputElement | null>(null)
const viewportHeight = ref<number>()
const dateLabel = computed(() => new Intl.DateTimeFormat(locale.value === 'zh' ? 'zh-CN' : 'en', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
}).format(localCalendarDateForDiaryDate(props.date)))
let active = true
let pending: AbortController | undefined
const generation = captureDiarySessionGeneration()
const sessionCurrent = () => active && isDiarySessionGenerationCurrent(generation)

function fitViewport() {
  viewportHeight.value = window.visualViewport?.height
}

onMounted(() => {
  fitViewport()
  window.visualViewport?.addEventListener('resize', fitViewport)
})

onBeforeUnmount(() => {
  active = false
  pending?.abort()
  window.visualViewport?.removeEventListener('resize', fitViewport)
})

async function load() {
  pending?.abort()
  const request = new AbortController()
  pending = request
  loading.value = true
  loadError.value = false
  try {
    const result = await diaryPlanApi.list(props.date, request.signal)
    if (sessionCurrent() && !request.signal.aborted) items.value = result
  } catch {
    if (!request.signal.aborted) loadError.value = true
  } finally {
    if (!request.signal.aborted) loading.value = false
  }
}

watch(() => props.date, () => {
  items.value = []
  editor.value = null
  deleting.value = null
  mutationError.value = ''
  busy.value = false
  void load()
}, { immediate: true })

async function edit(item?: DiaryPlanItem) {
  editor.value = { id: item?.id ?? newDiaryPlanId(), original: item }
  title.value = item?.title ?? ''
  time.value = item?.plannedTime ?? ''
  deleting.value = null
  mutationError.value = ''
  await nextTick()
  titleInput.value?.focus()
}

function closeEditor() {
  editor.value = null
  title.value = ''
  time.value = ''
  mutationError.value = ''
}

async function mutate(
  action: () => Promise<{ item: DiaryPlanItem } | void>,
  onSuccess?: () => void,
  removedId?: string,
) {
  if (busy.value || loading.value || !sessionCurrent()) return
  busy.value = true
  const date = props.date
  mutationError.value = ''
  try {
    const result = await action()
    if (!sessionCurrent() || props.date !== date) return
    const updated = result?.item
    items.value = items.value.filter((item) => item.id !== (updated?.id ?? removedId))
    if (updated) items.value = [...items.value, updated].sort(compareDiaryPlanItems)
    onSuccess?.()
  } catch (error) {
    if (!sessionCurrent() || props.date !== date) return
    if (error instanceof DiaryPlanRequestError && (error.status === 409 || error.status === 404)) {
      mutationError.value = 'diary.plan.conflict'
    } else {
      mutationError.value = 'diary.plan.save_failed'
    }
  } finally {
    if (sessionCurrent() && props.date === date) {
      // A lost response may follow a committed write. Reconcile the list
      // and marker while keeping the create ID available for a safe retry.
      if (mutationError.value) await load()
      if (sessionCurrent() && props.date === date) {
        emit('changed', date, loadError.value ? undefined : {
          date,
          total: items.value.length,
          completed: items.value.filter((item) => item.completedAt !== null).length,
        })
        busy.value = false
      }
    }
  }
}

function save() {
  const draft = editor.value
  if (!draft) return
  const fields = parseDiaryPlanFields({ title: title.value, plannedTime: time.value || null })
  if (!fields) {
    mutationError.value = 'diary.plan.invalid'
    return
  }
  void mutate(
    () => draft.original
      ? diaryPlanApi.update(draft.original, fields)
      : diaryPlanApi.create(draft.id, props.date, fields),
    closeEditor,
  )
}

function close() {
  if (!busy.value) emit('close')
}

function changeDate(event: Event) {
  const input = event.target as HTMLInputElement
  const date = parseDiaryDate(input.value)
  if (date && !busy.value && !editor.value) emit('date-change', date)
  else input.value = props.date
}
</script>

<template>
  <NModal
    :show="true"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    @update:show="!$event && close()"
  >
    <!-- Naive UI's focus trap uses the first DIV after its start sentinel. -->
    <div
      class="diary-day-plan-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="diary-day-plan-title"
      data-testid="diary-day-plan-sheet"
      :style="{ '--plan-viewport-height': viewportHeight ? `${viewportHeight}px` : undefined }"
    >
      <header class="diary-plan-header">
        <div>
          <h2 id="diary-day-plan-title">{{ t('diary.plan.heading') }}</h2>
          <div class="diary-plan-muted">{{ dateLabel }}</div>
        </div>
        <NButton text :disabled="busy" :aria-label="t('diary.plan.close')" @click="close">×</NButton>
      </header>
      <div class="diary-plan-content">
        <p v-if="loadError" role="alert">
          {{ t('diary.plan.load_failed') }}
          <NButton text type="primary" :disabled="loading" @click="load">{{ t('diary.plan.retry') }}</NButton>
        </p>
        <p v-else-if="loading && !items.length" role="status">{{ t('diary.plan.loading') }}</p>
        <p v-else-if="!items.length && !editor" class="diary-plan-muted">{{ t('diary.plan.empty') }}</p>
        <input
          v-if="chooseDate"
          class="diary-plan-field diary-plan-date"
          type="date"
          :aria-label="t('diary.plan.choose_date')"
          :value="date"
          :disabled="busy || !!editor"
          @change="changeDate"
        >
        <ul v-if="items.length" class="diary-plan-list">
          <li v-for="item in items" :key="item.id" class="diary-plan-row">
            <NCheckbox
              :checked="item.completedAt !== null"
              :disabled="busy || loading || !!editor || !!deleting"
              :aria-label="item.title"
              @update:checked="(completed) => mutate(() => diaryPlanApi.update(item, { completed }))"
            />
            <div class="diary-plan-item" :class="{ 'is-completed': item.completedAt !== null }">
              <time v-if="item.plannedTime">{{ item.plannedTime }}</time>
              {{ item.title }}
            </div>
            <div class="diary-plan-actions">
              <template v-if="deleting === item.id">
                <NButton size="tiny" :disabled="busy" @click="deleting = null">{{ t('common.cancel') }}</NButton>
                <NButton size="tiny" type="error" :disabled="busy || loading" @click="mutate(() => diaryPlanApi.remove(item), () => deleting = null, item.id)">
                  {{ t('diary.plan.confirm_delete') }}
                </NButton>
              </template>
              <template v-else>
                <NButton text size="small" :disabled="busy || loading || !!editor || !!deleting" @click="edit(item)">{{ t('diary.plan.edit') }}</NButton>
                <NButton text size="small" :disabled="busy || loading || !!editor || !!deleting" @click="deleting = item.id">{{ t('diary.plan.delete') }}</NButton>
              </template>
            </div>
          </li>
        </ul>
        <p v-if="mutationError" class="diary-plan-error" role="alert">{{ t(mutationError) }}</p>
        <form v-if="editor" class="diary-plan-form" @submit.prevent="save">
          <label for="diary-plan-name">{{ t('diary.plan.name') }}</label>
          <input
            id="diary-plan-name"
            ref="titleInput"
            v-model="title"
            class="diary-plan-field"
            type="text"
            required
            :disabled="busy"
          >
          <label for="diary-plan-time">{{ t('diary.plan.time') }}</label>
          <input id="diary-plan-time" v-model="time" class="diary-plan-field" type="time" :disabled="busy">
          <div class="diary-plan-actions">
            <NButton :disabled="busy" @click="closeEditor">{{ t('common.cancel') }}</NButton>
            <NButton type="primary" attr-type="submit" :loading="busy" :disabled="loading">{{ t('common.save') }}</NButton>
          </div>
        </form>
        <NButton v-else text type="primary" :disabled="busy || loading || loadError || !!deleting" @click="edit()">
          + {{ t('diary.plan.add') }}
        </NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.diary-day-plan-sheet {
  width: min(480px, calc(100vw - 32px));
  max-height: calc(var(--plan-viewport-height, 100dvh) - 32px);
  box-sizing: border-box;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--nuvyn-border);
  border-radius: 12px;
  background: var(--vs-bg-1, var(--bg));
  color: var(--vs-text-1, var(--text));
  box-shadow: 0 16px 52px #0003;
}

.diary-plan-header, .diary-plan-content { padding: 16px 20px; }
.diary-plan-header, .diary-plan-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.diary-plan-header { border-bottom: 1px solid var(--nuvyn-border); }
.diary-plan-header h2 { margin: 0 0 4px; font-size: 18px; }
.diary-plan-header > button { font-size: 24px; min-width: 28px; }
.diary-plan-muted, .diary-plan-item time, .diary-plan-item.is-completed {
  color: var(--vs-text-2, var(--text-muted));
}
.diary-plan-content > p { margin: 0 0 12px; }
.diary-plan-list { margin: 0 0 12px; padding: 0; list-style: none; }
.diary-plan-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 0;
  border-bottom: 1px solid var(--nuvyn-border);
}
.diary-plan-item { flex: 1 1 100px; min-width: 0; overflow-wrap: anywhere; }
.diary-plan-item.is-completed { text-decoration: line-through; }
.diary-plan-item time { margin-inline-end: 4px; font-variant-numeric: tabular-nums; }
.diary-plan-actions { justify-content: flex-end; margin-inline-start: auto; }
.diary-plan-form { display: grid; gap: 8px; }
.diary-plan-date { margin-bottom: 12px; }
.diary-plan-field {
  box-sizing: border-box;
  min-width: 0;
  min-height: 34px;
  max-width: 100%;
  padding: 0 10px;
  border: 1px solid var(--nuvyn-border);
  border-radius: var(--nuvyn-radius-md);
  background: var(--nuvyn-surface-1);
  color: inherit;
  caret-color: var(--nuvyn-text-1);
  font: inherit;
}
.diary-plan-field:focus {
  border-color: var(--nuvyn-accent);
  outline: 2px solid var(--nuvyn-accent);
  outline-offset: 1px;
}
.diary-plan-field:disabled { opacity: 0.65; }
:global(:root[data-theme='dark']) .diary-plan-field { color-scheme: dark; }
:global(:root[data-theme='light']) .diary-plan-field { color-scheme: light; }

@media (max-width: 600px) {
  .diary-day-plan-sheet {
    position: fixed;
    inset: auto 0 max(0px, calc(100dvh - var(--plan-viewport-height, 100dvh)));
    width: 100%;
    max-height: min(85dvh, calc(var(--plan-viewport-height, 100dvh) - 12px));
    margin: 0;
    border-radius: 12px 12px 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .diary-plan-field { font-size: 16px; }
}
</style>
