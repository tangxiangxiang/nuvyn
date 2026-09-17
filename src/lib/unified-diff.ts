import type { DiffOp, DiffOpKind, FileDiff } from './history-api'

export interface UnifiedDiffLineRow {
  kind: 'line'
  key: string
  operation: DiffOpKind
  oldLine: number | null
  newLine: number | null
  text: string
  words?: DiffOp[]
}

export type UnifiedDiffRow = UnifiedDiffLineRow

function toLineRow(op: DiffOp, index: number): UnifiedDiffLineRow {
  return {
    kind: 'line',
    key: `line-${index}-${op.oldLine ?? 'x'}-${op.newLine ?? 'x'}`,
    operation: op.op,
    oldLine: op.oldLine,
    newLine: op.newLine,
    text: op.text,
    words: op.words,
  }
}

/** Project structured FileDiff operations into unified rows. */
export function buildUnifiedDiffRows(
  diff: FileDiff,
): UnifiedDiffRow[] {
  return diff.ops.map(toLineRow)
}
