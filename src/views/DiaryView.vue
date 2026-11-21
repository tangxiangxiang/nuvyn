<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { NButton, NIcon, NModal, NSpin } from 'naive-ui'
import { Plus, X } from '@vicons/tabler'
import { Temporal } from '@js-temporal/polyfill'
import { DiaryAccessContextKey } from '../composables/diary/diaryAccessContext'
import { AppShellContextKey, type DiaryCalendarMode } from '../composables/appShellContext'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent, subscribeDiaryTeardown, useDiaryAccessSession } from '../composables/diary/useDiaryAccessSession'
import { useDiaryMoodIconPreferences } from '../composables/diary/useDiaryMoodIconPreferences'
import { useAuth } from '../composables/useAuth'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import { createDiaryEntryId, createDiaryEventId, diaryLifeApi, DiaryLifeApiError } from '../lib/diary-life-api'
import { createDiaryAttachmentClientId, diaryAttachmentsApi } from '../lib/diary-attachments-api'
import { DiaryAttachmentPreviewUrls } from '../lib/diaryAttachmentPreviewUrls'
import { addDays, compareEvents, displayEventTitle, eventOccurrenceStart, localToday, MAX_DIARY_IMAGE_GROUP_SIZE, nextOccurrence, occursOn, parseDay, parseEvent, type DiaryDay, type DiaryDaySummary, type DiaryEvent, type DayFields, type DiaryImageGroup, type EventFields } from '../../shared/diaryLife'
import { parseTaskSeriesFields, parseWritableTaskFields, taskTimeFieldsError, type DiaryRecurringTaskOccurrence, type DiaryTask, type DiaryTaskListItem, type TaskEditorFields } from '../../shared/diaryTasks'
import { DIARY_ATTACHMENT_STAGE_HEARTBEAT_INTERVAL_MS, MAX_DIARY_ATTACHMENT_BYTES, MAX_DIARY_DAY_ATTACHMENTS, type DiaryAttachment } from '../../shared/diaryAttachments'
import { NUVYN_BROWSER_STORAGE_KEYS, ownerScopedStorageKey, readStorageKey, writeStorageKey } from '../technicalNamespace'
import DiaryLifeCalendar from '../components/diary/DiaryLifeCalendar.vue'
import DiaryDayDialog from '../components/diary/DiaryDayDialog.vue'
import DiaryEventForm from '../components/diary/DiaryEventForm.vue'
import DiaryEventRow from '../components/diary/DiaryEventRow.vue'
import DiaryTaskForm from '../components/diary/DiaryTaskForm.vue'
import DiaryTaskRows from '../components/diary/DiaryTaskRows.vue'
import '../components/diary/diaryDayList.css'
import { DiaryTaskApiError, DiaryTaskConflictError, DiaryTaskHistoryProtectedError, diaryTasksApi } from '../lib/diary-tasks-api'
import { groupTasksByDueDate, listDiaryTasksInRange } from '../features/diary/diaryTaskCalendar'
import { eventEmojiSource } from '../features/diary/eventEmoji'
import { eventDistanceLabel } from '../features/diary/eventDistance'
import { todoDayVisualState, type TodoDayVisualState } from '../features/diary/deadlineVisualState'
import { clearDiarySearchOpen, consumeDiarySearchOpen, diarySearchOpenIntent, type DiaryDiarySearchOpenIntent, type DiaryEventSearchOpenIntent, type DiaryTaskSearchOpenIntent } from '../composables/diary/useDiarySearchNavigation'

function preventDiaryBackdropClickThrough(event: MouseEvent) {
  const target = event.composedPath()[0]
  if (target instanceof Element && target.matches('.n-modal-mask, .n-modal-scroll-content')) event.preventDefault()
}

const access = useDiaryAccessSession()
const accessContext = inject(DiaryAccessContextKey, null)
const appShell = inject(AppShellContextKey, null)
const preferences = useDiaryMoodIconPreferences()
const auth = useAuth()
const { confirmCancellable } = useConfirm()
const toast = useToast()
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
const mode = ref<DiaryCalendarMode>('diary')
const month = ref(`${localToday().slice(0, 7)}-01`)
const calendarRevision = ref(0)
const days = ref<DiaryDaySummary[]>([])
const events = ref<DiaryEvent[]>([])
const selected = ref<string | null>(null)
const day = ref<DiaryDay | null>(null)
const dayAttachments = ref<DiaryAttachment[]>([])
const draftAttachments = ref<Array<DiaryAttachment & { pending?: boolean; localPreviewUrl?: string }>>([])
const dayVersion = ref(0)
const draft = ref<DayFields>({ moodId: null, entries: [] })
const dayMode = ref<'read' | 'edit'>('read')
type EventReturnContext =
  { kind: 'day-list'; date: string; eventId: string; restoreFocus: boolean }
type TaskReturnContext =
  { kind: 'day-list'; date: string; taskId: string; restoreFocus: boolean }
type EventSurface =
  | { kind: 'day-list'; date: string }
  | { kind: 'edit'; event: DiaryEvent | null; eventId: string; draft: EventFields; initial: string; occurrenceDate: string; returnTo: EventReturnContext }
  | { kind: 'task-edit'; task: DiaryTaskListItem | null; draft: TaskEditorFields; initial: string; returnTo: TaskReturnContext }
const eventSurface = ref<EventSurface | null>(null)
const initial = ref('')
const busy = ref(false)
const loadingDay = ref(false)
const attachmentBusy = ref(false)
const attachmentError = ref('')
const dayReadFailed = ref(false)
const searchReveal = ref<{ entryId?: string; entryIndex?: number } | null>(null)
const searchHighlight = ref<{ kind: 'event' | 'task'; id: string } | null>(null)
const diaryCalendarError = ref('')
const eventCalendarError = ref('')
const calendarTaskError = ref('')
const calendarEventLoading = ref(false)
const formError = ref('')
const today = ref(localToday())
const serverToday = ref<string | null>(null)
const canWriteDay = computed(() => selected.value !== null && serverToday.value !== null && selected.value <= serverToday.value)
const eventForm = ref<{ validate: () => boolean } | null>(null)
const taskForm = ref<InstanceType<typeof DiaryTaskForm> | null>(null)
const eventDraft = computed(() => eventSurface.value?.kind === 'edit' ? eventSurface.value.draft : null)
const taskDraft = computed(() => eventSurface.value?.kind === 'task-edit' ? eventSurface.value.draft : null)
const editing = computed(() => eventSurface.value?.kind === 'edit' ? eventSurface.value.event : null)
const editingTask = computed(() => eventSurface.value?.kind === 'task-edit' ? eventSurface.value.task : null)
const eventSurfaceVisible = computed(() => access.isUnlocked.value && eventSurface.value !== null)
const calendarTasks = ref<DiaryTaskListItem[]>([])
const calendarTasksLoading = ref(false)
const calendarTasksByDate = computed(() => groupTasksByDueDate(calendarTasks.value))
const undatedTaskCount = ref(0)
const undatedTaskCandidate = ref<DiaryTask | null>(null)
const undatedTaskLoading = ref(false)
const undatedTaskOpening = ref(false)
const undatedTaskError = ref('')
const calendarError = computed(() => mode.value === 'diary' ? diaryCalendarError.value : mode.value === 'events' ? eventCalendarError.value : calendarTaskError.value)
const busyTaskIds = ref(new Set<string>())
const taskFormError = ref('')
const taskConflictNeedsReload = ref(false)
const currentTimestamp = ref(Date.now())
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
  if (!sessionId || !date || !canWriteDay.value || dayMode.value !== 'edit' || !access.isUnlocked.value || attachmentLeaseRequest) return
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
  if (!canWriteDay.value) return
  stopAttachmentSession()
  attachmentSessionId.value = createDiaryAttachmentClientId()
  void renewAttachmentSession()
  attachmentLeaseTimer = setInterval(() => { void renewAttachmentSession() }, DIARY_ATTACHMENT_STAGE_HEARTBEAT_INTERVAL_MS)
}

