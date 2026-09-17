import { ref } from 'vue'
import { LEDGER_BUILTIN_ACCOUNT_ICON_NAMES, LEDGER_DEFAULT_ACCOUNT_ICONS } from '../../shared/ledgerProtocol'
import type { LedgerAccountIcon, LedgerAccountIconConfig } from '../../shared/ledgerProtocol'
import { getLedgerSettings, patchLedgerSettings } from '../features/ledger/api'

const defaultIcon = ref<LedgerAccountIcon>('wallet')
const availableIcons = ref<LedgerAccountIcon[]>([...LEDGER_DEFAULT_ACCOUNT_ICONS])
const archivedIcons = ref<LedgerAccountIcon[]>([])
const customIcons = ref<Record<string, string>>({})
const customIconNames = ref<Record<string, string>>({})
const settingsVersion = ref<number | null>(null)
let loadPromise: Promise<void> | null = null

function hydrate(config?: LedgerAccountIconConfig, version?: number): void {
  if (!config) return
  const configuredNames = new Set(Object.values(config.customIconNames))
  const missingDefaults = LEDGER_DEFAULT_ACCOUNT_ICONS.filter((icon) => {
    const builtinName = LEDGER_BUILTIN_ACCOUNT_ICON_NAMES[icon]
    return !builtinName || !configuredNames.has(builtinName)
  })
  defaultIcon.value = config.defaultIcon
  const customNames = { ...LEDGER_BUILTIN_ACCOUNT_ICON_NAMES, ...config.customIconNames }
  const accidentalTestIcons = new Set<string>(config.availableIcons.filter((icon) => (
    icon.startsWith('custom_') && customNames[icon] === '测试'
  )))
  availableIcons.value = [...new Set([...missingDefaults, ...config.availableIcons.filter((icon) => !accidentalTestIcons.has(icon))])]
  archivedIcons.value = [...new Set((config.archivedIcons ?? []).filter((icon) => !availableIcons.value.includes(icon) && !accidentalTestIcons.has(icon)))]
  customIcons.value = Object.fromEntries(Object.entries(config.customIcons).filter(([icon]) => !accidentalTestIcons.has(icon)))
  customIconNames.value = Object.fromEntries(Object.entries(customNames).filter(([icon]) => !accidentalTestIcons.has(icon)))
  if (version !== undefined) settingsVersion.value = version
}

async function loadSettings(): Promise<void> {
  const settings = await getLedgerSettings()
  const configuredIcons = settings.accountIcons
  const accidentalTestIcons = configuredIcons?.availableIcons.filter((icon) => (
    icon.startsWith('custom_') && configuredIcons.customIconNames[icon] === '测试'
  )) ?? []
  hydrate(settings.accountIcons, settings.version)

  // Remove the accidental test icon created by the earlier category-upload
  // implementation. The exact label keeps this cleanup limited to that
  // mistaken entry and leaves all other user-defined account icons intact.
  if (accidentalTestIcons.length > 0) {
    accidentalTestIcons.forEach((icon) => {
      removeIcon(icon)
      deleteIcon(icon)
    })
    await persist()
  }

}

function load(): Promise<void> {
  if (loadPromise !== null) return loadPromise
  loadPromise = loadSettings().finally(() => {
    loadPromise = null
  })
  return loadPromise
}

async function persist(): Promise<void> {
  if (settingsVersion.value === null) return
  const settings = await patchLedgerSettings({
    expectedVersion: settingsVersion.value,
    accountIcons: { defaultIcon: defaultIcon.value, availableIcons: availableIcons.value, archivedIcons: archivedIcons.value, customIcons: customIcons.value, customIconNames: customIconNames.value },
  })
  hydrate(settings.accountIcons, settings.version)
}

function addIcon(icon: LedgerAccountIcon): void {
  if (!availableIcons.value.includes(icon)) availableIcons.value = [...availableIcons.value, icon]
}

function removeIcon(icon: LedgerAccountIcon): void {
  if (!icon.startsWith('custom_') || icon.startsWith('custom_builtin_')) return
  if (defaultIcon.value === icon) return
  if (availableIcons.value.length <= 1) return
  availableIcons.value = availableIcons.value.filter((item) => item !== icon)
  if (icon.startsWith('custom_')) archivedIcons.value = [...new Set([...archivedIcons.value, icon])]
}

function restoreIcon(icon: LedgerAccountIcon): void {
  if (!archivedIcons.value.includes(icon)) return
  archivedIcons.value = archivedIcons.value.filter((item) => item !== icon)
  availableIcons.value = [...availableIcons.value, icon]
}

function deleteIcon(icon: LedgerAccountIcon): void {
  if (!archivedIcons.value.includes(icon) || !icon.startsWith('custom_')) return
  archivedIcons.value = archivedIcons.value.filter((item) => item !== icon)
  const { [icon]: _removed, ...remainingNames } = customIconNames.value
  customIconNames.value = remainingNames
  const { [icon]: _removedSvg, ...remainingIcons } = customIcons.value
  customIcons.value = remainingIcons
}

function addCustomIcon(svg: string, name = '自定义图标'): LedgerAccountIcon {
  const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  customIcons.value = { ...customIcons.value, [id]: svg }
  customIconNames.value = { ...customIconNames.value, [id]: name.trim() || '自定义图标' }
  addIcon(id as LedgerAccountIcon)
  return id as LedgerAccountIcon
}

function renameCustomIcon(icon: LedgerAccountIcon, name: string): void {
  if (!icon.startsWith('custom_') || icon.startsWith('custom_builtin_')) return
  const nextName = name.trim()
  if (!nextName) return
  customIconNames.value = { ...customIconNames.value, [icon]: nextName }
}

function getCustomIcon(icon: LedgerAccountIcon): string | undefined {
  return customIcons.value[icon]
}

export function useLedgerAccountIconPreferences() {
  void load().catch(() => undefined)
  return { defaultIcon, availableIcons, archivedIcons, customIcons, customIconNames, addIcon, removeIcon, restoreIcon, deleteIcon, addCustomIcon, renameCustomIcon, getCustomIcon, hydrate, load, persist }
}
