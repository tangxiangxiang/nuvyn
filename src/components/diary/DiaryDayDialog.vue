<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NCard, NIcon, NModal } from 'naive-ui'
import { X } from '@vicons/tabler'
import type { DayFields, DiaryDay } from '../../../shared/diaryLife'
import type { DiaryAttachment } from '../../../shared/diaryAttachments'
import { useDiaryMoodIconPreferences } from '../../composables/diary/useDiaryMoodIconPreferences'
import DiaryMoodPicker from './DiaryMoodPicker.vue'
import DiaryBulletEditor from './DiaryBulletEditor.vue'
import DiaryBulletReader from './DiaryBulletReader.vue'
import DiaryAttachmentSection from './DiaryAttachmentSection.vue'

const props = defineProps<{
  show: boolean
  date: string
  day: DiaryDay | null
  attachments: Array<DiaryAttachment & { pending?: boolean }>
  draft: DayFields
  mode: 'read' | 'edit'
  loading?: boolean
  readFailed?: boolean
  busy?: boolean
  error?: string
  attachmentBusy?: boolean
  attachmentError?: string
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
const preferences = useDiaryMoodIconPreferences()
const picker = ref(false)
const moodSource = computed(() => props.draft.moodId ? preferences.sourceFor(props.draft.moodId) : undefined)
const moodLabel = computed(() => props.draft.moodId ? preferences.labelFor(props.draft.moodId) : '')
const placementOptions = computed(() => props.draft.entries.flatMap((entry, index) => {
  const id = props.draft.entryIds?.[index]
  if (!id) return []
  const label = entry.trim().replace(/\s+/g, ' ').slice(0, 42) || `第 ${index + 1} 条日记`
  return [{ id, label }]
}))
const pdfAttachments = computed(() => props.attachments.filter(item => item.mimeType === 'application/pdf'))
const endImageGroups = computed(() => {
  const mapped = new Set((props.draft.imageGroups ?? []).flatMap(group => group.attachmentIds))
  const groups = (props.draft.imageGroups ?? [])
    .filter(group => group.entryId === null)
    .map(group => group.attachmentIds
      .map(id => props.attachments.find(item => item.id === id))
      .filter((item): item is typeof props.attachments[number] => Boolean(item && item.mimeType !== 'application/pdf')))
    .filter(group => group.length)
  const legacy = props.attachments.filter(item => item.mimeType !== 'application/pdf' && !mapped.has(item.id))
  for (let offset = 0; offset < legacy.length; offset += 9) groups.push(legacy.slice(offset, offset + 9))
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

function updateMood(moodId: string | null) {
  emit('update:draft', { ...props.draft, moodId })
  picker.value = false
}
</script>

<template>
  <NModal
    :show="props.show"
    :mask-closable="!props.busy && !props.attachmentBusy"
    :close-on-esc="!props.busy && !props.attachmentBusy"
    :auto-focus="false"
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
          <strong>{{ props.date }}</strong>
          <div class="diary-day-header-actions">
            <NButton v-if="props.mode === 'read'" attr-type="button" quaternary :disabled="props.busy || props.attachmentBusy || props.loading || props.readFailed" data-testid="diary-edit-entry" @click="emit('edit')">编辑</NButton>
            <NButton v-else attr-type="button" quaternary :disabled="props.busy || props.attachmentBusy" data-testid="diary-cancel-edit" @click="emit('cancel-edit')">取消</NButton>
            <NButton attr-type="button" quaternary class="diary-day-close" :disabled="props.busy || props.attachmentBusy" aria-label="关闭日记" @click="emit('close')"><NIcon aria-hidden="true" :size="18"><X /></NIcon></NButton>
          </div>
        </header>
      </template>

      <p v-if="props.error" class="diary-day-message" role="alert">{{ props.error }}</p>
      <p v-else-if="props.loading" class="diary-day-message" role="status">正在读取…</p>
      <p v-else-if="props.readFailed" class="diary-day-message" role="alert">读取失败，请关闭后重试。</p>
      <template v-else>
        <div class="diary-day-body" data-testid="diary-day-content">
          <div v-if="props.mode === 'read' && props.draft.moodId" class="diary-day-mood" data-testid="diary-day-mood">
            <img v-if="moodSource" :src="moodSource" :alt="moodLabel">
            <span v-else-if="moodLabel">{{ moodLabel }}</span>
          </div>
          <div v-else-if="props.mode === 'edit'" class="diary-day-mood-editor">
            <NButton attr-type="button" quaternary aria-label="选择心情" @click="picker = !picker">
              <img v-if="moodSource" class="mood-preview" :src="moodSource" :alt="moodLabel">
              <span v-else>选择心情</span>
            </NButton>
            <DiaryMoodPicker v-if="picker" class="life-mood-picker" :current-mood="props.draft.moodId" @select="updateMood($event)" @clear="updateMood(null)" @close="picker = false" />
          </div>

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
                :show-add="false"
                :target-entry-id="entryId"
              />
            </template>
          </DiaryBulletReader>
          <DiaryBulletReader v-else-if="props.mode === 'read' && !props.attachments.length" :entries="[]" />
          <DiaryBulletEditor v-else-if="props.mode === 'edit'" :entries="props.draft.entries" :entry-ids="props.draft.entryIds" @update:content="emit('update:content', $event)">
            <template #after-entry="{ entryId }">
              <template v-if="entryId">
                <DiaryAttachmentSection
                  v-for="(group, groupIndex) in imageGroupsForEntry(entryId)"
                  :key="`${entryId}-${groupIndex}`"
                  :date="props.date"
                  :attachments="group"
                  mode="edit"
                  embedded
                  :show-add="groupIndex === 0"
                  add-label="图片"
                  image-only
                  :target-entry-id="entryId"
                  :placement-options="placementOptions"
                  :disabled="props.busy || props.loading || props.readFailed || props.attachmentBusy"
                  @add="(files, target) => emit('add-attachments', files, target)"
                  @remove="emit('remove-attachment', $event)"
                  @move="(id, target) => emit('move-attachment', id, target)"
                />
                <DiaryAttachmentSection
                  v-if="imageGroupsForEntry(entryId).length === 0"
                  :date="props.date"
                  :attachments="[]"
                  mode="edit"
                  embedded
                  add-label="图片"
                  image-only
                  :target-entry-id="entryId"
                  :placement-options="placementOptions"
                  :disabled="props.busy || props.loading || props.readFailed || props.attachmentBusy"
                  @add="(files, target) => emit('add-attachments', files, target)"
                />
              </template>
            </template>
          </DiaryBulletEditor>
          <DiaryAttachmentSection
            v-for="(group, groupIndex) in endImageGroups"
            :key="`end-images-${groupIndex}`"
            :date="props.date"
            :attachments="group"
            :mode="props.mode"
            embedded
            :show-add="false"
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
            :show-add="false"
            :target-entry-id="null"
            :placement-options="placementOptions"
            :disabled="props.busy || props.loading || props.readFailed || props.attachmentBusy"
            @remove="emit('remove-attachment', $event)"
          />
          <DiaryAttachmentSection
            v-if="props.mode === 'edit'"
            :date="props.date"
            :attachments="[]"
            mode="edit"
            embedded
            show-add
            add-label="添加附件"
            :target-entry-id="null"
            :disabled="props.busy || props.loading || props.readFailed || props.attachmentBusy"
            :uploading="props.attachmentBusy"
            :error="props.attachmentError"
            @add="(files, target) => emit('add-attachments', files, target)"
          />
          </div>
        </div>
      </template>

      <template v-if="props.mode === 'edit'" #footer>
        <div class="diary-day-actions">
          <NButton v-if="props.day" text type="error" :disabled="props.busy || props.attachmentBusy" data-testid="diary-delete-entry" @click="emit('remove')">删除</NButton>
          <span />
          <NButton type="primary" :loading="props.busy || props.attachmentBusy" :disabled="props.loading || props.readFailed || props.attachmentBusy" data-testid="diary-save-entry" @click="emit('save')">保存</NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.diary-day-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.diary-day-header > strong { font-size: 1rem; font-weight: 600; line-height: 1.4; }
.diary-day-header-actions { display: flex; align-items: center; gap: 4px; }
.diary-day-header-actions :deep(.n-button) { min-height: 40px; }
.diary-day-close { min-width: 40px; height: 40px; padding: 0; }
.diary-day-message { margin: 4px 0; line-height: 1.6; }
.diary-day-body { display: flex; min-width: 0; flex-direction: column; gap: 16px; padding-block: 4px 8px; }
.diary-day-stream { display: flex; min-width: 0; flex-direction: column; gap: 12px; }
.diary-day-mood { display: flex; min-height: 40px; align-items: center; font-size: 28px; line-height: 1; }
.diary-day-mood img { display: block; width: 32px; height: 32px; object-fit: contain; }
.diary-day-mood-editor { min-width: 0; }
.diary-day-mood-editor :deep(.n-button) { min-width: 40px; min-height: 40px; padding-inline: 0; color: var(--text-muted); }
.diary-day-mood-editor :deep(.n-button__content) { justify-content: flex-start; }
.mood-preview { width: 32px; height: 32px; }
.life-mood-picker { position: static !important; max-width: 100%; margin-top: 8px; }
.diary-day-actions { display: flex; align-items: center; gap: 8px; }
.diary-day-actions > span { flex: 1; }
.diary-day-actions :deep(.n-button) { min-height: 40px; }
</style>

<style>
.diary-life-dialog.diary-day-dialog-card.n-card { overflow: hidden; }
.diary-day-dialog-card .n-card__content-scrollbar { min-height: 0; flex: 1 1 auto; overflow: hidden; }
.diary-day-dialog-card .n-card__content-scrollbar .n-scrollbar { min-height: 0; flex: 1 1 auto; }
.diary-day-dialog-card .n-card__content-scrollbar .n-scrollbar-container { overscroll-behavior: contain; }
</style>
