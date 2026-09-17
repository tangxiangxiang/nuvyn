import { computed, ref } from 'vue'
import {
  DIARY_DEFAULT_MOOD_ICONS,
  getMoodDefinition,
  isDiaryCustomMoodId,
  isMoodId,
  type DiaryMoodIconConfig,
  type DiaryMoodId,
} from '../../../shared/diaryMood'
import { getDiaryMoodIconConfig, patchDiaryMoodIconConfig } from '../../lib/api'

const availableIcons = ref<DiaryMoodId[]>([...DIARY_DEFAULT_MOOD_ICONS])
const archivedIcons = ref<DiaryMoodId[]>([])
const customIcons = ref<Record<string, string>>({})
const customIconNames = ref<Record<string, string>>({})
const settingsVersion = ref<number | null>(null)
const loading = ref(false)
let loadPromise: Promise<void> | null = null

function hydrate(config: DiaryMoodIconConfig): void {
  const customIds = new Set(Object.keys(config.customIcons))
  availableIcons.value = [...new Set([
    ...DIARY_DEFAULT_MOOD_ICONS,
    ...config.availableIcons.filter((icon) => isMoodId(icon) || (isDiaryCustomMoodId(icon) && customIds.has(icon))),
  ])]
  archivedIcons.value = [...new Set((config.archivedIcons ?? []).filter((icon) => !availableIcons.value.includes(icon) && isDiaryCustomMoodId(icon)))]
  customIcons.value = { ...config.customIcons }
  customIconNames.value = { ...config.customIconNames }
  settingsVersion.value = config.version
}

async function load(force = false): Promise<void> {
  if (!force && settingsVersion.value !== null) return
  if (loadPromise && !force) return loadPromise
  loading.value = true
  loadPromise = getDiaryMoodIconConfig()
    .then(hydrate)
    .finally(() => {
      loading.value = false
      loadPromise = null
    })
  return loadPromise
}

async function persist(): Promise<void> {
  if (settingsVersion.value === null) await load()
  if (settingsVersion.value === null) return
  const next = await patchDiaryMoodIconConfig({
    expectedVersion: settingsVersion.value,
    availableIcons: availableIcons.value,
    archivedIcons: archivedIcons.value,
    customIcons: customIcons.value,
    customIconNames: customIconNames.value,
  })
  hydrate(next)
}

function addCustomIcon(svg: string, name = '自定义表情'): DiaryMoodId {
  const id = `custom_mood_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` as DiaryMoodId
  customIcons.value = { ...customIcons.value, [id]: svg }
  customIconNames.value = { ...customIconNames.value, [id]: name.trim() || '自定义表情' }
  availableIcons.value = [...availableIcons.value, id]
  return id
}

function removeIcon(icon: DiaryMoodId): void {
  if (!isDiaryCustomMoodId(icon)) return
  availableIcons.value = availableIcons.value.filter((item) => item !== icon)
  archivedIcons.value = [...new Set([...archivedIcons.value, icon])]
}

function restoreIcon(icon: DiaryMoodId): void {
  if (!archivedIcons.value.includes(icon)) return
  archivedIcons.value = archivedIcons.value.filter((item) => item !== icon)
  availableIcons.value = [...availableIcons.value, icon]
}

function deleteIcon(icon: DiaryMoodId): void {
  if (!archivedIcons.value.includes(icon) || !isDiaryCustomMoodId(icon)) return
  archivedIcons.value = archivedIcons.value.filter((item) => item !== icon)
  const { [icon]: _removedSvg, ...remainingIcons } = customIcons.value
  const { [icon]: _removedName, ...remainingNames } = customIconNames.value
  customIcons.value = remainingIcons
  customIconNames.value = remainingNames
}

function renameCustomIcon(icon: DiaryMoodId, name: string): void {
  if (!isDiaryCustomMoodId(icon)) return
  const nextName = name.trim()
  if (!nextName || !Object.hasOwn(customIcons.value, icon)) return
  customIconNames.value = { ...customIconNames.value, [icon]: nextName }
}

function isAvailable(icon: unknown): icon is DiaryMoodId {
  return isMoodId(icon) || (isDiaryCustomMoodId(icon) && availableIcons.value.includes(icon))
}

function getCustomIcon(icon: DiaryMoodId): string | undefined {
  return customIcons.value[icon]
}

function labelFor(icon: string, locale: 'zh' | 'en' = 'zh'): string {
  const definition = isMoodId(icon) ? getMoodDefinition(icon) : undefined
  if (definition) return locale === 'zh' ? definition.zhLabel : definition.enLabel
  return customIconNames.value[icon] || '自定义表情'
}

function sourceFor(icon: string): string | undefined {
  const definition = isMoodId(icon) ? getMoodDefinition(icon) : undefined
  if (definition) return definition.asset.startsWith('public/') ? `/${definition.asset.slice('public/'.length)}` : definition.asset
  const svg = customIcons.value[icon]
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : undefined
}

function presentationFor(icon: unknown, locale: 'zh' | 'en' = 'zh') {
  if (typeof icon !== 'string' || !isAvailable(icon)) return null
  const definition = isMoodId(icon) ? getMoodDefinition(icon) : undefined
  const label = labelFor(icon, locale)
  return {
    id: icon,
    label,
    accessibilityName: definition?.accessibilityName ?? label,
    source: sourceFor(icon),
  }
}

export function useDiaryMoodIconPreferences() {
  const availableCount = computed(() => availableIcons.value.length)
  return {
    availableIcons,
    archivedIcons,
    availableCount,
    customIcons,
    customIconNames,
    loading,
    addCustomIcon,
    removeIcon,
    restoreIcon,
    deleteIcon,
    renameCustomIcon,
    getCustomIcon,
    isAvailable,
    labelFor,
    sourceFor,
    presentationFor,
    hydrate,
    load,
    persist,
  }
}
