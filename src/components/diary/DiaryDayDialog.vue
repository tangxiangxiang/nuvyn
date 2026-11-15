<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NCard, NIcon, NModal } from 'naive-ui'
import { X } from '@vicons/tabler'
import type { DayFields, DiaryDay } from '../../../shared/diaryLife'
import { useDiaryMoodIconPreferences } from '../../composables/diary/useDiaryMoodIconPreferences'
import DiaryMoodPicker from './DiaryMoodPicker.vue'
import DiaryBulletEditor from './DiaryBulletEditor.vue'
import DiaryBulletReader from './DiaryBulletReader.vue'

const props = defineProps<{
  show: boolean
  date: string
  day: DiaryDay | null
  draft: DayFields
  mode: 'read' | 'edit'
  loading?: boolean
  readFailed?: boolean
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{
  edit: []
  'cancel-edit': []
  close: []
  save: []
  remove: []
  'update:draft': [draft: DayFields]
}>()
const preferences = useDiaryMoodIconPreferences()
const picker = ref(false)
const moodSource = computed(() => props.draft.moodId ? preferences.sourceFor(props.draft.moodId) : undefined)
const moodLabel = computed(() => props.draft.moodId ? preferences.labelFor(props.draft.moodId) : '')

function updateMood(moodId: string | null) {
  emit('update:draft', { ...props.draft, moodId })
  picker.value = false
}
</script>

<template>
  <NModal
    :show="props.show"
    :mask-closable="!props.busy"
    :close-on-esc="!props.busy"
    :auto-focus="false"
    @update:show="value => !value && emit('close')"
  >
    <NCard
      class="diary-life-dialog"
      data-testid="diary-day-dialog"
      :bordered="false"
      size="small"
      role="dialog"
      aria-modal="true"
      :aria-label="props.date"
    >
      <template #header>
        <header class="diary-day-header">
          <strong>{{ props.date }}</strong>
          <div class="diary-day-header-actions">
            <NButton v-if="props.mode === 'read'" attr-type="button" quaternary :disabled="props.busy || props.loading || props.readFailed" data-testid="diary-edit-entry" @click="emit('edit')">编辑</NButton>
            <NButton v-else attr-type="button" quaternary :disabled="props.busy" data-testid="diary-cancel-edit" @click="emit('cancel-edit')">取消</NButton>
            <NButton attr-type="button" quaternary class="diary-day-close" :disabled="props.busy" aria-label="关闭日记" @click="emit('close')"><NIcon aria-hidden="true" :size="18"><X /></NIcon></NButton>
          </div>
        </header>
      </template>

      <p v-if="props.error" role="alert">{{ props.error }}</p>
      <p v-else-if="props.loading" role="status">正在读取…</p>
      <p v-else-if="props.readFailed" role="alert">读取失败，请关闭后重试。</p>
      <template v-else>
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

        <DiaryBulletReader v-if="props.mode === 'read'" :entries="props.draft.entries" />
        <DiaryBulletEditor v-else :entries="props.draft.entries" @update:entries="emit('update:draft', { ...props.draft, entries: $event })" />
      </template>

      <template v-if="props.mode === 'edit'" #footer>
        <div class="diary-day-actions">
          <NButton v-if="props.day" text type="error" :disabled="props.busy" data-testid="diary-delete-entry" @click="emit('remove')">删除</NButton>
          <span />
          <NButton v-if="props.mode === 'edit'" type="primary" :loading="props.busy" :disabled="props.loading || props.readFailed" data-testid="diary-save-entry" @click="emit('save')">保存</NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.diary-day-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; }
.diary-day-header > strong { font-size: 1.05rem; font-weight: 600; }
.diary-day-header-actions { display: flex; align-items: center; gap: 4px; }
.diary-day-close { min-width: 32px; }
.diary-day-mood { min-height: 34px; margin-top: 4px; font-size: 30px; line-height: 1; }
.diary-day-mood img { display: block; width: 32px; height: 32px; object-fit: contain; }
.diary-day-mood-editor { margin: 0 0 10px; }
.mood-preview { width: 32px; height: 32px; }
.life-mood-picker { position: static !important; max-width: 100%; margin-bottom: 12px; }
.diary-day-actions { display: flex; align-items: center; gap: 12px; }
.diary-day-actions > span { flex: 1; }
</style>
