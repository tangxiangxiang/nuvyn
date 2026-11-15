<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { NButton, NModal } from 'naive-ui'
import { Temporal } from '@js-temporal/polyfill'
import { DiaryAccessContextKey } from '../composables/diary/diaryAccessContext'
import { AppShellContextKey } from '../composables/appShellContext'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent, subscribeDiaryTeardown, useDiaryAccessSession } from '../composables/diary/useDiaryAccessSession'
import { useDiaryMoodIconPreferences } from '../composables/diary/useDiaryMoodIconPreferences'
import { useAuth } from '../composables/useAuth'
import { useConfirm } from '../composables/useConfirm'
import { createDiaryEntryId, createDiaryEventId, diaryLifeApi } from '../lib/diary-life-api'
import { diaryAttachmentsApi } from '../lib/diary-attachments-api'
import { DiaryAttachmentPreviewUrls } from '../lib/diaryAttachmentPreviewUrls'
import { addDays, compareEvents, dayDistance, localToday, MAX_DIARY_IMAGE_GROUP_SIZE, nextOccurrence, occursOn, parseDay, parseEvent, type DiaryDay, type DiaryDaySummary, type DiaryEvent, type DayFields, type DiaryImageGroup, type EventFields } from '../../shared/diaryLife'
import { DIARY_ATTACHMENT_STAGE_HEARTBEAT_INTERVAL_MS, MAX_DIARY_ATTACHMENT_BYTES, MAX_DIARY_DAY_ATTACHMENTS, type DiaryAttachment } from '../../shared/diaryAttachments'
import { NUVYN_BROWSER_STORAGE_KEYS, ownerScopedStorageKey, readStorageKey, writeStorageKey } from '../technicalNamespace'
import DiaryLifeCalendar from '../components/diary/DiaryLifeCalendar.vue'
import DiaryDayDialog from '../components/diary/DiaryDayDialog.vue'
import DiaryEventForm from '../components/diary/DiaryEventForm.vue'
import DiaryEventListDialog from '../components/diary/DiaryEventListDialog.vue'
import { eventEmojiSource } from '../features/diary/eventEmoji'

const access = useDiaryAccessSession()
const accessContext = inject(DiaryAccessContextKey, null)
const appShell = inject(AppShellContextKey, null)
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
const days = ref<DiaryDaySummary[]>([])
const events = ref<DiaryEvent[]>([])
const upcoming = ref<DiaryEvent[]>([])
const selected = ref<string | null>(null)
const day = ref<DiaryDay | null>(null)
const dayAttachments = ref<DiaryAttachment[]>([])
const draftAttachments = ref<Array<DiaryAttachment & { pending?: boolean; localPreviewUrl?: string }>>([])
const dayVersion = ref(0)
const draft = ref<DayFields>({ moodId: null, entries: [] })
const dayMode = ref<'read' | 'edit'>('read')
const eventDraft = ref<EventFields | null>(null)
const editing = ref<DiaryEvent | null>(null)
const newId = ref('')
const initial = ref('')
const busy = ref(false)
const loadingDay = ref(false)
const attachmentBusy = ref(false)
const attachmentError = ref('')
const dayReadFailed = ref(false)
const error = ref('')
const formError = ref('')
const allCountdowns = ref(false)
const today = ref(localToday())
const eventListVisible = ref(false)
const eventListItems = ref<DiaryEvent[]>([])
const eventListNext = ref<number | null>(0)
const eventListLoaded = ref(false)
const eventListLoading = ref(false)
const eventListLoadingMore = ref(false)
const eventListError = ref('')

function stopAttachmentSession() {
  if (attachmentLeaseTimer) clearInterval(attachmentLeaseTimer)
  attachmentLeaseTimer = undefined
  attachmentLeaseRequest?.abort()
  attachmentLeaseRequest = null
  attachmentSessionId.value = null
}

function copyDayFields(fields: Pick<DayFields, 'moodId' | 'entries' | 'entryIds' | 'imageGroups'>): DayFields {
  return {
    moodId: fields.moodId,
    entries: [...fields.entries],
    ...(fields.entryIds ? { entryIds: [...fields.entryIds] } : {}),
    ...(fields.imageGroups ? { imageGroups: fields.imageGroups.map(group => ({ entryId: group.entryId, attachmentIds: [...group.attachmentIds] })) } : {}),
  }
}

