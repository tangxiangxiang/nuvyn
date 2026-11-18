<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { NButton, NIcon, NModal, NSpin } from 'naive-ui'
import { Plus, X } from '@vicons/tabler'
import { Temporal } from '@js-temporal/polyfill'
import { DiaryAccessContextKey } from '../composables/diary/diaryAccessContext'
import { AppShellContextKey } from '../composables/appShellContext'
import { captureDiarySessionGeneration, isDiarySessionGenerationCurrent, subscribeDiaryTeardown, useDiaryAccessSession } from '../composables/diary/useDiaryAccessSession'
import { useDiaryMoodIconPreferences } from '../composables/diary/useDiaryMoodIconPreferences'
import { useAuth } from '../composables/useAuth'
import { useConfirm } from '../composables/useConfirm'
import { useToast } from '../composables/useToast'
import DiaryActionMenu from '../components/diary/DiaryActionMenu.vue'
import { createDiaryEntryId, createDiaryEventId, diaryLifeApi } from '../lib/diary-life-api'
import { createDiaryAttachmentClientId, diaryAttachmentsApi } from '../lib/diary-attachments-api'
import { DiaryAttachmentPreviewUrls } from '../lib/diaryAttachmentPreviewUrls'
import { addDays, compareEvents, displayEventTitle, localToday, MAX_DIARY_IMAGE_GROUP_SIZE, nextOccurrence, occursOn, parseDay, parseEvent, type DiaryDay, type DiaryDaySummary, type DiaryEvent, type DayFields, type DiaryImageGroup, type EventFields } from '../../shared/diaryLife'
import { parseTaskFields, parseTaskSeriesFields, taskTimeFieldsError, type DiaryRecurringTaskOccurrence, type DiaryTaskListItem, type DiaryTaskListStatus, type TaskEditorFields } from '../../shared/diaryTasks'
import { DIARY_ATTACHMENT_STAGE_HEARTBEAT_INTERVAL_MS, MAX_DIARY_ATTACHMENT_BYTES, MAX_DIARY_DAY_ATTACHMENTS, type DiaryAttachment } from '../../shared/diaryAttachments'
import { NUVYN_BROWSER_STORAGE_KEYS, ownerScopedStorageKey, readStorageKey, writeStorageKey } from '../technicalNamespace'
import DiaryLifeCalendar from '../components/diary/DiaryLifeCalendar.vue'
import DiaryDayDialog from '../components/diary/DiaryDayDialog.vue'
import DiaryEventForm from '../components/diary/DiaryEventForm.vue'
import DiaryEventReader from '../components/diary/DiaryEventReader.vue'
import DiaryEventListDialog from '../components/diary/DiaryEventListDialog.vue'
import DiaryTaskForm from '../components/diary/DiaryTaskForm.vue'
import DiaryTaskRows from '../components/diary/DiaryTaskRows.vue'
import '../components/diary/diaryCloudCard.css'
import { DiaryTaskConflictError, DiaryTaskHistoryProtectedError, DiaryTaskListChangedError, diaryTasksApi } from '../lib/diary-tasks-api'
import { groupTasksByDueDate, listDiaryTasksInRange } from '../features/diary/diaryTaskCalendar'
import { eventEmojiSource } from '../features/diary/eventEmoji'
import { clearDiarySearchOpen, consumeDiarySearchOpen, diarySearchOpenIntent, type DiarySearchOpenIntent } from '../composables/diary/useDiarySearchNavigation'

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
const mode = ref<'diary' | 'events'>('diary')
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
  | { kind: 'day-list'; date: string; eventId: string; restoreFocus: boolean }
  | { kind: 'recent-list'; scrollTop: number; eventId: string; restoreFocus: boolean }
type TaskReturnContext =
  | { kind: 'day-list'; date: string; taskId: string; restoreFocus: boolean }
  | { kind: 'recent-list'; scrollTop: number; taskId: string; restoreFocus: boolean }
type EventFocusTarget = 'container' | 'edit' | null
type EventSurface =
  | { kind: 'day-list'; date: string }
  | { kind: 'recent-list' }
  | { kind: 'read'; event: DiaryEvent; occurrenceDate: string; returnTo: EventReturnContext; focusTarget: EventFocusTarget }
  | { kind: 'edit'; event: DiaryEvent | null; eventId: string; draft: EventFields; initial: string; occurrenceDate: string; returnTo: EventReturnContext; focusReturnToReader: boolean }
  | { kind: 'task-edit'; task: DiaryTaskListItem | null; draft: TaskEditorFields; initial: string; returnTo: TaskReturnContext }
