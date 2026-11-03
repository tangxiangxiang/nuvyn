<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { X } from '@vicons/tabler'
import { MOOD_CATALOG, type DiaryMoodId } from '../../../shared/diaryMood'
import { useI18n } from '../../composables/useI18n'
import { useDiaryMoodIconPreferences } from '../../composables/diary/useDiaryMoodIconPreferences'

const props = withDefaults(defineProps<{
  currentMood?: string | null
  busy?: boolean
}>(), {
  currentMood: null,
  busy: false,
})

const emit = defineEmits<{
  select: [mood: DiaryMoodId]
  clear: []
  close: []
  layoutChange: []
}>()

const { locale, t } = useI18n()
const preferences = useDiaryMoodIconPreferences()
const focusedIndex = ref(0)
const radioRefs = ref<Array<HTMLButtonElement | null>>([])
const moodCollection = ref<'common' | 'all'>('common')
// A small, stable starter selection. This is not inferred from private Diary
// contents or stored as additional mood data.
const COMMON_MOOD_IDS = new Set<string>(MOOD_CATALOG.slice(0, 24).map(({ id }) => id))
let suppressNextClick = false

// Keep the picker in the same four-column geometry as the original mood
// catalog while allowing managed custom icons to extend it below the defaults.
const MOOD_GRID_COLUMNS = 4
const moodOptions = computed(() => preferences.availableIcons.value
  .filter((id) => moodCollection.value === 'all' || COMMON_MOOD_IDS.has(id))
  .flatMap((id, index) => {
    const presentation = preferences.presentationFor(id, locale.value)
    if (!presentation) return []
    return [{
      ...presentation,
      row: Math.floor(index / MOOD_GRID_COLUMNS) + 1,
      column: (index % MOOD_GRID_COLUMNS) + 1,
    }]
  }))

const selectedIndex = computed(() => (
  moodOptions.value.findIndex((mood) => mood.id === props.currentMood)
))
const unknownMood = computed(() => (
  typeof props.currentMood === 'string' && !preferences.isAvailable(props.currentMood)
))

function setRadioRef(index: number, element: unknown): void {
  const node = element as HTMLButtonElement | null
  radioRefs.value[index] = node && node.tagName === 'BUTTON' ? node : null
}

function clampIndex(index: number): number {
  return Math.max(0, Math.min(moodOptions.value.length - 1, index))
}

function focusRadio(index: number): void {
  const nextIndex = clampIndex(index)
  focusedIndex.value = nextIndex
  void nextTick(() => radioRefs.value[nextIndex]?.focus())
}

function focusGridCell(index: number, rowDelta: number, columnDelta: number): void {
  const row = Math.floor(index / MOOD_GRID_COLUMNS)
  const column = index % MOOD_GRID_COLUMNS
  const moodGridRows = Math.max(1, Math.ceil(moodOptions.value.length / MOOD_GRID_COLUMNS))
  const nextRow = Math.max(0, Math.min(moodGridRows - 1, row + rowDelta))
  const nextColumn = Math.max(0, Math.min(MOOD_GRID_COLUMNS - 1, column + columnDelta))

  focusRadio(nextRow * MOOD_GRID_COLUMNS + nextColumn)
}

function focusInitial(): void {
  focusRadio(selectedIndex.value >= 0 ? selectedIndex.value : 0)
}

function isSelected(id: DiaryMoodId): boolean {
  return props.currentMood === id
}

function setMoodCollection(next: 'common' | 'all'): void {
  if (moodCollection.value === next) return
  moodCollection.value = next
  focusedIndex.value = selectedIndex.value >= 0 ? selectedIndex.value : 0
  // The popup changes height between Common and All.
  emit('layoutChange')
}

function selectMood(id: DiaryMoodId): void {
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  if (props.busy) return
  emit('select', id)
}

function clearMood(): void {
  if (props.busy || props.currentMood === null) return
  emit('clear')
}

