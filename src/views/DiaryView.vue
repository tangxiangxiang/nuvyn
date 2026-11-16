<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { NButton, NIcon, NModal } from 'naive-ui'
import { X } from '@vicons/tabler'
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
import { DIARY_ATTACHMENT_STAGE_HEARTBEAT_INTERVAL_MS, MAX_DIARY_ATTACHMENT_BYTES, MAX_DIARY_DAY_ATTACHMENTS, type DiaryAttachment } from '../../shared/diaryAttachments'
import { NUVYN_BROWSER_STORAGE_KEYS, ownerScopedStorageKey, readStorageKey, writeStorageKey } from '../technicalNamespace'
import DiaryLifeCalendar from '../components/diary/DiaryLifeCalendar.vue'
import DiaryDayDialog from '../components/diary/DiaryDayDialog.vue'
import DiaryEventDetail from '../components/diary/DiaryEventDetail.vue'
import DiaryEventForm from '../components/diary/DiaryEventForm.vue'
import DiaryEventListDialog from '../components/diary/DiaryEventListDialog.vue'
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
const eventDraft = ref<EventFields | null>(null)
const editing = ref<DiaryEvent | null>(null)
type EventReturnContext = { kind: 'event-list' } | { kind: 'day-list'; date: string }
const eventDetail = ref<{ event: DiaryEvent; occurrenceDate: string } | null>(null)
const eventDetailReturn = ref<EventReturnContext | null>(null)
const eventEditorReturnDate = ref<string | null>(null)
const newId = ref('')
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
const eventListVisible = ref(false)
const eventListItems = ref<DiaryEvent[]>([])
const eventListNext = ref<number | null>(0)
const eventListLoaded = ref(false)
const eventListLoading = ref(false)
const eventListLoadingMore = ref(false)
const eventListError = ref('')
const eventDayActions = [{ key: 'create', label: '新增事件' }]
const eventDetailActions = [{ key: 'delete', label: '删除事件' }]
const eventSurfaceVisible = computed(() => access.isUnlocked.value && (
  eventListVisible.value || eventDetail.value !== null || eventDraft.value !== null || (mode.value === 'events' && selected.value !== null)
))

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
let timer: ReturnType<typeof setInterval> | undefined
const dirty = computed(() => {
  if (eventDraft.value) return JSON.stringify(eventDraft.value) !== initial.value
  if (selected.value === null || loadingDay.value || dayReadFailed.value) return false
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
function dayEventLabel(event: DiaryEvent): string {
  return displayEventTitle(event, selected.value)
}
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
function load(): Promise<void> {
  if (!access.isUnlocked.value) return Promise.resolve()
  const key = `${range.value.start}:${range.value.end}:${today.value}:${access.epoch.value ?? ''}`
  if (pendingCalendarLoad?.key === key) return pendingCalendarLoad.promise
  request?.abort()
  const scope = new AbortController()
  request = scope
  error.value = ''
  const promise = (async () => {
    try {
      const [d, e] = await Promise.all([
        diaryLifeApi.days(range.value.start, range.value.end, scope.signal),
        diaryLifeApi.events(range.value.start, range.value.end, scope.signal),
      ])
      if (scope.signal.aborted) return
      days.value = d.days
      events.value = e
    } catch { if (!scope.signal.aborted) { days.value = []; events.value = []; error.value = '加载失败，请重试。' } }
    finally {
      if (pendingCalendarLoad?.controller === scope) {
        pendingCalendarLoad = null
        request = null
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
  eventDraft.value = null
  editing.value = null
  eventDetail.value = null
  eventDetailReturn.value = null
  eventEditorReturnDate.value = null
  eventListVisible.value = false
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
}

function clearPrivateData() {
  clearDiarySearchOpen()
  searchNavigationSequence += 1
  request?.abort()
  pendingCalendarLoad = null
  request = null
  eventListRequest?.abort()
  clearShellCommands()
  cancelConfirmation?.()
  resetForm()
  days.value = []
  events.value = []
  error.value = ''
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
  mode.value = 'events'
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
  mode.value = 'events'
  eventListVisible.value = false
  selected.value = event.startDate
  eventDetailReturn.value = { kind: 'event-list' }
  eventDetail.value = { event, occurrenceDate: nextOccurrence(event, today.value) ?? event.startDate }
  formError.value = ''
}

function selectEventFromDay(event: DiaryEvent) {
  const date = selected.value
  if (!date) return
  eventDetailReturn.value = { kind: 'day-list', date }
  eventDetail.value = { event, occurrenceDate: date }
  formError.value = ''
}

function restoreEventContext() {
  const context = eventDetailReturn.value
  eventDetailReturn.value = null
  eventDetail.value = null
  eventDraft.value = null
  editing.value = null
  eventEditorReturnDate.value = null
  formError.value = ''

  if (context?.kind === 'event-list') {
    selected.value = null
    eventListVisible.value = true
    if (!eventListLoaded.value) void loadEventList(true)
  } else if (context?.kind === 'day-list') {
    selected.value = context.date
    eventListVisible.value = false
  } else {
    selected.value = null
    eventListVisible.value = false
  }
}

async function closeEventSurface() {
  if (busy.value || attachmentBusy.value) return
  if (eventDraft.value) {
    await cancelEventEdit()
    return
  }
  if (eventDetail.value) {
    restoreEventContext()
    return
  }
  if (eventListVisible.value) {
    eventListVisible.value = false
    return
  }
  if (await canLeave()) {
    await discardPendingAttachments()
    resetForm()
  }
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
  if ((!options.skipLeaveCheck && !(await canLeave())) || !access.isUnlocked.value) return false
  await discardPendingAttachments()
  detailRequest?.abort()
  const scope = new AbortController(); detailRequest = scope
  selected.value = date; eventDraft.value = null; editing.value = null; formError.value = ''; initial.value = 'null'
  eventDetail.value = null; eventDetailReturn.value = null; eventEditorReturnDate.value = null; eventListVisible.value = false
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
  const date = selected.value
  if (!date) return
  eventDetail.value = null
  eventDetailReturn.value = null
  eventEditorReturnDate.value = date
  editing.value = null
  newId.value = createDiaryEventId()
  eventDraft.value = { title: '', description: '', emoji: '🎯', type: 'milestone', startDate: date, endDate: date, startTime: null, endTime: null, allDay: true, dateRule: { calendar: 'gregory' }, recurrence: 'none', showCountdown: false, isPrimary: false }
  initial.value = JSON.stringify(eventDraft.value)
}

function selectEventDayAction(action: string) {
  if (action === 'create' && !busy.value && !attachmentBusy.value) createEvent()
}

function startEventEdit() {
  const event = eventDetail.value?.event
  if (!event || busy.value) return
  editing.value = event
  eventEditorReturnDate.value = null
  newId.value = event.id
  eventDraft.value = { ...event }
  initial.value = JSON.stringify(eventDraft.value)
  formError.value = ''
}

async function cancelEventEdit() {
  if (!eventDraft.value || busy.value) return
  if (dirty.value && !await confirm('放弃未保存的修改？')) return
  eventDraft.value = null
  editing.value = null
  formError.value = ''
  if (eventDetail.value) return
  const returnDate = eventEditorReturnDate.value
  eventEditorReturnDate.value = null
  if (returnDate) selected.value = returnDate
  else resetForm()
}

function selectEventAction(action: string) {
  if (action === 'delete' && eventDetail.value) void removeEventFromDetail()
}
async function save() {
  if (busy.value || attachmentBusy.value || loadingDay.value || dayReadFailed.value || !selected.value) return
  if (!eventDraft.value && !canWriteDay.value) return
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
      if (day.value) toast.success('日记已保存')
      await load()
      return
    } else {
      const fields = parseEvent(eventDraft.value)
      if (!fields) {
        formError.value = eventDraft.value.type === 'birthday'
          ? '请检查姓名及出生农历年、月、日。'
          : '请检查标题、日期和时间范围。'
        return
      }
      const result = await diaryLifeApi.saveEvent(newId.value, fields, editing.value?.version ?? 0)
      if (!isDiarySessionGenerationCurrent(generation) || !access.isUnlocked.value) return
      const previousOccurrence = eventDetail.value?.occurrenceDate
      eventDraft.value = null
      editing.value = null
      eventEditorReturnDate.value = null
      eventDetail.value = {
        event: result.event,
        occurrenceDate: previousOccurrence && occursOn(result.event, previousOccurrence)
          ? previousOccurrence
          : nextOccurrence(result.event, today.value) ?? result.event.startDate,
      }
      if (!eventDetailReturn.value) eventDetailReturn.value = { kind: 'day-list', date: result.event.startDate }
      initial.value = ''
      formError.value = ''
      await load()
      invalidateEventList()
      return
    }
  } catch (e) { if (isDiarySessionGenerationCurrent(generation)) formError.value = (e as Error).message }
  finally { busy.value = false }
}
async function remove() {
  const date = selected.value
  const entry = eventDraft.value ? editing.value : day.value
  if (busy.value || attachmentBusy.value || !date || !entry || (!eventDraft.value && !canWriteDay.value)) return
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

async function removeEventFromDetail() {
  const event = eventDetail.value?.event
  if (!event || busy.value) return
  const generation = captureDiarySessionGeneration()
  busy.value = true
  formError.value = ''
  try {
    if (!await confirm('删除这条事件？') || !isDiarySessionGenerationCurrent(generation)) return
    await diaryLifeApi.deleteEvent(event.id, event.version)
    if (!isDiarySessionGenerationCurrent(generation) || !access.isUnlocked.value) return
    await load()
    invalidateEventList()
    restoreEventContext()
  } catch (error) {
    if (isDiarySessionGenerationCurrent(generation)) formError.value = (error as Error).message
  } finally {
    busy.value = false
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
        <div v-if="error" class="diary-life-error" role="alert">{{ error }} <NButton text @click="load">重试</NButton></div>
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
        :class="{ 'diary-event-list-dialog': eventListVisible, 'diary-event-detail-dialog': Boolean(eventDetail && !eventDraft) }"
        :mask-closable="!busy && !attachmentBusy"
        :close-on-esc="!busy && !attachmentBusy"
        :auto-focus="false"
        :closable="false"
        @update:show="visible => !visible && closeEventSurface()"
      >
        <template #header>
          <div v-if="eventDetail && !eventDraft" class="diary-event-modal-title">
            <img v-if="eventEmojiSource(eventDetail.event.emoji)" :src="eventEmojiSource(eventDetail.event.emoji)" alt="">
            <span v-else aria-hidden="true">{{ eventDetail.event.emoji }}</span>
            <strong>{{ displayEventTitle(eventDetail.event, eventDetail.occurrenceDate) }}</strong>
          </div>
          <span v-else-if="eventDraft">{{ editing ? '编辑事件' : '新增事件' }}</span>
          <span v-else-if="eventListVisible">近期事项</span>
          <span v-else>{{ selected }}</span>
        </template>
        <template #header-extra>
          <div class="diary-event-header-actions">
            <template v-if="eventDetail && !eventDraft">
              <DiaryActionMenu class="diary-event-more-menu" label="更多事件操作" :options="eventDetailActions" :disabled="busy" @select="selectEventAction" />
              <NButton text class="diary-event-edit-button" :disabled="busy" @click="startEventEdit">编辑</NButton>
            </template>
            <DiaryActionMenu
              v-else-if="selected !== null && !eventDraft && !eventListVisible"
              class="diary-event-more-menu"
              label="更多当天事件操作"
              :options="eventDayActions"
              :disabled="busy || attachmentBusy"
              @select="selectEventDayAction"
            />
            <NButton quaternary class="diary-event-close-button" :disabled="busy || attachmentBusy" :aria-label="eventDraft ? '关闭事件编辑' : eventDetail ? '关闭事件详情' : eventListVisible ? '关闭事件列表' : '关闭当天事件'" @click="closeEventSurface">
              <NIcon aria-hidden="true" :size="18"><X /></NIcon>
            </NButton>
          </div>
        </template>

        <DiaryEventListDialog
          v-if="eventListVisible"
          :items="eventListItems"
          :today="today"
          :loading="eventListLoading"
          :loading-more="eventListLoadingMore"
          :has-more="eventListNext !== null"
          :error="eventListError"
          @retry="loadEventList(true)"
          @load-more="loadEventList()"
          @select="selectEventFromList"
        />
        <DiaryEventDetail
          v-else-if="eventDetail && !eventDraft"
          :event="eventDetail.event"
          :today="today"
          :occurrence-date="eventDetail.occurrenceDate"
          :error="formError"
        />
        <div v-else-if="eventDraft" class="diary-event-form-content">
          <p v-if="formError" class="diary-event-form-error" role="alert">{{ formError }}</p>
          <DiaryEventForm v-model="eventDraft" :today="today" />
        </div>
        <div v-else class="day-events">
          <button v-for="event in selectedEvents" :key="event.id" type="button" :aria-label="dayEventLabel(event)" @click="selectEventFromDay(event)">
            <strong>
              <img v-if="eventEmojiSource(event.emoji)" :src="eventEmojiSource(event.emoji)" class="event-emoji" alt="">
              <span v-else class="day-event-emoji" aria-hidden="true">{{ event.emoji }}</span>
              <span class="day-event-title-text">{{ displayEventTitle(event, selected) }}</span>
            </strong>
          </button>
          <p v-if="!selectedEvents.length">还没有事件</p>
        </div>

        <template v-if="eventDraft" #footer>
          <div class="life-actions">
            <span />
            <NButton :disabled="busy" @click="cancelEventEdit">取消</NButton>
            <NButton type="primary" :loading="busy" @click="save">保存</NButton>
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
.day-events {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
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
.life-actions { display: flex; align-items: center; gap: 12px; }.life-actions > span { flex: 1; }
.event-emoji { width: 20px; height: 20px; flex: none; object-fit: contain; }
.diary-event-modal-title { display: flex; min-width: 0; align-items: center; gap: 8px; }
.diary-event-modal-title img { width: 24px; height: 24px; flex: none; object-fit: contain; }
.diary-event-modal-title > span { flex: none; font-size: 22px; }
.diary-event-modal-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diary-event-header-actions { display: flex; align-items: center; gap: 4px; }
.unlock-diary { display: block; margin: 20vh auto; }
@media (max-width: 600px) { .diary-life { padding-inline: 8px; } }
</style>
<style>
.diary-life-dialog.n-card { width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; scrollbar-width: none; }
.diary-life-dialog.n-card::-webkit-scrollbar { display: none; }
.diary-event-detail-dialog.n-card { width: min(620px, calc(100vw - 32px)); }
.diary-event-list-dialog.n-card { width: min(620px, calc(100vw - 32px)); }
.diary-event-detail-dialog .diary-event-edit-button { opacity: 1; }
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
  .diary-event-detail-dialog .diary-event-edit-button { opacity: 0; transition: opacity 150ms ease; }
  .diary-event-detail-dialog:hover .diary-event-edit-button,
  .diary-event-detail-dialog:focus-within .diary-event-edit-button { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .diary-event-detail-dialog .diary-event-edit-button { transition: none; } }
@media (max-width: 600px) { .diary-life-dialog.n-card { position: fixed; bottom: 0; left: 0; width: 100%; max-height: 90dvh; margin: 0; border-radius: 18px 18px 0 0; padding-bottom: env(safe-area-inset-bottom); } }
</style>
