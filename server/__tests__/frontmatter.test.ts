import { describe, it, expect } from 'vitest'
import { bumpUpdatedInFrontmatter } from '../frontmatter.js'

describe('bumpUpdatedInFrontmatter', () => {
  it('prepends a frontmatter block when the file has none', () => {
    const out = bumpUpdatedInFrontmatter('# Just a body\n', '2026-06-12')
    expect(out).toBe('---\nupdated: 2026-06-12\n---\n\n# Just a body\n')
  })

  it('appends `updated:` when the frontmatter has no updated line', () => {
    const raw = '---\ntitle: Smoke\ntags: [a]\n---\n\nbody\n'
    const out = bumpUpdatedInFrontmatter(raw, '2026-06-12')
    expect(out).toBe('---\ntitle: Smoke\ntags: [a]\nupdated: 2026-06-12\n---\n\nbody\n')
  })

  it('replaces the existing `updated:` line in place', () => {
    const raw = '---\ntitle: Smoke\nupdated: 2025-01-01\ntags: [a]\n---\n\nbody\n'
    const out = bumpUpdatedInFrontmatter(raw, '2026-06-12')
    expect(out).toBe('---\ntitle: Smoke\nupdated: 2026-06-12\ntags: [a]\n---\n\nbody\n')
  })

  it('replaces a quoted `updated:` value', () => {
    const raw = '---\nupdated: "2025-01-01"\ntitle: Smoke\n---\n\nbody\n'
    const out = bumpUpdatedInFrontmatter(raw, '2026-06-12')
    expect(out).toBe('---\nupdated: 2026-06-12\ntitle: Smoke\n---\n\nbody\n')
  })

  it('replaces an empty `updated:` value', () => {
    const raw = '---\nupdated:\ntitle: Smoke\n---\n\nbody\n'
    const out = bumpUpdatedInFrontmatter(raw, '2026-06-12')
    expect(out).toBe('---\nupdated: 2026-06-12\ntitle: Smoke\n---\n\nbody\n')
  })

  it('preserves user formatting and field order around the bump', () => {
    // Multi-space, trailing space, comments — all should survive.
    const raw = [
      '---',
      'title:   Spaced   # comment',
      'tags:    [a, b]',
      'updated: 2025-01-01',
      'custom:  keep-me',
      '---',
      '',
      'body content with `---` and stuff',
      '',
    ].join('\n')
    const out = bumpUpdatedInFrontmatter(raw, '2026-06-12')
    // `updated:` line is the only thing that changes
    expect(out).toContain('title:   Spaced   # comment')
    expect(out).toContain('tags:    [a, b]')
    expect(out).toContain('custom:  keep-me')
    expect(out).toContain('body content with `---` and stuff')
    expect(out).toMatch(/^updated: 2026-06-12$/m)
    expect(out).not.toMatch(/2025-01-01/)
  })

  it('leaves malformed (opening fence only) files untouched', () => {
    const raw = '---\nthis is not valid frontmatter'
    expect(bumpUpdatedInFrontmatter(raw, '2026-06-12')).toBe(raw)
  })

  it('does not match a stray `---` inside the body', () => {
    // The body uses `---` as a horizontal rule. The function must
    // only act on the file's actual frontmatter, not on horizontal
    // rules deeper in the file.
    const raw = [
      '# Title',
      '',
      'paragraph',
      '',
      '---',
      '',
      'after the rule',
    ].join('\n')
    const out = bumpUpdatedInFrontmatter(raw, '2026-06-12')
    expect(out).toBe('---\nupdated: 2026-06-12\n---\n\n' + raw)
  })
})
