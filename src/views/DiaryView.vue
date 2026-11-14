<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { NButton, NIcon, NInput, NModal, NTooltip } from 'naive-ui'
import { CalendarEvent, MoodSmile } from '@vicons/tabler'
import { Temporal } from '@js-temporal/polyfill'
import { DiaryAccessContextKey } from '../composables/diary/diaryAccessContext'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent, subscribeDiaryTeardown, useDiaryAccessSession } from '../composables/diary/useDiaryAccessSession'
import { useDiaryMoodIconPreferences } from '../composables/diary/useDiaryMoodIconPreferences'
import { useAuth } from '../composables/useAuth'
import { useConfirm } from '../composables/useConfirm'
import { createDiaryEventId, diaryLifeApi } from '../lib/diary-life-api'
import { addDays, compareEvents, dayDistance, localToday, nextOccurrence, occursOn, parseEvent, type DiaryDay, type DiaryEvent, type DayFields, type EventFields } from '../../shared/diaryLife'
import { NUVYN_BROWSER_STORAGE_KEYS, ownerScopedStorageKey, readStorageKey, writeStorageKey } from '../technicalNamespace'
import DiaryLifeCalendar from '../components/diary/DiaryLifeCalendar.vue'
import DiaryMoodPicker from '../components/diary/DiaryMoodPicker.vue'
import DiaryEventForm from '../components/diary/DiaryEventForm.vue'
import { eventEmojiSource } from '../features/diary/eventEmoji'

const access = useDiaryAccessSession()
const accessContext = inject(DiaryAccessContextKey, null)
const preferences = useDiaryMoodIconPreferences()
const auth = useAuth()
const { confirmCancellable } = useConfirm()
let cancelConfirmation: (() => void) | undefined
async function confirm(message: string) {
  if (cancelConfirmation) return false
  const pending = confirmCancellable(message)
  cancelConfirmation = pending.cancel
  try {
    return await pending.promise
  } finally {
    if (cancelConfirmation === pending.cancel) cancelConfirmation = undefined
  }
}
const mode = ref<'diary' | 'events'>('diary')
const month = ref(`${localToday().slice(0, 7)}-01`)
const days = ref<Pick<DiaryDay, 'date' | 'moodId' | 'version'>[]>([])
const events = ref<DiaryEvent[]>([])
const upcoming = ref<DiaryEvent[]>([])
const selected = ref<string | null>(null)
const day = ref<DiaryDay | null>(null)
const dayVersion = ref(0)
const draft = ref<DayFields>({ moodId: null, description: '' })
const eventDraft = ref<EventFields | null>(null)
const editing = ref<DiaryEvent | null>(null)
const newId = ref('')
const initial = ref('')
const busy = ref(false)
const loadingDay = ref(false)
const dayReadFailed = ref(false)
const picker = ref(false)
const error = ref('')
const formError = ref('')
const allCountdowns = ref(false)
const today = ref(localToday())
let request: AbortController | null = null
let detailRequest: AbortController | null = null
let timer: ReturnType<typeof setInterval> | undefined
const dirty = computed(() => selected.value !== null && !loadingDay.value && !dayReadFailed.value && JSON.stringify(mode.value === 'diary' ? draft.value : eventDraft.value) !== initial.value)
const storageKey = computed(() => auth.user.value ? ownerScopedStorageKey(NUVYN_BROWSER_STORAGE_KEYS.diaryLifeView, auth.user.value) : null)
watch(storageKey, key => { mode.value = key && readStorageKey(key) === 'events' ? 'events' : 'diary' }, { immediate: true })
watch(mode, value => { if (storageKey.value) writeStorageKey(storageKey.value, value) })