function onDiaryVisibilityChange() {
  if (document.visibilityState !== 'visible') return
  currentTimestamp.value = Date.now()
  void refreshDayPolicy()
  void renewAttachmentSession()
}
type CalendarLoadContext = {
  start: string
  end: string
  mode: DiaryCalendarMode
  owner: string
  generation: number
  key: string
}
type CalendarLoadRequest = { key: string; controller: AbortController; promise: Promise<void> }
let calendarContextKey = ''
let diaryCalendarRequest: CalendarLoadRequest | null = null
let eventCalendarRequest: CalendarLoadRequest | null = null
let calendarTaskRequest: CalendarLoadRequest | null = null
let detailRequest: AbortController | null = null
let searchNavigationSequence = 0
let searchNavigationRequest: AbortController | null = null
let searchHighlightTimer: ReturnType<typeof setTimeout> | undefined
let attachmentUploadRequest: AbortController | null = null
let attachmentLeaseRequest: AbortController | null = null
let attachmentLeaseTimer: ReturnType<typeof setInterval> | undefined
const attachmentSessionId = ref<string | null>(null)
const attachmentPreviewUrls = new DiaryAttachmentPreviewUrls()
let taskDetailRequest: AbortController | null = null
let undatedTaskRequest: AbortController | null = null
let taskContextSequence = 0
let timer: ReturnType<typeof setInterval> | undefined
let disposed = false
const dirty = computed(() => {
  const surface = eventSurface.value
  if (surface?.kind === 'edit') return JSON.stringify(surface.draft) !== surface.initial
  if (surface?.kind === 'task-edit') return JSON.stringify(surface.draft) !== surface.initial
  if (selected.value === null || loadingDay.value || dayReadFailed.value) return false
  if (mode.value !== 'diary' || dayMode.value !== 'edit') return false
  return JSON.stringify({ fields: draft.value, attachments: draftAttachments.value.map(item => item.id) }) !== initial.value
})
const storageKey = computed(() => auth.user.value ? ownerScopedStorageKey(NUVYN_BROWSER_STORAGE_KEYS.diaryLifeView, auth.user.value) : null)
watch(storageKey, (key, previousKey) => {
  if (previousKey && key !== previousKey) clearPrivateData()
  const savedMode = key ? readStorageKey(key) : null
  mode.value = savedMode === 'events' || savedMode === 'tasks' ? savedMode : 'diary'
}, { immediate: true, flush: 'sync' })
watch(mode, value => { if (storageKey.value) writeStorageKey(storageKey.value, value) })
watch(mode, value => { if (appShell?.diaryViewMode) appShell.diaryViewMode.value = value }, { immediate: true })

const range = computed(() => ({ start: addDays(month.value, -7), end: Temporal.PlainDate.from(month.value).add({ months: 1, days: 7 }).toString() }))
const selectedEvents = computed(() => events.value.filter(e => selected.value && occursOn(e, selected.value)).sort(compareEvents))
const selectedTasks = computed(() => (selected.value ? calendarTasksByDate.value.get(selected.value) ?? [] : [])
  .slice()
  .sort((left, right) => (left.dueTime ?? '99:99').localeCompare(right.dueTime ?? '99:99') || left.title.localeCompare(right.title)))
function dayEventLabel(event: DiaryEvent): string {
  return displayEventTitle(event, selected.value)
}

