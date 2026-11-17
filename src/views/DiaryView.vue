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
import { parseTaskFields, type DiaryTask, type DiaryTaskListStatus, type TaskFields } from '../../shared/diaryTasks'
import { DIARY_ATTACHMENT_STAGE_HEARTBEAT_INTERVAL_MS, MAX_DIARY_ATTACHMENT_BYTES, MAX_DIARY_DAY_ATTACHMENTS, type DiaryAttachment } from '../../shared/diaryAttachments'
import { NUVYN_BROWSER_STORAGE_KEYS, ownerScopedStorageKey, readStorageKey, writeStorageKey } from '../technicalNamespace'
import DiaryLifeCalendar from '../components/diary/DiaryLifeCalendar.vue'
import DiaryDayDialog from '../components/diary/DiaryDayDialog.vue'
import DiaryEventForm from '../components/diary/DiaryEventForm.vue'
import DiaryEventReader from '../components/diary/DiaryEventReader.vue'
import DiaryEventListDialog from '../components/diary/DiaryEventListDialog.vue'
import DiaryTaskForm from '../components/diary/DiaryTaskForm.vue'
import DiaryTaskRows from '../components/diary/DiaryTaskRows.vue'
import { DiaryTaskConflictError, DiaryTaskListChangedError, diaryTasksApi } from '../lib/diary-tasks-api'
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
  | { kind: 'task-edit'; task: DiaryTask | null; draft: TaskFields; initial: string; returnTo: TaskReturnContext }
const eventSurface = ref<EventSurface | null>(null)
const initial = ref('')
const busy = ref(false)
const loadingDay = ref(false)
const attachmentBusy = ref(false)
const attachmentError = ref('')
const dayReadFailed = ref(false)
const searchReveal = ref<{ entryId?: string; entryIndex?: number } | null>(null)
const error = ref('')
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
const calendarTasks = ref<DiaryTask[]>([])
const calendarTasksLoading = ref(false)
const calendarTasksByDate = computed(() => groupTasksByDueDate(calendarTasks.value))
const recentTaskItems = ref<DiaryTask[]>([])
const recentTaskStatus = ref<DiaryTaskListStatus>('open')
const recentTaskNext = ref<string | null>(null)
const recentTaskLoaded = ref(false)
const recentTaskLoading = ref(false)
const recentTaskLoadingMore = ref(false)
const recentTaskError = ref('')
const busyTaskIds = ref(new Set<string>())
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
let request: AbortController | null = null
let pendingCalendarLoad: { key: string; controller: AbortController; promise: Promise<void> } | null = null
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
      const hasTasks = (calendarTasksByDate.value.get(date) ?? []).some(task => task.completedAt === null)
      if (matches[0]) result[date] = { source: eventEmojiSource(matches[0].emoji), emoji: matches[0].emoji, count: matches.length, hasTasks }
      else if (hasTasks) result[date] = { hasTasks: true }
    }
  }
  return result
})
function load(refresh = false): Promise<void> {
  if (!access.isUnlocked.value) return Promise.resolve()
  const dateRange = range.value
  const loadMode = mode.value
  const owner = storageKey.value
  const generation = captureDiarySessionGeneration()
  const isCurrent = () => !disposed && isDiarySessionGenerationCurrent(generation)
    && storageKey.value === owner && mode.value === loadMode
  const key = `${dateRange.start}:${dateRange.end}:${today.value}:${loadMode}:${access.epoch.value ?? ''}`
  if (!refresh && pendingCalendarLoad?.key === key) return pendingCalendarLoad.promise
  request?.abort()
  const scope = new AbortController()
  request = scope
  error.value = ''
  if (loadMode === 'events') {
    calendarTasks.value = []
    calendarTasksLoading.value = true
  } else calendarTasksLoading.value = false
  const promise = (async () => {
    try {
      const [d, e, tasks] = await Promise.all([
        diaryLifeApi.days(dateRange.start, dateRange.end, scope.signal),
        diaryLifeApi.events(dateRange.start, dateRange.end, scope.signal),
        loadMode === 'events'
          ? listDiaryTasksInRange(dateRange.start, dateRange.end, scope.signal)
          : Promise.resolve([]),
      ])
      if (scope.signal.aborted || !isCurrent()) return
      days.value = d.days
      events.value = e
      calendarTasks.value = loadMode === 'events' ? tasks : []
    } catch { if (!scope.signal.aborted && isCurrent()) { days.value = []; events.value = []; calendarTasks.value = []; error.value = '加载失败，请重试。' } }
    finally {
      if (pendingCalendarLoad?.controller === scope) {
        pendingCalendarLoad = null
        request = null
        calendarTasksLoading.value = false
      }
    }
  })()
  pendingCalendarLoad = { key, controller: scope, promise }
  return promise
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
}

