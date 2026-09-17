// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { PostSummary, TreeNode } from '../../../lib/api'
import DiaryCalendarSurface from '../DiaryCalendarSurface.vue'
import { useI18n } from '../../../composables/useI18n'
import { useTheme } from '../../../composables/useTheme'

function installBrowserApiShims(): void {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe(): void { /* jsdom has no layout engine */ }
      unobserve(): void { /* jsdom has no layout engine */ }
      disconnect(): void { /* jsdom has no layout engine */ }
    }
  }

  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)
    window.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle)
  }
}

function file(path: string, title = path): TreeNode {
  const name = path.split('/').pop() ?? path
  return { kind: 'file', name, path, title, mtime: 0 }
}

function treeWith(...paths: string[]): TreeNode[] {
  return [{
    kind: 'folder',
    name: 'content',
    path: '',
    children: [{
      kind: 'folder',
      name: 'diary',
      path: 'diary',
      children: paths.map((path) => file('diary/' + path)),
    }],
  }]
}

function post(path: string, overrides: Partial<PostSummary> = {}): PostSummary {
  return {
    path,
    title: path,
    created: '2026-08-24',
    updated: '2026-08-24',
    tags: [],
    size: 0,
    mtime: 0,
    ...overrides,
  }
}

function mountSurface(tree: TreeNode[] = treeWith('2026-08-24'), extraProps: Record<string, unknown> = {}): VueWrapper {
  return mount(DiaryCalendarSurface, {
    props: {
      tree,
      initialMonth: { year: 2026, month: 8 },
      ...extraProps,
    },
  })
}

function dayCell(wrapper: VueWrapper, value: string): DOMWrapper<Element> {
  const target = wrapper.get('[data-diary-day-content][data-date="' + value + '"]').element
  return new DOMWrapper(target.closest('.n-calendar-cell')!)
}

describe('DiaryCalendarSurface', () => {
  let consoleError: ReturnType<typeof vi.spyOn>
  let consoleWarn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    installBrowserApiShims()
    useI18n().setLocale('en')
    useTheme().set('light')
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    const output = [...consoleError.mock.calls, ...consoleWarn.mock.calls]
      .flat()
      .map(String)
      .join('\n')
    expect(output).not.toMatch(/dayIndex|Unhandled|TypeError|undefined.*render/i)
    consoleError.mockRestore()
    consoleWarn.mockRestore()
    useI18n().setLocale('zh')
    useTheme().set('light')
  })

  it('projects the authoritative tree into managed Diary markers', async () => {
    const wrapper = mountSurface(treeWith('2026-08-24', '2026-08-25', 'legacy'))
    await flushPromises()

    expect(wrapper.find('.diary-calendar-surface-header').exists()).toBe(false)
    expect(wrapper.find('.diary-calendar-toolbar').exists()).toBe(false)
    expect(wrapper.get('[data-testid="diary-calendar-surface"]').attributes('role')).toBe('region')
    expect(dayCell(wrapper, '2026-08-24').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(1)
    expect(dayCell(wrapper, '2026-08-25').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(1)
    expect(dayCell(wrapper, '2026-08-26').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(0)
  })

  it('keeps a full calendar for empty data and separates loading/error states', async () => {
    const empty = mountSurface(treeWith(), { loading: false })
    await flushPromises()
    expect(empty.find('.n-calendar').exists()).toBe(true)
    expect(empty.find('[data-testid="diary-calendar-surface-empty"]').exists()).toBe(false)

    const loading = mountSurface(treeWith(), { loading: true, error: 'Tree unavailable' })
    await flushPromises()
    expect(loading.get('[data-testid="diary-calendar-surface"]').attributes('aria-busy')).toBe('true')
    expect(loading.get('[data-testid="diary-calendar-loading"]').attributes('role')).toBe('status')
    expect(loading.get('[data-testid="diary-calendar-error"]').attributes('role')).toBe('alert')
    expect(loading.find('.n-calendar').exists()).toBe(true)
  })

  it('re-emits date and month intents without owning navigation side effects', async () => {
    const wrapper = mountSurface()
    await flushPromises()

    await wrapper.get('[data-date="2026-08-24"]').trigger('click')
    await wrapper.get('[data-diary-calendar-nav="next"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('date-selected')).toEqual([['2026-08-24']])
    expect(wrapper.emitted('month-change')?.at(-1)?.[0]).toEqual({ year: 2026, month: 9 })
  })

  it('forwards selection clearing without remounting the Calendar', async () => {
    const wrapper = mountSurface()
    await flushPromises()
    const calendar = wrapper.get('[data-testid="diary-calendar"]').element

    await wrapper.get('[data-date="2026-08-24"]').trigger('click')
    expect(wrapper.get('[data-date="2026-08-24"]').classes()).toContain('is-selected')

    const surfaceApi = wrapper.vm as unknown as { clearSelection: () => void }
    surfaceApi.clearSelection()
    await flushPromises()

    expect(wrapper.get('[data-testid="diary-calendar"]').element).toBe(calendar)
    expect(wrapper.get('[data-date="2026-08-24"]').classes()).not.toContain('is-selected')
    expect(wrapper.get('[data-date="2026-08-24"]').attributes('aria-pressed')).toBe('false')
  })

  it('updates markers reactively from the latest tree props', async () => {
    const wrapper = mountSurface(treeWith())
    await flushPromises()
    expect(wrapper.findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(0)

    await wrapper.setProps({ tree: treeWith('2026-08-24') })
    await flushPromises()
    expect(dayCell(wrapper, '2026-08-24').findAll('[data-testid="diary-calendar-mood"]')).toHaveLength(1)
  })

  it('projects bulk mood summaries and forwards Calendar mood intents', async () => {
    const wrapper = mountSurface(treeWith('2026-08-24'), {
      posts: [post('diary/2026-08-24', { mood: 'happy', metadataUpdatedAt: 6 })],
    })
    await flushPromises()

    expect(dayCell(wrapper, '2026-08-24').get('[data-testid="diary-calendar-mood"] img').attributes('src')).toBe('/emoji/开心.svg')
    await dayCell(wrapper, '2026-08-24').get('[data-testid="diary-calendar-mood"]').trigger('click')
    await flushPromises()
    const pickerElement = document.body.querySelector('[data-testid="diary-mood-picker"]')
    expect(pickerElement).not.toBeNull()
    await new DOMWrapper(pickerElement!).get('[data-mood-id="sad"]').trigger('click')

    expect(wrapper.emitted('mood-change')).toEqual([['2026-08-24', 'sad']])
    wrapper.unmount()
  })

  it('does not own API, router, editor, or Diary create lifecycle', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/diary/DiaryCalendarSurface.vue'),
      'utf8',
    )

    expect(source).toContain('projectDiaryDaysFromTree(props.tree, props.posts)')
    expect(source).toContain("@date-selected=\"emit('date-selected', $event)\"")
    expect(source).toContain("@month-change=\"emit('month-change', $event)\"")
    expect(source).toContain('@mood-change="onMoodChange"')
    expect(source).not.toMatch(/fetch\(|authFetch|createPost|openPost|useRouter|router\.|\/api\/|openDiaryDate|toISOString/)
  })
})
