import { describe, expect, it } from 'vitest'
import type { DiffOp, FileDiff } from '../history-api'
import { buildUnifiedDiffRows } from '../unified-diff'

function equal(line: number, text = `line ${line}`): DiffOp {
  return { op: 'equal', oldLine: line, newLine: line, text }
}

function file(ops: DiffOp[]): FileDiff {
  return {
    ops,
    stats: {
      added: ops.filter((op) => op.op === 'add').length,
      removed: ops.filter((op) => op.op === 'remove').length,
      equal: ops.filter((op) => op.op === 'equal').length,
    },
  }
}

describe('buildUnifiedDiffRows', () => {
  it('preserves structured operations and real line numbers', () => {
    const rows = buildUnifiedDiffRows(file([
      equal(1, '# Title'),
      { op: 'remove', oldLine: 2, newLine: null, text: 'is_a: Type' },
      { op: 'add', oldLine: null, newLine: 2, text: 'type: Type' },
      equal(3, 'url: https://example.com'),
    ]))

    expect(rows).toMatchObject([
      { kind: 'line', operation: 'equal', oldLine: 1, newLine: 1 },
      { kind: 'line', operation: 'remove', oldLine: 2, newLine: null },
      { kind: 'line', operation: 'add', oldLine: null, newLine: 2 },
      { kind: 'line', operation: 'equal', oldLine: 3, newLine: 3 },
    ])
  })

  it('renders every operation, including distant unchanged sections', () => {
    const ops = Array.from({ length: 25 }, (_, index) => equal(index + 1))
    ops[1] = { op: 'remove', oldLine: 2, newLine: null, text: 'old A' }
    ops[19] = { op: 'add', oldLine: null, newLine: 20, text: 'new B' }

    expect(buildUnifiedDiffRows(file(ops))).toHaveLength(25)
    expect(buildUnifiedDiffRows(file(ops)).every((row) => row.kind === 'line')).toBe(true)
  })
})
