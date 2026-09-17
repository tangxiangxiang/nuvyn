// @vitest-environment jsdom
// Component-path regression: decoded Markmap source reaches the real
// Transformer, while Markmap.create/loadJS/loadCSS are captured at the
// post-transform boundary. This keeps the test independent of SVG layout.
import { beforeEach, describe, expect, it, vi } from 'vitest'

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

interface Captures {
  roots: unknown[]
  styles: unknown[]
  scripts: unknown[]
}

const captures: Captures = { roots: [], styles: [], scripts: [] }

vi.mock('markmap-view', () => ({
  refreshHook: { call() { /* no-op for the test */ } },
  Markmap: {
    create(_svg: SVGSVGElement, _options: Record<string, unknown>) {
      return {
        destroy() { /* no-op */ },
        fit() { /* no-op */ },
        setData(root: unknown) {
          captures.roots.push(root)
          return Promise.resolve()
        },
        setOptions() { /* no-op */ },
      }
    },
  },
  loadCSS(items: unknown) {
    captures.styles.push(items)
  },
  loadJS(items: unknown) {
    captures.scripts.push(items)
  },
  deriveOptions: () => ({}),
}))

import { createApp, defineComponent, h } from 'vue'
import MarkMap from '../MarkMap.vue'

interface TestNode {
  content?: string
  children?: TestNode[]
}

function collectNodeHtml(node: TestNode): string {
  return [
    node.content ?? '',
    ...(node.children ?? []).map((child) => collectNodeHtml(child)),
  ].join('\n')
}

function mountStandalone(content: string): { host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({
    setup() { return () => h(MarkMap, { content }) },
  }))
  app.mount(host)
  const svg = host.querySelector<SVGSVGElement>('svg.markmap-svg')
  if (svg) Object.defineProperty(svg, 'clientWidth', { configurable: true, value: 800 })
  return { host, unmount: () => { app.unmount(); host.remove() } }
}

async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  captures.roots.length = 0
  captures.styles.length = 0
  captures.scripts.length = 0
})

describe('MarkMap component security boundary', () => {
  it('uses the real Transformer path while separating author HTML from trusted KaTeX and assets', async () => {
    const { unmount } = mountStandalone([
      '---',
      'markmap:',
      '  extraJs:',
      '    - https://evil.example/payload.js',
      '  extraCss:',
      '    - https://evil.example/payload.css',
      '---',
      '# Mixed <script>alert(1)</script> <strong>safe</strong> Formula: $\\frac{a}{b}$',
      '<img src="x" onerror="alert(1)"> <span style="color:red" onclick="alert(1)">text</span>',
    ].join('\n'))
    await settle()

    expect(captures.roots).toHaveLength(1)
    const html = collectNodeHtml(captures.roots[0] as TestNode)
    expect(html).toContain('<strong>safe</strong>')
    expect(html).toContain('class="katex"')
    expect(html).toMatch(/class="katex"[\s\S]*?\sstyle="[^"]+/)
    expect(html).not.toMatch(/<script\b|\son(?:error|click|load|mouseover)\s*=/i)
    expect(html).not.toMatch(/style="color:red"|javascript:/i)

    expect(JSON.stringify(captures.scripts)).not.toContain('evil.example')
    expect(JSON.stringify(captures.styles)).not.toContain('evil.example')
    expect(JSON.stringify(captures.styles)).toContain('katex')

    unmount()
  })
})
