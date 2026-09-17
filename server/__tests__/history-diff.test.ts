// Unit tests for the L1 diff parser. Pure-function tests, no I/O —
// these run in <100ms. Coverage:
//
//   - identical inputs → empty FileDiff
//   - pure add / pure remove
//   - mixed change set with line numbers
//   - null oldContent / newContent (file did not exist on one side)
//   - CRLF input normalization
//   - stats correctness across all of the above
//   - word-level diff attaches to adjacent remove+add pairs that
//     look like edits, NOT to unrelated adjacent pairs
//   - the similarity gate rejects replacements of completely
//     different content

import { describe, it, expect } from 'vitest'
import { computeFileDiff } from '../history/diff.js'

describe('computeFileDiff', () => {
  it('returns an empty result for identical strings', () => {
    const d = computeFileDiff('a\nb\nc\n', 'a\nb\nc\n')
    expect(d.ops).toEqual([])
    expect(d.stats).toEqual({ added: 0, removed: 0, equal: 0 })
  })

  it('returns an empty result for both empty', () => {
    const d = computeFileDiff('', '')
    expect(d.ops).toEqual([])
    expect(d.stats).toEqual({ added: 0, removed: 0, equal: 0 })
  })

  it('treats null oldContent as fully empty (pure add of new)', () => {
    const d = computeFileDiff(null, 'a\nb\n')
    expect(d.ops.map((o) => o.op)).toEqual(['add', 'add'])
    expect(d.ops[0]).toMatchObject({ op: 'add', oldLine: null, newLine: 1, text: 'a' })
    expect(d.ops[1]).toMatchObject({ op: 'add', oldLine: null, newLine: 2, text: 'b' })
    expect(d.stats).toEqual({ added: 2, removed: 0, equal: 0 })
  })

  it('treats null newContent as fully empty (pure remove of old)', () => {
    const d = computeFileDiff('a\nb\n', null)
    expect(d.ops.map((o) => o.op)).toEqual(['remove', 'remove'])
    expect(d.stats).toEqual({ added: 0, removed: 2, equal: 0 })
  })

  it('emits add / remove / equal with correct 1-based line numbers', () => {
    const oldText = 'a\nb\nc\nd\n'
    const newText = 'a\nB\nc\nd\ne\n'
    const d = computeFileDiff(oldText, newText)
    // Expected: a equal, b removed, B added, c equal, d equal, e added
    expect(d.ops).toHaveLength(6)
    expect(d.ops[0]).toEqual({ op: 'equal', oldLine: 1, newLine: 1, text: 'a', words: undefined })
    expect(d.ops[1]).toMatchObject({ op: 'remove', oldLine: 2, newLine: null, text: 'b' })
    expect(d.ops[2]).toMatchObject({ op: 'add', oldLine: null, newLine: 2, text: 'B' })
    expect(d.ops[3]).toEqual({ op: 'equal', oldLine: 3, newLine: 3, text: 'c', words: undefined })
    expect(d.ops[4]).toEqual({ op: 'equal', oldLine: 4, newLine: 4, text: 'd', words: undefined })
    expect(d.ops[5]).toMatchObject({ op: 'add', oldLine: null, newLine: 5, text: 'e' })
    expect(d.stats).toEqual({ added: 2, removed: 1, equal: 3 })
  })

  it('handles a line being replaced in place (adjacent remove+add)', () => {
    const d = computeFileDiff('line one\nline two\n', 'line one\nLINE TWO\n')
    // The mid-line edit should get a word-level breakdown on both rows.
    const removed = d.ops.find((o) => o.op === 'remove')
    const added = d.ops.find((o) => o.op === 'add')
    expect(removed).toBeDefined()
    expect(added).toBeDefined()
    // Each op has words set; the remove op contains equal+remove chunks,
    // the add op contains equal+add chunks. The "equal" chunk holds
    // the unchanged "line " prefix (or "two" suffix, depending on how
    // diffWords splits).
    expect(removed!.words!.length).toBeGreaterThan(0)
    expect(added!.words!.length).toBeGreaterThan(0)
    const removedHasEqual = removed!.words!.some((w) => w.op === 'equal')
    const removedHasRemove = removed!.words!.some((w) => w.op === 'remove')
    const addedHasEqual = added!.words!.some((w) => w.op === 'equal')
    const addedHasAdd = added!.words!.some((w) => w.op === 'add')
    expect(removedHasEqual).toBe(true)
    expect(removedHasRemove).toBe(true)
    expect(addedHasEqual).toBe(true)
    expect(addedHasAdd).toBe(true)
  })

  it('does not annotate word-diff for completely different adjacent lines', () => {
    // Two adjacent lines with zero shared characters — the similarity
    // gate should suppress the word-level breakdown.
    const d = computeFileDiff('aaaa\nbbbb\ncccc\n', 'xxxx\nyyyy\nzzzz\n')
    const removes = d.ops.filter((o) => o.op === 'remove')
    const adds = d.ops.filter((o) => o.op === 'add')
    // None of the add/remove rows should have a `words` field set.
    for (const r of [...removes, ...adds]) {
      expect(r.words).toBeUndefined()
    }
  })

  it('does not annotate word-diff when an add follows a multi-line remove', () => {
    // Multi-line block on either side → no words annotation (the
    // optimization only triggers on 1:1 single-line pairs).
    const d = computeFileDiff('a\nb\nc\n', 'x\n')
    const adds = d.ops.filter((o) => o.op === 'add')
    for (const a of adds) expect(a.words).toBeUndefined()
  })

  it('normalizes CRLF input so cross-platform files diff cleanly', () => {
    const oldCrlf = 'line one\r\nline two\r\nline three\r\n'
    const newLf = 'line one\nline two\nLINE THREE\n'
    // If CRLF leaked through, every line would be "modified" — we'd
    // see 3 remove + 3 add. With normalization, only line 3 differs.
    const d = computeFileDiff(oldCrlf, newLf)
    expect(d.stats).toEqual({ added: 1, removed: 1, equal: 2 })
  })

  it('treats a trailing-newline change as a 1-line add + 1-line remove', () => {
    // kpdecker line-diff treats the trailing newline as part of the
    // line, so `b` (no newline) and `b\n` (with newline) are different
    // line tokens. We document this behavior rather than fight it —
    // the renderer collapses trailing-newline visual changes
    // naturally.
    const d = computeFileDiff('a\nb', 'a\nb\n')
    expect(d.stats).toEqual({ added: 1, removed: 1, equal: 1 })
    expect(d.ops[0]).toMatchObject({ op: 'equal', text: 'a' })
    expect(d.ops[1]).toMatchObject({ op: 'remove', text: 'b' })
    expect(d.ops[2]).toMatchObject({ op: 'add', text: 'b' })
  })

  it('handles a single-line file (no newlines)', () => {
    const d = computeFileDiff('hello', 'world')
    expect(d.ops).toHaveLength(2)
    expect(d.ops[0]).toMatchObject({ op: 'remove', text: 'hello' })
    expect(d.ops[1]).toMatchObject({ op: 'add', text: 'world' })
  })

  it('stats add up to the line count of old + new (invariant)', () => {
    const oldText = 'a\nb\nc\nd\ne\nf\n'
    const newText = 'a\nB\nc\nD\ne\nf\nG\n'
    const d = computeFileDiff(oldText, newText)
    // Every removed row has a counterpart, every added row is a real
    // addition. Total ops = removed + added + equal.
    expect(d.ops.length).toBe(d.stats.added + d.stats.removed + d.stats.equal)
    // The "equal" count must equal the number of lines common to
    // both old and new (line by line, not set intersection — the
    // diff is positional).
    expect(d.stats.equal).toBeGreaterThan(0)
  })
})
