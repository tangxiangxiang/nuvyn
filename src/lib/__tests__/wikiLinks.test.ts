// Tests for the markdown-it wiki-link plugin. We build a small
// MarkdownIt instance per-test (with the same config the app uses),
// register wikiLinkPlugin, and assert on the rendered HTML. This
// exercises the full inline + core rule pipeline, not just regexes.
//
// We don't need to stub fetch — the plugin is pure-transform, no I/O.
import { describe, it, expect } from 'vitest'
import MarkdownIt from 'markdown-it'
import { wikiLinkPlugin, type Resolver } from '../wikiLinks'

// A simple "all targets exist" resolver for happy-path tests.
const allExist: Resolver = (ref) => ({ target: ref })

// A "no targets exist" resolver for missing-link tests.
const noneExist: Resolver = () => ({ target: null })

// Mixed: only 'foo' and 'bar' exist.
const partial: Resolver = (ref) => ({ target: ref === 'foo' || ref === 'bar' ? ref : null })

function mdWith(resolve: Resolver, opts: { linkify?: boolean; typographer?: boolean } = {}) {
  return new MarkdownIt({ html: false, linkify: opts.linkify ?? true, typographer: opts.typographer ?? true })
    .use(wikiLinkPlugin, { resolve })
}

describe('wikiLinkPlugin', () => {
  describe('[[…]] wiki links', () => {
    it('rewrites [[ref]] to a wiki-link anchor', () => {
      const md = mdWith(allExist)
      const html = md.render('see [[foo]] here')
      expect(html).toContain('class="wiki-link"')
      expect(html).toContain('href="/vault/foo"')
      expect(html).toContain('data-target="foo"')
      expect(html).toContain('data-missing="false"')
      expect(html).toContain('>foo</a>')
    })

    it('rewrites [[ref|alias]] with display alias', () => {
      const md = mdWith(allExist)
      const html = md.render('see [[foo|the foo file]]')
      expect(html).toContain('>the foo file</a>')
      expect(html).toContain('data-target="foo"')
    })

    it('rewrites [[ref#anchor]] with anchor', () => {
      const md = mdWith(allExist)
      const html = md.render('see [[foo#section]]')
      expect(html).toContain('href="/vault/foo#section"')
      expect(html).toContain('data-anchor="section"')
    })

    it('rewrites [[ref#anchor|alias]] with both', () => {
      const md = mdWith(allExist)
      const html = md.render('see [[foo#section|the section]]')
      expect(html).toContain('href="/vault/foo#section"')
      expect(html).toContain('data-anchor="section"')
      expect(html).toContain('>the section</a>')
    })

    it('marks missing targets with wiki-link-missing class', () => {
      const md = mdWith(noneExist)
      const html = md.render('see [[ghost]]')
      expect(html).toContain('class="wiki-link wiki-link-missing"')
      expect(html).toContain('data-target="ghost"')
      expect(html).toContain('data-missing="true"')
      expect(html).toContain('href="#"')
    })

    it('leaves data-target as the as-written ref when the target is missing', () => {
      const md = mdWith(partial)
      const html = md.render('[[foo]] and [[ghost]]')
      // foo resolves
      expect(html).toMatch(/<a [^>]*data-target="foo"[^>]*data-missing="false"/)
      // ghost does not
      expect(html).toMatch(/<a [^>]*data-target="ghost"[^>]*data-missing="true"/)
    })

    it('does not match [[]] (empty ref)', () => {
      const md = mdWith(allExist)
      const html = md.render('[[]]')
      // Should render as literal text, no anchor.
      expect(html).not.toContain('<a ')
      expect(html).toContain('[[]]')
    })

    it('does not match unbalanced [[foo', () => {
      const md = mdWith(allExist)
      const html = md.render('text [[foo more text')
      expect(html).not.toContain('<a ')
    })

    it('skips [[…]] inside fenced code blocks', () => {
      const md = mdWith(allExist)
      const html = md.render('```\nconst x = [[foo]]\n```\nsee [[foo]]')
      // Only the one outside the fence is a link.
      const matches = html.match(/<a [^>]*wiki-link/g) ?? []
      expect(matches).toHaveLength(1)
    })

    it('skips [[…]] inside inline code spans', () => {
      const md = mdWith(allExist)
      const html = md.render('use `[[foo]]` and see [[foo]]')
      const matches = html.match(/<a [^>]*wiki-link/g) ?? []
      expect(matches).toHaveLength(1)
    })

    it('handles multiple wiki links in the same line', () => {
      const md = mdWith(allExist)
      const html = md.render('see [[foo]] and [[bar]]')
      const matches = html.match(/<a [^>]*wiki-link/g) ?? []
      expect(matches).toHaveLength(2)
    })
  })

  describe('standard [t](path.md) markdown links', () => {
    it('upgrades [t](foo.md) to a wiki-link with class', () => {
      const md = mdWith(allExist)
      const html = md.render('see [the foo file](foo.md) here')
      expect(html).toContain('class="wiki-link"')
      expect(html).toContain('href="/vault/foo"')
      expect(html).toContain('data-target="foo"')
      expect(html).toContain('>the foo file</a>')
    })

    it('upgrades [t](path/to/note.md) to a wiki-link', () => {
      const md = mdWith(allExist)
      const html = md.render('see [t](notes/draft.md)')
      expect(html).toContain('class="wiki-link"')
      expect(html).toContain('href="/vault/notes/draft"')
    })

    it('preserves anchor in [t](path.md#a)', () => {
      const md = mdWith(allExist)
      const html = md.render('see [t](foo.md#section)')
      expect(html).toContain('href="/vault/foo#section"')
      expect(html).toContain('data-anchor="section"')
    })

    it('marks unresolved md-link targets as missing', () => {
      const md = mdWith(partial)
      const html = md.render('see [t](foo.md) and [u](missing.md)')
      expect(html).toMatch(/<a [^>]*data-target="foo"[^>]*data-missing="false"/)
      expect(html).toMatch(/<a [^>]*data-target="missing"[^>]*data-missing="true"/)
    })

    it('adds the generated external-link policy to explicit Markdown links', () => {
      const md = mdWith(allExist)
      const html = md.render('see [ext](https://example.com)')
      // External link has no wiki-link class.
      expect(html).not.toContain('wiki-link')
      expect(html).toContain('href="https://example.com"')
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener noreferrer"')
    })

    it('adds the same policy to linkify-generated HTTP(S) links', () => {
      const md = mdWith(allExist)
      const html = md.render('see https://example.com/docs')
      expect(html).toContain('href="https://example.com/docs"')
      expect(html).toContain('target="_blank"')
      expect(html).toContain('rel="noopener noreferrer"')
    })

    it('leaves mailto links untouched', () => {
      const md = mdWith(allExist)
      const html = md.render('mail [me](mailto:x@y.com)')
      expect(html).not.toContain('wiki-link')
    })

    it('leaves absolute-path links untouched', () => {
      const md = mdWith(allExist)
      const html = md.render('see [home](/) here')
      expect(html).not.toContain('wiki-link')
    })

    it('leaves protocol-relative links untouched', () => {
      const md = mdWith(allExist)
      const html = md.render('see [x](//example.com)')
      expect(html).not.toContain('wiki-link')
    })
  })

  describe('code-fence / inline-code handling', () => {
    it('does not classify [t](path.md) inside fenced code as a wiki link', () => {
      const md = mdWith(allExist)
      const html = md.render('```\nsee [t](foo.md)\n```\nand [t](foo.md)')
      const matches = html.match(/<a [^>]*wiki-link/g) ?? []
      expect(matches).toHaveLength(1)
    })

    it('does not classify [t](path.md) inside inline code as a wiki link', () => {
      const md = mdWith(allExist)
      const html = md.render('use `[t](foo.md)` and see [t](foo.md)')
      const matches = html.match(/<a [^>]*wiki-link/g) ?? []
      expect(matches).toHaveLength(1)
    })

    it('advances source context across a multi-line code_inline token', () => {
      const calls: Array<{ ref: string; sourcePath?: string }> = []
      const md = mdWith((ref, _anchor, context) => {
        calls.push({ ref, sourcePath: context?.sourcePath })
        return { target: ref }
      })
      md.render('`included\nroot` [[root-wiki]]', {
        deferWikiResolution: true,
        resourceSourcePathByLine: ['docs/part.md', 'docs/root.md'],
      })

      expect(calls).toEqual([{ ref: 'root-wiki', sourcePath: 'docs/root.md' }])
    })

    it('keeps real code_inline source mapping when raw HTML has unrelated backticks', () => {
      const calls: Array<{ ref: string; sourcePath?: string }> = []
      const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
        .use(wikiLinkPlugin, {
          resolve: (ref, _anchor, context) => {
            calls.push({ ref, sourcePath: context?.sourcePath })
            return { target: ref }
          },
        })
      const source = '<span title="`not-code-inline`">x</span> `included\nroot` [Root](./root.md) [[root-wiki]]'
      const inline = md.parse(source, {}).find((token) => token.type === 'inline')
      expect(inline?.children?.some((child) => child.type === 'html_inline')).toBe(true)
      expect(inline?.children?.filter((child) => child.type === 'code_inline')).toHaveLength(1)
      calls.length = 0

      md.render(source, {
        deferWikiResolution: true,
        resourceSourcePathByLine: ['docs/part.md', 'docs/root.md'],
      })

      expect(calls).toEqual([
        { ref: './root', sourcePath: 'docs/root.md' },
        { ref: 'root-wiki', sourcePath: 'docs/root.md' },
      ])
    })

    it('keeps same-content html_inline backticks from consuming real code_inline source context', () => {
      const calls: Array<{ ref: string; sourcePath?: string }> = []
      const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
        .use(wikiLinkPlugin, {
          resolve: (ref, _anchor, context) => {
            calls.push({ ref, sourcePath: context?.sourcePath })
            return { target: ref }
          },
        })
      const source = '<span title="`included root`">x</span> `included\nroot` [Root](./root.md) [[root-wiki]]'
      const inline = md.parse(source, {}).find((token) => token.type === 'inline')
      expect(inline?.children?.some((child) => child.type === 'html_inline')).toBe(true)
      expect(inline?.children?.filter((child) => child.type === 'code_inline')).toHaveLength(1)
      calls.length = 0

      md.render(source, {
        deferWikiResolution: true,
        resourceSourcePathByLine: ['docs/part.md', 'docs/root.md'],
      })

      expect(calls).toEqual([
        { ref: './root', sourcePath: 'docs/root.md' },
        { ref: 'root-wiki', sourcePath: 'docs/root.md' },
      ])
    })

    it('keeps same-content Markdown link-title backticks from consuming real code_inline source context', () => {
      const calls: Array<{ ref: string; sourcePath?: string }> = []
      const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
        .use(wikiLinkPlugin, {
          resolve: (ref, _anchor, context) => {
            calls.push({ ref, sourcePath: context?.sourcePath })
            return { target: ref }
          },
        })
      const source = '[x](foo "`included root`") `included\nroot` [Root](./root.md) [[root-wiki]]'
      const inline = md.parse(source, {}).find((token) => token.type === 'inline')
      expect(inline?.children?.filter((child) => child.type === 'link_open')).toHaveLength(3)
      expect(inline?.children?.filter((child) => child.type === 'code_inline')).toHaveLength(1)
      calls.length = 0

      md.render(source, {
        deferWikiResolution: true,
        resourceSourcePathByLine: ['docs/part.md', 'docs/root.md'],
      })

      expect(calls.filter(({ ref }) => ref !== 'foo')).toEqual([
        { ref: './root', sourcePath: 'docs/root.md' },
        { ref: 'root-wiki', sourcePath: 'docs/root.md' },
      ])
    })

    it('advances source context across a multi-line image alt', () => {
      const calls: Array<{ ref: string; sourcePath?: string }> = []
      const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
        .use(wikiLinkPlugin, {
          resolve: (ref, _anchor, context) => {
            calls.push({ ref, sourcePath: context?.sourcePath })
            return { target: ref }
          },
        })
      const source = '![x `included\nroot`](foo) [Root](./root.md) [[root-wiki]]'
      const inline = md.parse(source, {}).find((token) => token.type === 'inline')
      const image = inline?.children?.find((child) => child.type === 'image')
      expect(image?.children?.filter((child) => child.type === 'code_inline')).toHaveLength(1)
      calls.length = 0

      md.render(source, {
        deferWikiResolution: true,
        resourceSourcePathByLine: ['docs/part.md', 'docs/root.md'],
      })

      expect(calls).toEqual([
        { ref: './root', sourcePath: 'docs/root.md' },
        { ref: 'root-wiki', sourcePath: 'docs/root.md' },
      ])
    })

    it('uses the outer link close after a code span label child for source context', () => {
      const calls: Array<{ ref: string; sourcePath?: string }> = []
      const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
        .use(wikiLinkPlugin, {
          resolve: (ref, _anchor, context) => {
            calls.push({ ref, sourcePath: context?.sourcePath })
            return { target: ref }
          },
        })
      const source = '[x `](foo)`](foo) `included\nroot` [Root](./root.md) [[root-wiki]]'
      const inline = md.parse(source, {}).find((token) => token.type === 'inline')
      expect(inline?.children?.map((child) => child.type)).toEqual([
        'link_open',
        'text',
        'code_inline',
        'link_close',
        'text',
        'code_inline',
        'text',
        'link_open',
        'text',
        'link_close',
        'text',
        'link_open',
        'text',
        'link_close',
      ])
      calls.length = 0

      md.render(source, {
        deferWikiResolution: true,
        resourceSourcePathByLine: ['docs/part.md', 'docs/root.md'],
      })

      expect(calls.filter(({ ref }) => ref !== 'foo')).toEqual([
        { ref: './root', sourcePath: 'docs/root.md' },
        { ref: 'root-wiki', sourcePath: 'docs/root.md' },
      ])
    })
  })

  describe('edge cases', () => {
    it('renders [[…]] whose target has uppercase letters (resolver should not be called with uppercase variants)', () => {
      // The resolver is the one that decides case-sensitivity. Here
      // we just verify the plugin passes the ref through unchanged.
      const called: Array<string> = []
      const md = mdWith((ref) => { called.push(ref); return { target: ref } })
      md.render('[[FooBar]]')
      expect(called).toEqual(['FooBar'])
    })

    it('passes the anchor separately to the resolver', () => {
      const calls: Array<{ ref: string; anchor?: string }> = []
      const md = mdWith((ref, anchor) => {
        calls.push({ ref, anchor })
        return { target: ref }
      })
      md.render('[[foo#bar]]')
      expect(calls).toEqual([{ ref: 'foo', anchor: 'bar' }])
    })
  })
})