const eventSurface = ref<EventSurface | null>(null)
const initial = ref('')
const busy = ref(false)
const loadingDay = ref(false)
const attachmentBusy = ref(false)
const attachmentError = ref('')
const dayReadFailed = ref(false)
const searchReveal = ref<{ entryId?: string; entryIndex?: number } | null>(null)
const diaryCalendarError = ref('')
const eventCalendarError = ref('')
const calendarTaskError = ref('')
const calendarEventLoading = ref(false)
const formError = ref('')
const today = ref(localToday())
const serverToday = ref<string | null>(null)
const canWriteDay = computed(() => selected.value !== null && serverToday.value !== null && selected.value <= serverToday.value)
const eventListDialog = ref<InstanceType<typeof DiaryEventListDialog> | null>(null)
const eventForm = ref<{ validate: () => boolean } | null>(null)
const taskForm = ref<InstanceType<typeof DiaryTaskForm> | null>(null)
const eventListVisible = computed(() => eventSurface.value?.kind === 'recent-list')
const eventDraft = computed(() => eventSurface.value?.kind === 'edit' ? eventSurface.value.draft : null)
const taskDraft = computed(() => eventSurface.value?.kind === 'task-edit' ? eventSurface.value.draft : null)
const editing = computed(() => eventSurface.value?.kind === 'edit' ? eventSurface.value.event : null)
const editingTask = computed(() => eventSurface.value?.kind === 'task-edit' ? eventSurface.value.task : null)
const eventSurfaceVisible = computed(() => access.isUnlocked.value && eventSurface.value !== null)
const eventListItems = ref<DiaryEvent[]>([])
const eventListNext = ref<number | null>(0)
const eventListLoaded = ref(false)
const eventListLoading = ref(false)
const eventListLoadingMore = ref(false)
const eventListError = ref('')
const calendarTasks = ref<DiaryTaskListItem[]>([])
const calendarTasksLoading = ref(false)
const calendarTasksByDate = computed(() => groupTasksByDueDate(calendarTasks.value))
const calendarError = computed(() => mode.value === 'diary' ? diaryCalendarError.value : eventCalendarError.value)
const recentTaskItems = ref<DiaryTaskListItem[]>([])
const recentTaskStatus = ref<DiaryTaskListStatus>('open')
const recentTaskNext = ref<string | null>(null)
const recentTaskLoaded = ref(false)
const recentTaskLoading = ref(false)
const recentTaskLoadingMore = ref(false)
const recentTaskError = ref('')
const busyTaskIds = ref(new Set<string>())
const eventReaderTasks = ref<DiaryTaskListItem[]>([])
const taskEventOptions = ref<Array<{ label: string; value: string }>>([])
const taskEventOptionsLoading = ref(false)
const taskEventOptionsLoaded = ref(false)
const taskFormError = ref('')
const taskConflictNeedsReload = ref(false)
const eventDayActions = [
  { key: 'create', label: '新增事件' },
  { key: 'create-task', label: '新增待办' },
]

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
  if (document.visibilityState === 'visible') {
    void refreshDayPolicy()
    void renewAttachmentSession()
  }
}
type CalendarLoadContext = {
  start: string
  end: string
  mode: 'diary' | 'events'
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
let attachmentUploadRequest: AbortController | null = null
let attachmentLeaseRequest: AbortController | null = null
let attachmentLeaseTimer: ReturnType<typeof setInterval> | undefined
const attachmentSessionId = ref<string | null>(null)
const attachmentPreviewUrls = new DiaryAttachmentPreviewUrls()
let eventListRequest: AbortController | null = null
let recentTaskRequest: AbortController | null = null
let taskDetailRequest: AbortController | null = null
let eventReaderTaskRequest: AbortController | null = null
let taskEventOptionsRequest: AbortController | null = null
let taskEventOptionsSequence = 0
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
  mode.value = key && readStorageKey(key) === 'events' ? 'events' : 'diary'
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
const markers = computed(() => {
  const result: Record<string, { source?: string; emoji?: string; count?: number; hasEntries?: boolean; hasAttachments?: boolean; hasTasks?: boolean }> = {}
  if (mode.value === 'diary') {
    for (const d of days.value) {
      if (d.moodId) result[d.date] = { source: preferences.sourceFor(d.moodId), hasAttachments: d.hasAttachments }
      else if (d.hasEntries || d.hasAttachments) result[d.date] = { hasEntries: d.hasEntries, hasAttachments: d.hasAttachments }
    }
  } else {
    for (let date = range.value.start; date <= range.value.end; date = addDays(date, 1)) {
      const matches = events.value.filter(e => occursOn(e, date)).sort(compareEvents)
      const hasTasks = (calendarTasksByDate.value.get(date) ?? []).some(task => task.completedAt === null
        && !(task.kind === 'recurring' && task.skipped))
      if (matches[0]) result[date] = { source: eventEmojiSource(matches[0].emoji), emoji: matches[0].emoji, count: matches.length, hasTasks }
      else if (hasTasks) result[date] = { hasTasks: true }
    }
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
  if (!context || context.mode !== 'events') return Promise.resolve()
  prepareCalendarContext(context)
  return loadCalendarTasks(context, true)
}

function retryCalendarStage(): Promise<void> {
  const context = getCalendarLoadContext()
  if (!context) return Promise.resolve()
  prepareCalendarContext(context)
  return context.mode === 'diary'
    ? loadCalendarDays(context, true)
    : loadCalendarEvents(context, true)
}

function load(refresh = false): Promise<void> {
  const context = getCalendarLoadContext()
  if (!context) return Promise.resolve()
  prepareCalendarContext(context)
  if (context.mode === 'diary') return loadCalendarDays(context, refresh)
  return Promise.all([
    loadCalendarEvents(context, refresh),
    loadCalendarTasks(context, refresh),
  ]).then(() => undefined)
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
  eventReaderTaskRequest?.abort()
  eventReaderTaskRequest = null
  eventReaderTasks.value = []
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
}

function clearPrivateData() {
  clearDiarySearchOpen()
  searchNavigationSequence += 1
  taskContextSequence += 1
  diaryCalendarRequest?.controller.abort()
  eventCalendarRequest?.controller.abort()
  calendarTaskRequest?.controller.abort()
  diaryCalendarRequest = null
  eventCalendarRequest = null
  calendarTaskRequest = null
  calendarContextKey = ''
  eventListRequest?.abort()
  eventListRequest = null
  recentTaskRequest?.abort()
  recentTaskRequest = null
  taskDetailRequest?.abort()
  taskDetailRequest = null
  eventReaderTaskRequest?.abort()
  eventReaderTaskRequest = null
  taskEventOptionsRequest?.abort()
  taskEventOptionsRequest = null
  busy.value = false
  clearShellCommands()
  cancelConfirmation?.()
  resetForm()
  days.value = []
  events.value = []
  calendarTasks.value = []
  diaryCalendarError.value = ''
  eventCalendarError.value = ''
  calendarTaskError.value = ''
  calendarEventLoading.value = false
  calendarTasksLoading.value = false
  eventListItems.value = []
  eventListNext.value = 0
  eventListLoaded.value = false
  eventListLoading.value = false
  eventListLoadingMore.value = false
  eventListError.value = ''
  recentTaskItems.value = []
  recentTaskStatus.value = 'open'
  recentTaskNext.value = null
  recentTaskLoaded.value = false
  recentTaskLoading.value = false
  recentTaskLoadingMore.value = false
  recentTaskError.value = ''
  busyTaskIds.value = new Set()
  eventReaderTasks.value = []
  taskEventOptions.value = []
  taskEventOptionsLoading.value = false
  taskEventOptionsLoaded.value = false
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
}

async function loadEventList(reset = false, minimumItems = 0) {
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
    const items: DiaryEvent[] = []
    let next: number | null = offset
    do {
      const result: Awaited<ReturnType<typeof diaryLifeApi.eventListPage>> = await diaryLifeApi.eventListPage(next, scope.signal)
      if (scope.signal.aborted || eventListRequest !== scope) return
      items.push(...result.items)
      next = result.next
    } while (next !== null && items.length < minimumItems)
    eventListItems.value = reset ? items : [...eventListItems.value, ...items]
    eventListNext.value = next
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

async function loadRecentTasks(reset = false, minimumItems = 0) {
  if (!access.isUnlocked.value) return
  if (!reset && (recentTaskLoading.value || recentTaskLoadingMore.value || recentTaskNext.value === null)) return

  const currentStatus = recentTaskStatus.value
  if (reset) {
    recentTaskRequest?.abort()
    recentTaskItems.value = []
    recentTaskNext.value = null
    recentTaskLoaded.value = false
  }
  const initialCursor = reset ? undefined : recentTaskNext.value ?? undefined
  const scope = new AbortController()
  const isCurrent = capturePrivateOperation()
  recentTaskRequest = scope
  if (reset) recentTaskLoading.value = true
  else recentTaskLoadingMore.value = true
  recentTaskError.value = ''

  try {
    const items = reset ? [] : [...recentTaskItems.value]
    let cursor = initialCursor
    let listChangeRetries = 0
    do {
      let page
      try {
        page = await diaryTasksApi.listTaskItems(addDays(today.value, -30), addDays(today.value, 90), cursor, scope.signal, currentStatus)
      } catch (cause) {
        if (scope.signal.aborted || recentTaskRequest !== scope || !isCurrent() || currentStatus !== recentTaskStatus.value) return
        if (cause instanceof DiaryTaskListChangedError && cursor !== undefined && listChangeRetries < 2) {
          listChangeRetries += 1
          items.length = 0
          cursor = undefined
          recentTaskItems.value = []
          recentTaskNext.value = null
          recentTaskLoaded.value = false
          recentTaskLoading.value = true
          recentTaskLoadingMore.value = false
          continue
        }
        throw cause
      }
      if (scope.signal.aborted || recentTaskRequest !== scope || !isCurrent() || currentStatus !== recentTaskStatus.value) return
      const unique = new Map(items.map(task => [task.id, task]))
      for (const task of page.items) unique.set(task.id, task)
      items.splice(0, items.length, ...unique.values())
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined && items.length < minimumItems)

    if (scope.signal.aborted || recentTaskRequest !== scope || !isCurrent() || currentStatus !== recentTaskStatus.value) return
    recentTaskItems.value = items
    recentTaskNext.value = cursor ?? null
    recentTaskLoaded.value = true
  } catch {
    if (!scope.signal.aborted && recentTaskRequest === scope && isCurrent()) recentTaskError.value = '待办加载失败，请重试。'
  } finally {
    if (recentTaskRequest === scope) {
      recentTaskRequest = null
      recentTaskLoading.value = false
      recentTaskLoadingMore.value = false
    }
  }
}

function invalidateRecentTasks(reload = false, minimumItems = 0) {
  recentTaskRequest?.abort()
  recentTaskRequest = null
  recentTaskLoading.value = false
  recentTaskLoadingMore.value = false
  recentTaskItems.value = []
  recentTaskNext.value = null
  recentTaskLoaded.value = false
  recentTaskError.value = ''
  if (reload) void loadRecentTasks(true, minimumItems)
}

function setRecentTaskStatus() {
  if (recentTaskLoading.value || recentTaskLoadingMore.value) return
  recentTaskStatus.value = recentTaskStatus.value === 'open' ? 'completed' : 'open'
  void loadRecentTasks(true)
}

function capturePrivateOperation() {
  const generation = captureDiarySessionGeneration()
  const owner = storageKey.value
  return () => !disposed && isDiarySessionGenerationCurrent(generation) && storageKey.value === owner && access.isUnlocked.value
}

async function openEventList() {
  const isCurrent = capturePrivateOperation()
  if (!(await canLeave()) || !isCurrent()) return
  await discardPendingAttachments()
  if (!isCurrent()) return
  resetForm()
  mode.value = 'events'
  eventSurface.value = { kind: 'recent-list' }
  if (!eventListLoaded.value) void loadEventList(true)
  void loadRecentTasks(true)
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

function selectEventFromList(event: DiaryEvent, scrollTop: number, keyboardActivated = false) {
  if (eventSurface.value?.kind !== 'recent-list') return
  const occurrenceDate = eventNavigationDate(event)
  selected.value = null
  syncCalendarToDate(occurrenceDate)
  startEventRead(event, occurrenceDate, { kind: 'recent-list', scrollTop, eventId: event.id, restoreFocus: keyboardActivated }, keyboardActivated ? 'container' : null)
}

function selectEventFromDay(event: DiaryEvent, interaction?: MouseEvent) {
  const surface = eventSurface.value
  if (surface?.kind !== 'day-list') return
  const keyboardActivated = interaction?.detail === 0
  startEventRead(
    event,
    surface.date,
    { kind: 'day-list', date: surface.date, eventId: event.id, restoreFocus: keyboardActivated },
    keyboardActivated ? 'container' : null,
  )
}

function focusEventDialogFallback() {
  document.querySelector<HTMLButtonElement>('.diary-life-dialog .diary-event-close-button')?.focus({ preventScroll: true })
}

function restoreEventContext(context: EventReturnContext) {
  formError.value = ''
  if (context.kind === 'day-list') {
    syncCalendarToDate(context.date)
    selected.value = context.date
    eventSurface.value = { kind: 'day-list', date: context.date }
  } else {
    selected.value = null
    eventSurface.value = { kind: 'recent-list' }
  }

  const isCurrent = capturePrivateOperation()
  void nextTick(() => {
    if (!isCurrent()) return
    if (context.kind === 'recent-list') {
      if (eventSurface.value?.kind !== 'recent-list') return
      eventListDialog.value?.restoreScroll(context.scrollTop)
      if (context.restoreFocus && !eventListDialog.value?.focusEvent(context.eventId)) focusEventDialogFallback()
      return
    }
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
  if (context.kind === 'day-list') {
    syncCalendarToDate(context.date)
    selected.value = context.date
    eventSurface.value = { kind: 'day-list', date: context.date }
  } else {
    selected.value = null
    eventSurface.value = { kind: 'recent-list' }
  }
}

function focusTaskContext(context: TaskReturnContext) {
  if (!context.restoreFocus) return
  if (context.kind === 'recent-list') {
    if (!eventListDialog.value?.focusTask(context.taskId)) focusEventDialogFallback()
    return
  }
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
    && (context.kind === 'recent-list' || (selected.value === context.date && month.value === expectedMonth))
  if (context.kind === 'recent-list') {
    if (!eventListLoaded.value) void loadEventList(true)
    if (!recentTaskLoaded.value) void loadRecentTasks(true)
  }
  void nextTick(() => {
    if (!isContextCurrent()) return
    if (context.kind === 'recent-list') eventListDialog.value?.restoreScroll(context.scrollTop)
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
    eventId: null,
  }
  return task
    ? { title: task.title, description: task.description, startDate: task.startDate, startTime: task.startTime, dueDate: task.dueDate, dueTime: task.dueTime, recurrence: null, eventId: task.eventId ?? null }
    : { title: '', description: '', startDate: null, startTime: null, dueDate, dueTime: null, recurrence: null, eventId: null }
}

function startTaskEdit(task: DiaryTaskListItem | null, returnTo: TaskReturnContext) {
  if (busy.value || attachmentBusy.value || !access.isUnlocked.value) return
  taskEventOptionsRequest?.abort()
  taskEventOptionsRequest = null
  taskEventOptionsSequence += 1
  taskEventOptions.value = []
  taskEventOptionsLoading.value = false
  taskEventOptionsLoaded.value = false
  const draft = taskFields(task, returnTo.kind === 'day-list' ? returnTo.date : null)
  eventSurface.value = { kind: 'task-edit', task, draft, initial: JSON.stringify(draft), returnTo }
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
  if (task?.kind === 'one-off' && task.eventId) void loadCurrentTaskEventOption(task.eventId, returnTo)
  if (!task) {
    const isCurrent = capturePrivateOperation()
    void nextTick(() => {
      if (isCurrent() && eventSurface.value?.kind === 'task-edit') taskForm.value?.focusTitle()
    })
  }
}

function taskEventOption(event: DiaryEvent): { label: string; value: string } {
  return { label: `${event.startDate} · ${displayEventTitle(event, event.startDate)}`, value: event.id }
}

function isLinkableTaskEvent(event: DiaryEvent): boolean {
  return event.type === 'schedule' && event.recurrence === 'none'
}

async function loadCurrentTaskEventOption(eventId: string, returnTo: TaskReturnContext) {
  const editor = eventSurface.value
  if (editor?.kind !== 'task-edit' || editor.returnTo !== returnTo) return
  const controller = new AbortController()
  taskEventOptionsRequest = controller
  const sequence = ++taskEventOptionsSequence
  const isCurrent = capturePrivateOperation()
  try {
    const result = await diaryLifeApi.event(eventId, controller.signal)
    if (controller.signal.aborted || sequence !== taskEventOptionsSequence || !isCurrent()
      || eventSurface.value?.kind !== 'task-edit' || eventSurface.value.returnTo !== returnTo) return
    if (isLinkableTaskEvent(result.event)) taskEventOptions.value = [taskEventOption(result.event)]
  } catch {
    // A deleted or no-longer-linkable Event is safely cleared by the server.
  } finally {
    if (taskEventOptionsRequest === controller) taskEventOptionsRequest = null
  }
}

async function loadTaskEventOptions() {
  const editor = eventSurface.value
  if (editor?.kind !== 'task-edit' || editor.draft.recurrence || !access.isUnlocked.value
    || taskEventOptionsLoaded.value || taskEventOptionsLoading.value) return
  taskEventOptionsRequest?.abort()
  const controller = new AbortController()
  taskEventOptionsRequest = controller
  const sequence = ++taskEventOptionsSequence
  const isCurrent = capturePrivateOperation()
  const isEditorCurrent = () => eventSurface.value?.kind === 'task-edit'
    && eventSurface.value.returnTo === editor.returnTo
    && eventSurface.value.task?.id === editor.task?.id
  taskEventOptionsLoading.value = true
  try {
    const options = new Map(taskEventOptions.value.map(option => [option.value, option]))
    let offset: number | null = 0
    while (offset !== null) {
      const page = await diaryLifeApi.eventListPage(offset, controller.signal)
      if (controller.signal.aborted || sequence !== taskEventOptionsSequence || !isCurrent() || !isEditorCurrent()) return
      for (const event of page.items) if (isLinkableTaskEvent(event)) options.set(event.id, taskEventOption(event))
      offset = page.next
    }
    taskEventOptions.value = [...options.values()].sort((left, right) => left.label.localeCompare(right.label))
    taskEventOptionsLoaded.value = true
  } catch {
    if (!controller.signal.aborted && sequence === taskEventOptionsSequence && isCurrent() && isEditorCurrent()) {
      taskFormError.value = '日程加载失败，请重试。'
    }
  } finally {
    if (taskEventOptionsRequest === controller) taskEventOptionsRequest = null
    if (sequence === taskEventOptionsSequence) taskEventOptionsLoading.value = false
  }
}

function createTaskFromDay() {
  const surface = eventSurface.value
  if (surface?.kind !== 'day-list' || !access.isUnlocked.value || busy.value || attachmentBusy.value) return
  startTaskEdit(null, { kind: 'day-list', date: surface.date, taskId: '', restoreFocus: false })
}

function createTaskFromRecent() {
  if (eventSurface.value?.kind !== 'recent-list' || busy.value || !access.isUnlocked.value) return
  startTaskEdit(null, { kind: 'recent-list', scrollTop: eventListDialog.value?.getScrollTop() ?? 0, taskId: '', restoreFocus: false })
}

function editTaskFromDay(task: DiaryTaskListItem, keyboardActivated: boolean) {
  if (selected.value === null || eventSurface.value?.kind !== 'day-list') return
  startTaskEdit(task, { kind: 'day-list', date: selected.value, taskId: task.id, restoreFocus: keyboardActivated })
}

function editTaskFromRecent(task: DiaryTaskListItem, scrollTop: number, keyboardActivated: boolean) {
  if (eventSurface.value?.kind !== 'recent-list') return
  startTaskEdit(task, { kind: 'recent-list', scrollTop, taskId: task.id, restoreFocus: keyboardActivated })
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
  const minimumItems = context.kind === 'recent-list' ? recentTaskItems.value.length : 0
  activateTaskContext(context)
  const expectedSurface = eventSurface.value
  const expectedMonth = month.value
  const isCurrent = () => isCurrentSession()
    && taskContextSequence === sequence
    && eventSurface.value === expectedSurface
    && (context.kind === 'recent-list' || (selected.value === context.date && month.value === expectedMonth))
  if (context.kind !== 'recent-list') invalidateRecentTasks()
  await Promise.all([
    reloadCalendarTasks(),
    context.kind === 'recent-list' ? loadRecentTasks(true, minimumItems) : Promise.resolve(),
    context.kind === 'recent-list' && !eventListLoaded.value ? loadEventList(true) : Promise.resolve(),
  ])
  if (!isCurrent()) return
  await nextTick()
  if (!isCurrent()) return
  if (context.kind === 'recent-list') eventListDialog.value?.restoreScroll(context.scrollTop)
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
    if (context.kind === 'recent-list' && task.completedAt !== null) recentTaskStatus.value = 'open'
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
  if (context.kind === 'recent-list') return eventSurface.value?.kind === 'recent-list'
  return eventSurface.value?.kind === 'day-list' && eventSurface.value.date === context.date
}

function startEventRead(event: DiaryEvent, occurrenceDate: string, returnTo: EventReturnContext, focusTarget: EventFocusTarget = null) {
  if (busy.value || eventSurface.value?.kind === 'edit' || !access.isUnlocked.value) return
  eventReaderTaskRequest?.abort()
  eventReaderTaskRequest = null
  eventReaderTasks.value = []
  eventSurface.value = { kind: 'read', event, occurrenceDate, returnTo, focusTarget }
  if (isLinkableTaskEvent(event)) void loadEventReaderTasks(event.id)
}

async function loadEventReaderTasks(eventId: string) {
  const surface = eventSurface.value
  if (surface?.kind !== 'read' || surface.event.id !== eventId || !isLinkableTaskEvent(surface.event)) return
  eventReaderTaskRequest?.abort()
  const controller = new AbortController()
  eventReaderTaskRequest = controller
  const isCurrent = capturePrivateOperation()
  try {
    const result = await diaryTasksApi.eventTasks(eventId, controller.signal)
    if (controller.signal.aborted || !isCurrent() || eventSurface.value?.kind !== 'read' || eventSurface.value.event.id !== eventId) return
    eventReaderTasks.value = result.tasks.map(task => ({ ...task, kind: 'one-off' as const }))
  } catch {
    if (!controller.signal.aborted && isCurrent() && eventSurface.value?.kind === 'read' && eventSurface.value.event.id === eventId) {
      toast.error('相关待办加载失败。')
    }
  } finally {
    if (eventReaderTaskRequest === controller) eventReaderTaskRequest = null
  }
}

async function toggleEventReaderTask(task: DiaryTaskListItem) {
  const surface = eventSurface.value
  if (surface?.kind !== 'read' || task.kind === 'recurring' || busyTaskIds.value.has(task.id) || !access.isUnlocked.value) return
  const eventId = surface.event.id
  const isCurrent = capturePrivateOperation()
  busyTaskIds.value = new Set(busyTaskIds.value).add(task.id)
  try {
    const result = task.completedAt === null
      ? await diaryTasksApi.completeTask(task.id, task.version)
      : await diaryTasksApi.reopenTask(task.id, task.version)
    if (!isCurrent() || eventSurface.value?.kind !== 'read' || eventSurface.value.event.id !== eventId) return
    const updated: DiaryTaskListItem = { ...result.task, kind: 'one-off' }
    eventReaderTasks.value = eventReaderTasks.value.map(item => item.id === updated.id ? updated : item)
    updateCalendarTask(updated)
    await Promise.all([
      reloadCalendarTasks(),
      recentTaskLoaded.value ? loadRecentTasks(true, recentTaskItems.value.length) : Promise.resolve(),
    ])
  } catch (cause) {
    if (!isCurrent()) return
    toast.error(cause instanceof DiaryTaskConflictError ? '待办已在其他设备更新，列表已刷新。' : '待办更新失败，请重试。')
    await loadEventReaderTasks(eventId)
    await Promise.all([
      reloadCalendarTasks(),
      recentTaskLoaded.value ? loadRecentTasks(true, recentTaskItems.value.length) : Promise.resolve(),
    ])
  } finally {
    if (isCurrent()) {
      const next = new Set(busyTaskIds.value)
      next.delete(task.id)
      busyTaskIds.value = next
    }
  }
}

function startEventEditFromReader(keyboardActivated = false) {
  const surface = eventSurface.value
  if (surface?.kind !== 'read' || busy.value || !access.isUnlocked.value) return
  const draft: EventFields = {
    ...surface.event,
    ...(surface.event.dateRule ? { dateRule: { ...surface.event.dateRule } } : {}),
    ...(surface.event.birthday ? { birthday: { ...surface.event.birthday } } : {}),
  }
  eventSurface.value = {
    kind: 'edit',
    event: surface.event,
    eventId: surface.event.id,
    draft,
    initial: JSON.stringify(draft),
    occurrenceDate: surface.occurrenceDate,
    returnTo: surface.returnTo,
    focusReturnToReader: keyboardActivated || surface.focusTarget !== null,
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
  const refreshList = state.returnTo.kind === 'recent-list'
  if (!refreshList) invalidateEventList()
  await Promise.all([
    reloadCalendarEvents(),
    refreshList ? loadEventList(true, eventListItems.value.length) : undefined,
  ])
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
  if (surface.kind === 'read') {
    restoreEventContext(surface.returnTo)
    return
  }
  if (surface.kind === 'recent-list') {
    eventSurface.value = null
    return
  }
  if (await canLeave()) {
    await discardPendingAttachments()
    resetForm()
  }
}

const stopTeardown = subscribeDiaryTeardown(clearPrivateData)
watch(() => eventSurface.value?.kind, kind => {
  if (kind !== 'read') {
    eventReaderTaskRequest?.abort()
    eventReaderTaskRequest = null
    eventReaderTasks.value = []
  }
  if (kind !== 'task-edit') {
    taskEventOptionsRequest?.abort()
    taskEventOptionsRequest = null
    taskEventOptionsLoading.value = false
    taskEventOptionsLoaded.value = false
    taskEventOptions.value = []
  }
}, { flush: 'sync' })
watch([month, mode, access.isUnlocked, access.epoch, storageKey], () => {
  if (access.isUnlocked.value && storageKey.value) void load()
  else clearPrivateData()
}, { immediate: true })
watch([access.isUnlocked, storageKey], ([unlocked, owner]) => {
  if (unlocked && owner) registerShellCommands()
  else clearShellCommands()
}, { immediate: true })
watch(eventListVisible, visible => {
  if (!visible) {
    eventListRequest?.abort()
    eventListRequest = null
    eventListLoading.value = false
    eventListLoadingMore.value = false
    recentTaskRequest?.abort()
    recentTaskRequest = null
    recentTaskLoading.value = false
    recentTaskLoadingMore.value = false
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
  eventSurface.value = mode.value === 'events' ? { kind: 'day-list', date } : null
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

async function openDiarySearchIntent(intent: DiarySearchOpenIntent) {
  const sequence = ++searchNavigationSequence
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

watch(diarySearchOpenIntent, intent => {
  if (intent) void openDiarySearchIntent(intent)
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
async function toggle() {
  if (!(await canLeave())) return
  await discardPendingAttachments()
  resetForm()
  mode.value = mode.value === 'diary' ? 'events' : 'diary'
}
function createEvent() {
  const surface = eventSurface.value
  const date = surface?.kind === 'day-list' ? surface.date : selected.value
  if (!date || surface?.kind !== 'day-list' || !access.isUnlocked.value) return
  const type = date >= today.value ? 'schedule' : 'milestone'
  const eventId = createDiaryEventId()
  const draft: EventFields = { title: '', description: '', emoji: type === 'schedule' ? '💼' : '🎯', type, startDate: date, endDate: date, startTime: null, endTime: null, allDay: true, dateRule: { calendar: 'gregory' }, recurrence: 'none', showCountdown: false, isPrimary: false }
  eventSurface.value = {
    kind: 'edit',
    event: null,
    eventId,
    draft,
    initial: JSON.stringify(draft),
    occurrenceDate: date,
    returnTo: { kind: 'day-list', date, eventId, restoreFocus: false },
    focusReturnToReader: false,
  }
}

function selectEventDayAction(action: string) {
  if (action === 'create' && !busy.value && !attachmentBusy.value) createEvent()
  if (action === 'create-task' && !busy.value && !attachmentBusy.value) createTaskFromDay()
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
  const oneOffFields = parseTaskFields(editor.draft)
  let seriesFields = parseTaskSeriesFields({
    title: editor.draft.title,
    description: editor.draft.description,
    dueTime: editor.draft.dueTime,
    recurrence: editor.draft.recurrence,
  })
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
  if (!oneOffFields || (editor.draft.recurrence && !seriesFields)) {
    const hasTimeError = taskTimeFieldsError(editor.draft) !== null
    taskFormError.value = editor.draft.title.trim()
      ? (hasTimeError ? '' : '请检查待办名称和备注。')
      : '请输入待办名称。'
    return
  }
  if (editor.task?.kind === 'one-off' && editor.draft.recurrence) {
    taskFormError.value = '已有待办暂不支持转换为重复任务。'
    return
  }
  if (editor.draft.recurrence && editor.draft.eventId) {
    taskFormError.value = '重复待办暂不支持关联日程。'
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
        ? await diaryTasksApi.updateTask(editor.task.id, oneOffFields!, editor.task.version, editor.draft.eventId)
        : await diaryTasksApi.createTask(oneOffFields!, editor.draft.eventId)
      focusTaskId = result.task.id
    }
    if (!isCurrent() || eventSurface.value !== editor) return
    if (!editor.task && editor.returnTo.kind === 'recent-list') recentTaskStatus.value = 'open'
    await refreshTaskContext({ ...editor.returnTo, taskId: focusTaskId, restoreFocus: true })
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
    eventSurface.value = {
      kind: 'read',
      event: surface.event,
      occurrenceDate: surface.occurrenceDate,
      returnTo: surface.returnTo,
      focusTarget: interaction?.detail === 0 || surface.focusReturnToReader ? 'edit' : null,
    }
    if (isLinkableTaskEvent(surface.event)) void loadEventReaderTasks(surface.event.id)
    formError.value = ''
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
      eventSurface.value = {
        kind: 'read',
        event: result.event,
        occurrenceDate,
        returnTo,
        focusTarget: keyboardActivated || editor.focusReturnToReader ? 'container' : null,
      }
      if (isLinkableTaskEvent(result.event)) void loadEventReaderTasks(result.event.id)
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
      if (isCurrent()) invalidateEventList()
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
        :class="{ 'diary-event-list-dialog': eventListVisible, 'diary-event-edit-dialog': eventSurface?.kind === 'edit' || eventSurface?.kind === 'task-edit', 'diary-task-edit-dialog': eventSurface?.kind === 'task-edit', 'diary-event-reader-dialog': eventSurface?.kind === 'read' }"
        :mask-closable="!busy && !attachmentBusy"
        :close-on-esc="!busy && !attachmentBusy"
        :auto-focus="false"
        :closable="false"
        @update:show="visible => !visible && closeEventSurface()"
      >
        <template v-if="eventSurface?.kind !== 'read'" #header>
          <span v-if="eventSurface?.kind === 'edit'">{{ eventSurface.event ? '编辑事件' : '新增事件' }}</span>
          <span v-else-if="eventSurface?.kind === 'task-edit'">{{ eventSurface.task ? '编辑待办' : '新增待办' }}</span>
          <span v-else-if="eventSurface?.kind === 'recent-list'">近期事项</span>
          <span v-else>{{ selected }}</span>
        </template>
        <template v-if="eventSurface?.kind !== 'read'" #header-extra>
          <div class="diary-event-header-actions">
            <NButton
              v-if="eventSurface?.kind === 'recent-list'"
              quaternary
              circle
              class="diary-task-add-button"
              aria-label="新增待办"
              :disabled="busy"
              @click="createTaskFromRecent"
            >
              <NIcon aria-hidden="true" :size="18"><Plus /></NIcon>
            </NButton>
            <DiaryActionMenu
              v-if="eventSurface?.kind === 'day-list'"
              class="diary-event-more-menu"
              label="更多当天事件操作"
              :options="eventDayActions"
              :disabled="busy || attachmentBusy"
              @select="selectEventDayAction"
            />
            <NButton quaternary class="diary-event-close-button" :disabled="busy || attachmentBusy" :aria-label="eventSurface?.kind === 'edit' ? '关闭事件编辑' : eventSurface?.kind === 'recent-list' ? '关闭事件列表' : '关闭当天事件'" @click="closeEventSurface($event)">
              <NIcon aria-hidden="true" :size="18"><X /></NIcon>
            </NButton>
          </div>
        </template>

        <DiaryEventListDialog
          v-if="eventListVisible"
          ref="eventListDialog"
          :items="eventListItems"
          :tasks="recentTaskItems"
          :task-status="recentTaskStatus"
          :busy-task-ids="busyTaskIds"
          :today="today"
          :loading="eventListLoading"
          :loading-more="eventListLoadingMore"
          :has-more="eventListNext !== null"
          :error="eventListError"
          :task-loading="recentTaskLoading"
          :task-loading-more="recentTaskLoadingMore"
          :task-has-more="recentTaskNext !== null"
          :task-error="recentTaskError"
          @retry="loadEventList(true)"
          @load-more="loadEventList()"
          @select="selectEventFromList"
          @toggle-task="toggleTask($event, { kind: 'recent-list', scrollTop: eventListDialog?.getScrollTop() ?? 0, taskId: $event.id, restoreFocus: true })"
          @edit-task="editTaskFromRecent"
          @load-more-tasks="loadRecentTasks()"
          @retry-tasks="loadRecentTasks(true)"
          @toggle-task-status="setRecentTaskStatus"
        />
        <DiaryEventReader
          v-else-if="eventSurface?.kind === 'read'"
          :event="eventSurface.event"
          :occurrence-date="eventSurface.occurrenceDate"
          :today="today"
          :related-tasks="eventReaderTasks"
          :busy-task-ids="busyTaskIds"
          :busy="busy"
          :focus-target="eventSurface.focusTarget"
          @edit="startEventEditFromReader"
          @close="closeEventSurface"
          @toggle-task="toggleEventReaderTask"
        />
        <div v-else-if="eventDraft" class="diary-event-form-content">
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
            :allow-recurrence="!editingTask || editingTask.kind === 'recurring'"
            :allow-event-link="!editingTask || editingTask.kind === 'one-off'"
            :lock-recurrence-start="editingTask?.kind === 'recurring'"
            :event-options="taskEventOptions"
            :event-options-loading="taskEventOptionsLoading"
            @event-picker-open="loadTaskEventOptions"
            @update:model-value="updateTaskDraft"
          />
        </div>
        <div v-else class="day-list-content">
          <section v-if="selectedTasks.length || calendarTasksLoading || calendarTaskError" class="day-tasks">
            <h3>待办事项</h3>
            <div v-if="calendarTasksLoading && !selectedTasks.length" class="diary-event-list-status" role="status"><NSpin size="small" /><span>正在加载待办…</span></div>
            <div v-if="calendarTaskError" class="diary-event-list-status" role="alert">
              <span>{{ calendarTaskError }}</span>
              <NButton text type="primary" @click="reloadCalendarTasks">重试</NButton>
            </div>
            <DiaryTaskRows v-if="selectedTasks.length"
              :items="selectedTasks"
              :today="today"
              :busy-ids="busyTaskIds"
              :show-due-date="false"
              @toggle="toggleTask($event, { kind: 'day-list', date: selected ?? '', taskId: $event.id, restoreFocus: true })"
              @edit="editTaskFromDay"
            />
          </section>
          <section v-if="selectedEvents.length || calendarEventLoading || eventCalendarError" class="day-events">
            <h3 v-if="selectedTasks.length || calendarTasksLoading || calendarTaskError">事件</h3>
            <div v-if="calendarEventLoading && !selectedEvents.length" class="diary-event-list-status" role="status"><NSpin size="small" /><span>正在加载事件…</span></div>
            <div v-if="eventCalendarError" class="diary-event-list-status" role="alert">
              <span>{{ eventCalendarError }}</span>
              <NButton text type="primary" @click="reloadCalendarEvents">重试</NButton>
            </div>
            <button v-for="event in selectedEvents" :key="event.id" type="button" class="diary-cloud-card" :data-event-id="event.id" :aria-label="dayEventLabel(event)" @click="selectEventFromDay(event, $event)">
              <strong>
                <img v-if="eventEmojiSource(event.emoji)" :src="eventEmojiSource(event.emoji)" class="event-emoji" alt="">
                <span v-else class="day-event-emoji" aria-hidden="true">{{ event.emoji }}</span>
                <span class="day-event-title-text">{{ displayEventTitle(event, selected) }}</span>
              </strong>
            </button>
          </section>
          <p v-if="!selectedEvents.length && !selectedTasks.length && !calendarTasksLoading && !calendarTaskError && !calendarEventLoading && !eventCalendarError" class="day-list-empty">还没有待办或事件</p>
        </div>

        <template v-if="eventSurface?.kind === 'task-edit'" #footer>
          <div class="diary-task-footer">
            <div v-if="editingTask?.kind === 'recurring'" class="diary-task-series-actions">
              <NButton v-if="editingTask.skipped" quaternary :disabled="busy || dirty" @click="changeEditedOccurrenceState">恢复本次</NButton>
              <NButton v-else-if="editingTask.completedAt === null" quaternary :disabled="busy || dirty" @click="changeEditedOccurrenceState">跳过本次</NButton>
              <NButton v-if="editingTask.recurrence.untilDate !== editingTask.occurrenceDate" quaternary :disabled="busy || dirty" @click="stopEditedSeries">结束重复</NButton>
            </div>
            <div class="life-actions">
              <NButton v-if="editingTask" quaternary type="error" :disabled="busy" @click="deleteTask">删除</NButton>
              <span />
              <NButton :disabled="busy" @click="cancelTaskEdit($event)">取消</NButton>
              <NButton type="primary" :loading="busy" @click="saveTask">保存</NButton>
            </div>
          </div>
        </template>
        <template v-if="eventSurface?.kind === 'edit'" #footer>
          <div class="life-actions">
            <NButton v-if="editing" quaternary type="error" :disabled="busy" @click="remove">删除事件</NButton>
            <span />
            <NButton :disabled="busy" @click="cancelEventEdit($event)">取消</NButton>
            <NButton type="primary" :loading="busy" @click="save($event.detail === 0)">保存</NButton>
          </div>
        </template>
      </NModal>
    </template>
    <NButton v-else v-show="!accessContext?.dialogOpen.value" class="unlock-diary" @click="accessContext?.requestAccess()">解锁日记</NButton>
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
.day-events > button { text-align: left; color: inherit; font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.day-list-content { display: flex; flex-direction: column; gap: 14px; }
.day-tasks,
.day-events {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.day-tasks > h3,
.day-events > h3 { margin: 0; color: var(--text-muted, #6b7280); font-size: 13px; font-weight: 600; }
.day-events > button {
  width: 100%;
  align-items: flex-start;
  padding: 13px 12px;
}
.day-events > button:focus-visible { outline: none; }
.day-events > button strong { display: flex; max-width: 100%; align-items: center; gap: 6px; font-size: 16px; font-weight: 600; }
.day-event-emoji { flex: none; font-size: 20px; line-height: 1; }
.day-event-title-text { min-width: 0; line-height: 20px; overflow-wrap: anywhere; }
.diary-event-form-error { margin: 0 0 14px; color: var(--danger, #dc2626); }
.diary-task-reload { margin: -4px 0 12px; }
.day-list-empty { margin: 0; padding: 12px 0; color: var(--text-muted, #6b7280); text-align: center; }
.life-actions { display: flex; align-items: center; gap: 12px; }.life-actions > span { flex: 1; }
.diary-task-footer { display: flex; flex-direction: column; gap: 8px; }
.diary-task-series-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.event-emoji { width: 20px; height: 20px; flex: none; object-fit: contain; }
.diary-event-header-actions { display: flex; align-items: center; gap: 4px; }
.unlock-diary { display: block; margin: 20vh auto; }
@media (max-width: 600px) { .diary-life { padding-inline: 8px; } }
</style>
<style>
.diary-life-dialog.n-card { width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; scrollbar-width: none; }
.diary-life-dialog.n-card::-webkit-scrollbar { display: none; }
.diary-event-list-dialog.n-card { width: min(620px, calc(100vw - 32px)); }
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
  border-top: 1px solid var(--border, #8883);
  background: var(--card-color, var(--bg));
}
.diary-life-dialog .diary-event-close-button.n-button {
  width: 40px;
  height: 40px;
  min-width: 40px;
  border-radius: 10px;
  color: var(--text-muted, #6b7280);
  background-color: transparent;
}
.diary-life-dialog .diary-event-close-button.n-button:hover {
  background-color: color-mix(in srgb, var(--text) 6%, transparent);
}
.diary-life-dialog .diary-event-close-button.n-button:focus-visible {
  outline: 2px solid var(--primary, #6366f1);
  outline-offset: 2px;
}
@media (hover: hover) and (pointer: fine) and (not (any-pointer: coarse)) {
  .diary-event-more-menu { opacity: 0; }
  .diary-event-more-menu:hover,
  .diary-event-more-menu:focus-within,
  .diary-event-more-menu.is-open { opacity: 1; }
}
@media (max-width: 600px) {
  .diary-life-dialog.n-card { position: fixed; bottom: 0; left: 0; width: 100%; max-height: 90dvh; margin: 0; border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom); }
  .diary-event-edit-dialog.n-card { max-height: 90dvh; }
}
</style>
