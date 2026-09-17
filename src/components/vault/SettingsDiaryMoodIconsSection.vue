<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NCard, NModal, NUpload, type UploadFileInfo } from 'naive-ui'
import { DIARY_DEFAULT_MOOD_ICONS, type DiaryMoodId } from '../../../shared/diaryMood'
import { useDiaryMoodIconPreferences } from '../../composables/diary/useDiaryMoodIconPreferences'
import { useI18n } from '../../composables/useI18n'
import { useSettingsIconManagement } from '../../composables/useSettingsIconManagement'
import { useConfirm } from '../../composables/useConfirm'
import { useToast } from '../../composables/useToast'

const preferences = useDiaryMoodIconPreferences()
const { locale } = useI18n()
const { confirm } = useConfirm()
const toast = useToast()
const allOptions = computed(() => preferences.availableIcons.value.map((value) => ({
  value,
  label: preferences.labelFor(value, locale.value),
  source: preferences.sourceFor(value),
})))
const protectedIcons = new Set<DiaryMoodId>(DIARY_DEFAULT_MOOD_ICONS)
const isProtected = (icon: DiaryMoodId) => protectedIcons.has(icon)
const uploadError = ref('')
const showRecycleBin = ref(false)
const iconActionId = ref<DiaryMoodId | null>(null)
const { managing, editingId: editingIcon, editingName, startHold, cancelHold, enterManaging, startRename: beginRename, cancelRename, stopManaging } = useSettingsIconManagement<DiaryMoodId>()
let lastUploadedSvg = ''

onMounted(() => {
  void preferences.load().catch(() => undefined)
})

