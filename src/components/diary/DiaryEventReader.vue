<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { Pencil, X } from '@vicons/tabler'
import { addDays, dayDistance, displayEventTitle, eventOccurrenceStart, type DiaryEvent } from '../../../shared/diaryLife'
import { formatLunarRule } from '../../../shared/lunarCalendar'
import { eventEmojiSource } from '../../features/diary/eventEmoji'

const props = defineProps<{
  event: DiaryEvent
  occurrenceDate: string
  busy?: boolean
  focusTarget?: 'container' | 'edit' | null
}>()

const emit = defineEmits<{
  edit: [keyboardActivated: boolean]
  close: []
}>()

const reader = ref<HTMLElement | null>(null)

function focus(target: 'container' | 'edit') {
  const element = target === 'edit'
    ? reader.value?.querySelector<HTMLButtonElement>('[data-testid="diary-event-reader-edit"]')
    : reader.value
  element?.focus({ preventScroll: true })
}

function focusRequestedTarget() {
  if (props.focusTarget) focus(props.focusTarget)
}

watch(() => props.focusTarget, () => { void nextTick(focusRequestedTarget) }, { flush: 'post' })
onMounted(focusRequestedTarget)

function occurrenceStart(event: DiaryEvent, date: string): string {
  return eventOccurrenceStart(event, date) ?? date
}

function formatDate(date: string, includeYear = true): string {
  const [year, month, day] = date.split('-').map(Number)
  return `${includeYear ? `${year}年` : ''}${month}月${day}日`
}

const startDate = computed(() => occurrenceStart(props.event, props.occurrenceDate))
const endDate = computed(() => addDays(startDate.value, dayDistance(props.event.startDate, props.event.endDate)))
const title = computed(() => displayEventTitle(props.event, startDate.value))
const emojiSource = computed(() => eventEmojiSource(props.event.emoji))
const dateLabel = computed(() => {
  const event = props.event
  if (event.type === 'birthday') {
    const lunarDate = event.dateRule?.calendar === 'chinese' ? formatLunarRule(event.dateRule) : ''
    return [lunarDate, formatDate(startDate.value)].filter(Boolean).join(' · ')
  }
  if (event.type === 'anniversary') {
    if (event.dateRule?.calendar === 'chinese') return formatLunarRule(event.dateRule)
    return formatDate(startDate.value, event.recurrence !== 'yearly')
  }
  if (event.type === 'schedule') {
    const date = startDate.value === endDate.value
      ? formatDate(startDate.value)
      : `${formatDate(startDate.value)} – ${formatDate(endDate.value)}`
    if (event.allDay) return `${date} · 全天`
    const times = event.startTime && event.endTime
      ? `${event.startTime}–${event.endTime}`
      : event.startTime
        ? `${event.startTime}开始`
        : ''
    return times ? `${date} · ${times}` : date
  }
  return formatDate(startDate.value)
})

const accessibleName = computed(() => title.value)
</script>

<template>
  <article ref="reader" class="diary-event-reader" :aria-label="accessibleName" tabindex="-1" data-testid="diary-event-reader">
    <header class="diary-event-reader-header">
      <div class="diary-event-reader-heading">
        <span class="diary-event-reader-emoji" aria-hidden="true">
          <img v-if="emojiSource" :src="emojiSource" alt="">
          <span v-else>{{ event.emoji }}</span>
        </span>
        <h1>{{ title }}</h1>
      </div>
      <div class="diary-event-reader-actions">
        <NButton
          quaternary
          class="diary-event-reader-edit"
          :disabled="busy"
          aria-label="编辑事件"
          data-testid="diary-event-reader-edit"
          @click="emit('edit', $event.detail === 0)"
        >
          <NIcon aria-hidden="true" :size="18"><Pencil /></NIcon>
          <span>编辑</span>
        </NButton>
        <NButton quaternary :disabled="busy" aria-label="关闭事件" @click="emit('close')">
          <NIcon aria-hidden="true" :size="18"><X /></NIcon>
        </NButton>
      </div>
    </header>

    <div class="diary-event-reader-content">
      <p v-if="event.type === 'schedule' || event.type === 'birthday' || event.type === 'anniversary'" class="diary-event-reader-date">
        {{ dateLabel }}
      </p>
      <p v-if="event.description.trim()" class="diary-event-reader-description">{{ event.description }}</p>
    </div>
  </article>
</template>

<style scoped>
.diary-event-reader { display: flex; min-width: 0; flex-direction: column; gap: 20px; color: var(--text); }
.diary-event-reader-header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; }
.diary-event-reader-heading { display: flex; min-width: 0; align-items: center; gap: 12px; }
.diary-event-reader-emoji { display: grid; width: 44px; height: 44px; flex: none; place-items: center; border-radius: 12px; background: color-mix(in srgb, var(--accent, #6366f1) 8%, transparent); font-size: 25px; }
.diary-event-reader-emoji img { width: 28px; height: 28px; object-fit: contain; }
.diary-event-reader-heading h1 { min-width: 0; margin: 0; font-size: 20px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
.diary-event-reader-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.diary-event-reader-actions :deep(.n-button) { min-width: 40px; height: 40px; color: var(--text-muted, #6b7280); }
.diary-event-reader-content { display: flex; min-width: 0; flex-direction: column; gap: 14px; }
.diary-event-reader-date { margin: 0; color: var(--text-muted, #6b7280); font-size: 14px; line-height: 1.5; }
.diary-event-reader-description { margin: 0; color: var(--text); font-size: 15px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (hover: hover) and (pointer: fine) and (not (any-pointer: coarse)) {
  .diary-event-reader-edit { opacity: 0; transition: opacity .14s ease; }
  .diary-event-reader-header:hover .diary-event-reader-edit,
  .diary-event-reader-header:focus-within .diary-event-reader-edit { opacity: 1; }
}
@media (max-width: 420px) {
  .diary-event-reader { gap: 16px; }
  .diary-event-reader-heading { gap: 9px; }
  .diary-event-reader-heading h1 { font-size: 18px; }
  .diary-event-reader-emoji { width: 38px; height: 38px; }
}
@media (prefers-reduced-motion: reduce) {
  .diary-event-reader-edit { transition: none; }
}
</style>
