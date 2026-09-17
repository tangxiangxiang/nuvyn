<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NCard, NModal, NUpload, type UploadFileInfo } from 'naive-ui'
import { LEDGER_BUILTIN_ACCOUNT_ICON_NAMES, LEDGER_DEFAULT_ACCOUNT_ICONS, type LedgerAccountIcon as AccountIcon } from '../../../shared/ledgerProtocol'
import { useLedgerAccountIconPreferences } from '../../composables/useLedgerAccountIconPreferences'
import { useSettingsIconManagement } from '../../composables/useSettingsIconManagement'
import { useLedgerStore } from '../../features/ledger/ledgerStore'
import { useConfirm } from '../../composables/useConfirm'
import { useToast } from '../../composables/useToast'
import LedgerAccountIcon from '../ledger/LedgerAccountIcon.vue'

const preferences = useLedgerAccountIconPreferences()
const ledgerStore = useLedgerStore()
const { confirm } = useConfirm()
const toast = useToast()
const options: ReadonlyArray<{ value: AccountIcon; label: string }> = [
  { value: 'wallet', label: '钱包' },
  { value: 'credit_card', label: '信用卡' },
  { value: 'cash', label: '现金' },
  { value: 'building_bank', label: '银行' },
  { value: 'briefcase', label: '其他' },
]
const enabled = (value: AccountIcon) => preferences.availableIcons.value.includes(value)
const protectedIcons = new Set<AccountIcon>(LEDGER_DEFAULT_ACCOUNT_ICONS)
const protectedIconNames = new Set([...Object.values(LEDGER_BUILTIN_ACCOUNT_ICON_NAMES), '现金'])
const isProtected = (icon: AccountIcon) => protectedIcons.has(icon)
  || icon.startsWith('custom_builtin_')
  || (icon.startsWith('custom_') && protectedIconNames.has(preferences.customIconNames.value[icon] ?? ''))
const hasMultipleIcons = computed(() => preferences.availableIcons.value.length > 1)
const usedIcons = computed(() => new Set([
  ...ledgerStore.accounts.value.map((account) => account.icon ?? 'wallet'),
  ...ledgerStore.categories.value.map((category) => category.icon ?? 'wallet'),
]))
const canDelete = (icon: AccountIcon) => hasMultipleIcons.value
  && icon.startsWith('custom_')
  && !icon.startsWith('custom_builtin_')
  && !isProtected(icon)
  && preferences.defaultIcon.value !== icon
  && !usedIcons.value.has(icon)
const builtinLabels = Object.fromEntries(options.map(({ value, label }) => [value, label]))
const allOptions = computed(() => preferences.availableIcons.value.map((value, index) => ({
  value,
  label: preferences.customIconNames.value[value] || builtinLabels[value] || `自定义图标 ${index + 1}`,
})))
const archivedOptions = computed(() => preferences.archivedIcons.value.map((value, index) => ({
  value,
  label: preferences.customIconNames.value[value] || `自定义图标 ${index + 1}`,
})))
const uploadError = ref('')
const showRecycleBin = ref(false)
const iconActionId = ref<AccountIcon | null>(null)
const { managing, editingId: editingIcon, editingName, startHold, cancelHold, enterManaging, startRename: beginRename, cancelRename, stopManaging } = useSettingsIconManagement<AccountIcon>()
let lastUploadedSvg = ''

