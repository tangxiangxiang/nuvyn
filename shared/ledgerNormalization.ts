/**
 * Canonical Ledger Category identity.
 *
 * This is intentionally a tiny, dependency-free shared primitive. It is
 * deliberately not Unicode-normalized and does not use a locale-sensitive
 * case conversion or SQLite's lower() function.
 */

export const LEDGER_CATEGORY_IDENTITY_CONTRACT_VERSION = 'ledger-category-identity-v1' as const

/** Derive the persisted Category identity from its display name. */
export function normalizeLedgerCategoryName(name: string): string {
  return name.trim().toLowerCase()
}

/** Alias for callers that use the shorter normalization terminology. */
export const normalizeCategoryName = normalizeLedgerCategoryName
