// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LedgerCategoryDto, LedgerTransactionDto } from '../../../../shared/ledgerProtocol'
import { recentCategoryIds, recordCategoryUsage } from '../categoryUsage'

const owner = { id: 1, username: 'owner' }
const key = 'nuvyn.ledger.category-usage:1:owner'

function category(id: string, kind: 'expense' | 'income' = 'expense', archivedAt: number | null = null): LedgerCategoryDto {
  return { id, kind, name: id, normalizedName: id, archivedAt, version: 1, createdAt: 1, updatedAt: 1 }
}

function record(categoryId: string, confirmedKey: string, type: 'expense' | 'income' = 'expense'): void {
  recordCategoryUsage(owner, { type, categoryId } as LedgerTransactionDto, confirmedKey)
}

describe('Ledger category usage', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('ranks by frequency, recency and ID, caps the result at three and excludes stale categories', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    record('archived', '1')
    record('archived', '2')
    record('archived', '3')
    record('deleted', '4')
    record('deleted', '5')
    record('most-used', '6')
    record('most-used', '7')
    record('older', '8')
    clock.mockReturnValue(200)
    record('b', '9')
    record('a', '10')
    record('salary', '11', 'income')
    const categories = [
      category('b'), category('never-used'), category('archived', 'expense', 1),
      category('a'), category('older'), category('most-used'), category('salary', 'income'),
    ]

    expect(recentCategoryIds(owner, 'expense', categories)).toEqual(['most-used', 'a', 'b'])
    expect(recentCategoryIds(owner, 'income', categories)).toEqual(['salary'])
    expect(recentCategoryIds({ ...owner, id: 2 }, 'expense', categories)).toEqual([])
    expect(recentCategoryIds({ ...owner, username: 'other' }, 'expense', categories)).toEqual([])
    expect(recentCategoryIds(null, 'expense', categories)).toEqual([])
  })

  it('validates stored data, bounds counters and ignores an already-confirmed key', () => {
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      expense: [
        { categoryId: 'food', useCount: 1_000_000, lastUsedAt: 10, extra: 'discard' },
        { categoryId: 'food', useCount: 1, lastUsedAt: 11 },
        { categoryId: 'zero', useCount: 0, lastUsedAt: 5 },
        { categoryId: 'bad-count', useCount: -5, lastUsedAt: 5 },
        { categoryId: 'bad-date', useCount: 2, lastUsedAt: '5' },
        null,
      ],
      income: 'bad',
      confirmedKeys: ['confirmed', 123],
    }))
    const categories = ['food', 'zero', 'bad-count', 'bad-date'].map((id) => category(id))
    expect(recentCategoryIds(owner, 'expense', categories)).toEqual(['food'])
    expect(recentCategoryIds(owner, 'income', categories)).toEqual([])

    record('other', 'confirmed')
    expect(recentCategoryIds(owner, 'expense', [category('other')])).toEqual([])
    vi.spyOn(Date, 'now').mockReturnValue(20)
    record('food', 'new')
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      version: 1,
      expense: [{ categoryId: 'food', useCount: 1_000_000, lastUsedAt: 20 }],
      income: [],
      confirmedKeys: ['confirmed', 'new'],
    })
  })

  it('bounds stored rows and replay keys', () => {
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      expense: Array.from({ length: 256 }, (_, index) => ({ categoryId: String(index), useCount: 1, lastUsedAt: 10 })),
      income: [],
      confirmedKeys: Array.from({ length: 512 }, (_, index) => String(index)),
    }))
    record('latest', 'new')
    const stored = JSON.parse(localStorage.getItem(key)!)
    expect(stored.expense).toHaveLength(256)
    expect(stored.expense[0].categoryId).toBe('latest')
    expect(stored.confirmedKeys).toHaveLength(512)
    expect(stored.confirmedKeys.at(-1)).toBe('new')
  })

  it('falls back safely for malformed JSON and unavailable browser storage', () => {
    localStorage.setItem(key, '{')
    expect(recentCategoryIds(owner, 'expense', [category('food')])).toEqual([])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => record('food', 'new')).not.toThrow()
    expect(recentCategoryIds(owner, 'expense', [category('food')])).toEqual([])
  })
})