function clearPrivateData() {
  clearDiarySearchOpen()
  searchNavigationSequence += 1
  request?.abort()
  pendingCalendarLoad = null
  request = null
  eventListRequest?.abort()
  eventListRequest = null
  recentTaskRequest?.abort()
  recentTaskRequest = null
  taskDetailRequest?.abort()
  taskDetailRequest = null
  busy.value = false
  clearShellCommands()
  cancelConfirmation?.()
  resetForm()
  days.value = []
  events.value = []
  calendarTasks.value = []
  calendarTasksLoading.value = false
  error.value = ''
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
        page = await diaryTasksApi.listTasks(cursor, scope.signal, currentStatus)
      } catch (cause) {
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
  if (context.kind === 'recent-list') {
    if (!eventListLoaded.value) void loadEventList(true)
    if (!recentTaskLoaded.value) void loadRecentTasks(true)
  }
  const isCurrent = capturePrivateOperation()
  void nextTick(() => {
    if (!isCurrent()) return
    if (context.kind === 'recent-list') eventListDialog.value?.restoreScroll(context.scrollTop)
    focusTaskContext(context)
  })
}

function taskFields(task: DiaryTask | null, dueDate: string | null): TaskFields {
  return task
    ? { title: task.title, description: task.description, dueDate: task.dueDate, dueTime: task.dueTime }
    : { title: '', description: '', dueDate, dueTime: null }
}

