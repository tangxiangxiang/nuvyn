<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NCard, NIcon, NModal, NPopover, NSpin } from 'naive-ui'
import { ArrowBackUp, MoodSmile, Pencil, X } from '@vicons/tabler'
import type { DayFields, DiaryDay } from '../../../shared/diaryLife'
import type { DiaryAttachment } from '../../../shared/diaryAttachments'
import { useDiaryMoodIconPreferences } from '../../composables/diary/useDiaryMoodIconPreferences'
import DiaryMoodPicker from './DiaryMoodPicker.vue'
import DiaryBulletEditor from './DiaryBulletEditor.vue'
import DiaryBulletReader from './DiaryBulletReader.vue'
import DiaryAttachmentSection from './DiaryAttachmentSection.vue'
import DiaryActionMenu from './DiaryActionMenu.vue'

const props = defineProps<{
  show: boolean
  date: string
  day: DiaryDay | null
  attachments: Array<DiaryAttachment & { pending?: boolean }>
  draft: DayFields
  mode: 'read' | 'edit'
  futureDate?: boolean
  loading?: boolean
  readFailed?: boolean
  busy?: boolean
  error?: string
  attachmentBusy?: boolean
  attachmentError?: string
  revealEntryId?: string
  revealEntryIndex?: number
}>()
const emit = defineEmits<{
  edit: []
  'cancel-edit': []
  close: []
  save: []
  remove: []
  'update:draft': [draft: DayFields]
  'update:content': [content: { entries: string[]; entryIds: string[] }]
  'add-attachments': [files: File[], entryId: string | null]
  'remove-attachment': [id: string]
  'move-attachment': [id: string, entryId: string | null]
}>()
function preventDiaryBackdropClickThrough(event: MouseEvent) {
  const target = event.composedPath()[0]
  if (target instanceof Element && target.matches('.n-modal-mask, .n-modal-scroll-content')) event.preventDefault()
}
const preferences = useDiaryMoodIconPreferences()
const picker = ref(false)
const moodTrigger = ref<HTMLButtonElement | null>(null)
watch(() => [props.show, props.mode, props.date], () => { picker.value = false })
const bulletEditor = ref<InstanceType<typeof DiaryBulletEditor> | null>(null)
const attachmentInput = ref<HTMLInputElement | null>(null)
const entryImageInput = ref<HTMLInputElement | null>(null)
let imageTarget: string | null = null
const editActionsDisabled = computed(() => props.busy || props.loading || props.readFailed || props.attachmentBusy)
const dayActions = computed(() => [
  { key: 'save', label: '保存日记' },
  { key: 'add-entry', label: '添加一条' },
  { key: 'add-attachment', label: '添加附件' },
  ...(props.day ? [{ key: 'remove', label: '删除日记' }] : []),
])

function selectDayAction(action: string) {
  if (props.mode !== 'edit' || editActionsDisabled.value) return
  if (action === 'save') emit('save')
  else if (action === 'add-entry') bulletEditor.value?.addEntry()
  else if (action === 'add-attachment') attachmentInput.value?.click()
  else if (action === 'remove' && props.day) emit('remove')
}
const moodSource = computed(() => props.draft.moodId ? preferences.sourceFor(props.draft.moodId) : undefined)
const moodLabel = computed(() => props.draft.moodId ? preferences.labelFor(props.draft.moodId) : '')
const placementOptions = computed(() => props.draft.entries.flatMap((_, index) => {
  const id = props.draft.entryIds?.[index]
  return id ? [{ id, line: index + 1 }] : []
}))
const pdfAttachments = computed(() => props.attachments.filter(item => item.mimeType === 'application/pdf'))
async function revealSearchEntry() {
  if (!props.show || props.loading || props.readFailed || (!props.revealEntryId && props.revealEntryIndex === undefined)) return
  await nextTick()
  const dialog = document.querySelector<HTMLElement>('[data-testid="diary-day-dialog"]')
  if (!dialog) return
  const entries = [...dialog.querySelectorAll<HTMLElement>('[data-entry-id]')]
  const target = props.revealEntryId
    ? entries.find(entry => entry.dataset.entryId === props.revealEntryId)
    : entries[props.revealEntryIndex!]
  target?.scrollIntoView?.({ block: 'nearest' })
}
watch(
  () => [props.show, props.loading, props.readFailed, props.date, props.revealEntryId, props.revealEntryIndex],
  () => { void revealSearchEntry() },
  { flush: 'post' },
)
const endImageGroups = computed(() => {
  const mapped = new Set((props.draft.imageGroups ?? []).flatMap(group => group.attachmentIds))
  const groups = (props.draft.imageGroups ?? [])
    .filter(group => group.entryId === null)
    .map(group => group.attachmentIds
      .map(id => props.attachments.find(item => item.id === id))
      .filter((item): item is typeof props.attachments[number] => Boolean(item && item.mimeType !== 'application/pdf')))
    .filter(group => group.length)
  const unassignedImages = props.attachments.filter(item => item.mimeType !== 'application/pdf' && !mapped.has(item.id))
  for (let offset = 0; offset < unassignedImages.length; offset += 9) groups.push(unassignedImages.slice(offset, offset + 9))
  return groups
})

