<script setup lang="ts">
import { NInput, NSelect, NCheckbox } from 'naive-ui'
import type { EventFields } from '../../../shared/diaryLife'
import { EVENT_EMOJI } from '../../features/diary/eventEmoji'

const value = defineModel<EventFields>({ required: true })
const types = [
  { label: '人生时刻', value: 'milestone' },
  { label: '纪念日', value: 'anniversary' },
  { label: '重要日程', value: 'schedule' },
]
</script>

<template>
  <div class="event-fields">
    <section class="event-form-section" aria-labelledby="event-basic-heading">
      <h2 id="event-basic-heading">基础信息</h2>
      <div class="event-emojis" role="group" aria-label="选择事件 Emoji">
        <button
          v-for="icon in EVENT_EMOJI"
          :key="icon.asset"
          type="button"
          :aria-label="icon.name"
          :aria-pressed="value.emoji === icon.glyph"
          @click="value.emoji = icon.glyph"
        ><img :src="`/emoji/event-${icon.asset}.svg`" alt=""></button>
      </div>
      <label class="event-field">
        <span>事件标题</span>
        <NInput v-model:value="value.title" :input-props="{ 'aria-label': '事件标题' }" placeholder="值得记住的事" :maxlength="160" />
      </label>
      <NSelect v-model:value="value.type" :options="types" aria-label="事件类型" />
      <div class="event-dates">
        <label class="event-field"><span>开始日期</span><input v-model="value.startDate" type="date" required aria-label="开始日期"></label>
        <label class="event-field"><span>结束日期</span><input v-model="value.endDate" type="date" required aria-label="结束日期"></label>
      </div>
      <NCheckbox v-model:checked="value.allDay">全天</NCheckbox>
      <div v-if="!value.allDay" class="event-dates">
        <label class="event-field"><span>开始时间</span><input :value="value.startTime ?? ''" type="time" aria-label="开始时间" @input="value.startTime = ($event.target as HTMLInputElement).value || null"></label>
        <label class="event-field"><span>结束时间</span><input :value="value.endTime ?? ''" type="time" aria-label="结束时间" @input="value.endTime = ($event.target as HTMLInputElement).value || null"></label>
      </div>
    </section>

    <section class="event-form-section" aria-labelledby="event-display-heading">
      <h2 id="event-display-heading">重复与展示</h2>
      <div class="event-checkboxes">
        <NCheckbox :checked="value.recurrence === 'yearly'" @update:checked="value.recurrence = $event ? 'yearly' : 'none'">每年重复</NCheckbox>
        <NCheckbox v-model:checked="value.showCountdown">显示倒数日</NCheckbox>
        <NCheckbox v-model:checked="value.isPrimary">优先显示此事件</NCheckbox>
      </div>
    </section>

    <section class="event-form-section" aria-labelledby="event-other-heading">
      <h2 id="event-other-heading">其他</h2>
      <label class="event-field">
        <span>说明 <small>可选</small></span>
        <NInput v-model:value="value.description" type="textarea" :input-props="{ 'aria-label': '事件描述' }" placeholder="记下这一刻" :maxlength="4000" :rows="3" />
      </label>
    </section>
  </div>
</template>

<style scoped>
.event-fields { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
.event-form-section { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.event-form-section h2 { margin: 0; color: var(--text-muted, #6b7280); font-size: 14px; font-weight: 600; }
.event-emojis { display: flex; flex-wrap: wrap; gap: 4px; }
.event-emojis button { border: 1px solid transparent; border-radius: 8px; width: 40px; height: 40px; display: grid; place-items: center; background: transparent; cursor: pointer; }
.event-emojis button:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.event-emojis button:focus-visible { outline: 2px solid var(--accent, #6366f1); outline-offset: 1px; }
.event-emojis button[aria-pressed="true"] { border-color: var(--accent, #6366f1); background: color-mix(in srgb, var(--accent, #6366f1) 8%, transparent); }
.event-emojis img { width: 28px; height: 28px; object-fit: contain; }
.event-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.event-field > span { color: var(--text-muted, #6b7280); font-size: 13px; }
.event-field small { margin-inline-start: 4px; font-size: inherit; }
.event-dates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.event-field input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 36px; padding: 6px 8px; background: transparent; color: inherit; border: 1px solid var(--border, #8886); border-radius: 6px; font: inherit; }
.event-checkboxes { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
@media (max-width: 390px) { .event-dates { gap: 8px; } }
</style>