async function addSvgFile(file: UploadFileInfo): Promise<void> {
  uploadError.value = ''
  const rawFile = file.file
  if (!rawFile) {
    uploadError.value = '无法读取所选文件。'
    return
  }
  const source = rawFile.name.toLowerCase().endsWith('.svg') && rawFile.size <= 256 * 1024
    ? await rawFile.text()
    : ''
  const svgStart = source.search(/<svg(?:\s|>)/i)
  const prefix = svgStart >= 0 ? source.slice(0, svgStart) : source
  const validPrefix = /^(?:\uFEFF|\s|<\?xml[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->)*$/i.test(prefix)
  if (svgStart < 0 || !validPrefix || /<script(?:\s|>)/i.test(source)) {
    uploadError.value = rawFile.size > 256 * 1024 ? 'SVG 文件不能超过 256 KB。' : '请选择有效的 SVG 文件。'
    return
  }
  if (source === lastUploadedSvg) return
  lastUploadedSvg = source
  const name = rawFile.name.replace(/\.svg$/i, '').trim()
  preferences.addCustomIcon(source, name)
  await preferences.persist()
}

function finishRename(): void {
  if (editingIcon.value !== null) {
    preferences.renameCustomIcon(editingIcon.value, editingName.value)
    void preferences.persist()
  }
  cancelRename()
}

function removeIcon(icon: DiaryMoodId): void {
  preferences.removeIcon(icon)
  void preferences.persist()
}

async function permanentlyDeleteIcon(option: { value: DiaryMoodId; label: string }): Promise<void> {
  if (iconActionId.value !== null) return
  const confirmed = await confirm(
    `永久删除图标「${option.label}」？`,
    '删除后无法恢复，只能重新上传 SVG 图标。',
    { confirmLabel: '永久删除', cancelLabel: '取消', destructive: true },
  )
  if (!confirmed) return
  iconActionId.value = option.value
  try {
    preferences.deleteIcon(option.value)
    await preferences.persist()
    toast.success('图标已永久删除')
  } catch {
    uploadError.value = '图标没有删除，请稍后重试。'
  } finally {
    iconActionId.value = null
  }
}

async function restoreArchivedIcon(option: { value: DiaryMoodId }): Promise<void> {
  if (iconActionId.value !== null) return
  iconActionId.value = option.value
  try {
    preferences.restoreIcon(option.value)
    await preferences.persist()
    toast.success('图标已恢复')
  } catch {
    uploadError.value = '图标没有恢复，请稍后重试。'
  } finally {
    iconActionId.value = null
  }
}

async function onBeforeUpload({ file }: { file: UploadFileInfo }): Promise<boolean> {
  await addSvgFile(file)
  return false
}

async function onFileChange({ file }: { file: UploadFileInfo }): Promise<void> {
  await addSvgFile(file)
}
</script>

<template>
  <section class="settings-section" aria-labelledby="settings-diary-mood-icons-title">
    <header class="settings-section-header">
      <div>
        <h3 id="settings-diary-mood-icons-title">表情图标</h3>
        <p>管理日记使用的表情图标；已有日记不会被自动修改。</p>
      </div>
      <div class="settings-section-actions">
        <NButton data-testid="settings-diary-mood-icons-recycle-bin" size="small" secondary @click="showRecycleBin = true">回收站 {{ preferences.archivedIcons.value.length }}</NButton>
        <NUpload accept=".svg,image/svg+xml" :show-file-list="false" :default-upload="false" @before-upload="onBeforeUpload" @change="onFileChange">
          <NButton type="primary" size="small">＋ 添加图标</NButton>
        </NUpload>
        <span v-if="uploadError" class="settings-diary-mood-upload-error" role="alert">{{ uploadError }}</span>
      </div>
    </header>
    <div class="settings-section-body">
      <div class="settings-card settings-diary-mood-card">
        <h4 class="settings-card-title">表情图标</h4>
        <div class="settings-diary-mood-options" aria-label="表情图标" @click.self="stopManaging">
          <button
            v-for="option in allOptions"
            :key="option.value"
            type="button"
            class="settings-diary-mood-option"
            :class="{ managing, 'is-system': isProtected(option.value) }"
            :aria-label="option.label"
            @pointerdown="startHold"
            @pointerup="cancelHold"
            @pointerleave="cancelHold"
            @pointercancel="cancelHold"
            @contextmenu.prevent="enterManaging"
            @click="cancelHold"
          >
            <img v-if="option.source" :src="option.source" alt="" aria-hidden="true">
            <input
              v-if="managing && editingIcon === option.value && option.value.startsWith('custom_mood_')"
              v-model="editingName"
              class="settings-diary-mood-name-input"
              aria-label="图标名称"
              autofocus
              @click.stop
              @pointerdown.stop
              @keydown.enter.prevent="finishRename"
              @keydown.esc.prevent="editingIcon = null"
              @blur="finishRename"
            >
            <span v-else @dblclick.stop="beginRename(option.value, option.label, option.value.startsWith('custom_mood_'))">{{ option.label }}</span>
            <span
              v-if="managing && option.value.startsWith('custom_mood_')"
              class="settings-diary-mood-delete"
              aria-hidden="true"
              @click.stop="removeIcon(option.value)"
            >×</span>
          </button>
        </div>
      </div>
    </div>
  </section>

  <NModal v-model:show="showRecycleBin" :z-index="10000" :mask-closable="true" :auto-focus="false">
    <NCard class="settings-diary-mood-recycle-modal" data-testid="settings-diary-mood-icons-recycle-modal" :bordered="false" size="small" role="dialog" aria-modal="true" aria-labelledby="settings-diary-mood-recycle-title">
      <template #header>
        <span id="settings-diary-mood-recycle-title">回收站 <span class="settings-diary-mood-recycle-count">{{ preferences.archivedIcons.value.length }}</span></span>
      </template>
      <template #header-extra>
        <NButton class="settings-diary-mood-recycle-close" quaternary circle size="small" aria-label="关闭回收站" @click="showRecycleBin = false">×</NButton>
      </template>
      <p class="settings-diary-mood-recycle-hint">已删除图标可恢复或永久删除。</p>
      <div class="settings-diary-mood-recycle-content">
        <div v-if="preferences.archivedIcons.value.length" class="settings-diary-mood-recycle-options" role="list">
          <div v-for="option in preferences.archivedIcons.value" :key="option" class="settings-diary-mood-recycle-option" role="listitem">
            <img :src="preferences.sourceFor(option)" alt="">
            <span class="settings-diary-mood-recycle-label" :title="preferences.labelFor(option, locale)">{{ preferences.labelFor(option, locale) }}</span>
            <span class="settings-diary-mood-recycle-actions">
              <NButton class="settings-diary-mood-recycle-action" attr-type="button" size="small" :bordered="false" :disabled="iconActionId !== null" @click="restoreArchivedIcon({ value: option })">恢复</NButton>
              <NButton class="settings-diary-mood-recycle-action settings-diary-mood-recycle-danger" attr-type="button" type="error" secondary size="small" :disabled="iconActionId !== null" @click="permanentlyDeleteIcon({ value: option, label: preferences.labelFor(option, locale) })">永久删除</NButton>
            </span>
          </div>
        </div>
        <p v-else class="settings-diary-mood-recycle-empty">回收站为空</p>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.settings-section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.settings-section-body { flex: 1 1 auto; min-height: 0; }
.settings-diary-mood-card { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.settings-diary-mood-options { display: grid; flex: 1 1 auto; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); align-content: start; gap: 8px; height: 70%; min-height: 0; overflow-y: auto; padding: 8px 10px 8px 2px; box-sizing: border-box; }
.settings-diary-mood-option { position: relative; display: flex; min-width: 0; min-height: 74px; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; font: inherit; transform-origin: 50% 55%; }
.settings-diary-mood-option.is-system { border-color: color-mix(in srgb, var(--accent) 24%, var(--border)); }
.settings-diary-mood-option:hover { background: var(--bg-soft); color: var(--text-h); }
.settings-diary-mood-option.managing { animation: settings-diary-mood-wiggle 180ms ease-in-out infinite alternate; }
.settings-diary-mood-option.managing:nth-child(2n) { animation-delay: -90ms; animation-direction: alternate-reverse; }
.settings-diary-mood-option.managing:nth-child(3n) { animation-delay: -45ms; animation-duration: 200ms; }
.settings-diary-mood-option img { width: 32px; height: 32px; object-fit: contain; }
.settings-diary-mood-name-input { width: 100%; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; text-align: center; }
.settings-diary-mood-delete { position: absolute; top: 0; right: 0; display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; border: 2px solid var(--surface); border-radius: 50%; background: #ef4444; color: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 18%); font-size: 11px; font-weight: 700; line-height: 1; cursor: pointer; transform: translate(38%, -38%); }
.settings-diary-mood-upload-error { color: #dc4c4c; font-size: .75rem; }
.settings-diary-mood-recycle-modal { --settings-mood-surface: var(--bg-soft); width: min(520px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 64px)); overflow: hidden; border: 1px solid var(--border); border-radius: 14px; background: var(--settings-mood-surface); color: var(--text-h); box-shadow: 0 18px 48px rgb(0 0 0 / 22%); }
.settings-diary-mood-recycle-modal :deep(.n-card__header) { padding: 14px 18px 4px; }
.settings-diary-mood-recycle-modal :deep(.n-card__content) { display: flex; min-height: 0; flex-direction: column; padding: 0 18px 16px; }
.settings-diary-mood-recycle-close { color: var(--text-muted); font-size: 20px; }
.settings-diary-mood-recycle-count { display: inline-flex; min-width: 20px; height: 20px; align-items: center; justify-content: center; padding: 0 6px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); font-size: .72rem; font-weight: 650; }
.settings-diary-mood-recycle-hint { margin: 2px 0 8px; color: var(--text-muted); font-size: .75rem; line-height: 1.35; }
.settings-diary-mood-recycle-content { min-height: 0; overflow-y: auto; }
.settings-diary-mood-recycle-options { display: grid; }
.settings-diary-mood-recycle-option { display: flex; min-width: 0; min-height: 38px; align-items: center; gap: 8px; padding: 3px 0; border-top: 1px solid var(--border); box-sizing: border-box; }
.settings-diary-mood-recycle-option:first-child { border-top: 0; }
.settings-diary-mood-recycle-option img { width: 22px; height: 22px; object-fit: contain; }
.settings-diary-mood-recycle-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-diary-mood-recycle-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; margin-left: auto; }
.settings-diary-mood-recycle-action { min-width: 52px; min-height: 28px; padding: 0 8px; }
.settings-diary-mood-recycle-danger { min-width: 76px; }
.settings-diary-mood-recycle-empty { margin: 0; padding: 14px 0 2px; color: var(--text-muted); font-size: .78rem; }

@keyframes settings-diary-mood-wiggle {
  from { transform: rotate(-.7deg) translateY(-.25px); }
  to { transform: rotate(.7deg) translateY(.25px); }
}

@media (prefers-reduced-motion: reduce) {
  .settings-diary-mood-option.managing { animation: none; }
}
</style>