function startTaskEdit(task: DiaryTask | null, returnTo: TaskReturnContext) {
  if (busy.value || attachmentBusy.value || !access.isUnlocked.value) return
  const draft = taskFields(task, returnTo.kind === 'day-list' ? returnTo.date : null)
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

function createTaskFromDay() {
  const surface = eventSurface.value
  if (surface?.kind !== 'day-list' || !access.isUnlocked.value || busy.value || attachmentBusy.value) return
  startTaskEdit(null, { kind: 'day-list', date: surface.date, taskId: '', restoreFocus: false })
}

function createTaskFromRecent() {
  if (eventSurface.value?.kind !== 'recent-list' || busy.value || !access.isUnlocked.value) return
  startTaskEdit(null, { kind: 'recent-list', scrollTop: eventListDialog.value?.getScrollTop() ?? 0, taskId: '', restoreFocus: false })
}

function editTaskFromDay(task: DiaryTask, keyboardActivated: boolean) {
  if (selected.value === null || eventSurface.value?.kind !== 'day-list') return
  startTaskEdit(task, { kind: 'day-list', date: selected.value, taskId: task.id, restoreFocus: keyboardActivated })
}

function editTaskFromRecent(task: DiaryTask, scrollTop: number, keyboardActivated: boolean) {
  if (eventSurface.value?.kind !== 'recent-list') return
  startTaskEdit(task, { kind: 'recent-list', scrollTop, taskId: task.id, restoreFocus: keyboardActivated })
}

function updateTaskDraft(next: TaskFields) {
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

function updateCalendarTask(task: DiaryTask | null, previousId?: string) {
  const removedId = previousId ?? task?.id
  const without = calendarTasks.value.filter(item => item.id !== removedId)
  if (task?.dueDate && task.dueDate >= range.value.start && task.dueDate <= range.value.end) without.push(task)
  calendarTasks.value = without
}

async function refreshTaskContext(context: TaskReturnContext) {
  const minimumItems = context.kind === 'recent-list' ? recentTaskItems.value.length : 0
  activateTaskContext(context)
  if (context.kind !== 'recent-list') invalidateRecentTasks()
  await Promise.all([
    load(true),
    context.kind === 'recent-list' ? loadRecentTasks(true, minimumItems) : Promise.resolve(),
    context.kind === 'recent-list' && !eventListLoaded.value ? loadEventList(true) : Promise.resolve(),
  ])
  const isCurrent = capturePrivateOperation()
  await nextTick()
  if (!isCurrent()) return
  if (context.kind === 'recent-list') eventListDialog.value?.restoreScroll(context.scrollTop)
  focusTaskContext(context)
}

async function toggleTask(task: DiaryTask, context: TaskReturnContext) {
  if (busyTaskIds.value.has(task.id) || !access.isUnlocked.value) return
  const isCurrent = capturePrivateOperation()
  busyTaskIds.value = new Set(busyTaskIds.value).add(task.id)
  try {
    const result = task.completedAt === null
      ? await diaryTasksApi.completeTask(task.id, task.version)
      : await diaryTasksApi.reopenTask(task.id, task.version)
    if (!isCurrent()) return
    if (!isTaskContextActive(context)) {
      updateCalendarTask(result.task)
      return
    }
    updateCalendarTask(result.task)
    if (context.kind === 'recent-list' && task.completedAt !== null) recentTaskStatus.value = 'open'
    await refreshTaskContext(context)
  } catch (cause) {
    if (!isCurrent()) return
    if (cause instanceof DiaryTaskConflictError) toast.error('待办已在其他设备更新，列表已刷新。')
    else toast.error('待办更新失败，请重试。')
    if (!isTaskContextActive(context)) return
    await refreshTaskContext(context)
  } finally {
    if (isCurrent()) {
      const next = new Set(busyTaskIds.value)
      next.delete(task.id)
      busyTaskIds.value = next
    }
  }
}

function isTaskContextActive(context: TaskReturnContext): boolean {
  if (context.kind === 'recent-list') return eventSurface.value?.kind === 'recent-list'
  return eventSurface.value?.kind === 'day-list' && eventSurface.value.date === context.date
}

function startEventRead(event: DiaryEvent, occurrenceDate: string, returnTo: EventReturnContext, focusTarget: EventFocusTarget = null) {
  if (busy.value || eventSurface.value?.kind === 'edit' || !access.isUnlocked.value) return
  eventSurface.value = { kind: 'read', event, occurrenceDate, returnTo, focusTarget }
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
    load(true),
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
  const fields = parseTaskFields(editor.draft)
  if (!fields) {
    taskFormError.value = editor.draft.title.trim() ? '请检查待办名称、截止日期和时间。' : '请输入待办名称。'
    return
  }
  const isCurrent = capturePrivateOperation()
  busy.value = true
  taskFormError.value = ''
  taskConflictNeedsReload.value = false
  try {
    const result = editor.task
      ? await diaryTasksApi.updateTask(editor.task.id, fields, editor.task.version)
      : await diaryTasksApi.createTask(fields)
    if (!isCurrent() || eventSurface.value !== editor) return
    updateCalendarTask(result.task, editor.task?.id)
    if (!editor.task && editor.returnTo.kind === 'recent-list') recentTaskStatus.value = 'open'
    await refreshTaskContext({ ...editor.returnTo, taskId: result.task.id, restoreFocus: true })
  } catch (cause) {
    if (!isCurrent() || eventSurface.value !== editor) return
    if (cause instanceof DiaryTaskConflictError) {
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
    if (!await confirm('删除这条待办？') || !isCurrent() || eventSurface.value !== editor) return
    await diaryTasksApi.deleteTask(editor.task.id, editor.task.version)
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
    const { task } = await diaryTasksApi.getTask(editor.task.id, controller.signal)
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
        <div v-if="error" class="diary-life-error" role="alert">{{ error }} <NButton text @click="load()">重试</NButton></div>
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
          :busy="busy"
          :focus-target="eventSurface.focusTarget"
          @edit="startEventEditFromReader"
          @close="closeEventSurface"
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
            @update:model-value="updateTaskDraft"
          />
        </div>
        <div v-else class="day-list-content">
          <div v-if="error" class="diary-event-list-status" role="alert">
            <span>{{ error }}</span>
            <NButton text type="primary" @click="load(true)">重试</NButton>
          </div>
          <div v-else-if="calendarTasksLoading" class="diary-event-list-status" role="status"><NSpin size="small" /><span>正在加载…</span></div>
          <template v-else>
          <section v-if="selectedTasks.length" class="day-tasks">
            <h3>待办事项</h3>
            <DiaryTaskRows
              :items="selectedTasks"
              :today="today"
              :busy-ids="busyTaskIds"
              :show-due-date="false"
              @toggle="toggleTask($event, { kind: 'day-list', date: selected ?? '', taskId: $event.id, restoreFocus: true })"
              @edit="editTaskFromDay"
            />
          </section>
          <section v-if="selectedEvents.length" class="day-events">
            <h3 v-if="selectedTasks.length">事件</h3>
          <button v-for="event in selectedEvents" :key="event.id" type="button" :data-event-id="event.id" :aria-label="dayEventLabel(event)" @click="selectEventFromDay(event, $event)">
            <strong>
              <img v-if="eventEmojiSource(event.emoji)" :src="eventEmojiSource(event.emoji)" class="event-emoji" alt="">
              <span v-else class="day-event-emoji" aria-hidden="true">{{ event.emoji }}</span>
              <span class="day-event-title-text">{{ displayEventTitle(event, selected) }}</span>
            </strong>
          </button>
          </section>
          <p v-if="!selectedEvents.length && !selectedTasks.length" class="day-list-empty">还没有待办或事件</p>
          </template>
        </div>

        <template v-if="eventSurface?.kind === 'task-edit'" #footer>
          <div class="life-actions">
            <NButton v-if="editingTask" quaternary type="error" :disabled="busy" @click="deleteTask">删除</NButton>
            <span />
            <NButton :disabled="busy" @click="cancelTaskEdit($event)">取消</NButton>
            <NButton type="primary" :loading="busy" @click="saveTask">保存</NButton>
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
.day-events > button { text-align: left; background: transparent; color: inherit; border: 0; font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 6px; padding: 8px; }
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
  border-bottom: 1px solid var(--border, #d9dce5);
  border-radius: 12px;
  background-color: var(--bg);
  background-image: url('/diary-events-cloud-pattern.png');
  background-position: center;
  background-size: cover;
  background-blend-mode: multiply;
}
.day-events > button:hover,
.day-events > button:focus-visible {
  outline: none;
  background-color: color-mix(in srgb, var(--bg) 96%, var(--text) 4%);
}
.day-events > button strong { display: flex; max-width: 100%; align-items: center; gap: 6px; font-size: 16px; font-weight: 600; }
.day-event-emoji { flex: none; font-size: 20px; line-height: 1; }
.day-event-title-text { min-width: 0; line-height: 20px; overflow-wrap: anywhere; }
.diary-event-form-error { margin: 0 0 14px; color: var(--danger, #dc2626); }
.diary-task-reload { margin: -4px 0 12px; }
.day-list-empty { margin: 0; padding: 12px 0; color: var(--text-muted, #6b7280); text-align: center; }
.life-actions { display: flex; align-items: center; gap: 12px; }.life-actions > span { flex: 1; }
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
