<script setup lang="ts">
import { NInput, NSelect, NCheckbox } from 'naive-ui'
import type { EventFields } from '../../../shared/diaryLife'
import { EVENT_EMOJI } from '../../features/diary/eventEmoji'
const value = defineModel<EventFields>({ required: true })
const types = [{ label: '人生时刻', value: 'milestone' }, { label: '纪念日', value: 'anniversary' }, { label: '重要日程', value: 'schedule' }]
</script>
<template>
  <div class="event-fields">
    <div class="event-emojis"><button v-for="icon in EVENT_EMOJI" :key="icon.asset" type="button" :aria-label="icon.name" :aria-pressed="value.emoji === icon.glyph" @click="value.emoji = icon.glyph"><img :src="`/emoji/event-${icon.asset}.svg`" alt=""></button></div>
    <div class="event-title"><NInput v-model:value="value.emoji" :input-props="{ 'aria-label': '事件 Emoji' }" placeholder="Emoji" :maxlength="100" /><NInput v-model:value="value.title" :input-props="{ 'aria-label': '事件标题' }" placeholder="值得记住的事" :maxlength="160" /></div>
    <NSelect v-model:value="value.type" :options="types" aria-label="事件类型" />
    <div class="event-dates"><label>开始日期<input v-model="value.startDate" type="date" required aria-label="开始日期"></label><label>结束日期<input v-model="value.endDate" type="date" required aria-label="结束日期"></label></div>
    <NCheckbox v-model:checked="value.allDay">全天</NCheckbox>
    <div v-if="!value.allDay" class="event-dates"><label>开始时间<input :value="value.startTime ?? ''" type="time" @input="value.startTime = ($event.target as HTMLInputElement).value || null"></label><label>结束时间<input :value="value.endTime ?? ''" type="time" @input="value.endTime = ($event.target as HTMLInputElement).value || null"></label></div>
    <NInput v-model:value="value.description" type="textarea" :input-props="{ 'aria-label': '事件描述' }" placeholder="记下这一刻（可选）" :maxlength="4000" :rows="3" />
    <NCheckbox :checked="value.recurrence === 'yearly'" @update:checked="value.recurrence = $event ? 'yearly' : 'none'">每年重复</NCheckbox>
    <NCheckbox v-model:checked="value.showCountdown">显示倒数日</NCheckbox>
    <NCheckbox v-model:checked="value.isPrimary">优先显示此事件</NCheckbox>
  </div>
</template>
<style scoped>
.event-fields { display: flex; flex-direction: column; gap: 16px; }
.event-emojis { display: flex; flex-wrap: wrap; gap: 4px; }
.event-emojis button { border: 1px solid transparent; border-radius: 6px; width: 40px; height: 40px; display: grid; place-items: center; background: transparent; cursor: pointer; }
.event-emojis button[aria-pressed="true"] { border-color: var(--accent, #6366f1); }
.event-emojis img { width: 28px; height: 28px; }
.event-title { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; }
.event-dates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 36px; padding: 6px; background: transparent; color: inherit; border: 1px solid var(--border, #8886); border-radius: 6px; font: inherit; }
</style>
