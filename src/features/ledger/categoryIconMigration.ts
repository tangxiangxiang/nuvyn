import type { LedgerAccountIcon, LedgerCategoryDto } from '../../../shared/ledgerProtocol'
import { NUVYN_BROWSER_STORAGE_KEYS, readStorageKey, removeStorageKey } from '../../technicalNamespace'

const CATEGORY_ICON_STORAGE = NUVYN_BROWSER_STORAGE_KEYS.ledgerCategoryIcons
export const CATEGORY_ICON_STORAGE_KEY = CATEGORY_ICON_STORAGE
export const DEFAULT_CATEGORY_ICON: LedgerAccountIcon = 'wallet'

type LegacyCategoryIconMap = Record<string, LedgerAccountIcon>

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLedgerAccountIcon(value: unknown): value is LedgerAccountIcon {
  return typeof value === 'string'
    && (['wallet', 'credit_card', 'cash', 'building_bank', 'briefcase'].includes(value)
      || /^custom_[a-z0-9_]+$/.test(value))
}

function readLegacyCategoryIcons(): { icons: LegacyCategoryIconMap; deferred: boolean } | null {
  try {
    const raw = readStorageKey(CATEGORY_ICON_STORAGE)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainRecord(parsed)) return null

    const icons: LegacyCategoryIconMap = {}
    for (const [categoryId, icon] of Object.entries(parsed)) {
      if (categoryId && isLedgerAccountIcon(icon)) icons[categoryId] = icon
    }
    return { icons, deferred: false }
  } catch {
    // Legacy browser data is untrusted. A malformed value must not block the
    // Ledger workspace or cause an exception during bootstrap.
    return null
  }
}

interface CategoryIconMigrationCategory {
  readonly id: string
  readonly icon?: LedgerAccountIcon
  readonly archivedAt: number | null
  readonly version: number
}

interface CategoryIconMigrationPatch {
  readonly expectedVersion: number
  readonly icon: LedgerAccountIcon
}

/**
 * Move the old client-only category icon map into Category entities once.
 * Server state wins over legacy browser state; the legacy key is removed only
 * after every applicable write has succeeded.
 */
export async function migrateLegacyCategoryIcons(
  categories: readonly CategoryIconMigrationCategory[],
  patchCategory: (id: string, patch: CategoryIconMigrationPatch) => Promise<LedgerCategoryDto>,
): Promise<void> {
  const legacy = readLegacyCategoryIcons()
  if (legacy === null) return

  const byId = new Map(categories.map((category) => [category.id, category]))
  let deferred = false
  try {
    for (const [categoryId, legacyIcon] of Object.entries(legacy.icons)) {
      const category = byId.get(categoryId)
      if (!category || legacyIcon === DEFAULT_CATEGORY_ICON) continue

      // Archived categories are intentionally protected by the existing
      // Category service. Keep their legacy value for a future restore.
      if (category.archivedAt !== null) {
        deferred = true
        continue
      }

      // A non-default server value is authoritative, even if the browser has
      // a different stale value left over from an interrupted migration.
      if ((category.icon ?? DEFAULT_CATEGORY_ICON) !== DEFAULT_CATEGORY_ICON) continue
      await patchCategory(category.id, { expectedVersion: category.version, icon: legacyIcon })
    }

    if (deferred) return
    removeStorageKey(CATEGORY_ICON_STORAGE)
  } catch {
    // Preserve the key so the next bootstrap can retry an interrupted write.
  }
}
