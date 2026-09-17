// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CommandPalette from '../CommandPalette.vue'
import { dispose } from '../../../lib/search'
import type { PostSummary } from '../../../lib/api'
import { useI18n } from '../../../composables/useI18n'

const post: PostSummary = { path: 'inbox/redis', title: 'Redis', created: '', updated: '', tags: [], summary: '', size: 0, mtime: 1 }
const secondPost: PostSummary = { path: 'inbox/river', title: 'River', created: '', updated: '', tags: [], summary: '', size: 0, mtime: 1 }

describe('CommandPalette Chinese copy', () => {
  beforeEach(() => { useI18n().setLocale('zh'); dispose(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ content: '' }) }))) })
  afterEach(() => { vi.unstubAllGlobals(); dispose(); document.body.innerHTML = '' })

  it('uses a dynamic Chinese placeholder and accessibility labels', async () => {
    const wrapper = mount(CommandPalette, { props: { posts: [post], activePath: null } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    expect(input.placeholder).toBe('搜索 1 篇文档…')
    expect(input.getAttribute('aria-label')).toBe('搜索全部内容')
    expect(document.body.querySelector('.palette')?.getAttribute('aria-label')).toBe('全局搜索')
    wrapper.unmount()
  })

  it('shows Chinese empty, new-document, navigation, and badge copy', async () => {
    const wrapper = mount(CommandPalette, { props: { posts: [post], activePath: null } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '不存在'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(document.body.textContent).toContain('没有匹配结果')
    expect(document.body.textContent).toContain('新建“不存在”')
    expect(document.body.textContent).toContain('↑↓ 切换')
    expect(document.body.textContent).toContain('↵ 打开')
    expect(document.body.textContent).toContain('Esc 关闭')

    input.value = 'Redis'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect(document.body.querySelector('.palette-section-title')).toBeNull()
    expect(document.body.querySelector('.palette-badge')?.textContent).toBe('标题')
    wrapper.unmount()
  })

  it('renders the same Search UI in English through useI18n', async () => {
    useI18n().setLocale('en')
    const wrapper = mount(CommandPalette, { props: { posts: [post], activePath: null } })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    expect(input.placeholder).toBe('Search 1 documents…')
    expect(input.getAttribute('aria-label')).toBe('Search all content')
    expect(document.body.querySelector('.palette')?.getAttribute('aria-label')).toBe('Global search')
    expect(document.body.querySelector('.palette-section-title')).toBeNull()
    expect(document.body.querySelector('.palette-badge')?.textContent).toBe('Title')
    wrapper.unmount()
  })

  it('opens from Ctrl+P, focuses search, and preserves listbox keyboard selection', async () => {
    useI18n().setLocale('en')
    const wrapper = mount(CommandPalette, {
      props: { posts: [post, secondPost], activePath: null },
      attachTo: document.body,
    })

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }))
    await flushPromises()
    const input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    expect(document.activeElement).toBe(input)
    expect(document.body.querySelector('[role="listbox"]')).toBeTruthy()
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(document.body.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Redis')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('River')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([['inbox/river']])
    expect(document.body.querySelector('.palette')).toBeNull()
    wrapper.unmount()
  })

  it('keeps Unicode input, create-new, Escape, and backdrop close behavior', async () => {
    const wrapper = mount(CommandPalette, {
      props: { posts: [], activePath: null },
      attachTo: document.body,
    })
    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    let input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.value = '新文档'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    const create = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('新建“新文档”'))!
    create.click()
    await flushPromises()
    expect(wrapper.emitted('new')).toEqual([['新文档']])

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    input = document.body.querySelector<HTMLInputElement>('.palette-input input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.querySelector('.palette')).toBeNull()

    ;(wrapper.vm as unknown as { show: () => void }).show()
    await flushPromises()
    document.body.querySelector<HTMLElement>('.palette-backdrop')?.click()
    await flushPromises()
    expect(document.body.querySelector('.palette')).toBeNull()
    wrapper.unmount()
  })
})
