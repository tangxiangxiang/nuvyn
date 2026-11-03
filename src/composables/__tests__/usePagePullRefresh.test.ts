import { describe, expect, it } from 'vitest'
import { pagePullDirection } from '../usePagePullRefresh'

describe('page pull-to-refresh gesture', () => {
  it('accepts only deliberate downward motion', () => {
    expect(pagePullDirection(0, 50)).toBe(true)
    expect(pagePullDirection(8, 80)).toBe(true)
    expect(pagePullDirection(15, 5)).toBe(false)
    expect(pagePullDirection(80, 20)).toBe(false)
    expect(pagePullDirection(0, -20)).toBe(false)
    expect(pagePullDirection(Number.NaN, 50)).toBe(false)
  })
})
