<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { X } from '@vicons/tabler'
import { getMoodDefinition, isMoodId, type DiaryMoodId } from '../../../shared/diaryMood'
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
}>()

const { locale, t } = useI18n()
const preferences = useDiaryMoodIconPreferences()
const focusedIndex = ref(0)
const radioRefs = ref<Array<HTMLButtonElement | null>>([])
let suppressNextClick = false

// Keep the picker in the same four-column geometry as the original mood
// catalog while allowing managed custom icons to extend it below the defaults.
const MOOD_GRID_COLUMNS = 4
const moodOptions = computed(() => preferences.availableIcons.value.flatMap((id, index) => {
  const presentation = preferences.presentationFor(id, locale.value)
  if (!presentation) return []
  const definition = isMoodId(id) ? getMoodDefinition(id) : undefined
  return [{
    ...presentation,
    row: definition?.row ?? Math.floor(index / MOOD_GRID_COLUMNS) + 1,
    column: definition?.column ?? index % MOOD_GRID_COLUMNS + 1,
  }]
}))

const selectedIndex = computed(() => (
  moodOptions.value.findIndex((mood) => mood.id === props.currentMood)
))
const unknownMood = computed(() => (
  typeof props.currentMood === 'string' && selectedIndex.value < 0
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

watch(() => props.currentMood, () => {
  focusedIndex.value = selectedIndex.value >= 0 ? selectedIndex.value : 0
})

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
  overflow: auto;
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
.diary-mood-option:focus-visible {
  outline: 2px solid var(--vs-accent, #4f6fff);
  outline-offset: 2px;
}

.diary-mood-picker-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
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