onMounted(() => {
  void ledgerStore.bootstrap()
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
  if (svgStart < 0 || !validPrefix) {
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

async function permanentlyDeleteIcon(option: { value: AccountIcon; label: string }): Promise<void> {
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

async function restoreArchivedIcon(option: { value: AccountIcon }): Promise<void> {
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
  <section class="settings-section" aria-labelledby="settings-ledger-account-icons-title">
    <header class="settings-section-header">
      <div>
        <h3 id="settings-ledger-account-icons-title">账户图标</h3>
        <p>管理新账户使用的默认图标；已有账户不会被自动修改。</p>
      </div>
      <div class="settings-section-actions">
        <NButton data-testid="settings-ledger-account-icons-recycle-bin" size="small" secondary @click="showRecycleBin = true">回收站 {{ archivedOptions.length }}</NButton>
        <NUpload accept=".svg,image/svg+xml" :show-file-list="false" :default-upload="false" @before-upload="onBeforeUpload" @change="onFileChange">
          <NButton type="primary" size="small">＋ 添加图标</NButton>
        </NUpload>
        <span v-if="uploadError" class="settings-ledger-icon-upload-error" role="alert">{{ uploadError }}</span>
      </div>
    </header>
    <div class="settings-section-body">
      <div class="settings-card settings-ledger-icon-card">
        <h4 class="settings-card-title">账户图标</h4>
        <div class="settings-ledger-icon-options" role="radiogroup" aria-label="默认账户图标" @click.self="stopManaging">
          <button v-for="option in allOptions" v-show="enabled(option.value)" :key="option.value" type="button" class="settings-ledger-icon-option" :class="{ managing, 'is-system': isProtected(option.value) }" :aria-label="option.label" :aria-checked="preferences.defaultIcon.value === option.value" role="radio" @pointerdown="startHold" @pointerup="cancelHold" @pointerleave="cancelHold" @pointercancel="cancelHold" @contextmenu.prevent="enterManaging" @click="cancelHold(); preferences.defaultIcon.value = option.value; void preferences.persist()">
            <span class="settings-ledger-icon-glyph" aria-hidden="true">
              <LedgerAccountIcon :icon="option.value" :size="20" />
            </span>
            <input
              v-if="managing && editingIcon === option.value && option.value.startsWith('custom_') && !isProtected(option.value)"
              v-model="editingName"
              class="settings-ledger-icon-name-input"
              aria-label="图标名称"
              autofocus
              @click.stop
              @pointerdown.stop
              @keydown.enter.prevent="finishRename"
              @keydown.esc.prevent="editingIcon = null"
              @blur="finishRename"
            >
            <span v-else class="settings-ledger-icon-label" @dblclick.stop="beginRename(option.value, option.label, option.value.startsWith('custom_') && !isProtected(option.value))">{{ option.label }}</span>
            <span v-if="managing && canDelete(option.value)" class="settings-ledger-icon-delete" aria-hidden="true" @click.stop="preferences.removeIcon(option.value); void preferences.persist()">×</span>
          </button>
        </div>
      </div>
    </div>
  </section>

  <NModal v-model:show="showRecycleBin" :z-index="10000" :mask-closable="true" :auto-focus="false">
    <NCard class="settings-ledger-icon-recycle-modal" data-testid="settings-ledger-account-icons-recycle-modal" :bordered="false" size="small" role="dialog" aria-modal="true" aria-labelledby="settings-ledger-icon-recycle-title">
      <template #header>
        <span id="settings-ledger-icon-recycle-title">回收站 <span class="settings-ledger-icon-recycle-count">{{ archivedOptions.length }}</span></span>
      </template>
      <template #header-extra>
        <NButton class="settings-ledger-icon-recycle-close" quaternary circle size="small" aria-label="关闭回收站" @click="showRecycleBin = false">×</NButton>
      </template>
      <p class="settings-ledger-icon-recycle-hint">已删除图标可恢复或永久删除。</p>
      <div class="settings-ledger-icon-recycle-content">
        <div v-if="archivedOptions.length" class="settings-ledger-icon-recycle-options" role="list">
          <div v-for="option in archivedOptions" :key="option.value" class="settings-ledger-icon-recycle-option" role="listitem">
            <span class="settings-ledger-icon-glyph" aria-hidden="true"><LedgerAccountIcon :icon="option.value" :size="20" /></span>
            <span class="settings-ledger-icon-label" :title="option.label">{{ option.label }}</span>
            <span class="settings-ledger-icon-recycle-actions">
              <NButton class="settings-ledger-icon-recycle-action" attr-type="button" size="small" :bordered="false" :disabled="iconActionId !== null" @click="restoreArchivedIcon(option)">恢复</NButton>
              <NButton class="settings-ledger-icon-recycle-action settings-ledger-icon-recycle-danger" attr-type="button" type="error" secondary size="small" :disabled="iconActionId !== null" @click="permanentlyDeleteIcon(option)">永久删除</NButton>
            </span>
          </div>
        </div>
        <p v-else class="settings-ledger-icon-recycle-empty">回收站为空</p>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.settings-section { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.settings-section-body { flex: 1 1 auto; min-height: 0; }
.settings-ledger-icon-card { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; }
.settings-ledger-icon-options { display: grid; flex: 1 1 auto; grid-template-columns: repeat(5, minmax(0, 1fr)); align-content: start; gap: 10px; height: 70%; min-height: 0; box-sizing: border-box; overflow-y: auto; padding: 8px 10px 8px 2px; }
.settings-ledger-icon-file { display: none; }
.settings-ledger-icon-option { position: relative; display: inline-flex; width: 100%; min-width: 0; min-height: 40px; box-sizing: border-box; align-items: center; justify-content: flex-start; gap: 7px; padding: 6px 12px; overflow: visible; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text-muted); cursor: pointer; font: inherit; text-align: left; transform-origin: 50% 55%; }
.settings-ledger-icon-option.is-system { border-color: color-mix(in srgb, var(--accent) 24%, var(--border)); }
.settings-ledger-icon-glyph { display: grid; width: 22px; height: 22px; flex: 0 0 22px; place-items: center; }
.settings-ledger-icon-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-ledger-icon-option.managing { animation: settings-ledger-icon-wiggle 180ms ease-in-out infinite alternate; }
.settings-ledger-icon-option.managing:nth-child(2n) { animation-delay: -90ms; animation-direction: alternate-reverse; }
.settings-ledger-icon-option.managing:nth-child(3n) { animation-delay: -45ms; animation-duration: 200ms; }
.settings-ledger-icon-name-input { width: 8em; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
.settings-ledger-icon-delete { position: absolute; top: 0; right: 0; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border: 2px solid var(--surface); border-radius: 50%; background: #ef4444; color: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 18%); font-size: 11px; font-weight: 700; line-height: 1; cursor: pointer; transform: translate(38%, -38%); }
.settings-ledger-icon-upload-error { color: #dc4c4c; font-size: .75rem; }
.settings-ledger-icon-recycle-modal { --settings-icon-surface: var(--bg-soft); width: min(520px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 64px)); overflow: hidden; border: 1px solid var(--border); border-radius: 14px; background: var(--settings-icon-surface); color: var(--text-h); box-shadow: 0 18px 48px rgb(0 0 0 / 22%); }
.settings-ledger-icon-recycle-modal :deep(.n-card__header) { padding: 14px 18px 4px; }
.settings-ledger-icon-recycle-modal :deep(.n-card__content) { display: flex; min-height: 0; flex-direction: column; padding: 0 18px 16px; }
.settings-ledger-icon-recycle-close { color: var(--text-muted); font-size: 20px; }
.settings-ledger-icon-recycle-count { display: inline-flex; min-width: 20px; height: 20px; align-items: center; justify-content: center; padding: 0 6px; border-radius: 10px; background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); font-size: .72rem; font-weight: 650; }
.settings-ledger-icon-recycle-hint { margin: 2px 0 8px; color: var(--text-muted); font-size: .75rem; line-height: 1.35; }
.settings-ledger-icon-recycle-content { min-height: 0; overflow-y: auto; }
.settings-ledger-icon-recycle-options { display: grid; }
.settings-ledger-icon-recycle-option { display: flex; min-width: 0; min-height: 32px; align-items: center; gap: 8px; padding: 3px 0; border-top: 1px solid var(--border); box-sizing: border-box; }
.settings-ledger-icon-recycle-option:first-child { border-top: 0; }
.settings-ledger-icon-recycle-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; margin-left: auto; }
.settings-ledger-icon-recycle-action { min-width: 52px; min-height: 28px; padding: 0 8px; }
.settings-ledger-icon-recycle-danger { min-width: 76px; }
.settings-ledger-icon-recycle-empty { margin: 0; padding: 14px 0 2px; color: var(--text-muted); font-size: .78rem; }

@media (max-width: 900px) {
  .settings-ledger-icon-options { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 560px) {
  .settings-ledger-icon-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@keyframes settings-ledger-icon-wiggle {
  from { transform: rotate(-.7deg) translateY(-.25px); }
  to { transform: rotate(.7deg) translateY(.25px); }
}

@media (prefers-reduced-motion: reduce) {
  .settings-ledger-icon-option.managing { animation: none; }
}
</style>
