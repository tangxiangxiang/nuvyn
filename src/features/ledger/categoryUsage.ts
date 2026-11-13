import type { LedgerCategoryDto, LedgerTransactionDto } from '../../../shared/ledgerProtocol'
import type { AuthUser } from '../../lib/auth-api'
import { NUVYN_BROWSER_STORAGE_KEYS, readStorageKey, writeStorageKey } from '../../technicalNamespace'

type CategoryKind = LedgerCategoryDto['kind']

interface CategoryUsage {
  categoryId: string
  useCount: number
  lastUsedAt: number
}

interface CategoryUsageStorage {
  version: 1
  expense: CategoryUsage[]
  income: CategoryUsage[]
  confirmedKeys: string[]
}

const maxCategories = 256
const maxUseCount = 1_000_000
const maxConfirmedKeys = 512
const maxIdLength = 128
const maxStorageLength = 512 * 1024

function storageKey(owner: AuthUser): string {
  return `${NUVYN_BROWSER_STORAGE_KEYS.ledgerCategoryUsage}:${owner.id}:${encodeURIComponent(owner.username)}`
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= maxIdLength
}

function validUsage(value: unknown): value is CategoryUsage {
  if (!value || typeof value !== 'object') return false
  const { categoryId, useCount, lastUsedAt } = value as Partial<CategoryUsage>
  return validId(categoryId)
    && typeof useCount === 'number' && Number.isSafeInteger(useCount) && useCount > 0 && useCount <= maxUseCount
    && typeof lastUsedAt === 'number' && Number.isSafeInteger(lastUsedAt) && lastUsedAt >= 0
}

function readUsage(value: unknown): CategoryUsage[] {
  if (!Array.isArray(value)) return []
  const entries = new Map<string, CategoryUsage>()
  for (const entry of value.slice(0, maxCategories)) {
    if (!validUsage(entry) || entries.has(entry.categoryId)) continue
    const { categoryId, useCount, lastUsedAt } = entry
    entries.set(categoryId, { categoryId, useCount, lastUsedAt })
  }
  return [...entries.values()]
}

function readCategoryUsage(key: string): CategoryUsageStorage {
  const raw = readStorageKey(key)
  if (raw && raw.length <= maxStorageLength) {
    try {
      const stored = JSON.parse(raw)
      if (stored?.version === 1) {
        return {
          version: 1,
          expense: readUsage(stored.expense),
          income: readUsage(stored.income),
          confirmedKeys: Array.isArray(stored.confirmedKeys)
            ? stored.confirmedKeys.slice(-maxConfirmedKeys).filter(validId)
            : [],
        }
      }
    } catch {
      // Malformed storage has no usage history.
    }
  }
  return { version: 1, expense: [], income: [], confirmedKeys: [] }
}

export function recentCategoryIds(
  owner: AuthUser | null,
  kind: CategoryKind,
  categories: readonly LedgerCategoryDto[],
): string[] {
  if (!owner) return []
  const activeIds = new Set(categories
    .filter((category) => category.kind === kind && category.archivedAt === null)
    .map((category) => category.id))
  return readCategoryUsage(storageKey(owner))[kind]
    .filter(({ categoryId }) => activeIds.has(categoryId))
    .sort((left, right) => right.useCount - left.useCount
      || right.lastUsedAt - left.lastUsedAt
      || (left.categoryId < right.categoryId ? -1 : 1))
    .slice(0, 3)
    .map(({ categoryId }) => categoryId)
}

export function recordCategoryUsage(owner: AuthUser, transaction: LedgerTransactionDto, confirmedKey: string): void {
  if (transaction.type !== 'income' && transaction.type !== 'expense') return
  if (!validId(transaction.categoryId) || !validId(confirmedKey)) return

  const key = storageKey(owner)
  const stored = readCategoryUsage(key)
  if (stored.confirmedKeys.includes(confirmedKey)) return

  const categoryId = transaction.categoryId
  const entries = stored[transaction.type]
  const previous = entries.find((entry) => entry.categoryId === categoryId)
  stored[transaction.type] = [
    { categoryId, useCount: Math.min((previous?.useCount ?? 0) + 1, maxUseCount), lastUsedAt: Date.now() },
    ...entries.filter((entry) => entry.categoryId !== categoryId).slice(0, maxCategories - 1),
  ]
  stored.confirmedKeys = [...stored.confirmedKeys.slice(1 - maxConfirmedKeys), confirmedKey]
  writeStorageKey(key, JSON.stringify(stored))
}