function imageGroupsForEntry(entryId: string | null) {
  if (!entryId) return []
  return (props.draft.imageGroups ?? [])
    .filter(group => group.entryId === entryId)
    .map(group => group.attachmentIds
      .map(id => props.attachments.find(item => item.id === id))
      .filter((item): item is typeof props.attachments[number] => Boolean(item && item.mimeType !== 'application/pdf')))
    .filter(group => group.length)
}

function closeMoodPicker(): void {
  picker.value = false
  void nextTick(() => moodTrigger.value?.focus())
}

function updateMood(moodId: string | null) {
  emit('update:draft', { ...props.draft, moodId })
  closeMoodPicker()
}

function chooseEntryImages(entryId: string) {
  if (props.mode !== 'edit' || editActionsDisabled.value || !props.draft.entryIds?.includes(entryId)) return
  imageTarget = entryId
  entryImageInput.value?.click()
}

function selectEntryImages(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const files = Array.from(input.files ?? [])
  const entryId = imageTarget
  imageTarget = null
  input.value = ''
  if (files.length && entryId && props.mode === 'edit' && !editActionsDisabled.value && props.draft.entryIds?.includes(entryId)) {
    emit('add-attachments', files, entryId)
  }
}

function selectAttachments(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length && props.mode === 'edit' && !editActionsDisabled.value) {
    emit('add-attachments', files, null)
  }
}
</script>

