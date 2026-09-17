<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import type { DiaryMoodId } from '../../../shared/diaryMood'
import { useI18n } from '../../composables/useI18n'
import { useDiaryMoodIconPreferences } from '../../composables/diary/useDiaryMoodIconPreferences'
import DiaryMoodPicker from './DiaryMoodPicker.vue'

const props = withDefaults(defineProps<{
  currentMood?: string | null
  busy?: boolean
  disabled?: boolean
}>(), {
  currentMood: null,
  busy: false,
  disabled: false,
})

const emit = defineEmits<{
  select: [mood: DiaryMoodId]
  clear: []
}>()

const { locale, t } = useI18n()
const moodPreferences = useDiaryMoodIconPreferences()
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<{ $el: HTMLButtonElement } | null>(null)
const pickerRef = ref<InstanceType<typeof DiaryMoodPicker> | null>(null)
const pickerStyle = ref<Record<string, string>>({
  top: '12px',
  left: '12px',
})
const open = ref(false)
let positionFrame: number | null = null

const currentDefinition = computed(() => moodPreferences.presentationFor(props.currentMood, locale.value))
const currentLabel = computed(() => {
  if (currentDefinition.value) {
    return currentDefinition.value.label
  }
  return props.currentMood === null ? t('mood.not_set') : t('mood.unknown')
})
const triggerLabel = computed(() => t('mood.trigger', { mood: currentLabel.value }))

function pickerElement(): HTMLElement | null {
  const element = pickerRef.value?.$el
  return element instanceof HTMLElement ? element : null
}

function updatePickerPosition(): void {
  if (!open.value) return

  const trigger = triggerRef.value?.$el
  const picker = pickerElement()
  if (!trigger || !picker) return

  const triggerRect = trigger.getBoundingClientRect()
  const pickerRect = picker.getBoundingClientRect()
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight
  const inset = 12
  const gap = 8
  const pickerWidth = pickerRect.width || picker.offsetWidth
  const pickerHeight = pickerRect.height || picker.offsetHeight
  const maxLeft = Math.max(inset, viewportWidth - pickerWidth - inset)
  const maxTop = Math.max(inset, viewportHeight - pickerHeight - inset)

  const left = Math.min(
    Math.max(triggerRect.right - pickerWidth, inset),
    maxLeft,
  )
  const belowTop = triggerRect.bottom + gap
  const aboveTop = triggerRect.top - pickerHeight - gap
  const top = belowTop > maxTop && aboveTop >= inset
    ? aboveTop
    : Math.min(Math.max(belowTop, inset), maxTop)

  pickerStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  }
}

function schedulePickerPosition(): void {
  if (!open.value) return
  void nextTick(() => {
    if (!open.value) return
    if (positionFrame !== null) window.cancelAnimationFrame(positionFrame)
    if (typeof window.requestAnimationFrame === 'function') {
      positionFrame = window.requestAnimationFrame(() => {
        positionFrame = null
        updatePickerPosition()
      })
    } else {
      updatePickerPosition()
    }
  })
}

function closePicker(restoreFocus = true): void {
  if (!open.value) return
  open.value = false
  pickerStyle.value = { top: '12px', left: '12px' }
  if (restoreFocus) void nextTick(() => triggerRef.value?.$el.focus())
}

function openPicker(): void {
  if (props.disabled) return
  pickerStyle.value = { top: '12px', left: '12px' }
  open.value = true
  void nextTick(() => {
    pickerRef.value?.focusInitial()
    schedulePickerPosition()
  })
}

function togglePicker(): void {
  if (open.value) closePicker()
  else openPicker()
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  const picker = pickerElement()
  if (
    open.value
    && target instanceof Node
    && !rootRef.value?.contains(target)
    && !picker?.contains(target)
  ) closePicker(false)
}

function focusTrigger(): void {
  triggerRef.value?.$el.focus()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  window.addEventListener('resize', schedulePickerPosition)
  window.addEventListener('scroll', schedulePickerPosition, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('resize', schedulePickerPosition)
  window.removeEventListener('scroll', schedulePickerPosition, true)
  if (positionFrame !== null) window.cancelAnimationFrame(positionFrame)
})

defineExpose({ close: closePicker, focusTrigger })
</script>

<template>
  <div ref="rootRef" class="diary-mood-context" data-testid="diary-native-mood-context">
    <NButton
      ref="triggerRef"
      attr-type="button"
      size="small"
      quaternary
      :bordered="false"
      class="diary-mood-trigger"
      data-testid="diary-mood-trigger"
      :aria-label="triggerLabel"
      aria-haspopup="true"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-busy="props.busy ? 'true' : undefined"
      :disabled="props.disabled"
      @click="togglePicker"
    >
      <img
        v-if="currentDefinition"
        :src="currentDefinition.source"
        alt=""
        aria-hidden="true"
      >
      <span v-else class="diary-mood-trigger-empty" aria-hidden="true">○</span>
      <span class="diary-mood-trigger-label">{{ currentLabel }}</span>
    </NButton>

    <Teleport to="body">
      <DiaryMoodPicker
        v-if="open"
        ref="pickerRef"
        :style="pickerStyle"
        :current-mood="props.currentMood"
        :busy="props.busy"
        @select="emit('select', $event)"
        @clear="emit('clear')"
        @close="closePicker"
      />
    </Teleport>
  </div>
</template>

<style scoped>
.diary-mood-context {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}

.diary-mood-trigger {
  display: inline-flex;
  min-width: 0;
  height: 30px;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--vs-text-2, #667085);
  cursor: pointer;
  font: inherit;
  font-size: 0.76rem;
}

.diary-mood-trigger:hover:not(:disabled) {
  background: var(--vs-hover-bg, rgb(80 90 110 / 8%));
  color: var(--vs-text-1, #1b2433);
}

.diary-mood-trigger:focus-visible {
  outline: 2px solid var(--vs-accent, #4f6fff);
  outline-offset: 2px;
}

.diary-mood-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.diary-mood-trigger img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.diary-mood-trigger-empty {
  width: 20px;
  color: var(--vs-text-3, #98a2b3);
  font-size: 1.05rem;
  line-height: 1;
  text-align: center;
}

.diary-mood-trigger-label {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
