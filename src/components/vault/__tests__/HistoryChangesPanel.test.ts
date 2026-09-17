// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HistoryChangesPanel from '../HistoryChangesPanel.vue'
import { useI18n } from '../../../composables/useI18n'

const entries = [
  { path: 'inbox/modified.md', index: ' ', worktree: 'M' },
  { path: 'inbox/new.md', index: '?', worktree: '?' },
  { path: 'archive/deleted.md', index: 'D', worktree: ' ' },
]

beforeEach(() => useI18n().setLocale('en'))
afterEach(() => vi.restoreAllMocks())

describe('HistoryChangesPanel', () => {
  it('renders understandable statuses and accessible selection controls', async () => {
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries,
        selectedPaths: new Set(['inbox/modified.md']),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
      },
    })
    expect(wrapper.text()).toContain('Modified')
    expect(wrapper.text()).toContain('New')
    expect(wrapper.text()).toContain('Deleted')
    expect(wrapper.findAll('[role="checkbox"]')).toHaveLength(3)
    expect(wrapper.get('[role="checkbox"]').attributes('aria-label')).toContain('inbox/modified.md')
    expect(wrapper.get('#history-version-message').attributes('aria-label')).toBe('Version message')

    await wrapper.findAll('[role="checkbox"]')[1]!.trigger('click')
    expect(wrapper.emitted('toggle')?.[0]).toEqual(['inbox/new.md'])
  })

  it('keeps selection on the checkbox and opens a diff from the document button', async () => {
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries,
        selectedPaths: new Set<string>(),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
      },
    })

    await wrapper.get('.history-change-open').trigger('click')
    expect(wrapper.emitted('open-diff')?.[0]).toEqual([entries[0]])

    await wrapper.find('[role="checkbox"]').trigger('click')
    expect(wrapper.emitted('toggle')?.[0]).toEqual(['inbox/modified.md'])
    expect(wrapper.emitted('open-diff')).toHaveLength(1)

    await wrapper.setProps({ activeDiffPath: 'inbox/modified.md' })
    expect(wrapper.get('.history-change-row').classes()).toContain('active')
    expect(wrapper.get('.history-change-open').classes()).toContain('active')
  })

  it('shows document titles and falls back to file names', () => {
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries: [
          { path: 'inbox/english-object.md', index: ' ', worktree: 'M' },
          { path: 'inbox/no-title.md', index: ' ', worktree: 'M' },
        ],
        posts: [{ path: 'inbox/english-object', title: 'English Object', created: '', updated: '', tags: [], size: 0, mtime: 0 }],
        selectedPaths: new Set<string>(),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
      },
    })

    expect(wrapper.findAll('.history-change-copy strong').map((item) => item.text())).toEqual([
      'English Object',
      'no-title',
    ])
    expect(wrapper.findAll('.history-change-open').map((item) => item.attributes('title'))).toEqual([
      'inbox/english-object.md',
      'inbox/no-title.md',
    ])
    expect(wrapper.findAll('.history-change-copy span')).toHaveLength(0)
  })

  it('toggles the single selection action and emits message and keyboard submission intents', async () => {
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries,
        selectedPaths: new Set(['inbox/modified.md']),
        message: 'Version',
        busy: false,
        canCommit: true,
        error: null,
      },
    })
    const action = wrapper.get('.history-changes-actions button')
    expect(action.text()).toBe('Select all')
    await action.trigger('click')
    await wrapper.setProps({ selectedPaths: new Set(entries.map((entry) => entry.path)) })
    expect(action.text()).toBe('Deselect all')
    await action.trigger('click')
    await wrapper.get('textarea').setValue('Next version')
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('select-all')).toHaveLength(1)
    expect(wrapper.emitted('clear-selection')).toHaveLength(1)
    expect(wrapper.emitted('update:message')?.at(-1)).toEqual(['Next version'])
    expect(wrapper.emitted('submit')).toHaveLength(1)
  })

  it('generates a commit message from the selected paths and fills the editor', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'Refresh selected documents' }),
    } as Response)
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries,
        selectedPaths: new Set(['inbox/modified.md', 'inbox/new.md']),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
      },
    })

    await wrapper.get('.history-generate-message').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/ai/commit-message', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ paths: ['inbox/modified.md', 'inbox/new.md'], language: 'en' }),
    }))
    expect(wrapper.emitted('update:message')).toEqual([['Refresh selected documents']])
  })

  it('sends Chinese as the generation language in a Chinese environment', async () => {
    useI18n().setLocale('zh')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ message: '更新选中的文档' }),
    } as Response)
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries,
        selectedPaths: new Set(['inbox/modified.md']),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
      },
    })

    await wrapper.get('.history-generate-message').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/ai/commit-message', expect.objectContaining({
      body: JSON.stringify({ paths: ['inbox/modified.md'], language: 'zh' }),
    }))
    expect(wrapper.emitted('update:message')).toEqual([['更新选中的文档']])
  })

  it('does not apply a stale AI response after the composer changes', async () => {
    let resolveResponse!: (response: Response) => void
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestSignal = init?.signal as AbortSignal | undefined
      return await new Promise<Response>((resolve) => {
        resolveResponse = resolve
      })
    })
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries,
        selectedPaths: new Set(['inbox/modified.md']),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
      },
    })

    await wrapper.get('.history-generate-message').trigger('click')
    await wrapper.setProps({ message: 'Manual message' })
    resolveResponse({
      ok: true,
      json: async () => ({ message: 'Stale suggestion' }),
    } as Response)
    await flushPromises()

    expect(requestSignal?.aborted).toBe(false)
    expect(wrapper.emitted('update:message')).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts generation when a commit starts', async () => {
    let resolveResponse!: (response: Response) => void
    let requestSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestSignal = init?.signal as AbortSignal | undefined
      return await new Promise<Response>((resolve) => {
        resolveResponse = resolve
      })
    })
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries,
        selectedPaths: new Set(['inbox/modified.md']),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
      },
    })

    await wrapper.get('.history-generate-message').trigger('click')
    await wrapper.setProps({ busy: true })
    expect(requestSignal?.aborted).toBe(true)
    resolveResponse({ ok: true, json: async () => ({ message: 'Ignored' }) } as Response)
    await flushPromises()
    expect(wrapper.emitted('update:message')).toBeUndefined()
  })

  it('exposes localized busy and error states and disables mutation controls', () => {
    useI18n().setLocale('zh')
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries,
        selectedPaths: new Set(['inbox/modified.md']),
        message: '版本',
        busy: true,
        canCommit: false,
        error: '提交失败',
      },
    })
    expect(wrapper.get('.history-changes').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[role="status"]').text()).toBe('正在创建版本…')
    expect(wrapper.get('[role="alert"]').text()).toBe('提交失败')
    expect(wrapper.get('.history-create-version').text()).toBe('正在创建版本…')
    expect(wrapper.findAll('[role="checkbox"][aria-disabled="true"]')).toHaveLength(3)
  })

  it('exposes an explicit retry when real-index repair is pending', async () => {
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries: [],
        selectedPaths: new Set<string>(),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
        indexRepairPending: true,
        indexRepairBusy: false,
      },
    })

    const button = wrapper.get('.history-commit-error button')
    expect(button.text()).toBe('Retry Git status repair')
    await button.trigger('click')
    expect(wrapper.emitted('repair-index')).toHaveLength(1)
  })

  it('offers a metadata-only dismissal after a staged-index conflict', async () => {
    const wrapper = mount(HistoryChangesPanel, {
      props: {
        entries: [],
        selectedPaths: new Set<string>(),
        message: '',
        busy: false,
        canCommit: false,
        error: null,
        indexRepairPending: true,
        indexRepairBusy: false,
        indexRepairConflict: true,
      },
    })

    const button = wrapper.get('.history-commit-error button')
    expect(button.text()).toBe('Keep staged changes and dismiss')
    await button.trigger('click')
    expect(wrapper.emitted('discard-index-repair')).toHaveLength(1)
    expect(wrapper.emitted('repair-index')).toBeUndefined()
  })
})