<template>
  <NModal
    :show="props.show"
    :mask-closable="!props.busy && !props.attachmentBusy"
    :close-on-esc="!props.busy && !props.attachmentBusy"
    :auto-focus="false"
    @mask-click="preventDiaryBackdropClickThrough"
    @update:show="value => !value && emit('close')"
  >
    <NCard
      class="diary-life-dialog diary-day-dialog-card"
      data-testid="diary-day-dialog"
      :bordered="false"
      size="small"
      :content-scrollable="true"
      role="dialog"
      aria-modal="true"
      :aria-label="props.date"
    >
      <template #header>
        <header class="diary-day-header">
          <div class="diary-day-heading">
            <strong>{{ props.date }}</strong>
            <span v-if="props.mode === 'read' && props.draft.moodId && !props.error && !props.loading && !props.readFailed" class="diary-day-mood" data-testid="diary-day-mood">
              <img v-if="moodSource" :src="moodSource" :alt="moodLabel">
              <span v-else-if="moodLabel" class="diary-day-mood-label" :title="moodLabel">{{ moodLabel }}</span>
            </span>
            <NPopover
              v-else-if="props.mode === 'edit' && !props.loading && !props.readFailed"
              v-model:show="picker"
              trigger="click"
              placement="bottom-start"
              :show-arrow="false"
              raw
            >
              <template #trigger>
                <button
                  ref="moodTrigger"
                  type="button"
                  class="diary-day-mood diary-day-mood-trigger"
                  aria-label="选择心情"
                  aria-haspopup="true"
                  aria-controls="diary-mood-picker"
                  :aria-expanded="picker"
                  :disabled="editActionsDisabled"
                >
                  <img v-if="moodSource" :src="moodSource" :alt="moodLabel">
                  <span v-else-if="moodLabel" class="diary-day-mood-label" :title="moodLabel">{{ moodLabel }}</span>
                  <MoodSmile v-else aria-hidden="true" />
                </button>
              </template>
              <DiaryMoodPicker
                class="life-mood-picker"
                :current-mood="props.draft.moodId"
                :busy="editActionsDisabled"
                @select="updateMood($event)"
                @clear="updateMood(null)"
                @close="closeMoodPicker"
              />
            </NPopover>
          </div>
          <div class="diary-day-header-actions">
            <DiaryActionMenu
              v-if="props.mode === 'edit'"
              label="更多日记操作"
              data-testid="diary-day-actions-menu"
              :options="dayActions"
              :disabled="editActionsDisabled"
              @select="selectDayAction"
            />
            <NButton v-if="props.mode === 'read' && !props.futureDate" class="diary-day-icon-button diary-day-edit" attr-type="button" quaternary :disabled="editActionsDisabled" data-testid="diary-edit-entry" aria-label="编辑日记" title="编辑日记" @click="emit('edit')"><NIcon aria-hidden="true" :size="18"><Pencil /></NIcon></NButton>
            <NButton v-else-if="props.mode === 'edit'" class="diary-day-icon-button" attr-type="button" quaternary :disabled="props.busy || props.attachmentBusy" data-testid="diary-cancel-edit" aria-label="取消" title="取消编辑" @click="emit('cancel-edit')"><NIcon aria-hidden="true" :size="18"><ArrowBackUp /></NIcon></NButton>
            <NButton attr-type="button" quaternary class="diary-day-icon-button" :disabled="props.busy || props.attachmentBusy" aria-label="关闭日记" @click="emit('close')"><NIcon aria-hidden="true" :size="18"><X /></NIcon></NButton>
          </div>
        </header>
      </template>

      <p v-if="props.error" class="diary-day-message" role="alert">{{ props.error }}</p>
      <p v-if="props.loading" class="diary-day-message" role="status">正在读取…</p>
      <p v-else-if="props.readFailed" class="diary-day-message" role="alert">读取失败，请关闭后重试。</p>
      <template v-else-if="!props.error || props.mode === 'edit'">
        <div class="diary-day-body" data-testid="diary-day-content">
          <div class="diary-day-stream" data-testid="diary-attachments">
          <DiaryBulletReader v-if="props.mode === 'read' && props.draft.entries.length" :entries="props.draft.entries" :entry-ids="props.draft.entryIds">
            <template #after-entry="{ entryId }">
              <DiaryAttachmentSection
                v-for="(group, groupIndex) in imageGroupsForEntry(entryId)"
                :key="`${entryId}-${groupIndex}`"
                :date="props.date"
                :attachments="group"
                :mode="props.mode"
                embedded
                :target-entry-id="entryId"
              />
            </template>
          </DiaryBulletReader>
          <p v-else-if="props.futureDate && !props.day" class="diary-day-message diary-future-day">未来的日子还没有日记。可以在事件中安排计划。</p>
          <DiaryBulletReader v-else-if="props.mode === 'read' && !props.attachments.length" :entries="[]" />
          <DiaryBulletEditor
            v-else-if="props.mode === 'edit'"
            ref="bulletEditor"
            :entries="props.draft.entries"
            :entry-ids="props.draft.entryIds"
            :actions-disabled="editActionsDisabled"
            @update:content="emit('update:content', $event)"
            @add-image="chooseEntryImages"
          >
            <template #after-entry="{ entryId }">
              <DiaryAttachmentSection
                v-for="(group, groupIndex) in imageGroupsForEntry(entryId)"
                :key="`${entryId}-${groupIndex}`"
                :date="props.date"
                :attachments="group"
                mode="edit"
                embedded
                :target-entry-id="entryId"
                :placement-options="placementOptions"
                :disabled="editActionsDisabled"
                @remove="emit('remove-attachment', $event)"
                @move="(id, target) => emit('move-attachment', id, target)"
              />
            </template>
          </DiaryBulletEditor>
          <DiaryAttachmentSection
            v-for="(group, groupIndex) in endImageGroups"
            :key="`end-images-${groupIndex}`"
            :date="props.date"
            :attachments="group"
            :mode="props.mode"
            embedded
            :target-entry-id="null"
            :placement-options="placementOptions"
            :disabled="props.busy || props.loading || props.readFailed || props.attachmentBusy"
            @remove="emit('remove-attachment', $event)"
            @move="(id, target) => emit('move-attachment', id, target)"
          />
          <DiaryAttachmentSection
            v-if="pdfAttachments.length"
            :date="props.date"
            :attachments="pdfAttachments"
            :mode="props.mode"
            embedded
            :target-entry-id="null"
            :placement-options="placementOptions"
            :disabled="props.busy || props.loading || props.readFailed || props.attachmentBusy"
            @remove="emit('remove-attachment', $event)"
          />
          <input
            v-if="props.mode === 'edit'"
            ref="entryImageInput"
            data-testid="diary-entry-image-input"
            type="file"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif,.png,.jpg,.jpeg,.webp,.gif,.avif"
            @change="selectEntryImages"
          >
          <input
            v-if="props.mode === 'edit'"
            ref="attachmentInput"
            data-testid="diary-attachment-input"
            type="file"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.avif,.pdf"
            @change="selectAttachments"
          >
          <p v-if="props.mode === 'edit' && props.attachmentBusy" class="diary-attachment-status" role="status"><NSpin size="small" />正在加密上传…</p>
          <p v-if="props.mode === 'edit' && props.attachmentError" class="diary-attachment-error" role="alert">{{ props.attachmentError }}</p>
          </div>
        </div>
      </template>

    </NCard>
  </NModal>