function onRadioKeydown(index: number, event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }

  const movement = event.key === 'ArrowRight'
    ? { rowDelta: 0, columnDelta: 1 }
    : event.key === 'ArrowLeft'
      ? { rowDelta: 0, columnDelta: -1 }
      : event.key === 'ArrowDown'
        ? { rowDelta: 1, columnDelta: 0 }
        : event.key === 'ArrowUp'
          ? { rowDelta: -1, columnDelta: 0 }
          : null
  if (movement) {
    event.preventDefault()
    focusGridCell(index, movement.rowDelta, movement.columnDelta)
    return
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    // Native buttons also synthesize a click for Enter/Space. Suppress that
    // follow-up click so keyboard activation emits exactly one selection.
    suppressNextClick = true
    void nextTick(() => { suppressNextClick = false })
    const mood = moodOptions.value[index]
    if (mood && !props.busy) emit('select', mood.id)
  }
}

function onPickerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  emit('close')
}

watch(() => props.currentMood, (mood) => {
  // When editing a previously selected expanded/custom mood, reveal it in All
  // before focusing the picker. Never mislabel a filtered mood as unknown.
  if (mood && preferences.isAvailable(mood) && !COMMON_MOOD_IDS.has(mood)) {
    moodCollection.value = 'all'
  }
  focusedIndex.value = selectedIndex.value >= 0 ? selectedIndex.value : 0
}, { immediate: true })

onMounted(() => {
  focusInitial()
})

defineExpose({ focusInitial })
</script>

<template>
  <section
    id="diary-mood-picker"
    class="diary-mood-picker"
    data-testid="diary-mood-picker"
    role="group"
    :aria-label="t('mood.picker_label')"
    @keydown="onPickerKeydown"
  >
    <header class="diary-mood-picker-header">
      <span class="diary-mood-picker-title">{{ t('mood.picker_label') }}</span>
      <NButton
        attr-type="button"
        size="small"
        quaternary
        :bordered="false"
        class="diary-mood-picker-close"
        data-testid="diary-mood-picker-close"
        :aria-label="t('mood.close')"
        @click="emit('close')"
        @keydown="onPickerKeydown"
      ><NIcon aria-hidden="true" :size="18"><X /></NIcon></NButton>
    </header>

    <div class="diary-mood-picker-collections" role="group" :aria-label="t('mood.groups_label')">
      <button
        type="button"
        class="diary-mood-picker-collection"
        data-testid="diary-mood-common"
        :class="{ 'is-active': moodCollection === 'common' }"
        :aria-pressed="moodCollection === 'common'"
        @click="setMoodCollection('common')"
      >{{ t('mood.common') }}</button>
      <button
        type="button"
        class="diary-mood-picker-collection"
        data-testid="diary-mood-all"
        :class="{ 'is-active': moodCollection === 'all' }"
        :aria-pressed="moodCollection === 'all'"
        @click="setMoodCollection('all')"
      >{{ t('mood.all') }}</button>
    </div>

    <p
      v-if="unknownMood"
      class="diary-mood-picker-unknown"
      data-testid="diary-mood-unknown"
      role="status"
    >
      {{ t('mood.unknown') }}
    </p>

    <div
      class="diary-mood-picker-grid"
      role="radiogroup"
      :aria-label="t('mood.options_label')"
    >
      <button
        v-for="(mood, index) in moodOptions"
        :key="mood.id"
        :ref="(element) => setRadioRef(index, element)"
        type="button"
        class="diary-mood-option"
        :class="{ 'is-selected': isSelected(mood.id) }"
        :data-mood-id="mood.id"
        :data-row="mood.row"
        :data-column="mood.column"
        role="radio"
        :aria-label="mood.accessibilityName"
        :aria-checked="isSelected(mood.id)"
        :aria-disabled="props.busy ? 'true' : undefined"
        :aria-posinset="index + 1"
        :aria-setsize="moodOptions.length"
        :tabindex="focusedIndex === index ? 0 : -1"
        @focus="focusedIndex = index"
        @click="selectMood(mood.id)"
        @keydown="onRadioKeydown(index, $event)"
      >
        <img v-if="mood.source" :src="mood.source" alt="" aria-hidden="true">
        <span class="diary-mood-option-label">{{ mood.label }}</span>
      </button>
    </div>

    <div class="diary-mood-picker-footer">
      <NButton
        attr-type="button"
        size="small"
        quaternary
        :bordered="false"
        class="diary-mood-clear"
        data-testid="diary-mood-clear"
        :disabled="props.busy || props.currentMood === null"
        @click="clearMood"
        @keydown="onPickerKeydown"
      >
        {{ t('mood.clear') }}
      </NButton>
      <span v-if="props.busy" class="diary-mood-saving" role="status" aria-live="polite">
        {{ t('mood.saving') }}
      </span>
    </div>
  </section>
