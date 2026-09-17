import { describe, expect, it } from 'vitest'
import { rewriteDocumentReferences } from '../renameReferences'

describe('rewriteDocumentReferences', () => {
  it('updates resolved wiki and Markdown links while preserving anchors and aliases', () => {
    const raw = [
      '[[old]] [[old#setup|Guide]]',
      '[read](old.md#details)',
      '`[[old]]`',
      'plain old text',
    ].join('\n')
    expect(rewriteDocumentReferences(raw, 'notes/source', 'notes/old', 'notes/new', ['notes/source', 'notes/old'])).toBe([
      '[[notes/new]] [[notes/new#setup|Guide]]',
      '[read](notes/new.md#details)',
      '`[[old]]`',
      'plain old text',
    ].join('\n'))
  })

  it('does not rewrite a same-named link that resolves elsewhere', () => {
    expect(rewriteDocumentReferences('[[old]]', 'other/source', 'notes/old', 'notes/new', [
      'other/source', 'other/old', 'notes/old',
    ])).toBe('[[old]]')
  })
})
