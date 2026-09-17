import { normalizeLedgerCategoryName } from '../../shared/ledgerNormalization.js'
import { LEDGER_BUILTIN_CATEGORY_ICONS, type LedgerCategoryKind } from '../../shared/ledgerProtocol.js'
import type { LedgerCategory } from './domain.js'
import type { LedgerRepository } from './repository.js'

/** The exact ordered v2 catalog created with the first Ledger Settings row. */
export const DEFAULT_LEDGER_CATEGORIES_V2: readonly { kind: LedgerCategoryKind; name: string; icon: string; sortOrder: number; systemKey?: LedgerCategory['systemKey'] }[] = LEDGER_BUILTIN_CATEGORY_ICONS
  .map(({ kind, name, id: icon, sortOrder, systemKey }) => ({ kind, name, icon, sortOrder, ...(systemKey ? { systemKey } : {}) }))

export interface LedgerCategorySeedDependencies {
  readonly now: () => number
  readonly createId: () => string
}

/**
 * Seed the catalog inside the caller's write transaction. Existing identities
 * are deliberately untouched, including archived identities.
 */
export function seedDefaultLedgerCategories(
  repository: LedgerRepository,
  dependencies: LedgerCategorySeedDependencies,
): void {
  for (const entry of DEFAULT_LEDGER_CATEGORIES_V2) {
    const normalizedName = normalizeLedgerCategoryName(entry.name)
    if (repository.findCategoryByIdentity(entry.kind, normalizedName) !== null) continue

    const timestamp = dependencies.now()
    const category: LedgerCategory = {
      id: dependencies.createId(),
      kind: entry.kind,
      name: entry.name,
      normalizedName,
      ...(entry.systemKey ? { systemKey: entry.systemKey } : {}),
      isDefault: true,
      icon: entry.icon as LedgerCategory['icon'],
      sortOrder: entry.sortOrder,
      archivedAt: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    repository.insertCategory(category)
  }
}
