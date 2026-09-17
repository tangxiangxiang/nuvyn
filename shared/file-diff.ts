import { diffLines, diffWordsWithSpace, type Change } from 'diff'
import type { DiffOp, DiffOpKind, FileDiff } from '../src/lib/history-api'

function changeToOp(
  change: Change,
  oldLineStart: number,
  newLineStart: number,
): {
  op: DiffOpKind
  oldLineStart: number
  newLineStart: number
  lines: Array<{ text: string; oldLine: number | null; newLine: number | null }>
} {
  const op: DiffOpKind = change.added ? 'add' : change.removed ? 'remove' : 'equal'
  const parts = change.value.split('\n')
  if (parts.at(-1) === '') parts.pop()
  const lines = []
  let oldLine = oldLineStart
  let newLine = newLineStart

  for (const text of parts) {
    lines.push({
      text,
      oldLine: op === 'add' ? null : oldLine,
      newLine: op === 'remove' ? null : newLine,
    })
    if (op !== 'add') oldLine++
    if (op !== 'remove') newLine++
  }
  return { op, oldLineStart: oldLine, newLineStart: newLine, lines }
}

function looksLikeEditPair(removed: DiffOp, added: DiffOp): boolean {
  if (removed.op !== 'remove' || added.op !== 'add') return false
  if (removed.text.includes('\n') || added.text.includes('\n')) return false
  if (!removed.text || !added.text) return false
  return Math.min(removed.text.length, added.text.length)
    / Math.max(removed.text.length, added.text.length) >= 0.5
}

function similarity(left: string, right: string): number {
  if (!left && !right) return 1
  const chars = new Set(left.toLowerCase())
  let intersection = 0
  let union = chars.size
  for (const char of right.toLowerCase()) {
    if (chars.has(char)) intersection++
    else union++
  }
  return union === 0 ? 0 : intersection / union
}

function annotateWordDiffs(ops: DiffOp[]): void {
  for (let index = 0; index + 1 < ops.length; index++) {
    const removed = ops[index]
    const added = ops[index + 1]
    if (!removed || !added || !looksLikeEditPair(removed, added)) continue
    if (similarity(removed.text, added.text) < 0.5) continue

    const words = diffWordsWithSpace(removed.text, added.text)
    removed.words = words
      .filter((word) => !word.added)
      .map((word) => ({
        op: word.removed ? 'remove' : 'equal',
        oldLine: removed.oldLine,
        newLine: removed.newLine,
        text: word.value,
      }))
    added.words = words
      .filter((word) => !word.removed)
      .map((word) => ({
        op: word.added ? 'add' : 'equal',
        oldLine: removed.oldLine,
        newLine: removed.newLine,
        text: word.value,
      }))
  }
}

/** Compute the shared line and word diff used by both server history APIs
 * and client-side comparisons against unsaved editor content. */
export function computeFileDiff(oldContent: string | null, newContent: string | null): FileDiff {
  if (oldContent === newContent) {
    return { ops: [], stats: { added: 0, removed: 0, equal: 0 } }
  }

  const changes = diffLines(
    (oldContent ?? '').replace(/\r\n/g, '\n'),
    (newContent ?? '').replace(/\r\n/g, '\n'),
  )
  const ops: DiffOp[] = []
  let oldLine = 1
  let newLine = 1
  let added = 0
  let removed = 0
  let equal = 0

  for (const change of changes) {
    const output = changeToOp(change, oldLine, newLine)
    oldLine = output.oldLineStart
    newLine = output.newLineStart
    for (const line of output.lines) {
      ops.push({ op: output.op, ...line })
      if (output.op === 'add') added++
      else if (output.op === 'remove') removed++
      else equal++
    }
  }

  annotateWordDiffs(ops)
  return { ops, stats: { added, removed, equal } }
}
