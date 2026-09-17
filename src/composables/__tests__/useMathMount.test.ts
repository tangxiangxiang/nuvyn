// @vitest-environment jsdom
import { createApp, defineComponent, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { renderMock } = vi.hoisted(() => ({
  renderMock: vi.fn((tex: string, host: HTMLElement, _options: Record<string, unknown>) => {
    host.innerHTML = `<span class="katex">${tex}</span>`
  }),
}))

vi.mock('katex', () => ({ default: { render: renderMock } }))

import { mountMath, useMathMount } from '../useMathMount'

function placeholder(kind: 'inline' | 'block', content: string): string {
  const tag = kind === 'inline' ? 'span' : 'div'
  return `<${tag} class="math-mount math-${kind}" data-content="${encodeURIComponent(content)}"></${tag}>`
}

async function settleMutationObserver(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  renderMock.mockClear()
  renderMock.mockImplementation((tex: string, host: HTMLElement, _options: Record<string, unknown>) => {
    host.innerHTML = `<span class="katex">${tex}</span>`
  })
  document.body.innerHTML = ''
})

describe('mountMath', () => {
  it('renders inline and block placeholders with decoded TeX and safe options', () => {
    const root = document.createElement('article')
    root.innerHTML = placeholder('inline', 'x^2') + placeholder('block', '\\frac{a}{b}')
    const statesObservedDuringRender: string[] = []
    renderMock.mockImplementation((tex: string, host: HTMLElement, _options: Record<string, unknown>) => {
      statesObservedDuringRender.push(host.dataset.mathState ?? '')
      host.innerHTML = `<span class="katex">${tex}</span>`
    })

    expect(mountMath(root)).toBe(2)
    expect(renderMock).toHaveBeenCalledTimes(2)
    expect(statesObservedDuringRender).toEqual(['pending', 'pending'])
    expect(renderMock.mock.calls[0]?.[0]).toBe('x^2')
    expect(renderMock.mock.calls[0]?.[2]).toEqual({
      throwOnError: false,
      trust: false,
      displayMode: false,
    })
    expect(renderMock.mock.calls[1]?.[2]).toEqual({
      throwOnError: false,
      trust: false,
      displayMode: true,
    })
    expect(root.querySelectorAll('.katex')).toHaveLength(2)
    expect(root.querySelectorAll('[data-math-mounted="true"]')).toHaveLength(2)
    expect(root.querySelector<HTMLElement>('.math-inline')?.dataset.mathState).toBe('ready')
    expect(root.querySelector<HTMLElement>('.math-block')?.dataset.mathState).toBe('ready')

    // KaTeX's children can trigger another observer pass, but the marker
    // makes a second explicit scan a no-op.
    expect(mountMath(root)).toBe(0)
    expect(renderMock).toHaveBeenCalledTimes(2)
  })

  it('keeps invalid formulas local and exposes the original source as text', () => {
    renderMock.mockImplementationOnce(() => { throw new Error('invalid TeX') })
    const root = document.createElement('article')
    root.innerHTML = placeholder('inline', '\\frac{1}{')

    mountMath(root)

    const error = root.querySelector('.math-error')
    expect(error).not.toBeNull()
    expect(error?.textContent).toBe('\\frac{1}{')
    expect(error?.getAttribute('data-math-mounted')).toBe('true')
    expect(error?.getAttribute('data-math-state')).toBe('error')
    expect(error?.querySelector('script, style, svg')).toBeNull()

    expect(mountMath(root)).toBe(0)
    expect(renderMock).toHaveBeenCalledTimes(1)
    expect(error?.getAttribute('data-math-state')).toBe('error')
  })

  it('marks a non-throwing KaTeX error representation as settled error', () => {
    renderMock.mockImplementationOnce((_tex: string, host: HTMLElement) => {
      host.innerHTML = '<span class="katex-error">invalid TeX</span>'
    })
    const root = document.createElement('article')
    root.innerHTML = placeholder('inline', '\\frac{1}{')

    mountMath(root)

    const error = root.querySelector<HTMLElement>('.math-mount')
    expect(error?.getAttribute('data-math-mounted')).toBe('true')
    expect(error?.getAttribute('data-math-state')).toBe('error')
    expect(error?.classList.contains('math-error')).toBe(true)
  })
})

describe('useMathMount', () => {
  it('mounts placeholders added after the article is attached and cleans up its observer', async () => {
    const article = ref<HTMLElement | null>(null)
    const appHost = document.createElement('div')
    document.body.appendChild(appHost)
    const app = createApp(defineComponent({
      setup() {
        useMathMount(article)
        return () => null
      },
    }))
    app.mount(appHost)

    const root = document.createElement('article')
    document.body.appendChild(root)
    article.value = root
    await nextTick()
    root.innerHTML = placeholder('inline', 'x + y')
    await settleMutationObserver()
    expect(renderMock).toHaveBeenCalledTimes(1)
    expect(root.querySelector('.katex')).not.toBeNull()
    expect(root.querySelector<HTMLElement>('.math-mount')?.getAttribute('data-math-state')).toBe('ready')

    app.unmount()
    root.innerHTML = placeholder('inline', 'z')
    await settleMutationObserver()
    expect(renderMock).toHaveBeenCalledTimes(1)
  })
})