function assignImage(imageGroups: DiaryImageGroup[] | undefined, attachmentId: string, entryId: string | null): DiaryImageGroup[] {
  const groups = (imageGroups ?? []).map(group => ({ ...group, attachmentIds: [...group.attachmentIds] }))
  if (groups.some(group => group.entryId === entryId && group.attachmentIds.includes(attachmentId))) return groups
  const remaining = groups
    .map(group => ({ ...group, attachmentIds: group.attachmentIds.filter(id => id !== attachmentId) }))
    .filter(group => group.attachmentIds.length)
  const destination = [...remaining].reverse().find(group => group.entryId === entryId && group.attachmentIds.length < MAX_DIARY_IMAGE_GROUP_SIZE)
  if (destination) destination.attachmentIds.push(attachmentId)
  else remaining.push({ entryId, attachmentIds: [attachmentId] })
  return remaining
}

function removeImageReference(imageGroups: DiaryImageGroup[] | undefined, attachmentId: string): DiaryImageGroup[] | undefined {
  if (!imageGroups) return undefined
  return imageGroups
    .map(group => ({ ...group, attachmentIds: group.attachmentIds.filter(id => id !== attachmentId) }))
    .filter(group => group.attachmentIds.length)
}

async function renewAttachmentSession() {
  const sessionId = attachmentSessionId.value
  const date = selected.value
  if (!sessionId || !date || dayMode.value !== 'edit' || !access.isUnlocked.value || attachmentLeaseRequest) return
  const controller = new AbortController()
  attachmentLeaseRequest = controller
  const generation = captureDiarySessionGeneration()
  try {
    await diaryAttachmentsApi.heartbeat(date, sessionId, controller.signal)
  } catch {
    // A failed heartbeat lets the server lease expire. The next heartbeat or
    // upload retries; no attachment bytes or metadata are exposed here.
  } finally {
    if (attachmentLeaseRequest === controller) attachmentLeaseRequest = null
    if (!isDiarySessionGenerationCurrent(generation) || attachmentSessionId.value !== sessionId) controller.abort()
  }
}

function startAttachmentSession() {
  stopAttachmentSession()
  attachmentSessionId.value = crypto.randomUUID().toLowerCase()
  void renewAttachmentSession()
  attachmentLeaseTimer = setInterval(() => { void renewAttachmentSession() }, DIARY_ATTACHMENT_STAGE_HEARTBEAT_INTERVAL_MS)
}

function onDiaryVisibilityChange() {
  if (document.visibilityState === 'visible') void renewAttachmentSession()
}
let request: AbortController | null = null
let detailRequest: AbortController | null = null
let attachmentUploadRequest: AbortController | null = null
let attachmentLeaseRequest: AbortController | null = null
let attachmentLeaseTimer: ReturnType<typeof setInterval> | undefined
const attachmentSessionId = ref<string | null>(null)
const attachmentPreviewUrls = new DiaryAttachmentPreviewUrls()
let eventListRequest: AbortController | null = null
let timer: ReturnType<typeof setInterval> | undefined
const dirty = computed(() => {
  if (selected.value === null || loadingDay.value || dayReadFailed.value) return false
  if (eventDraft.value) return JSON.stringify(eventDraft.value) !== initial.value
  if (mode.value !== 'diary' || dayMode.value !== 'edit') return false
  return JSON.stringify({ fields: draft.value, attachments: draftAttachments.value.map(item => item.id) }) !== initial.value
})
const storageKey = computed(() => auth.user.value ? ownerScopedStorageKey(NUVYN_BROWSER_STORAGE_KEYS.diaryLifeView, auth.user.value) : null)
watch(storageKey, key => {
  mode.value = key && readStorageKey(key) === 'events' ? 'events' : 'diary'
}, { immediate: true })
watch(mode, value => { if (storageKey.value) writeStorageKey(storageKey.value, value) })
watch(mode, value => { if (appShell?.diaryViewMode) appShell.diaryViewMode.value = value }, { immediate: true })