function selectedEventDistance(event: DiaryEvent): string {
  const occurrenceDate = selected.value
  return occurrenceDate ? eventDistanceLabel(event, occurrenceDate, today.value) : ''
}
const markers = computed(() => {
  const result: Record<string, { source?: string; emoji?: string; count?: number; hasEntries?: boolean; hasAttachments?: boolean; hasTasks?: boolean; todoDayState?: TodoDayVisualState }> = {}
  if (mode.value === 'diary') {
    for (const d of days.value) {
      if (d.moodId) result[d.date] = { source: preferences.sourceFor(d.moodId), hasAttachments: d.hasAttachments }
      else if (d.hasEntries || d.hasAttachments) result[d.date] = { hasEntries: d.hasEntries, hasAttachments: d.hasAttachments }
    }
  } else if (mode.value === 'events') {
    for (let date = range.value.start; date <= range.value.end; date = addDays(date, 1)) {
      const matches = events.value.filter(e => occursOn(e, date)).sort(compareEvents)
      if (matches[0]) result[date] = { source: eventEmojiSource(matches[0].emoji), emoji: matches[0].emoji, count: matches.length }
    }
  } else {
    for (let date = range.value.start; date <= range.value.end; date = addDays(date, 1)) {
      const todoDayState = todoDayVisualState(calendarTasksByDate.value.get(date) ?? [], today.value)
      if (todoDayState !== 'none') result[date] = { hasTasks: true, todoDayState }
    }
  return result
})
function getCalendarLoadContext(): CalendarLoadContext | null {
  if (!access.isUnlocked.value || !storageKey.value) return null
  const dateRange = range.value
  const generation = captureDiarySessionGeneration()
  const loadMode = mode.value
  const owner = storageKey.value
  return {
    start: dateRange.start,
    end: dateRange.end,
    mode: loadMode,
    owner,
    generation,
    key: `${dateRange.start}:${dateRange.end}:${today.value}:${loadMode}:${owner}:${generation}:${access.epoch.value ?? ''}`,
  }
}

function isCalendarContextCurrent(context: CalendarLoadContext): boolean {
  const dateRange = range.value
  return !disposed && access.isUnlocked.value
    && isDiarySessionGenerationCurrent(context.generation)
    && storageKey.value === context.owner
    && mode.value === context.mode
    && dateRange.start === context.start && dateRange.end === context.end
    && calendarContextKey === context.key
}

function prepareCalendarContext(context: CalendarLoadContext) {
  if (calendarContextKey === context.key) return
  diaryCalendarRequest?.controller.abort()
  eventCalendarRequest?.controller.abort()
  calendarTaskRequest?.controller.abort()
  diaryCalendarRequest = null
  eventCalendarRequest = null
  calendarTaskRequest = null
  calendarContextKey = context.key
  days.value = []
  events.value = []
  calendarTasks.value = []
  diaryCalendarError.value = ''
  eventCalendarError.value = ''
  calendarTaskError.value = ''
  calendarEventLoading.value = false
  calendarTasksLoading.value = false
}

function loadCalendarDays(context: CalendarLoadContext, refresh = false): Promise<void> {
  if (!refresh && diaryCalendarRequest?.key === context.key) return diaryCalendarRequest.promise
  diaryCalendarRequest?.controller.abort()
  const controller = new AbortController()
  diaryCalendarError.value = ''
  const promise = (async () => {
    try {
      const result = await diaryLifeApi.days(context.start, context.end, controller.signal)
      if (controller.signal.aborted || diaryCalendarRequest?.controller !== controller || !isCalendarContextCurrent(context)) return
      days.value = result.days
    } catch {
      if (!controller.signal.aborted && diaryCalendarRequest?.controller === controller && isCalendarContextCurrent(context)) {
        diaryCalendarError.value = '加载失败，请重试。'
      }
    } finally {
      if (diaryCalendarRequest?.controller === controller) diaryCalendarRequest = null
    }
  })()
  diaryCalendarRequest = { key: context.key, controller, promise }
  return promise
}

function loadCalendarEvents(context: CalendarLoadContext, refresh = false): Promise<void> {
  if (!refresh && eventCalendarRequest?.key === context.key) return eventCalendarRequest.promise
  eventCalendarRequest?.controller.abort()
  const controller = new AbortController()
  eventCalendarError.value = ''
  calendarEventLoading.value = true
  const promise = (async () => {
    try {
      const result = await diaryLifeApi.events(context.start, context.end, controller.signal)
      if (controller.signal.aborted || eventCalendarRequest?.controller !== controller || !isCalendarContextCurrent(context)) return
      events.value = result
    } catch {
      if (!controller.signal.aborted && eventCalendarRequest?.controller === controller && isCalendarContextCurrent(context)) {
        eventCalendarError.value = '加载事件失败，请重试。'
      }
    } finally {
      if (eventCalendarRequest?.controller === controller) {
        eventCalendarRequest = null
        calendarEventLoading.value = false
      }
    }
  })()
  eventCalendarRequest = { key: context.key, controller, promise }
  return promise
}

function loadCalendarTasks(context: CalendarLoadContext, refresh = false): Promise<void> {
  if (!refresh && calendarTaskRequest?.key === context.key) return calendarTaskRequest.promise
  calendarTaskRequest?.controller.abort()
  const controller = new AbortController()
  calendarTaskError.value = ''
  calendarTasksLoading.value = true
  const promise = (async () => {
    try {
      const result = await listDiaryTasksInRange(context.start, context.end, controller.signal)
      if (controller.signal.aborted || calendarTaskRequest?.controller !== controller || !isCalendarContextCurrent(context)) return
      calendarTasks.value = result
    } catch {
      if (!controller.signal.aborted && calendarTaskRequest?.controller === controller && isCalendarContextCurrent(context)) {
        calendarTaskError.value = '待办加载失败，请重试。'
      }
    } finally {
      if (calendarTaskRequest?.controller === controller) {
        calendarTaskRequest = null
        calendarTasksLoading.value = false
      }
    }
  })()
  calendarTaskRequest = { key: context.key, controller, promise }
  return promise
}

function reloadCalendarEvents(): Promise<void> {
  const context = getCalendarLoadContext()
  if (!context || context.mode !== 'events') return Promise.resolve()
  prepareCalendarContext(context)
  return loadCalendarEvents(context, true)
}

function reloadCalendarTasks(): Promise<void> {
  const context = getCalendarLoadContext()
  if (!context || context.mode !== 'tasks') return Promise.resolve()
  prepareCalendarContext(context)
  return loadCalendarTasks(context, true)
}

function retryCalendarStage(): Promise<void> {
  const context = getCalendarLoadContext()
  if (!context) return Promise.resolve()
  prepareCalendarContext(context)
  return context.mode === 'diary'
    ? loadCalendarDays(context, true)
    : context.mode === 'events'
      ? loadCalendarEvents(context, true)
      : loadCalendarTasks(context, true)
}

function load(refresh = false): Promise<void> {
  const context = getCalendarLoadContext()
  if (!context) return Promise.resolve()
  prepareCalendarContext(context)
  if (context.mode === 'diary') return loadCalendarDays(context, refresh)
  return context.mode === 'events' ? loadCalendarEvents(context, refresh) : loadCalendarTasks(context, refresh)
}
function resetForm() {
  detailRequest?.abort()
  attachmentUploadRequest?.abort()
  attachmentUploadRequest = null
  stopAttachmentSession()
  attachmentPreviewUrls.clear()
  selected.value = null
  serverToday.value = null
  eventSurface.value = null
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
  searchReveal.value = null
  initial.value = ''
  formError.value = ''
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
  clearSearchHighlight()
}

function clearSearchHighlight() {
  if (searchHighlightTimer) clearTimeout(searchHighlightTimer)
  searchHighlightTimer = undefined
  searchHighlight.value = null
}

function highlightSearchRecord(kind: 'event' | 'task', id: string) {
  clearSearchHighlight()
  searchHighlight.value = { kind, id }
  searchHighlightTimer = setTimeout(clearSearchHighlight, 1600)
}

function clearPrivateData() {
  clearDiarySearchOpen()
  searchNavigationSequence += 1
  searchNavigationRequest?.abort()
  searchNavigationRequest = null
  clearSearchHighlight()
  taskContextSequence += 1
  diaryCalendarRequest?.controller.abort()
  eventCalendarRequest?.controller.abort()
  calendarTaskRequest?.controller.abort()
  undatedTaskRequest?.abort()
  undatedTaskRequest = null
  diaryCalendarRequest = null
  eventCalendarRequest = null
  calendarTaskRequest = null
  calendarContextKey = ''
  taskDetailRequest?.abort()
  taskDetailRequest = null
  busy.value = false
  clearShellCommands()
  cancelConfirmation?.()
  resetForm()
  days.value = []
  events.value = []
  calendarTasks.value = []
  undatedTaskCount.value = 0
  undatedTaskCandidate.value = null
  undatedTaskLoading.value = false
  undatedTaskOpening.value = false
  undatedTaskError.value = ''
  diaryCalendarError.value = ''
  eventCalendarError.value = ''
  calendarTaskError.value = ''
  calendarEventLoading.value = false
  calendarTasksLoading.value = false
  busyTaskIds.value = new Set()
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
}

function capturePrivateOperation() {
  const generation = captureDiarySessionGeneration()
  const owner = storageKey.value
  return () => !disposed && isDiarySessionGenerationCurrent(generation) && storageKey.value === owner && access.isUnlocked.value
}

async function refreshUndatedTaskSummary() {
  if (!access.isUnlocked.value || !storageKey.value) {
    undatedTaskRequest?.abort()
    undatedTaskRequest = null
    undatedTaskCount.value = 0
    undatedTaskCandidate.value = null
    undatedTaskLoading.value = false
    undatedTaskError.value = ''
    return
  }
  undatedTaskRequest?.abort()
  const controller = new AbortController()
  undatedTaskRequest = controller
  const generation = captureDiarySessionGeneration()
  const owner = storageKey.value
  const isCurrent = () => !disposed && undatedTaskRequest === controller && !controller.signal.aborted
    && isDiarySessionGenerationCurrent(generation) && storageKey.value === owner && access.isUnlocked.value
  undatedTaskLoading.value = true
  undatedTaskError.value = ''
  try {
    const result = await diaryTasksApi.undatedTaskSummary(controller.signal)
    if (!isCurrent()) return
    undatedTaskCount.value = result.count
    undatedTaskCandidate.value = result.task
  } catch {
    if (isCurrent()) undatedTaskError.value = '检查历史待办失败，请重试。'
  } finally {
    if (undatedTaskRequest === controller) {
      undatedTaskRequest = null
      undatedTaskLoading.value = false
    }
  }
}

function registerShellCommands() {
  if (appShell?.diaryViewToggleCommand) appShell.diaryViewToggleCommand.value = diaryViewToggleCommand
}

function clearShellCommands() {
  if (appShell?.diaryViewToggleCommand?.value === diaryViewToggleCommand) appShell.diaryViewToggleCommand.value = null
}

const diaryViewToggleCommand = (target?: DiaryCalendarMode) => { void switchMode(target ?? (mode.value === 'diary' ? 'events' : 'diary')) }

function syncCalendarToDate(date: string) {
  const targetMonth = `${date.slice(0, 7)}-01`
  if (month.value === targetMonth) return
  month.value = targetMonth
  calendarRevision.value += 1
}

function eventNavigationDate(event: DiaryEvent, fromDate = today.value): string {
  if (occursOn(event, fromDate)) return fromDate
  return nextOccurrence(event, fromDate) ?? event.startDate
}

function selectEventFromDay(event: DiaryEvent, interaction?: MouseEvent) {
  const surface = eventSurface.value
  if (surface?.kind !== 'day-list') return
  const keyboardActivated = interaction?.detail === 0
  startEventEdit(
    event,
    surface.date,
    { kind: 'day-list', date: surface.date, eventId: event.id, restoreFocus: keyboardActivated },
    keyboardActivated,
  )
}

function focusEventDialogFallback() {
  document.querySelector<HTMLButtonElement>('.diary-life-dialog .diary-event-close-button')?.focus({ preventScroll: true })
}

function restoreEventContext(context: EventReturnContext) {
  formError.value = ''
  syncCalendarToDate(context.date)
  selected.value = context.date
  eventSurface.value = { kind: 'day-list', date: context.date }

  const isCurrent = capturePrivateOperation()
  void nextTick(() => {
    if (!isCurrent()) return
    if (eventSurface.value?.kind !== 'day-list' || !context.restoreFocus) return
    const eventButton = [...document.querySelectorAll<HTMLButtonElement>('.diary-life-dialog .day-events [data-event-id]')]
      .find(button => button.dataset.eventId === context.eventId)
    if (eventButton) eventButton.focus({ preventScroll: true })
    else focusEventDialogFallback()
  })
}

function activateTaskContext(context: TaskReturnContext) {
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
  syncCalendarToDate(context.date)
  selected.value = context.date
  eventSurface.value = { kind: 'day-list', date: context.date }
}

function focusTaskContext(context: TaskReturnContext) {
  if (!context.restoreFocus) return
  const taskButton = [...document.querySelectorAll<HTMLButtonElement>('.diary-life-dialog .day-tasks [data-task-id]')]
    .find(button => button.dataset.taskId === context.taskId)
  if (taskButton) taskButton.focus({ preventScroll: true })
  else focusEventDialogFallback()
}

function restoreTaskContext(context: TaskReturnContext) {
  activateTaskContext(context)
  const expectedSurface = eventSurface.value
  const expectedMonth = month.value
  const isCurrent = capturePrivateOperation()
  const isContextCurrent = () => isCurrent()
    && eventSurface.value === expectedSurface
    && selected.value === context.date
    && month.value === expectedMonth
  void nextTick(() => {
    if (!isContextCurrent()) return
    focusTaskContext(context)
  })
}

function taskFields(task: DiaryTaskListItem | null, dueDate: string | null): TaskEditorFields {
  if (task?.kind === 'recurring') return {
    title: task.title,
    description: task.description,
    startDate: null,
    startTime: null,
    dueDate: task.occurrenceDate,
    dueTime: task.dueTime,
    recurrence: { ...task.recurrence, startDate: task.occurrenceDate },
  }
  return task
    ? { title: task.title, description: task.description, startDate: task.startDate, startTime: task.startTime, dueDate: task.dueDate, dueTime: task.dueTime, recurrence: null }
    : { title: '', description: '', startDate: null, startTime: null, dueDate, dueTime: null, recurrence: null }
}

function startTaskEdit(task: DiaryTaskListItem | null, returnTo: TaskReturnContext) {
  if (busy.value || attachmentBusy.value || !access.isUnlocked.value) return
  const draft = taskFields(task, returnTo.date)
  eventSurface.value = { kind: 'task-edit', task, draft, initial: JSON.stringify(draft), returnTo }
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
  if (!task) {
    const isCurrent = capturePrivateOperation()
    void nextTick(() => {
      if (isCurrent() && eventSurface.value?.kind === 'task-edit') taskForm.value?.focusTitle()
    })
  }
}

async function openUndatedTaskRepair() {
  if (undatedTaskOpening.value || undatedTaskLoading.value || busy.value || attachmentBusy.value || !access.isUnlocked.value) return
  const candidate = undatedTaskCandidate.value
  if (!candidate) {
    await refreshUndatedTaskSummary()
    return
  }
  const isCurrent = capturePrivateOperation()
  taskDetailRequest?.abort()
  const controller = new AbortController()
  taskDetailRequest = controller
  undatedTaskOpening.value = true
  undatedTaskError.value = ''
  try {
    const currentTask = (await diaryTasksApi.getTask(candidate.id, controller.signal)).task
    if (controller.signal.aborted || !isCurrent()) return
    if (currentTask.dueDate !== null) {
      await refreshUndatedTaskSummary()
      return
    }
    const date = today.value
    const returnTo: TaskReturnContext = { kind: 'day-list', date, taskId: currentTask.id, restoreFocus: false }
    mode.value = 'tasks'
    syncCalendarToDate(date)
    selected.value = date
    eventSurface.value = { kind: 'day-list', date }
    await nextTick()
    if (!isCurrent()) return
    startTaskEdit({ ...currentTask, kind: 'one-off' }, returnTo)
  } catch {
    if (!controller.signal.aborted && isCurrent()) undatedTaskError.value = '加载历史待办失败，请重试。'
  } finally {
    if (taskDetailRequest === controller) taskDetailRequest = null
    if (isCurrent()) undatedTaskOpening.value = false
  }
}

function createTaskFromDay() {
  const surface = eventSurface.value
  if (surface?.kind !== 'day-list' || !access.isUnlocked.value || busy.value || attachmentBusy.value) return
  startTaskEdit(null, { kind: 'day-list', date: surface.date, taskId: '', restoreFocus: false })
}

function editTaskFromDay(task: DiaryTaskListItem, keyboardActivated: boolean) {
  if (selected.value === null || eventSurface.value?.kind !== 'day-list') return
  startTaskEdit(task, { kind: 'day-list', date: selected.value, taskId: task.id, restoreFocus: keyboardActivated })
}

function updateTaskDraft(next: TaskEditorFields) {
  const surface = eventSurface.value
  if (surface?.kind === 'task-edit' && access.isUnlocked.value && !busy.value) {
    eventSurface.value = { ...surface, draft: next }
  }
}

async function cancelTaskEdit(interaction?: MouseEvent) {
  const surface = eventSurface.value
  if (surface?.kind !== 'task-edit' || busy.value) return
  if (JSON.stringify(surface.draft) !== surface.initial && !await confirm('放弃未保存的修改？')) return
  if (eventSurface.value !== surface || !access.isUnlocked.value) return
  restoreTaskContext({ ...surface.returnTo, restoreFocus: interaction?.detail === 0 || surface.returnTo.restoreFocus })
}

function updateCalendarTask(task: DiaryTaskListItem | null, previousId?: string) {
  const removedId = previousId ?? task?.id
  const existing = calendarTasks.value.find(item => item.id === removedId || item.id === task?.id)
  if (task && existing && existing.version > task.version) return
  const without = calendarTasks.value.filter(item => item.id !== removedId)
  if (task?.dueDate && task.dueDate >= range.value.start && task.dueDate <= range.value.end) without.push(task)
  calendarTasks.value = without
}

async function refreshTaskContext(context: TaskReturnContext) {
  const isCurrentSession = capturePrivateOperation()
  if (!isCurrentSession()) return
  const sequence = ++taskContextSequence
  activateTaskContext(context)
  const expectedSurface = eventSurface.value
  const expectedMonth = month.value
  const isCurrent = () => isCurrentSession()
    && taskContextSequence === sequence
    && eventSurface.value === expectedSurface
    && selected.value === context.date
    && month.value === expectedMonth
  await Promise.all([
    reloadCalendarTasks(),
  ])
  if (!isCurrent()) return
  await nextTick()
  if (!isCurrent()) return
  focusTaskContext(context)
}

async function toggleTask(task: DiaryTaskListItem, context: TaskReturnContext) {
  if (busyTaskIds.value.has(task.id) || !access.isUnlocked.value) return
  if (!isTaskContextActive(context)) return
  const isCurrentSession = capturePrivateOperation()
  const expectedSurface = eventSurface.value
  const isCurrentContext = () => isCurrentSession()
    && eventSurface.value === expectedSurface
    && isTaskContextActive(context)
  busyTaskIds.value = new Set(busyTaskIds.value).add(task.id)
  try {
    const result = task.kind === 'recurring'
      ? task.completedAt === null
        ? await diaryTasksApi.completeOccurrence(task.seriesId, task.occurrenceDate, task.occurrenceVersion)
        : await diaryTasksApi.reopenOccurrence(task.seriesId, task.occurrenceDate, task.occurrenceVersion)
      : task.completedAt === null
        ? await diaryTasksApi.completeTask(task.id, task.version)
        : await diaryTasksApi.reopenTask(task.id, task.version)
    if (!isCurrentSession()) return
    if ('task' in result) updateCalendarTask({ ...result.task, kind: 'one-off' })
    else updateCalendarTask(result.occurrence as DiaryRecurringTaskOccurrence)
    if (!isCurrentContext()) return
    await refreshTaskContext(context)
  } catch (cause) {
    if (!isCurrentSession()) return
    if (cause instanceof DiaryTaskConflictError) toast.error('待办已在其他设备更新，列表已刷新。')
    else toast.error('待办更新失败，请重试。')
    if (!isCurrentContext()) return
    await refreshTaskContext(context)
  } finally {
    if (isCurrentSession()) {
      const next = new Set(busyTaskIds.value)
      next.delete(task.id)
      busyTaskIds.value = next
    }
  }
}

async function changeEditedOccurrenceState() {
  const editor = eventSurface.value?.kind === 'task-edit' ? eventSurface.value : null
  const task = editor?.task
  if (!editor || task?.kind !== 'recurring' || busy.value || dirty.value || !access.isUnlocked.value) return
  const action = task.skipped ? 'reopen' : 'skip'
  if (action === 'skip' && task.completedAt !== null) return
  const isCurrent = capturePrivateOperation()
  busy.value = true
  taskFormError.value = ''
  try {
    const result = action === 'reopen'
      ? await diaryTasksApi.reopenOccurrence(task.seriesId, task.occurrenceDate, task.occurrenceVersion)
      : await diaryTasksApi.skipOccurrence(task.seriesId, task.occurrenceDate, task.occurrenceVersion)
    if (!isCurrent() || eventSurface.value !== editor) return
    updateCalendarTask(result.occurrence)
    await refreshTaskContext({ ...editor.returnTo, taskId: result.occurrence.id, restoreFocus: true })
  } catch (cause) {
    if (!isCurrent() || eventSurface.value !== editor) return
    taskFormError.value = cause instanceof DiaryTaskConflictError
      ? '这次待办已在其他设备更新，请重新加载后再试。'
      : '更新失败，请重试。'
    taskConflictNeedsReload.value = cause instanceof DiaryTaskConflictError
  } finally {
    if (isCurrent()) busy.value = false
  }
}

async function stopEditedSeries() {
  const editor = eventSurface.value?.kind === 'task-edit' ? eventSurface.value : null
  const task = editor?.task
  if (!editor || task?.kind !== 'recurring' || busy.value || dirty.value || !access.isUnlocked.value
    || task.recurrence.untilDate === task.occurrenceDate) return
  const isCurrent = capturePrivateOperation()
  busy.value = true
  taskFormError.value = ''
  try {
    if (!await confirm('结束后续重复安排？当前这次和之前的记录会保留。') || !isCurrent() || eventSurface.value !== editor) return
    await diaryTasksApi.stopSeries(task.seriesId, task.occurrenceDate, task.seriesVersion)
    if (!isCurrent() || eventSurface.value !== editor) return
    await refreshTaskContext({ ...editor.returnTo, taskId: task.id, restoreFocus: true })
  } catch (cause) {
    if (!isCurrent() || eventSurface.value !== editor) return
    taskFormError.value = cause instanceof DiaryTaskConflictError
      ? '重复任务已在其他设备更新，请重新加载后再试。'
      : '结束重复失败，请重试。'
    taskConflictNeedsReload.value = cause instanceof DiaryTaskConflictError
  } finally {
    if (isCurrent()) busy.value = false
  }
}

function isTaskContextActive(context: TaskReturnContext): boolean {
  return eventSurface.value?.kind === 'day-list' && eventSurface.value.date === context.date
}

function startEventEdit(event: DiaryEvent, occurrenceDate: string, returnTo: EventReturnContext, keyboardActivated = false) {
  if (busy.value || eventSurface.value?.kind === 'edit' || !access.isUnlocked.value) return
  const eventStartDate = eventOccurrenceStart(event, occurrenceDate) ?? occurrenceDate
  const draft: EventFields = {
    ...event,
    ...(event.dateRule ? { dateRule: { ...event.dateRule } } : {}),
    ...(event.birthday ? { birthday: { ...event.birthday } } : {}),
  }
  eventSurface.value = {
    kind: 'edit',
    event,
    eventId: event.id,
    draft,
    initial: JSON.stringify(draft),
    occurrenceDate: eventStartDate,
    returnTo,
  }
  formError.value = ''
  if (keyboardActivated) {
    const isCurrent = capturePrivateOperation()
    void nextTick(() => {
      if (!isCurrent() || eventSurface.value?.kind !== 'edit') return
      document.querySelector<HTMLInputElement>('.diary-event-form-content input[aria-label="事件名称"], .diary-event-form-content input[aria-label="生日称呼"]')?.focus({ preventScroll: true })
    })
  }
}

async function refreshEventData(state: Extract<EventSurface, { kind: 'edit' }>, isCurrent: () => boolean) {
  await reloadCalendarEvents()
  return isCurrent() && eventSurface.value === state
}

async function closeEventSurface(interaction?: MouseEvent) {
  if (busy.value || attachmentBusy.value) return
  const surface = eventSurface.value
  if (!surface) return
  if (surface.kind === 'edit') {
    await cancelEventEdit(interaction)
    return
  }
  if (surface.kind === 'task-edit') {
    await cancelTaskEdit(interaction)
    return
  }
  if (await canLeave()) {
    await discardPendingAttachments()
    resetForm()
  }
}

const stopTeardown = subscribeDiaryTeardown(clearPrivateData)
watch([month, mode, access.isUnlocked, access.epoch, storageKey], () => {
  if (access.isUnlocked.value && storageKey.value) void load()
  else clearPrivateData()
}, { immediate: true })
watch([access.isUnlocked, storageKey, access.epoch], ([unlocked, owner]) => {
  if (unlocked && owner) {
    registerShellCommands()
    void refreshUndatedTaskSummary()
  } else clearShellCommands()
}, { immediate: true })
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
  if (!canWriteDay.value || loadingDay.value || dayReadFailed.value) return
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
  if (!selected.value || !canWriteDay.value || dayMode.value !== 'edit' || attachmentBusy.value) return
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
async function open(date: string, options: { skipLeaveCheck?: boolean; searchResult?: boolean } = {}) {
  const isCurrent = capturePrivateOperation()
  if ((!options.skipLeaveCheck && !(await canLeave())) || !isCurrent()) return false
  await discardPendingAttachments()
  if (!isCurrent()) return false
  detailRequest?.abort()
  const scope = new AbortController(); detailRequest = scope
  selected.value = date
  eventSurface.value = mode.value !== 'diary' ? { kind: 'day-list', date } : null
  formError.value = ''
  initial.value = 'null'
  serverToday.value = null
  day.value = null; dayAttachments.value = []; draftAttachments.value = []; draft.value = { moodId: null, entries: [] }; dayMode.value = 'read'; dayReadFailed.value = false
  if (mode.value !== 'diary') return true
  loadingDay.value = true
  try {
    const result = await diaryLifeApi.day(date, scope.signal)
    if (scope.signal.aborted) return
    serverToday.value = result.today
    if (options.searchResult && !result.day) {
      toast.error('这条日记已不存在。')
      resetForm()
      return false
    }
    day.value = result.day
    dayAttachments.value = result.attachments
    draftAttachments.value = result.attachments.map(item => ({ ...item }))
    dayVersion.value = result.version
    draft.value = result.day ? copyDayFields(result.day) : { moodId: null, entries: [] }
    if (!result.day && canWriteDay.value && !options.searchResult) {
      dayMode.value = 'edit'
      startAttachmentSession()
    }
    initial.value = JSON.stringify({ fields: draft.value, attachments: draftAttachments.value.map(item => item.id) })
  } catch { if (!scope.signal.aborted) { dayReadFailed.value = true; formError.value = '读取失败，请关闭后重试。' } }
  finally { if (!scope.signal.aborted) loadingDay.value = false }
  return true
}

async function openDiarySearchIntent(intent: DiaryDiarySearchOpenIntent) {
  const sequence = ++searchNavigationSequence
  searchNavigationRequest?.abort()
  searchNavigationRequest = null
  const isCurrent = () => searchNavigationSequence === sequence && diarySearchOpenIntent.value?.id === intent.id
  if (!access.isUnlocked.value) {
    consumeDiarySearchOpen(intent.id)
    return
  }
  if (!(await canLeave())) {
    consumeDiarySearchOpen(intent.id)
    return
  }
  if (!isCurrent() || !access.isUnlocked.value) return
  await discardPendingAttachments()
  if (!isCurrent() || !access.isUnlocked.value) return
  resetForm()
  mode.value = 'diary'
  const targetMonth = `${intent.date.slice(0, 7)}-01`
  if (month.value !== targetMonth) {
    month.value = targetMonth
    calendarRevision.value += 1
  }
  await nextTick()
  if (!isCurrent() || !access.isUnlocked.value) return
  await load()
  if (!isCurrent() || !access.isUnlocked.value) return
  searchReveal.value = {
    ...(intent.entryId ? { entryId: intent.entryId } : {}),
    ...(!intent.entryId && intent.entryIndex !== undefined ? { entryIndex: intent.entryIndex } : {}),
  }
  const opened = await open(intent.date, { skipLeaveCheck: true, searchResult: true })
  if (!opened && selected.value === intent.date) resetForm()
  consumeDiarySearchOpen(intent.id)
}

async function openDiaryRecordSearchIntent(intent: DiaryEventSearchOpenIntent | DiaryTaskSearchOpenIntent) {
  const sequence = ++searchNavigationSequence
  searchNavigationRequest?.abort()
  const controller = new AbortController()
  searchNavigationRequest = controller
  const isCurrent = () => searchNavigationSequence === sequence
    && diarySearchOpenIntent.value?.id === intent.id
    && !controller.signal.aborted
    && access.isUnlocked.value
  if (!isCurrent()) {
    consumeDiarySearchOpen(intent.id)
    return
  }
  if (!(await canLeave())) {
    consumeDiarySearchOpen(intent.id)
    return
  }
  if (!isCurrent()) return
  await discardPendingAttachments()
  if (!isCurrent()) return

  try {
    let targetDate: string | null = null
    let highlightKind: 'event' | 'task'
    let highlightId: string

    if (intent.kind === 'event') {
      const current = (await diaryLifeApi.event(intent.eventId, controller.signal)).event
      if (!isCurrent()) return
      highlightKind = 'event'
      highlightId = current.id
      targetDate = current.recurrence === 'none'
        ? current.startDate
        : occursOn(current, today.value)
          ? today.value
          : nextOccurrence(current, today.value)
      if (!targetDate) {
        toast.error('这条事件暂无可定位的发生日期。')
        consumeDiarySearchOpen(intent.id)
        return
      }
    } else if (intent.seriesId) {
      const occurrence = (await diaryTasksApi.searchTarget(intent.seriesId, controller.signal)).occurrence
      if (!isCurrent()) return
      targetDate = occurrence.occurrenceDate
      highlightKind = 'task'
      highlightId = occurrence.id
    } else if (intent.taskId) {
      const current = (await diaryTasksApi.getTask(intent.taskId, controller.signal)).task
      if (!isCurrent()) return
      highlightKind = 'task'
      highlightId = current.id
      if (!current.dueDate) {
        const date = today.value
        resetForm()
        mode.value = 'tasks'
        syncCalendarToDate(date)
        selected.value = date
        eventSurface.value = { kind: 'day-list', date }
        await nextTick()
        if (!isCurrent()) return
        startTaskEdit({ ...current, kind: 'one-off' }, { kind: 'day-list', date, taskId: current.id, restoreFocus: false })
        consumeDiarySearchOpen(intent.id)
        return
      }
      targetDate = current.dueDate
    } else {
      consumeDiarySearchOpen(intent.id)
      return
    }

    if (!targetDate) {
      toast.error('这条待办暂无可定位的有效日期。')
      consumeDiarySearchOpen(intent.id)
      return
    }

    resetForm()
    mode.value = intent.kind === 'event' ? 'events' : 'tasks'
    syncCalendarToDate(targetDate)
    await nextTick()
    if (!isCurrent()) return
    await load()
    if (!isCurrent()) return

    if (intent.kind === 'event' ? eventCalendarError.value : calendarTaskError.value) {
      toast.error('加载日程失败，请重试。')
      consumeDiarySearchOpen(intent.id)
      return
    }

    if (intent.kind === 'event') {
      const event = events.value.find(item => item.id === highlightId)
      if (!event || !occursOn(event, targetDate)) {
        toast.error('这条事件已更新，请重新搜索。')
        consumeDiarySearchOpen(intent.id)
        return
      }
    } else if (intent.seriesId) {
      if (!calendarTasks.value.some(item => item.kind === 'recurring' && item.id === highlightId && !item.skipped)) {
        toast.error('这条重复待办已更新，请重新搜索。')
        consumeDiarySearchOpen(intent.id)
        return
      }
    } else if (!calendarTasks.value.some(item => item.id === highlightId && item.dueDate === targetDate)) {
      toast.error('这条待办已更新，请重新搜索。')
      consumeDiarySearchOpen(intent.id)
      return
    }

    const opened = await open(targetDate, { skipLeaveCheck: true })
    if (!opened || !isCurrent()) return
    highlightSearchRecord(highlightKind, highlightId)
    consumeDiarySearchOpen(intent.id)
  } catch (error) {
    if (controller.signal.aborted || !isCurrent()) return
    if (error instanceof DiaryLifeApiError && error.status === 404) toast.error('这条事件已不存在。')
    else if (error instanceof DiaryTaskApiError && error.status === 404) toast.error('这条待办已不存在或没有有效实例。')
    else toast.error('定位日程失败，请重试。')
    consumeDiarySearchOpen(intent.id)
  } finally {
    if (searchNavigationRequest === controller) searchNavigationRequest = null
  }
}

watch(diarySearchOpenIntent, intent => {
  if (!intent) return
  if (intent.kind === 'diary') void openDiarySearchIntent(intent)
  else void openDiaryRecordSearchIntent(intent)
})
async function refreshDayPolicy() {
  const signal = detailRequest?.signal
  if (!signal || signal.aborted || !selected.value || !serverToday.value || loadingDay.value || !access.isUnlocked.value) return
  try {
    const result = await diaryLifeApi.dayPolicy(signal)
    if (!signal.aborted) serverToday.value = result.today
  } catch {
    // Keep the last known boundary. The server checks every write independently.
  }
}
async function switchMode(target: DiaryCalendarMode) {
  if (mode.value === target || !await canLeave()) return
  await discardPendingAttachments()
  resetForm()
  mode.value = target
}
function createEvent() {
  const surface = eventSurface.value
  const date = surface?.kind === 'day-list' ? surface.date : selected.value
  if (!date || surface?.kind !== 'day-list' || !access.isUnlocked.value) return
  const type = date >= today.value ? 'schedule' : 'milestone'
  const eventId = createDiaryEventId()
  const draft: EventFields = { title: '', description: '', emoji: type === 'schedule' ? '💼' : '🎓', type, startDate: date, endDate: date, startTime: null, endTime: null, allDay: true, dateRule: { calendar: 'gregory' }, recurrence: 'none', showCountdown: false, isPrimary: false }
  eventSurface.value = {
    kind: 'edit',
    event: null,
    eventId,
    draft,
    initial: JSON.stringify(draft),
    occurrenceDate: date,
    returnTo: { kind: 'day-list', date, eventId, restoreFocus: false },
  }
}

function updateEventDraft(next: EventFields) {
  const surface = eventSurface.value
  if (surface?.kind === 'edit' && access.isUnlocked.value && !busy.value) {
    eventSurface.value = { ...surface, draft: next }
  }
}

async function saveTask() {
  const editor = eventSurface.value?.kind === 'task-edit' ? eventSurface.value : null
  if (!editor || busy.value || !access.isUnlocked.value) return
  const isRecurring = editor.draft.recurrence !== null
  if (!editor.draft.title.trim()) {
    taskFormError.value = '请输入待办名称。'
    return
  }
  if (isRecurring && !editor.draft.recurrence?.untilDate) {
    taskFormError.value = '请选择结束日期。'
    return
  }
  const oneOffFields = isRecurring ? null : parseWritableTaskFields(editor.draft)
  let seriesFields = isRecurring ? parseTaskSeriesFields({
    title: editor.draft.title,
    description: editor.draft.description,
    dueTime: editor.draft.dueTime,
    recurrence: editor.draft.recurrence,
  }) : null
  if (seriesFields && editor.task?.kind === 'recurring') {
    const frequencyChanged = editor.draft.recurrence?.frequency !== editor.task.recurrence.frequency
    seriesFields = {
      ...seriesFields,
      recurrence: {
        ...seriesFields.recurrence,
        startDate: frequencyChanged ? editor.task.occurrenceDate : editor.task.recurrence.startDate,
      },
    }
  }
  if ((!isRecurring && !oneOffFields) || (isRecurring && !seriesFields)) {
    if (isRecurring) taskFormError.value = '请检查待办名称、备注和重复规则。'
    else if (taskTimeFieldsError(editor.draft, true) === 'missing-due-date') taskFormError.value = '请选择截止日期。'
    else if (taskTimeFieldsError(editor.draft, true)) taskFormError.value = '请检查开始和截止时间设置。'
    else taskFormError.value = '请检查待办名称和备注。'
    return
  }
  if (editor.task?.kind === 'one-off' && editor.draft.recurrence) {
    taskFormError.value = '已有待办暂不支持转换为重复任务。'
    return
  }
  const isCurrent = capturePrivateOperation()
  busy.value = true
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
  try {
    let focusTaskId = editor.task?.id ?? ''
    if (editor.task?.kind === 'recurring') {
      const result = await diaryTasksApi.updateSeries(editor.task.seriesId, editor.task.occurrenceDate, seriesFields!, editor.task.seriesVersion)
      focusTaskId = `${result.series.id}:${editor.task.occurrenceDate}`
    } else if (editor.draft.recurrence) {
      const result = await diaryTasksApi.createSeries(seriesFields!)
      focusTaskId = `${result.series.id}:${result.series.effectiveFrom}`
    } else {
      const result = editor.task
        ? await diaryTasksApi.updateTask(editor.task.id, oneOffFields!, editor.task.version)
        : await diaryTasksApi.createTask(oneOffFields!)
      focusTaskId = result.task.id
    }
    if (!isCurrent() || eventSurface.value !== editor) return
    const repairedUndatedTask = editor.task?.kind === 'one-off' && editor.task.dueDate === null
    if (repairedUndatedTask) await refreshUndatedTaskSummary()
    const returnTo = repairedUndatedTask && editor.draft.dueDate
      ? { ...editor.returnTo, date: editor.draft.dueDate }
      : editor.returnTo
    await refreshTaskContext({ ...returnTo, taskId: focusTaskId, restoreFocus: true })
  } catch (cause) {
    if (!isCurrent() || eventSurface.value !== editor) return
    if (cause instanceof DiaryTaskHistoryProtectedError) {
      taskFormError.value = '这条重复任务已有历史边界或记录，无法安全扩展或覆盖历史内容。请从后续日期开始创建新的重复任务。'
    } else if (cause instanceof DiaryTaskConflictError) {
      taskFormError.value = '待办已在其他设备更新，当前草稿已保留。请重新加载后再保存。'
      taskConflictNeedsReload.value = true
    } else {
      taskFormError.value = '保存失败，请重试。'
    }
  } finally {
    if (isCurrent()) busy.value = false
  }
}

async function deleteTask() {
  const editor = eventSurface.value?.kind === 'task-edit' ? eventSurface.value : null
  if (!editor?.task || busy.value || !access.isUnlocked.value) return
  const isCurrent = capturePrivateOperation()
  busy.value = true
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
  try {
    const prompt = editor.task.kind === 'recurring' ? '删除整个重复任务及已记录的完成、跳过状态？' : '删除这条待办？'
    if (!await confirm(prompt) || !isCurrent() || eventSurface.value !== editor) return
    if (editor.task.kind === 'recurring') await diaryTasksApi.deleteSeries(editor.task.seriesId, editor.task.seriesVersion)
    else await diaryTasksApi.deleteTask(editor.task.id, editor.task.version)
    if (!isCurrent() || eventSurface.value !== editor) return
    updateCalendarTask(null, editor.task.id)
    if (editor.task.kind === 'one-off' && editor.task.dueDate === null) await refreshUndatedTaskSummary()
    await refreshTaskContext(editor.returnTo)
  } catch (cause) {
    if (!isCurrent() || eventSurface.value !== editor) return
    if (cause instanceof DiaryTaskConflictError) {
      taskFormError.value = '待办已在其他设备更新，当前草稿已保留。请重新加载后再删除。'
      taskConflictNeedsReload.value = true
    } else {
      taskFormError.value = '删除失败，请重试。'
    }
  } finally {
    if (isCurrent()) busy.value = false
  }
}

async function reloadTaskEditor() {
  const editor = eventSurface.value?.kind === 'task-edit' ? eventSurface.value : null
  if (!editor?.task || busy.value || !access.isUnlocked.value) return
  taskDetailRequest?.abort()
  const controller = new AbortController()
  taskDetailRequest = controller
  const isCurrent = capturePrivateOperation()
  busy.value = true
  try {
    const task = editor.task.kind === 'recurring'
      ? (await diaryTasksApi.getOccurrence(editor.task.seriesId, editor.task.occurrenceDate, controller.signal)).occurrence
      : { ...(await diaryTasksApi.getTask(editor.task.id, controller.signal)).task, kind: 'one-off' as const }
    if (controller.signal.aborted || !isCurrent() || eventSurface.value !== editor) return
    const draft = taskFields(task, null)
    eventSurface.value = { ...editor, task, draft, initial: JSON.stringify(draft) }
    taskFormError.value = ''
    taskConflictNeedsReload.value = false
  } catch {
    if (!controller.signal.aborted && isCurrent() && eventSurface.value === editor) {
      taskFormError.value = '重新加载失败，任务可能已被删除，请重试。'
    }
  } finally {
    if (taskDetailRequest === controller) taskDetailRequest = null
    if (isCurrent()) busy.value = false
  }
}

async function cancelEventEdit(interaction?: MouseEvent) {
  const surface = eventSurface.value
  if (surface?.kind !== 'edit' || busy.value) return
  if (JSON.stringify(surface.draft) !== surface.initial && !await confirm('放弃未保存的修改？')) return
  if (eventSurface.value !== surface || !access.isUnlocked.value) return
  if (surface.event) {
    restoreEventContext({
      ...surface.returnTo,
      restoreFocus: interaction?.detail === 0 || surface.returnTo.restoreFocus,
    })
  } else {
    restoreEventContext(surface.returnTo)
  }
}
async function save(keyboardActivated = false) {
  if (busy.value || attachmentBusy.value || !access.isUnlocked.value) return
  const isCurrent = capturePrivateOperation()
  const date = selected.value
  const editor = eventSurface.value?.kind === 'edit' ? eventSurface.value : null
  busy.value = true; formError.value = ''
  try {
    if (!editor) {
      if (!date || loadingDay.value || dayReadFailed.value || !canWriteDay.value) return
      const fields = parseDay(draft.value)
      if (!fields) { formError.value = '日记最多 100 条，每条和全部文字均不能超过 4000 个字符。'; return }
      const attachmentIds = draftAttachments.value.map(item => item.id)
      if (!fields.moodId && !fields.entries.length && !attachmentIds.length) {
        if (day.value) {
          const version = dayVersion.value
          if (!await confirm('删除当天记录？') || !isCurrent()) return
          await diaryLifeApi.deleteDay(date, version)
          if (!isCurrent()) return
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
          if (!isCurrent()) return
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
      if (day.value) toast.success('日记已保存')
      await load()
      return
    } else {
      if (!eventForm.value?.validate()) return
      const fields = parseEvent(editor.draft)
      if (!fields) {
        formError.value = editor.draft.type === 'birthday'
          ? '请检查姓名及出生农历年、月、日。'
          : '请检查标题、日期和时间范围。'
        return
      }
      const result = await diaryLifeApi.saveEvent(editor.eventId, fields, editor.event?.version ?? 0)
      if (!isCurrent() || eventSurface.value !== editor) return
      const occurrenceDate = eventNavigationDate(result.event, editor.occurrenceDate)
      const returnTo: EventReturnContext = editor.returnTo.kind === 'day-list'
        ? { ...editor.returnTo, date: occurrenceDate, eventId: editor.eventId }
        : { ...editor.returnTo, eventId: editor.eventId }
      editor.returnTo = returnTo
      syncCalendarToDate(occurrenceDate)
      selected.value = editor.returnTo.kind === 'day-list' ? occurrenceDate : null
      if (!await refreshEventData(editor, isCurrent)) return
      restoreEventContext({ ...returnTo, restoreFocus: keyboardActivated || returnTo.restoreFocus })
      return
    }
  } catch (e) { if (isCurrent()) formError.value = (e as Error).message }
  finally { if (isCurrent()) busy.value = false }
}
async function remove() {
  const date = selected.value
  const editor = eventSurface.value?.kind === 'edit' ? eventSurface.value : null
  const event = editor?.event ?? null
  const dayEntry = editor ? null : day.value
  if (busy.value || attachmentBusy.value || !access.isUnlocked.value) return
  if (!event && (!date || !dayEntry || !canWriteDay.value)) return
  const isCurrent = capturePrivateOperation()
  busy.value = true
  try {
    if (!await confirm(event ? '删除这条事件？' : '删除这条记录？') || !isCurrent()) return
    if (event) {
      await diaryLifeApi.deleteEvent(event.id, event.version)
      if (isCurrent() && editor && eventSurface.value === editor && await refreshEventData(editor, isCurrent)) {
        restoreEventContext(editor.returnTo)
      }
    } else if (date && dayEntry) {
      await diaryLifeApi.deleteDay(date, dayEntry.version)
      if (!isCurrent()) return
      resetForm()
      await load()
    }
  } catch (error) {
    if (isCurrent()) formError.value = (error as Error).message
  } finally {
    if (isCurrent()) busy.value = false
  }
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
  timer = setInterval(() => {
    currentTimestamp.value = Date.now()
    const currentDate = localToday()
    if (today.value !== currentDate) { today.value = currentDate; void load() }
    void refreshDayPolicy()
  }, 30000)
})
onBeforeUnmount(() => {
  disposed = true
  clearDiarySearchOpen()
  searchNavigationSequence += 1
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
        <div v-if="calendarError" class="diary-life-error" role="alert">{{ calendarError }} <NButton text @click="retryCalendarStage()">重试</NButton></div>
        <DiaryLifeCalendar :markers="markers" :today="today" :selected-date="selected" :month="month" :revision="calendarRevision" @select="open" @month="month = $event" />
      </div>
      <div v-if="mode === 'tasks' && undatedTaskCount > 0" class="diary-undated-task-notice" data-testid="diary-undated-task-notice" role="status">
        <span>发现 {{ undatedTaskCount }} 条历史待办缺少截止日期，补充后会显示在日历中。</span>
        <span class="diary-undated-task-actions">
          <NButton text type="primary" :disabled="undatedTaskLoading || undatedTaskOpening" @click="openUndatedTaskRepair">补充截止日期</NButton>
          <NButton v-if="undatedTaskError" text @click="refreshUndatedTaskSummary">重试</NButton>
        </span>
      </div>
      <div v-else-if="mode === 'tasks' && undatedTaskError" class="diary-life-error" role="alert">
        {{ undatedTaskError }} <NButton text @click="refreshUndatedTaskSummary">重试</NButton>
      </div>
      <DiaryDayDialog
        v-if="selected !== null && mode === 'diary' && !eventDraft"
        :show="selected !== null && mode === 'diary' && !eventDraft"
        :date="selected"
        :day="day"
        :attachments="draftAttachments"
        :draft="draft"
        :mode="canWriteDay ? dayMode : 'read'"
        :future-date="serverToday !== null && !canWriteDay"
        :loading="loadingDay"
        :read-failed="dayReadFailed"
        :reveal-entry-id="searchReveal?.entryId"
        :reveal-entry-index="searchReveal?.entryIndex"
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
      <NModal
        v-if="eventSurfaceVisible"
        :show="eventSurfaceVisible"
        preset="card"
        class="diary-life-dialog"
        :class="{ 'diary-event-edit-dialog': eventSurface?.kind === 'edit' || eventSurface?.kind === 'task-edit', 'diary-task-edit-dialog': eventSurface?.kind === 'task-edit' }"
        :mask-closable="!busy && !attachmentBusy"
        :close-on-esc="!busy && !attachmentBusy"
        :auto-focus="false"
        :closable="false"
        @mask-click="preventDiaryBackdropClickThrough"
        @update:show="visible => !visible && closeEventSurface()"
      >
        <template #header>
          <span v-if="eventSurface?.kind === 'edit'">{{ eventSurface.event ? '编辑事件' : '新增事件' }}</span>
          <span v-else-if="eventSurface?.kind === 'task-edit'">{{ eventSurface.task ? '编辑待办' : '新增待办' }}</span>
          <span v-else>{{ selected }}</span>
        </template>
        <template #header-extra>
          <div class="diary-event-header-actions">
            <NButton
              v-if="eventSurface?.kind === 'day-list'"
              quaternary circle class="diary-day-list-add-button"
              :data-testid="mode === 'tasks' ? 'diary-add-task' : 'diary-add-event'"
              :aria-label="mode === 'tasks' ? '新增待办' : '新增重要日程'"
              :title="mode === 'tasks' ? '新增待办' : '新增重要日程'"
              :disabled="busy || attachmentBusy"
              @click="mode === 'tasks' ? createTaskFromDay() : createEvent()"
            ><NIcon aria-hidden="true" :size="16"><Plus /></NIcon></NButton>
            <NButton quaternary circle class="diary-event-close-button" :disabled="busy || attachmentBusy" :aria-label="eventSurface?.kind === 'edit' ? '关闭事件编辑' : eventSurface?.kind === 'task-edit' ? '关闭待办编辑' : mode === 'tasks' ? '关闭当天待办' : '关闭当天事件'" @click="closeEventSurface($event)">
              <NIcon aria-hidden="true" :size="16"><X /></NIcon>
            </NButton>
          </div>
        </template>

        <div v-if="eventDraft" class="diary-event-form-content">
          <p v-if="formError" class="diary-event-form-error" role="alert">{{ formError }}</p>
          <DiaryEventForm
            ref="eventForm"
            :model-value="eventDraft"
            :today="today"
            :is-editing="editing !== null"
            :inert="busy"
            @update:model-value="updateEventDraft"
          />
        </div>
        <div v-else-if="taskDraft" class="diary-event-form-content diary-task-form-content">
          <p v-if="taskFormError" class="diary-event-form-error" role="alert">{{ taskFormError }}</p>
          <NButton v-if="taskConflictNeedsReload" text type="primary" class="diary-task-reload" :disabled="busy" @click="reloadTaskEditor">重新加载</NButton>
          <DiaryTaskForm
            ref="taskForm"
            :key="editingTask?.id ?? 'new-task'"
            :model-value="taskDraft"
            :inert="busy"
            :today="today"
            :now="currentTimestamp"
            :allow-recurrence="!editingTask || editingTask.kind === 'recurring'"
            :lock-recurrence-start="editingTask?.kind === 'recurring'"
            :status-task="editingTask"
            @update:model-value="updateTaskDraft"
          />
        </div>
        <div
          v-else
          class="day-list-content"
          :class="{ 'day-list-content--empty': mode === 'tasks' ? !selectedTasks.length && !calendarTasksLoading && !calendarTaskError : !selectedEvents.length && !calendarEventLoading && !eventCalendarError }"
        >
          <section v-if="mode === 'tasks'" class="day-list-section day-tasks">
            <div v-if="calendarTasksLoading && !selectedTasks.length" class="diary-day-status" role="status"><NSpin size="small" /><span>正在加载待办…</span></div>
            <div v-if="calendarTaskError" class="diary-day-status" role="alert">
              <span>{{ calendarTaskError }}</span>
              <NButton text type="primary" @click="reloadCalendarTasks">重试</NButton>
            </div>
            <DiaryTaskRows v-if="selectedTasks.length"
              :items="selectedTasks"
              :today="today"
              :now="currentTimestamp"
              :busy-ids="busyTaskIds"
              :highlighted-id="searchHighlight?.kind === 'task' ? searchHighlight.id : null"
              :show-due-date="false"
              @toggle="toggleTask($event, { kind: 'day-list', date: selected ?? '', taskId: $event.id, restoreFocus: true })"
              @edit="editTaskFromDay"
            />
          </section>
          <section v-else-if="mode === 'events'" class="day-list-section day-events">
            <div v-if="calendarEventLoading && !selectedEvents.length" class="diary-day-status" role="status"><NSpin size="small" /><span>正在加载事件…</span></div>
            <div v-if="eventCalendarError" class="diary-day-status" role="alert">
              <span>{{ eventCalendarError }}</span>
              <NButton text type="primary" @click="reloadCalendarEvents">重试</NButton>
            </div>
            <DiaryEventRow
              v-for="event in selectedEvents"
              :key="event.id"
              :title="displayEventTitle(event, selected)"
              :emoji="event.emoji"
              :single-line="true"
              :search-highlighted="searchHighlight?.kind === 'event' && searchHighlight.id === event.id"
              :data-event-id="event.id"
              :aria-label="dayEventLabel(event)"
              @click="selectEventFromDay(event, $event)"
            >
              <small class="diary-task-detail diary-event-distance">{{ selectedEventDistance(event) }}</small>
            </DiaryEventRow>
          </section>
        </div>

        <template v-if="eventSurface?.kind === 'task-edit'" #footer>
          <div class="diary-task-footer">
            <div v-if="editingTask?.kind === 'recurring'" class="diary-task-series-actions">
              <NButton v-if="editingTask.skipped" quaternary size="small" :disabled="busy || dirty" @click="changeEditedOccurrenceState">恢复本次</NButton>
              <NButton v-else-if="editingTask.completedAt === null" quaternary size="small" :disabled="busy || dirty" @click="changeEditedOccurrenceState">跳过本次</NButton>
              <NButton v-if="editingTask.recurrence.untilDate !== editingTask.occurrenceDate" quaternary size="small" :disabled="busy || dirty" @click="stopEditedSeries">结束重复</NButton>
            </div>
            <div class="life-actions">
              <NButton v-if="editingTask" quaternary type="error" size="medium" :disabled="busy" @click="deleteTask">删除</NButton>
              <span />
              <NButton size="medium" :disabled="busy" @click="cancelTaskEdit($event)">取消</NButton>
              <NButton type="primary" size="medium" :loading="busy" @click="saveTask">保存</NButton>
            </div>
          </div>
        </template>
        <template v-if="eventSurface?.kind === 'edit'" #footer>
          <div class="life-actions">
            <NButton v-if="editing" quaternary type="error" size="medium" :disabled="busy" @click="remove">删除事件</NButton>
            <span />
            <NButton size="medium" :disabled="busy" @click="cancelEventEdit($event)">取消</NButton>
            <NButton type="primary" size="medium" :loading="busy" @click="save($event.detail === 0)">保存</NButton>
          </div>
        </template>
      </NModal>
    </template>
    <NButton v-else v-show="!accessContext?.dialogOpen.value" class="unlock-diary" @click="accessContext?.requestAccess()">解锁日程</NButton>
  </main>
</template>

<style scoped>
.diary-life {
  width: 100%;
  min-width: 0;
  height: calc(100dvh - var(--navbar-h, 36px));
  box-sizing: border-box;
  padding: 24px 20px clamp(16px, 3dvh, 32px);
  overflow: auto;
  color: var(--text);
  scrollbar-width: none;
}
.diary-life::-webkit-scrollbar { display: none; width: 0; height: 0; }
.diary-life-calendar-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.diary-life-error { margin-top: 8px; padding: 8px 0; }
.diary-undated-task-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 auto 12px; padding: 10px 14px; max-width: 1100px; border: 1px solid var(--border, #e5e7eb); border-radius: 12px; background: var(--surface-muted, #f9fafb); color: var(--text-muted, #6b7280); font-size: 13px; }
.diary-undated-task-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.diary-event-form-error { margin: 0 0 14px; color: var(--danger, #dc2626); }
.diary-task-reload { margin: -4px 0 12px; }
.day-list-section { min-width: 0; }
.diary-day-list-add-button.n-button { width: 32px; min-width: 32px; height: 32px; border-radius: 50%; color: var(--text-muted, #6b7280); }
.diary-day-list-add-button :deep(svg) { stroke-width: 1.6px; }
.diary-day-list-add-button.n-button:hover:not(:disabled) { background-color: color-mix(in srgb, var(--text) 4%, transparent); }
.diary-day-list-add-button.n-button:focus-visible { outline: 2px solid var(--primary, #6366f1); outline-offset: 2px; }
.life-actions { display: flex; align-items: center; gap: 8px; }.life-actions > span { flex: 1; }
.diary-task-footer { display: flex; flex-direction: column; gap: 8px; }
.diary-task-series-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.diary-event-header-actions { display: flex; align-items: center; gap: 4px; }
.diary-day-status { display: flex; align-items: center; gap: 8px; padding: 4px 0; color: var(--text-muted, #6b7280); }
.diary-event-distance { min-width: 0; color: var(--text-muted, #6b7280); font-size: 12px; font-weight: 400; line-height: 20px; text-align: right; white-space: nowrap; }
.unlock-diary { display: block; margin: 20vh auto; }
@media (max-width: 520px) {
  .diary-undated-task-notice { align-items: flex-start; flex-direction: column; gap: 4px; }
}
@media (hover: hover) and (pointer: fine) and (not (any-pointer: coarse)) {
  .diary-day-list-add-button { opacity: 0; transition: opacity 140ms ease; }
  .diary-event-header-actions:hover .diary-day-list-add-button,
  .diary-event-header-actions:focus-within .diary-day-list-add-button { opacity: 1; }
}
@media (hover: none), (pointer: coarse) {
  .diary-day-list-add-button.n-button { width: 40px; min-width: 40px; height: 40px; opacity: .68; }
}
@media (prefers-reduced-motion: reduce) { .diary-day-list-add-button { transition: none; } }
@media (max-width: 600px) { .diary-life { padding: 16px 8px clamp(16px, 3dvh, 32px); } }
</style>
<style>
.diary-life-dialog:has(.day-list-content--empty) .n-card__content { padding-top: 0; padding-bottom: 0; }
.diary-life-dialog.n-card { width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; scrollbar-width: none; }
.diary-life-dialog.n-card::-webkit-scrollbar { display: none; }
.diary-event-edit-dialog.n-card {
  display: flex;
  flex-direction: column;
  width: min(700px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  overflow: hidden;
}
.diary-task-edit-dialog.n-card { width: min(540px, calc(100vw - 32px)); }
.diary-event-edit-dialog .n-card-header,
.diary-event-edit-dialog .n-card__footer { flex: none; }
.diary-event-edit-dialog .n-card-content {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.diary-event-edit-dialog .n-card-content::-webkit-scrollbar { display: none; width: 0; height: 0; }
.diary-event-edit-dialog .diary-event-form-content { min-width: 0; }
.diary-event-edit-dialog .n-card__footer {
  padding: 12px 24px 16px;
  border-top: 1px solid var(--border, #8883);
  background: var(--card-color, var(--bg));
}
.diary-life-dialog .diary-event-close-button.n-button,
.diary-life-dialog .diary-day-list-add-button.n-button {
  width: 32px;
  height: 32px;
  min-width: 32px;
  padding: 0;
  border-radius: 50%;
  color: var(--text-muted, #6b7280);
  background-color: transparent;
}
.diary-life-dialog .diary-event-close-button.n-button:hover,
.diary-life-dialog .diary-day-list-add-button.n-button:hover {
  background-color: color-mix(in srgb, var(--text) 4%, transparent);
}
.diary-life-dialog .diary-event-close-button.n-button:focus-visible,
.diary-life-dialog .diary-day-list-add-button.n-button:focus-visible {
  outline: 2px solid var(--primary, #6366f1);
  outline-offset: 2px;
}
@media (max-width: 600px) {
  .diary-life-dialog.n-card { position: fixed; bottom: 0; left: 0; width: 100%; max-height: 90dvh; margin: 0; border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom); }
  .diary-life-dialog .diary-event-close-button.n-button, .diary-life-dialog .diary-day-list-add-button.n-button { width: 40px; height: 40px; min-width: 40px; }
  .diary-event-edit-dialog.n-card { max-height: 90dvh; }
  .diary-event-edit-dialog .n-card__footer { padding-inline: 16px; }
}
</style>