const range = computed(() => ({ start: addDays(month.value, -7), end: Temporal.PlainDate.from(month.value).add({ months: 1, days: 7 }).toString() }))
const selectedEvents = computed(() => events.value.filter(e => selected.value && occursOn(e, selected.value)).sort(compareEvents))
const countdowns = computed(() => upcoming.value.filter(e => e.showCountdown).flatMap(event => {
  const date = nextOccurrence(event, today.value)
  return date ? [{ event, date, days: dayDistance(today.value, date) }] : []
}).sort((a, b) => a.date.localeCompare(b.date) || a.event.id.localeCompare(b.event.id)))
const markers = computed(() => {
  const result: Record<string, { source?: string; emoji?: string; count?: number }> = {}
  if (mode.value === 'diary') {
    for (const d of days.value) if (d.moodId) result[d.date] = { source: preferences.sourceFor(d.moodId) }
  } else {
    for (let date = range.value.start; date <= range.value.end; date = addDays(date, 1)) {
      const matches = events.value.filter(e => occursOn(e, date)).sort(compareEvents)
      if (matches[0]) result[date] = { source: eventEmojiSource(matches[0].emoji), emoji: matches[0].emoji, count: matches.length }
    }
  }
  return result
})
async function load() {
  request?.abort()
  const scope = new AbortController()
  request = scope
  error.value = ''
  if (!access.isUnlocked.value) return
  try {
    const [d, e, u] = await Promise.all([
      diaryLifeApi.days(range.value.start, range.value.end, scope.signal),
      diaryLifeApi.events(range.value.start, range.value.end, scope.signal),
      diaryLifeApi.countdowns(today.value, scope.signal),
    ])
    if (scope.signal.aborted) return
    days.value = d.days
    events.value = e
    upcoming.value = u
  } catch { if (!scope.signal.aborted) { days.value = []; events.value = []; upcoming.value = []; error.value = '加载失败，请重试。' } }
}
function resetForm() {
  detailRequest?.abort()
  selected.value = null
  eventDraft.value = null
  editing.value = null
  day.value = null
  draft.value = { moodId: null, description: '' }
  dayVersion.value = 0
  loadingDay.value = false
  dayReadFailed.value = false
  initial.value = ''
  picker.value = false
  formError.value = ''
}

function clearPrivateData() {
  request?.abort()
  cancelConfirmation?.()
  resetForm()
  days.value = []
  events.value = []
  upcoming.value = []
  error.value = ''
  allCountdowns.value = false
}