const range = computed(() => ({ start: addDays(month.value, -7), end: Temporal.PlainDate.from(month.value).add({ months: 1, days: 7 }).toString() }))
const selectedEvents = computed(() => events.value.filter(e => selected.value && occursOn(e, selected.value)).sort(compareEvents))
const countdowns = computed(() => upcoming.value.filter(e => e.showCountdown).flatMap(event => {
  const date = nextOccurrence(event, today.value)
  return date ? [{ event, date, days: dayDistance(today.value, date) }] : []
}).sort((a, b) => a.date.localeCompare(b.date) || a.event.id.localeCompare(b.event.id)))
const markers = computed(() => {
  const result: Record<string, { source?: string; emoji?: string; count?: number; hasEntries?: boolean; hasAttachments?: boolean }> = {}
  if (mode.value === 'diary') {
    for (const d of days.value) {
      if (d.moodId) result[d.date] = { source: preferences.sourceFor(d.moodId), hasAttachments: d.hasAttachments }
      else if (d.hasEntries || d.hasAttachments) result[d.date] = { hasEntries: d.hasEntries, hasAttachments: d.hasAttachments }
    }
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
  attachmentUploadRequest?.abort()
  attachmentUploadRequest = null
  stopAttachmentSession()
  attachmentPreviewUrls.clear()
  selected.value = null
  eventDraft.value = null
  editing.value = null
  day.value = null
  dayAttachments.value = []
  draftAttachments.value = []
  attachmentBusy.value = false
  attachmentError.value = ''
  draft.value = { moodId: null, entries: [] }
  dayMode.value = 'read'
  dayVersion.value = 0
  loadingDay.value = false
  dayReadFailed.value = false
  initial.value = ''
  formError.value = ''
}

function clearPrivateData() {
  request?.abort()
  eventListRequest?.abort()
  clearShellCommands()
  cancelConfirmation?.()
  resetForm()
  days.value = []
  events.value = []
  upcoming.value = []
  error.value = ''
  allCountdowns.value = false
  eventListVisible.value = false
  eventListItems.value = []
  eventListNext.value = 0
  eventListLoaded.value = false
  eventListLoading.value = false
  eventListLoadingMore.value = false
  eventListError.value = ''
}

async function loadEventList(reset = false) {
  if (!access.isUnlocked.value || eventListLoading.value || eventListLoadingMore.value) return
  const offset = reset ? 0 : eventListNext.value
  if (offset === null) return
  eventListRequest?.abort()
  const scope = new AbortController()
  eventListRequest = scope
  if (reset) eventListLoading.value = true
  else eventListLoadingMore.value = true
  eventListError.value = ''
  try {
    const result = await diaryLifeApi.eventListPage(offset, scope.signal)
    if (scope.signal.aborted || eventListRequest !== scope) return
    eventListItems.value = reset ? result.items : [...eventListItems.value, ...result.items]
    eventListNext.value = result.next
    eventListLoaded.value = true
  } catch {
    if (!scope.signal.aborted && eventListRequest === scope) eventListError.value = '加载失败，请重试。'
  } finally {
    if (eventListRequest === scope) {
      eventListRequest = null
      eventListLoading.value = false
      eventListLoadingMore.value = false
    }
  }
}

async function openEventList() {
  if (!(await canLeave()) || !access.isUnlocked.value) return
  await discardPendingAttachments()
  resetForm()
  eventListVisible.value = true
  if (!eventListLoaded.value) void loadEventList(true)
}

function invalidateEventList() {
  eventListRequest?.abort()
  eventListRequest = null
  eventListLoading.value = false
  eventListLoadingMore.value = false
  eventListItems.value = []
  eventListNext.value = 0
  eventListLoaded.value = false
  eventListError.value = ''
  if (eventListVisible.value) void loadEventList(true)
}

function registerShellCommands() {
  if (appShell?.diaryViewToggleCommand) appShell.diaryViewToggleCommand.value = diaryViewToggleCommand
  if (appShell?.diaryEventListCommand) appShell.diaryEventListCommand.value = diaryEventListCommand
}

function clearShellCommands() {
  if (appShell?.diaryViewToggleCommand?.value === diaryViewToggleCommand) appShell.diaryViewToggleCommand.value = null
  if (appShell?.diaryEventListCommand?.value === diaryEventListCommand) appShell.diaryEventListCommand.value = null
}

const diaryViewToggleCommand = () => { void toggle() }
const diaryEventListCommand = () => { void openEventList() }

function selectEventFromList(event: DiaryEvent) {
  eventListVisible.value = false
  resetForm()
  selected.value = event.startDate
  edit(event)
}

const stopTeardown = subscribeDiaryTeardown(clearPrivateData)
watch([month, access.isUnlocked, access.epoch], () => {
  if (access.isUnlocked.value) void load()
  else clearPrivateData()
}, { immediate: true })
watch(access.isUnlocked, unlocked => {
  if (unlocked) registerShellCommands()
  else clearShellCommands()
}, { immediate: true })
watch(eventListVisible, visible => {
  if (!visible) {
    eventListRequest?.abort()
    eventListRequest = null
    eventListLoading.value = false
    eventListLoadingMore.value = false
  }
})
async function canLeave() {
  return !busy.value && !attachmentBusy.value && (!dirty.value || await confirm('放弃未保存的修改？'))
}
async function close() {
  if (await canLeave()) {
    await discardPendingAttachments()
    resetForm()
  }
}
function editDay() {
  const fields = copyDayFields(draft.value)
  fields.entryIds = fields.entries.map((_, index) => fields.entryIds?.[index] ?? createDiaryEntryId())
  draft.value = fields
  initial.value = JSON.stringify({ fields, attachments: draftAttachments.value.map(item => item.id) })
  dayMode.value = 'edit'
  if (selected.value) startAttachmentSession()
}
async function cancelDayEdit() {
  if (busy.value || attachmentBusy.value) return
  if (dirty.value && !await confirm('放弃未保存的修改？')) return
  if (!day.value) {
    await discardPendingAttachments()
    resetForm()
    return
  }
  await discardPendingAttachments()
  draft.value = copyDayFields(day.value)
  draftAttachments.value = dayAttachments.value.map(item => ({ ...item }))
  initial.value = JSON.stringify({ fields: draft.value, attachments: draftAttachments.value.map(item => item.id) })
  dayMode.value = 'read'
  formError.value = ''
}
function updateDayDraft(next: DayFields) { draft.value = next }
function updateDayContent(content: { entries: string[]; entryIds: string[] }) {
  const retained = new Set(content.entryIds)
  const imageGroups = draft.value.imageGroups?.map(group => ({
    ...group,
    attachmentIds: [...group.attachmentIds],
    entryId: group.entryId !== null && !retained.has(group.entryId) ? null : group.entryId,
  }))
  draft.value = {
    ...draft.value,
    entries: [...content.entries],
    entryIds: [...content.entryIds],
    ...(imageGroups ? { imageGroups } : {}),
  }
}
async function discardPendingAttachments() {
  const pending = draftAttachments.value.filter(item => item.pending)
  for (const item of pending) {
    try { await diaryAttachmentsApi.discard(item.id) } catch {
      attachmentError.value = '部分未保存附件将在过期后自动清理。'
    } finally {
      attachmentPreviewUrls.release(item.id)
    }
  }
  stopAttachmentSession()
  draftAttachments.value = dayAttachments.value.map(item => ({ ...item }))
}
async function addDayAttachments(files: File[], requestedEntryId: string | null = null) {
  if (!selected.value || dayMode.value !== 'edit' || attachmentBusy.value) return
  if (!attachmentSessionId.value) startAttachmentSession()
  const sessionId = attachmentSessionId.value
  if (!sessionId) return
  const generation = captureDiarySessionGeneration()
  const date = selected.value
  const failures: string[] = []
  const controller = new AbortController()
  attachmentUploadRequest = controller
  attachmentBusy.value = true
  attachmentError.value = ''
  try {
    for (const file of files) {
      if (controller.signal.aborted || !isDiarySessionGenerationCurrent(generation) || selected.value !== date) return
      if (draftAttachments.value.length >= MAX_DIARY_DAY_ATTACHMENTS) {
        failures.push(`${file.name}：每天最多添加 20 个附件。`)
        continue
      }
      if (file.size > MAX_DIARY_ATTACHMENT_BYTES) {
        failures.push(`${file.name}：单个附件不能超过 20 MiB。`)
        continue
      }
      let localPreviewUrl: string | null = null
      try { localPreviewUrl = attachmentPreviewUrls.create(file) } catch { /* The protected preview remains available after saving. */ }
      try {
        const attachment = await diaryAttachmentsApi.stage(date, sessionId, file, controller.signal)
        if (controller.signal.aborted || !isDiarySessionGenerationCurrent(generation) || selected.value !== date) {
          void diaryAttachmentsApi.discard(attachment.id).catch(() => {})
          return
        }
        if (localPreviewUrl) attachmentPreviewUrls.associate(attachment.id, localPreviewUrl)
        draftAttachments.value = [...draftAttachments.value, {
          ...attachment,
          pending: true,
          ...(localPreviewUrl ? { localPreviewUrl } : {}),
        }]
        if (attachment.mimeType.startsWith('image/')) {
          const entryId = requestedEntryId && draft.value.entryIds?.includes(requestedEntryId) ? requestedEntryId : null
          draft.value = { ...draft.value, imageGroups: assignImage(draft.value.imageGroups, attachment.id, entryId) }
        }
        localPreviewUrl = null
      } catch (error) {
        if (!controller.signal.aborted) failures.push(`${file.name}：${(error as Error).message}`)
      } finally {
        attachmentPreviewUrls.releaseUnassigned(localPreviewUrl)
      }
    }
  } finally {
    if (attachmentUploadRequest === controller) {
      attachmentUploadRequest = null
      attachmentBusy.value = false
      attachmentError.value = isDiarySessionGenerationCurrent(generation) && selected.value === date
        ? failures.join('\n')
        : ''
    }
  }
}
async function removeDayAttachment(id: string) {
  const attachment = draftAttachments.value.find(item => item.id === id)
  if (!attachment || attachmentBusy.value || busy.value) return
  attachmentError.value = ''
  if (attachment.pending) {
    attachmentBusy.value = true
    try {
      await diaryAttachmentsApi.discard(id)
      attachmentPreviewUrls.release(id)
      draftAttachments.value = draftAttachments.value.filter(item => item.id !== id)
      draft.value = { ...draft.value, imageGroups: removeImageReference(draft.value.imageGroups, id) }
    } catch (error) { attachmentError.value = (error as Error).message }
    finally { attachmentBusy.value = false }
    return
  }
  draftAttachments.value = draftAttachments.value.filter(item => item.id !== id)
  draft.value = { ...draft.value, imageGroups: removeImageReference(draft.value.imageGroups, id) }
}
function moveDayImage(id: string, entryId: string | null) {
  const attachment = draftAttachments.value.find(item => item.id === id)
  if (!attachment || !attachment.mimeType.startsWith('image/') || busy.value || attachmentBusy.value) return
  const validEntryId = entryId && draft.value.entryIds?.includes(entryId) ? entryId : null
  draft.value = { ...draft.value, imageGroups: assignImage(draft.value.imageGroups, id, validEntryId) }
}
async function open(date: string) {
  if (!(await canLeave()) || !access.isUnlocked.value) return false
  await discardPendingAttachments()
  detailRequest?.abort()
  const scope = new AbortController(); detailRequest = scope
  selected.value = date; eventDraft.value = null; editing.value = null; formError.value = ''; initial.value = 'null'
  day.value = null; dayAttachments.value = []; draftAttachments.value = []; draft.value = { moodId: null, entries: [] }; dayMode.value = 'edit'; dayReadFailed.value = false
  if (mode.value !== 'diary') return true
  loadingDay.value = true
  try {
    const result = await diaryLifeApi.day(date, scope.signal)
    if (scope.signal.aborted) return
    day.value = result.day
    dayAttachments.value = result.attachments
    draftAttachments.value = result.attachments.map(item => ({ ...item }))
    dayVersion.value = result.version
    draft.value = result.day ? copyDayFields(result.day) : { moodId: null, entries: [] }
    dayMode.value = result.day ? 'read' : 'edit'
    if (!result.day) startAttachmentSession()
    initial.value = JSON.stringify({ fields: draft.value, attachments: draftAttachments.value.map(item => item.id) })
  } catch { if (!scope.signal.aborted) { dayReadFailed.value = true; formError.value = '读取失败，请关闭后重试。' } }
  finally { if (!scope.signal.aborted) loadingDay.value = false }
}
async function toggle() {
  if (!(await canLeave())) return
  await discardPendingAttachments()
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
  if (busy.value || attachmentBusy.value || loadingDay.value || dayReadFailed.value || !selected.value) return
  const generation = captureDiarySessionGeneration()
  const date = selected.value
  busy.value = true; formError.value = ''
  try {
    if (!eventDraft.value) {
      const fields = parseDay(draft.value)
      if (!fields) { formError.value = '日记最多 100 条，每条和全部文字均不能超过 4000 个字符。'; return }
      const attachmentIds = draftAttachments.value.map(item => item.id)
      if (!fields.moodId && !fields.entries.length && !attachmentIds.length) {
        if (day.value) {
          const version = dayVersion.value
          if (!await confirm('删除当天记录？') || !isDiarySessionGenerationCurrent(generation)) return
          await diaryLifeApi.deleteDay(date, version)
          if (!isDiarySessionGenerationCurrent(generation) || !access.isUnlocked.value) return
          resetForm()
          await load()
          return
        }
        draft.value = { moodId: null, entries: [] }
      } else {
        const unchanged = day.value
          && JSON.stringify(fields) === JSON.stringify(copyDayFields(day.value))
          && JSON.stringify(attachmentIds) === JSON.stringify(dayAttachments.value.map(item => item.id))
        if (!unchanged) {
          const result = await diaryLifeApi.saveDay(date, fields, dayVersion.value, attachmentIds)
          if (!isDiarySessionGenerationCurrent(generation) || !access.isUnlocked.value) return
          day.value = result.day
          dayVersion.value = result.version
          dayAttachments.value = result.attachments
          attachmentPreviewUrls.clear()
          draftAttachments.value = result.attachments.map(item => ({ ...item }))
        }
        draft.value = copyDayFields(fields)
      }
      initial.value = JSON.stringify({ fields: draft.value, attachments: draftAttachments.value.map(item => item.id) })
      stopAttachmentSession()
      dayMode.value = 'read'
      await load()
      return
    } else {
      const fields = parseEvent(eventDraft.value)
      if (!fields) { formError.value = '请检查标题、日期和时间范围。'; return }
      await diaryLifeApi.saveEvent(newId.value, fields, editing.value?.version ?? 0)
    }
    if (!isDiarySessionGenerationCurrent(generation) || !access.isUnlocked.value) return
    resetForm()
    await load()
    invalidateEventList()
  } catch (e) { if (isDiarySessionGenerationCurrent(generation)) formError.value = (e as Error).message }
  finally { busy.value = false }
}
async function remove() {
  const date = selected.value
  const entry = eventDraft.value ? editing.value : day.value
  if (busy.value || attachmentBusy.value || !date || !entry) return
  const generation = captureDiarySessionGeneration()
  busy.value = true
  try {
    if (!await confirm('删除这条记录？') || !isDiarySessionGenerationCurrent(generation)) return
    if ('id' in entry) await diaryLifeApi.deleteEvent(entry.id, entry.version)
    else await diaryLifeApi.deleteDay(date, entry.version)
    if (!isDiarySessionGenerationCurrent(generation) || !access.isUnlocked.value) return
    resetForm()
    await load()
    invalidateEventList()
  } catch (error) {
    if (isDiarySessionGenerationCurrent(generation)) formError.value = (error as Error).message
  } finally {
    busy.value = false
  }
}
async function openCountdown(event: DiaryEvent, date: string) {
  if (await open(date)) edit(event)
}
onBeforeRouteLeave(async () => {
  if (!await canLeave()) return false
  await discardPendingAttachments()
  return true
})
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => {
  void preferences.load().catch(() => {})
  if (!access.isUnlocked.value) void accessContext?.requestAccess()
  window.addEventListener('beforeunload', beforeUnload)
  document.addEventListener('visibilitychange', onDiaryVisibilityChange)
  timer = setInterval(() => { if (today.value !== localToday()) { today.value = localToday(); void load() } }, 30000)
})
onBeforeUnmount(() => {
  stopTeardown()
  clearPrivateData()
  clearInterval(timer)
  window.removeEventListener('beforeunload', beforeUnload)
  document.removeEventListener('visibilitychange', onDiaryVisibilityChange)
  clearShellCommands()
  if (appShell?.diaryViewMode) appShell.diaryViewMode.value = 'diary'
})
</script>

<template>
  <main class="diary-life" data-testid="diary-life">
    <template v-if="access.isUnlocked.value">
      <div class="diary-life-calendar-stage">
        <div v-if="error" class="diary-life-error" role="alert">{{ error }} <NButton text @click="load">重试</NButton></div>
        <DiaryLifeCalendar :markers="markers" :today="today" @select="open" @month="month = $event" />
      </div>
      <section v-if="mode === 'events' && countdowns.length" class="countdowns" aria-label="倒数日">
        <button v-for="item in (allCountdowns ? countdowns : countdowns.slice(0, 3))" :key="item.event.id" type="button" @click="openCountdown(item.event, item.date)"><span><img v-if="eventEmojiSource(item.event.emoji)" :src="eventEmojiSource(item.event.emoji)" class="event-emoji" alt=""><template v-else>{{ item.event.emoji }}</template> {{ item.event.title }}</span><small>{{ item.days === 0 ? '就是今天' : `还有 ${item.days} 天` }}</small></button>
        <NButton v-if="countdowns.length > 3" text @click="allCountdowns = !allCountdowns">{{ allCountdowns ? '收起' : '查看全部' }}</NButton>
      </section>
      <DiaryDayDialog
        v-if="selected !== null && mode === 'diary' && !eventDraft"
        :show="selected !== null && mode === 'diary' && !eventDraft"
        :date="selected"
        :day="day"
        :attachments="draftAttachments"
        :draft="draft"
        :mode="dayMode"
        :loading="loadingDay"
        :read-failed="dayReadFailed"
        :busy="busy"
        :error="formError"
        :attachment-busy="attachmentBusy"
        :attachment-error="attachmentError"
        @edit="editDay"
        @cancel-edit="cancelDayEdit"
        @close="close"
        @save="save"
        @remove="remove"
        @update:draft="updateDayDraft"
        @update:content="updateDayContent"
        @add-attachments="addDayAttachments"
        @remove-attachment="removeDayAttachment"
        @move-attachment="moveDayImage"
      />
      <NModal v-if="selected !== null && (mode === 'events' || eventDraft)" :show="selected !== null && (mode === 'events' || eventDraft !== null)" preset="card" :title="selected ?? ''" class="diary-life-dialog" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy" @update:show="!$event && close()">
        <p v-if="formError" role="alert">{{ formError }}</p>
        <template v-if="mode === 'events' || eventDraft">
          <DiaryEventForm v-if="eventDraft" v-model="eventDraft" />
          <div v-else class="day-events"><button v-for="event in selectedEvents" :key="event.id" type="button" @click="edit(event)"><strong><img v-if="eventEmojiSource(event.emoji)" :src="eventEmojiSource(event.emoji)" class="event-emoji" alt=""><template v-else>{{ event.emoji }}</template> {{ event.title }}</strong><span v-if="event.description">{{ event.description }}</span></button><p v-if="!selectedEvents.length">还没有事件</p><NButton @click="edit()">新增事件</NButton></div>
        </template>
        <template #footer><div class="life-actions"><NButton v-if="editing" text type="error" :disabled="busy" @click="remove">删除</NButton><span /><NButton :disabled="busy" @click="close">取消</NButton><NButton v-if="eventDraft" type="primary" :loading="busy" @click="save">保存</NButton></div></template>
      </NModal>
      <DiaryEventListDialog
        v-model:show="eventListVisible"
        :items="eventListItems"
        :loading="eventListLoading"
        :loading-more="eventListLoadingMore"
        :has-more="eventListNext !== null"
        :error="eventListError"
        @retry="loadEventList(true)"
        @load-more="loadEventList()"
        @select="selectEventFromList"
      />
    </template>
    <NButton v-else class="unlock-diary" @click="accessContext?.requestAccess()">解锁日记</NButton>
  </main>
</template>

<style scoped>
.diary-life {
  width: 100%;
  min-width: 0;
  height: calc(100dvh - var(--navbar-h, 36px));
  box-sizing: border-box;
  padding: 8px 20px clamp(16px, 3dvh, 32px);
  overflow: auto;
  color: var(--text);
  scrollbar-gutter: stable both-edges;
}
.diary-life-calendar-stage {
  /* Countdown cards continue below the calendar in the same scroll area. */
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.diary-life-error { margin-top: 8px; padding: 8px 0; }
.countdowns { display: flex; gap: 16px; flex-wrap: wrap; padding: 12px 0; }
.countdowns button, .day-events > button { text-align: left; background: transparent; color: inherit; border: 0; font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.countdowns small, .day-events span { opacity: .65; }
.day-events { display: flex; flex-direction: column; gap: 12px; }
.life-actions { display: flex; align-items: center; gap: 12px; }.life-actions > span { flex: 1; }
.event-emoji { width: 20px; height: 20px; vertical-align: middle; margin-inline-end: 4px; }
.unlock-diary { display: block; margin: 20vh auto; }
@media (max-width: 600px) { .diary-life { padding-inline: 8px; } }
</style>
<style>
.diary-life-dialog.n-card { width: min(520px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; }
@media (max-width: 600px) { .diary-life-dialog.n-card { position: fixed; bottom: 0; left: 0; width: 100%; max-height: 90dvh; margin: 0; border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom); } }
</style>
