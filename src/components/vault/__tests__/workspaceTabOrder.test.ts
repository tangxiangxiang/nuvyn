import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceTabOrder,
  migrateWorkspaceTabIds,
  moveWorkspaceTab,
  reconcileWorkspaceTabOrder,
} from '../workspaceTabOrder'

describe('workspaceTabOrder', () => {
  it('initializes from natural order and remains stable', () => {
    expect(reconcileWorkspaceTabOrder([], ['doc:a', 'history:a', 'diff:a'])).toEqual([
      'doc:a', 'history:a', 'diff:a',
    ])
    expect(reconcileWorkspaceTabOrder(
      ['history:a', 'doc:a', 'diff:a'],
      ['doc:a', 'history:a', 'diff:a'],
    )).toEqual(['history:a', 'doc:a', 'diff:a'])
  })

  it('appends new IDs, removes missing IDs, and deduplicates both inputs', () => {
    expect(reconcileWorkspaceTabOrder(
      ['b', 'missing', 'b', 'a'],
      ['a', 'b', 'c', 'c'],
    )).toEqual(['b', 'a', 'c'])
  })

  it.each([
    ['before', ['a', 'c', 'b', 'd']],
    ['after', ['a', 'c', 'd', 'b']],
  ] as const)('moves before and after a target', (position, expected) => {
    expect(moveWorkspaceTab(['a', 'b', 'c', 'd'], 'b', 'd', position)).toEqual(expected)
  })

  it('moves to either edge and treats same/unknown positions as no-ops', () => {
    expect(moveWorkspaceTab(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    expect(moveWorkspaceTab(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
    expect(moveWorkspaceTab(['a', 'b'], 'a', 'a', 'before')).toEqual(['a', 'b'])
    expect(moveWorkspaceTab(['a', 'b'], 'x', 'a', 'before')).toEqual(['a', 'b'])
    expect(moveWorkspaceTab(['a', 'b'], 'a', 'x', 'before')).toEqual(['a', 'b'])
  })

  it('accepts only an exact requested ID set', () => {
    expect(applyWorkspaceTabOrder(['a', 'b'], ['b', 'a'], ['a', 'b'])).toEqual(['b', 'a'])
    expect(applyWorkspaceTabOrder(['a', 'b'], ['a'], ['a', 'b'])).toBeNull()
    expect(applyWorkspaceTabOrder(['a', 'b'], ['a', 'a'], ['a', 'b'])).toBeNull()
    expect(applyWorkspaceTabOrder(['a', 'b'], ['a', 'x'], ['a', 'b'])).toBeNull()
  })

  it('migrates rename IDs in place with source position winning duplicates', () => {
    expect(migrateWorkspaceTabIds(['a', 'history:a', 'b'], [{ from: 'a', to: 'x' }]))
      .toEqual(['x', 'history:a', 'b'])
    expect(migrateWorkspaceTabIds(['a', 'b', 'c'], [{ from: 'a', to: 'b' }]))
      .toEqual(['b', 'c'])
    expect(migrateWorkspaceTabIds(['b', 'a', 'c'], [{ from: 'a', to: 'b' }]))
      .toEqual(['b', 'c'])
  })

  it('applies multiple mappings stably without parsing mixed IDs', () => {
    expect(migrateWorkspaceTabIds(
      ['history:a', 'doc:a', 'diff:b', 'doc:b'],
      [{ from: 'doc:a', to: 'doc:x' }, { from: 'diff:b', to: 'diff:y' }],
    )).toEqual(['history:a', 'doc:x', 'diff:y', 'doc:b'])
  })
})