</template>

<style scoped>
.diary-day-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.diary-day-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.diary-day-heading > strong { font-size: 1rem; font-weight: 600; line-height: 1.4; white-space: nowrap; }
.diary-day-header-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.diary-day-header-actions :deep(.n-button) { min-height: 40px; }
@media (hover: hover) and (pointer: fine) and (not (any-pointer: coarse)) {
  .diary-day-edit { opacity: 0; }
  .diary-day-edit:hover,
  .diary-day-edit:focus-within { opacity: 1; }
}
@media (prefers-reduced-motion: no-preference) {
  .diary-day-edit { transition: opacity 150ms ease; }
}
@media (prefers-reduced-motion: reduce) {
  .diary-day-edit { transition: none; }
}
.diary-day-icon-button { width: 40px; height: 40px; padding: 0; }
.diary-attachment-status { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--text-muted); font-size: .88rem; }
.diary-attachment-error { margin: 0; color: var(--error, #d03050); font-size: .88rem; white-space: pre-line; }
.diary-day-message { margin: 4px 0; line-height: 1.6; }
.diary-future-day { color: var(--text-muted); }
.diary-day-body { display: flex; min-width: 0; flex-direction: column; gap: 16px; padding-block: 4px 8px; }
.diary-day-stream { display: flex; min-width: 0; flex-direction: column; gap: 12px; }
.diary-day-mood { display: flex; align-items: center; min-width: 0; }
.diary-day-mood img { display: block; width: 24px; height: 24px; object-fit: contain; }
.diary-day-mood-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diary-day-mood-trigger {
  height: 40px;
  padding: 0 8px;
  margin-inline-start: -8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  cursor: pointer;
}
.diary-day-mood-trigger > svg { width: 24px; height: 24px; }
.diary-day-mood-trigger:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 6%, transparent); }
.diary-day-mood-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.diary-day-mood-trigger:disabled { cursor: not-allowed; }
.life-mood-picker { position: static !important; max-width: 100%; }
</style>

<style>
.diary-life-dialog.diary-day-dialog-card.n-card { overflow: hidden; }
@media (min-width: 601px) {
  .diary-life-dialog.diary-day-dialog-card.n-card { width: min(640px, calc(100vw - 32px)); }
}
.diary-day-dialog-card .n-card__content-scrollbar { min-height: 0; flex: 1 1 auto; overflow: hidden; }
.diary-day-dialog-card .n-card__content-scrollbar .n-scrollbar { min-height: 0; flex: 1 1 auto; }
.diary-day-dialog-card .n-card__content-scrollbar > .n-scrollbar-container {
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.diary-day-dialog-card .n-card__content-scrollbar > .n-scrollbar-container::-webkit-scrollbar { display: none; }
.diary-day-dialog-card .n-card__content-scrollbar > .n-scrollbar-rail { display: none; }
</style>