</template>

<style scoped>
.diary-mood-picker {
  position: fixed;
  z-index: 1000;
  width: min(320px, calc(100vw - 24px));
  max-height: min(620px, calc(100vh - 52px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid var(--vs-border, var(--border, #d8dce5));
  border-radius: 10px;
  background: var(--vs-bg-1, var(--bg, #fff));
  color: var(--vs-text-1, var(--text-h, #1b2433));
  box-shadow: 0 8px 28px rgb(24 34 56 / 14%);
}

.diary-mood-picker-header,
.diary-mood-picker-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.diary-mood-picker-header {
  flex: 0 0 auto;
  margin-bottom: 10px;
}

.diary-mood-picker-title {
  font-size: 0.85rem;
  font-weight: 650;
}

.diary-mood-picker-close,
.diary-mood-clear {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--vs-text-2, var(--text-muted, #667085));
  cursor: pointer;
}

.diary-mood-picker-close {
  width: 28px;
  height: 28px;
  font-size: 1.2rem;
  line-height: 1;
}

.diary-mood-picker-close:hover,
.diary-mood-clear:hover:not(:disabled) {
  background: var(--vs-hover-bg, var(--bg-soft, rgb(80 90 110 / 8%)));
  color: var(--vs-text-1, var(--text-h, #1b2433));
}

.diary-mood-picker-close:focus-visible,
.diary-mood-clear:focus-visible,
.diary-mood-picker-collection:focus-visible,
.diary-mood-option:focus-visible {
  outline: 2px solid var(--vs-accent, #4f6fff);
  outline-offset: 2px;
}

/* Keep the choice compact and touch-accessible at 320px. */
.diary-mood-picker-collections {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  margin-bottom: 8px;
  padding: 3px;
  border-radius: 8px;
  background: var(--vs-bg-2, var(--bg-soft));
}
.diary-mood-picker-collection {
  min-height: 36px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--vs-text-2, var(--text-muted));
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;
}
.diary-mood-picker-collection.is-active {
  background: var(--vs-bg-1, var(--bg));
  color: var(--vs-text-1, var(--text-h));
  font-weight: 650;
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
}
.diary-mood-picker-grid {
  display: grid;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-content: start;
  gap: 6px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}

.diary-mood-option {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 58px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 5px 3px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: center;
}

.diary-mood-option:hover {
  background: var(--vs-hover-bg, var(--bg-soft, rgb(80 90 110 / 8%)));
}

.diary-mood-option.is-selected {
  border-color: var(--vs-accent, var(--accent, #4f6fff));
  background: color-mix(in srgb, var(--vs-accent, var(--accent, #4f6fff)) 10%, transparent);
}

.diary-mood-option.is-selected .diary-mood-option-label {
  font-weight: 700;
}

.diary-mood-option[aria-disabled='true'] {
  cursor: wait;
  opacity: 0.68;
}

.diary-mood-option img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.diary-mood-option-label {
  max-width: 100%;
  overflow-wrap: anywhere;
  font-size: 0.68rem;
  line-height: 1.1;
}

.diary-mood-picker-unknown {
  margin: 0 0 8px;
  color: var(--vs-text-2, var(--text-muted, #667085));
  font-size: 0.75rem;
}

.diary-mood-picker-footer {
  flex: 0 0 auto;
  margin-top: 10px;
}

.diary-mood-clear {
  padding: 5px 8px;
  font-size: 0.76rem;
}

.diary-mood-clear:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.diary-mood-saving {
  color: var(--vs-text-2, var(--text-muted, #667085));
  font-size: 0.72rem;
}

@media (max-width: 420px) {
  .diary-mood-picker {
    padding: 8px;
  }

  .diary-mood-picker-grid {
    gap: 4px;
  }

  .diary-mood-option {
    min-height: 52px;
    padding-inline: 2px;
  }

  .diary-mood-option img {
    width: 24px;
    height: 24px;
  }

  .diary-mood-option-label {
    font-size: 0.63rem;
  }
}
</style>
