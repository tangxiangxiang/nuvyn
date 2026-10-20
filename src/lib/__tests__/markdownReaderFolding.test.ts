// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { render } from '../markdown'
import { enhanceMarkdownFolding, revealMarkdownTarget, type FoldingLabels } from '../markdownReaderFolding'

const labels: FoldingLabels = { expand: 'Expand', collapse: 'Collapse' }
const roots: HTMLElement[] = []
async function fixture(source: string, options?: Parameters<typeof render>[1]) {
  const root = document.createElement('article')
  root.innerHTML = await render(source, options)
  document.body.append(root)
  roots.push(root)
  const folding = enhanceMarkdownFolding(root, labels)
  return { root, folding }
}
const button = (el: Element) => el.querySelector<HTMLButtonElement>(':scope > .nuvyn-fold-toggle')!
afterEach(() => { roots.splice(0).forEach((root) => root.remove()) })

describe('Reader structural folding', () => {
  it('folds final Include headings and Snippets without refetching resources', async () => {
    const reads: string[] = []
    const { root } = await fixture('## Parent\n\n<!--@include: ./part.md-->\n\n<<< ./snippet.ts\n\n## After\nlast', {
      sourcePath: 'inbox/host.md',
      resourceResolver: { async read({ kind, path }) {
        reads.push(path)
        return { kind, path, content: kind === 'include' ? '### 中文 `label` {#included-target}\n\nincluded body' : 'const snippet = 1' }
      } },
    })
    const parent = root.querySelector('#parent')!
    const included = root.querySelector<HTMLElement>('#included-target')!
    expect(included).not.toBeNull()
    button(parent).click()
    expect(included.hidden).toBe(true)
    revealMarkdownTarget(root, included)
    expect(included.hidden).toBe(false)
    expect(root.querySelector('pre code')?.textContent).toContain('const snippet = 1')
    expect(reads).toEqual(['inbox/part.md', 'inbox/snippet.ts'])
  })

  it('reveals native Details and inactive Code Group targets for internal navigation', async () => {
    const { root } = await fixture('::: details Native\n## Target\nbody\n:::\n\n::: code-group\n```ts [A]\na\n```\n```js [B]\nb\n```\n:::')
    const details = root.querySelector('details')!
    expect(details.open).toBe(false)
    revealMarkdownTarget(root, root.querySelector<HTMLElement>('details h2')!)
    expect(details.open).toBe(true)
    const panels = root.querySelectorAll<HTMLElement>('[role="tabpanel"]')
    revealMarkdownTarget(root, panels[1].querySelector('code')!)
    expect(panels[1].getAttribute('aria-hidden')).toBe('false')
    expect(panels[0].getAttribute('aria-hidden')).toBe('true')
  })
  it('preserves independent child sections and only reveals necessary ancestors', async () => {
    const { root, folding } = await fixture('## A\nintro\n### Child\nchild text\n### Other\nother text\n## B\nlast')
    const [a, child, other, b] = Array.from(root.querySelectorAll('h2,h3'))
    const childText = child.nextElementSibling as HTMLElement
    button(child).click()
    button(a).click()
    expect((child as HTMLElement).hidden).toBe(true)
    expect(childText.hidden).toBe(true)
    expect((b as HTMLElement).hidden).toBe(false)
    button(a).click()
    expect((child as HTMLElement).hidden).toBe(false)
    expect(childText.hidden).toBe(true)
    button(other).click()
    revealMarkdownTarget(root, childText)
    expect(childText.hidden).toBe(false)
    expect(button(other).getAttribute('aria-expanded')).toBe('false')
    folding.dispose()
    expect(root.querySelector('button')).toBeNull()
    expect(root.querySelector('[hidden]')).toBeNull()
  })
  it('leaves the document H1 untouched but folds later H1 sections and Setext headings', async () => {
    const { root } = await fixture('# Title\nintro\n\nSection\n=======\nbody\n\n中文\n----\n内容\n\n### Leaf {#custom}\ntext\n\n# End\nlast')
    const headings = root.querySelectorAll('h1,h2,h3')
    expect(button(headings[0])).toBeNull()
    expect(button(headings[1])).not.toBeNull()
    expect(button(headings[2])).not.toBeNull()
    button(headings[1]).click()
    expect((headings[2] as HTMLElement).hidden).toBe(true)
    expect((headings[4] as HTMLElement).hidden).toBe(false)
    revealMarkdownTarget(root, root.querySelector<HTMLElement>('#custom')!)
    expect((headings[2] as HTMLElement).hidden).toBe(false)
  })

  it('does not add controls to or alter non-heading blocks', async () => {
    const { root, folding } = await fixture([
      '# Title', '', '## Section', '',
      '- [x] first', '  - child', '- second', '',
      '> **first** line', '> second *line*', '',
      '::: info', 'first', '', 'second', ':::', '',
      '::: details Native', 'body', ':::', '',
      '::: flex', 'Left', '', 'Right', ':::', '',
      '::: code-group', '```ts [A]', 'const a = 1', '```', '```js [B]', 'const b = 2', '```', ':::', '',
      '```mermaid', 'graph LR', 'A-->B', '```', '',
      '```markmap', '# Root', '## Leaf', '```', '',
      '![Image](a.png)', '', '| A | B |', '| - | - |', '| a | b |',
      '', '![Board](board:8a1c2544-dad0-4f20-a593-7bbc59882921)',
    ].join('\n'))
    const controls = root.querySelectorAll('.nuvyn-fold-toggle')
    expect(controls).toHaveLength(1)
    expect(controls[0].parentElement?.tagName).toBe('H2')
    const flex = root.querySelector('.nuvyn-flex')!
    const nodes = Array.from(root.querySelectorAll('pre,code,blockquote,li,img,table,.nuvyn-flex,[role="tabpanel"],.mermaid-mount,.markmap-mount,.board-embed-mount'))
    const originals = nodes.map((node) => node.innerHTML)
    const children = Array.from(flex.children)
    const toggle = button(root.querySelector('h2')!)
    toggle.click()
    expect(flex.closest('[hidden]')).not.toBeNull()
    toggle.click()
    expect(Array.from(flex.children)).toEqual(children)
    nodes.forEach((node, index) => {
      expect(root.contains(node)).toBe(true)
      expect(node.innerHTML).toBe(originals[index])
    })
    expect(root.querySelector('blockquote span[hidden]')).toBeNull()
    expect(root.querySelector('details')!.open).toBe(false)
    folding.dispose()
    expect(root.querySelector('.nuvyn-fold-toggle')).toBeNull()
  })

  it('folds H2–H6 and bounds nested container sections without interpreting code headings', async () => {
    const { root } = await fixture([
      '# Title', '', '## Two', 'body', '### Three', 'body',
      '#### Four', 'body', '##### Five', 'body', '###### Six', 'body', '',
      '::: flex', '## Inside', 'inside body', ':::', '',
      '```md', '# Fake', '## Also fake', '```', '', '## Outside', 'outside body',
    ].join('\n'))
    for (const level of [2, 3, 4, 5, 6]) {
      const heading = root.querySelector(`h${level}`)!
      expect(button(heading)).not.toBeNull()
      button(heading).click()
      expect((heading.nextElementSibling as HTMLElement).hidden).toBe(true)
      button(heading).click()
    }
    const outside = root.querySelector<HTMLElement>('#outside')!
    button(root.querySelector('#inside')!).click()
    expect(outside.hidden).toBe(false)
    expect((root.querySelector('pre') as HTMLElement).hidden).toBe(false)
    expect(root.querySelectorAll('pre .nuvyn-fold-toggle')).toHaveLength(0)
    expect(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(8)
  })

  it('ignores forged controls and cleans listeners and generated IDs on repeat enhancement', async () => {
    const { root, folding } = await fixture('## Section\nbody\n\n<div data-fold="true"><button class="nuvyn-fold-toggle" aria-controls="section">Fake</button></div>')
    const real = button(root.querySelector('h2')!)
    const fake = Array.from(root.querySelectorAll('button')).find((el) => el.textContent === 'Fake')!
    fake.click()
    expect(real.getAttribute('aria-expanded')).toBe('true')
    real.click()
    folding.updateLabels({ ...labels, expand: '展开' })
    expect(real.getAttribute('aria-label')).toBe('展开: Section')
    const next = enhanceMarkdownFolding(root, labels)
    expect(root.querySelectorAll('h2 > button')).toHaveLength(1)
    expect(root.querySelector('p')!.hidden).toBe(false)
    const current = button(root.querySelector('h2')!)
    next.dispose()
    current.click()
    expect(root.querySelector('p')!.hidden).toBe(false)
    expect(root.querySelector('p')!.id).toBe('')
    expect(root.querySelector('h2')!.id).toBe('section')
  })

  it('preserves authored classes through nested folding and disposal', async () => {
    const { root, folding } = await fixture([
      '## Parent', '', '### Child', '',
      '<div id="authored" class="nuvyn-fold-hidden custom">Visible authored content</div>', '',
      '<div id="initially-hidden" class="custom">Initially hidden</div>', '',
      '## After', 'last',
    ].join('\n'))
    const parent = root.querySelector('#parent')!
    const child = root.querySelector('#child')!
    const authored = root.querySelector<HTMLElement>('#authored')!
    const hidden = root.querySelector<HTMLElement>('#initially-hidden')!
    hidden.hidden = true
    expect(authored.hidden).toBe(false)
    expect(authored.classList.contains('nuvyn-fold-hidden')).toBe(true)
    button(child).click()
    button(parent).click()
    button(parent).click()
    expect(authored.hidden).toBe(true)
    button(child).click()
    expect(authored.hidden).toBe(false)
    expect(authored.className).toBe('nuvyn-fold-hidden custom')
    expect(hidden.hidden).toBe(true)
    button(parent).click()
    folding.dispose()
    expect(authored.hidden).toBe(false)
    expect(authored.className).toBe('nuvyn-fold-hidden custom')
    expect(hidden.hidden).toBe(true)
    expect(hidden.className).toBe('custom')
    expect(root.querySelector('.nuvyn-fold-toggle')).toBeNull()
    expect(child.id).toBe('child')
  })

  it('removes only controller-owned classes, states and IDs', async () => {
    const { root, folding } = await fixture([
      '<h2 id="authored-heading" class="custom nuvyn-fold-host nuvyn-fold-collapsed">Heading</h2>',
      '', 'body',
    ].join('\n'))
    const heading = root.querySelector('h2')!
    const body = root.querySelector('p')!
    button(heading).click()
    expect(body.classList.contains('nuvyn-fold-hidden')).toBe(true)
    button(heading).click()
    expect(heading.classList.contains('nuvyn-fold-collapsed')).toBe(true)
    button(heading).click()
    folding.dispose()
    expect(heading.className).toBe('custom nuvyn-fold-host nuvyn-fold-collapsed')
    expect(body.hidden).toBe(false)
    expect(body.classList.contains('nuvyn-fold-hidden')).toBe(false)
    expect(body.id).toBe('')
    expect(heading.id).toBe('authored-heading')
  })
})