const stopTeardown = subscribeDiaryTeardown(clearPrivateData)
watch([month, access.isUnlocked, access.epoch], () => {
  if (access.isUnlocked.value) void load()
  else clearPrivateData()
}, { immediate: true })
async function canLeave() {
  return !busy.value && (!dirty.value || await confirm('放弃未保存的修改？'))
}
async function close() {
  if (await canLeave()) resetForm()
}
async function open(date: string) {
  if (!(await canLeave()) || !access.isUnlocked.value) return false
  detailRequest?.abort()
  const scope = new AbortController(); detailRequest = scope
  selected.value = date; eventDraft.value = null; editing.value = null; picker.value = false; formError.value = ''; initial.value = 'null'
  day.value = null; draft.value = { moodId: null, description: '' }; dayReadFailed.value = false
  if (mode.value !== 'diary') return true
  loadingDay.value = true
  try {
    const result = await diaryLifeApi.day(date, scope.signal)
    if (scope.signal.aborted) return
    day.value = result.day
    dayVersion.value = result.version
    draft.value = { moodId: result.day?.moodId ?? null, description: result.day?.description ?? '' }
    initial.value = JSON.stringify(draft.value)
  } catch { if (!scope.signal.aborted) { dayReadFailed.value = true; formError.value = '读取失败，请关闭后重试。' } }
  finally { if (!scope.signal.aborted) loadingDay.value = false }
}
async function toggle() {
  if (!(await canLeave())) return
  resetForm()
  mode.value = mode.value === 'diary' ? 'events' : 'diary'
}
function edit(event?: DiaryEvent) {
  editing.value = event ?? null
  newId.value = event?.id ?? createDiaryEventId()
  eventDraft.value = event ? { ...event } : { title: '', description: '', emoji: '🎯', type: 'milestone', startDate: selected.value!, endDate: selected.value!, startTime: null, endTime: null, allDay: true, recurrence: 'none', showCountdown: false, isPrimary: false }
  initial.value = JSON.stringify(eventDraft.value)
}
async function save() {
  if (busy.value || loadingDay.value || dayReadFailed.value || !selected.value) return
  const generation = captureDiarySessionGeneration()
  const date = selected.value
  busy.value = true; formError.value = ''
  try {
    if (mode.value === 'diary') {
      if (!draft.value.moodId && !draft.value.description.trim()) {
        if (day.value) {
          const version = day.value.version
          if (!await confirm('删除当天记录？') || !isDiarySessionGenerationCurrent(generation)) return
          await diaryLifeApi.deleteDay(date, version)
        }
      } else await diaryLifeApi.saveDay(selected.value, draft.value, dayVersion.value)
    } else {
      const fields = parseEvent(eventDraft.value)
      if (!fields) { formError.value = '请检查标题、日期和时间范围。'; return }
      await diaryLifeApi.saveEvent(newId.value, fields, editing.value?.version ?? 0)
    }
    if (!isDiarySessionGenerationCurrent(generation) || !access.isUnlocked.value) return
    resetForm()
    await load()
  } catch (e) { if (isDiarySessionGenerationCurrent(generation)) formError.value = (e as Error).message }
  finally { busy.value = false }
}
async function remove() {
  const date = selected.value
  const entry = mode.value === 'diary' ? day.value : editing.value
  if (busy.value || !date || !entry) return
  const generation = captureDiarySessionGeneration()
  busy.value = true
  try {
    if (!await confirm('删除这条记录？') || !isDiarySessionGenerationCurrent(generation)) return
    if ('id' in entry) await diaryLifeApi.deleteEvent(entry.id, entry.version)
    else await diaryLifeApi.deleteDay(date, entry.version)
    if (!isDiarySessionGenerationCurrent(generation) || !access.isUnlocked.value) return
    resetForm()
    await load()
  } catch (error) {
    if (isDiarySessionGenerationCurrent(generation)) formError.value = (error as Error).message
  } finally {
    busy.value = false
  }
}
async function openCountdown(event: DiaryEvent, date: string) {
  if (await open(date)) edit(event)
}
onBeforeRouteLeave(canLeave)
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => {
  void preferences.load().catch(() => {})
  if (!access.isUnlocked.value) void accessContext?.requestAccess()
  window.addEventListener('beforeunload', beforeUnload)
  timer = setInterval(() => { if (today.value !== localToday()) { today.value = localToday(); void load() } }, 30000)
})
onBeforeUnmount(() => {
  stopTeardown()
  clearPrivateData()
  clearInterval(timer)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <main class="diary-life" data-testid="diary-life">
    <template v-if="access.isUnlocked.value">
      <div class="diary-life-toolbar"><NTooltip><template #trigger><NButton quaternary circle :aria-label="mode === 'diary' ? '切换到人生事件' : '切换到情绪日记'" @click="toggle"><NIcon><CalendarEvent v-if="mode === 'diary'" /><MoodSmile v-else /></NIcon></NButton></template>{{ mode === 'diary' ? '人生事件' : '情绪日记' }}</NTooltip></div>
      <div v-if="error" role="alert">{{ error }} <NButton text @click="load">重试</NButton></div>
      <DiaryLifeCalendar :markers="markers" :today="today" @select="open" @month="month = $event" />
      <section v-if="mode === 'events' && countdowns.length" class="countdowns" aria-label="倒数日">
        <button v-for="item in (allCountdowns ? countdowns : countdowns.slice(0, 3))" :key="item.event.id" type="button" @click="openCountdown(item.event, item.date)"><span><img v-if="eventEmojiSource(item.event.emoji)" :src="eventEmojiSource(item.event.emoji)" class="event-emoji" alt=""><template v-else>{{ item.event.emoji }}</template> {{ item.event.title }}</span><small>{{ item.days === 0 ? '就是今天' : `还有 ${item.days} 天` }}</small></button>
        <NButton v-if="countdowns.length > 3" text @click="allCountdowns = !allCountdowns">{{ allCountdowns ? '收起' : '查看全部' }}</NButton>
      </section>
      <NModal :show="selected !== null" preset="card" :title="selected ?? ''" class="diary-life-dialog" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy" @update:show="!$event && close()">
        <p v-if="formError" role="alert">{{ formError }}</p>
        <p v-else-if="loadingDay" role="status">正在读取…</p>
        <template v-if="mode === 'diary' && !loadingDay && !dayReadFailed">
          <NButton quaternary aria-label="选择心情" @click="picker = !picker"><img v-if="draft.moodId && preferences.sourceFor(draft.moodId)" class="mood-preview" :src="preferences.sourceFor(draft.moodId)" alt="心情"><span v-else>选择心情</span></NButton>
          <DiaryMoodPicker v-if="picker" class="life-mood-picker" :current-mood="draft.moodId" @select="draft.moodId = $event; picker = false" @clear="draft.moodId = null; picker = false" @close="picker = false" />
          <NInput v-model:value="draft.description" type="textarea" :input-props="{ 'aria-label': '记录' }" placeholder="记录今天的感受…" :maxlength="4000" :rows="5" />
        </template>
        <template v-else-if="mode === 'events'">
          <DiaryEventForm v-if="eventDraft" v-model="eventDraft" />
          <div v-else class="day-events"><button v-for="event in selectedEvents" :key="event.id" type="button" @click="edit(event)"><strong><img v-if="eventEmojiSource(event.emoji)" :src="eventEmojiSource(event.emoji)" class="event-emoji" alt=""><template v-else>{{ event.emoji }}</template> {{ event.title }}</strong><span v-if="event.description">{{ event.description }}</span></button><p v-if="!selectedEvents.length">还没有事件</p><NButton @click="edit()">新增事件</NButton></div>
        </template>
        <template #footer><div class="life-actions"><NButton v-if="(mode === 'diary' && day) || editing" text type="error" :disabled="busy" @click="remove">删除</NButton><span /><NButton :disabled="busy" @click="close">取消</NButton><NButton v-if="mode === 'diary' || eventDraft" type="primary" :loading="busy" :disabled="loadingDay || dayReadFailed" @click="save">保存</NButton></div></template>
      </NModal>
    </template>
    <NButton v-else class="unlock-diary" @click="accessContext?.requestAccess()">解锁日记</NButton>
  </main>
</template>

<style scoped>
.diary-life { width: 100%; min-width: 0; box-sizing: border-box; padding: 4px 20px 20px; overflow: auto; color: var(--text); }
.diary-life-toolbar { display: flex; justify-content: flex-end; height: 36px; }
.countdowns { display: flex; gap: 16px; flex-wrap: wrap; padding: 12px 0; }
.countdowns button, .day-events > button { text-align: left; background: transparent; color: inherit; border: 0; font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.countdowns small, .day-events span { opacity: .65; }
.day-events { display: flex; flex-direction: column; gap: 12px; }
.life-actions { display: flex; align-items: center; gap: 12px; }.life-actions > span { flex: 1; }
.event-emoji { width: 20px; height: 20px; vertical-align: middle; margin-inline-end: 4px; }
.mood-preview { width: 32px; height: 32px; }
.life-mood-picker { position: static !important; max-width: 100%; margin-bottom: 12px; }
.unlock-diary { display: block; margin: 20vh auto; }
@media (max-width: 600px) { .diary-life { padding: 4px 8px 16px; } }
</style>
<style>
.diary-life-dialog.n-card { width: min(520px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; }
@media (max-width: 600px) { .diary-life-dialog.n-card { position: fixed; bottom: 0; left: 0; width: 100%; max-height: 90dvh; margin: 0; border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom); } }
</style>
