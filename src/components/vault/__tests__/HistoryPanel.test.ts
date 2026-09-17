// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import HistoryPanel from '../HistoryPanel.vue'
import { __resetHistoryStateForTesting, useHistory } from '../../../composables/vault/useHistory'
import { useHistoryCommit } from '../../../composables/vault/useHistoryCommit'
import { useHistoryWithdraw } from '../../../composables/vault/useHistoryWithdraw'
import { useFileHistory, type FileHistoryState } from '../../../composables/vault/useFileHistory'
import { useI18n } from '../../../composables/useI18n'
import type { PostSummary } from '../../../lib/api'
import * as api from '../../../lib/history-api'

vi.mock('../../../lib/history-api', async () => {
  const actual = await vi.importActual<typeof api>('../../../lib/history-api')
  return {
    ...actual,
    getCapability: vi.fn(),
    getStatus: vi.fn(),
    getLog: vi.fn(),
    createCommit: vi.fn(),
    getContentHashes: vi.fn(),
    repairIndex: vi.fn(),
    getIndexRepairStatus: vi.fn().mockResolvedValue([]),
    discardIndexRepair: vi.fn(),
    dropCommit: vi.fn(),
  }
})

const NOW = new Date(2026, 6, 15, 12).getTime()
const commit = (sha: string, date: number, subject: string, files: string[]): api.CommitRecord => ({
  sha,
  parents: [],
  author: 'A',
  date: new Date(date).toISOString(),
  subject,
  body: `${subject} details`,
  files,
})
const post = (path: string, title: string): PostSummary => ({
  path,
  title,
  created: '',
  updated: '',
  tags: [],
  size: 0,
  mtime: 0,
})

function createWithdraw(
  history: ReturnType<typeof useHistory>,
  commitState: ReturnType<typeof useHistoryCommit>,
) {
  return useHistoryWithdraw({
    history,
    confirm: async () => true,
    acquireMutation: () => () => {},
    refreshComparisons: async () => {},
    refreshIndexRepairStatus: commitState.refreshIndexRepairStatus,
    registerIndexRepair: commitState.registerIndexRepair,
    settleIndexRepairPaths: commitState.settleIndexRepairPaths,
    closeDroppedRevision: () => {},
  })
}

function mountPanel(options: {
  posts?: PostSummary[]
  attachTo?: HTMLElement | string
  saveBeforeCommit?: (paths: string[]) => Promise<void>
  fileHistory?: FileHistoryState
} = {}) {
  const history = useHistory()
  const historyCommit = useHistoryCommit({
    history,
    saveSelected: options.saveBeforeCommit ?? (async () => {}),
  })
  const withdraw = createWithdraw(history, historyCommit)
  const wrapper = mount(HistoryPanel, {
    attachTo: options.attachTo,
    props: {
      history,
      commit: historyCommit,
      withdraw,
      posts: options.posts ?? [],
      fileHistory: options.fileHistory,
    },
  })
  return { wrapper, history, historyCommit, withdraw }
}

async function expandFirstDate(wrapper: VueWrapper): Promise<void> {
  const date = wrapper.get('.history-timeline-group-header')
  if (date.attributes('aria-expanded') !== 'true') await date.trigger('click')
}

async function expandFirstCommit(wrapper: VueWrapper): Promise<void> {
  await expandFirstDate(wrapper)
  await wrapper.get('.history-commit-row').trigger('click')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  __resetHistoryStateForTesting()
  vi.clearAllMocks()
  useI18n().setLocale('en')
  vi.mocked(api.getCapability).mockResolvedValue({ gitAvailable: true, repoInitialized: true })
  vi.mocked(api.getStatus).mockResolvedValue({ dirty: [], available: true })
  vi.mocked(api.getLog).mockResolvedValue({ commits: [] })
  vi.mocked(api.createCommit).mockResolvedValue({ sha: 'new-version', filesCommitted: [] })
  vi.mocked(api.getContentHashes).mockImplementation(async (paths) => (
    Object.fromEntries(paths.map((path) => [path, 'a'.repeat(64)]))
  ))
  vi.mocked(api.dropCommit).mockResolvedValue({
    sha: '',
    droppedSha: 'latest',
    filesChanged: [],
    indexRefreshFailed: false,
    repairStatePersistenceFailed: false,
  })
})

afterEach(() => {
  __resetHistoryStateForTesting()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('HistoryPanel commit-first timeline', () => {
  it('keeps the global log intact while rendering and leaving independent file history', async () => {
    vi.mocked(api.getLog).mockImplementation(async (options = {}) => ({
      commits: options.path
        ? [commit('file-version', NOW - 1_000, 'File version', ['inbox/agents.md'])]
        : [commit('repository-head', NOW, 'Repository head', ['inbox/readme.md'])],
    }))
    const fileHistory = useFileHistory(ref('en-US'))
    await fileHistory.open({ documentPath: 'inbox/agents', documentTitle: 'AGENTS' })
    const { wrapper, history } = mountPanel({ fileHistory })
    await flushPromises()

    expect(wrapper.findAll('.history-file-commit-row')).toHaveLength(1)
    expect(wrapper.find('.history-file-row').exists()).toBe(false)
    expect(history.log.value.map((item) => item.sha)).toEqual(['repository-head'])
    expect(api.getLog).toHaveBeenCalledWith({ path: 'inbox/agents.md', limit: 200 })
    expect(api.getLog).toHaveBeenCalledWith({ path: undefined, limit: 200 })

    await wrapper.get('.history-back-button').trigger('click')
    expect(wrapper.emitted('show-all-history')).toHaveLength(1)
    fileHistory.clear()
    await wrapper.vm.$nextTick()
    await expandFirstDate(wrapper)
    expect(wrapper.findAll('.history-commit-row')).toHaveLength(1)
    expect(wrapper.get('.history-commit-row').text()).toContain('Repository head')
  })

  it('opens a file-history commit through the existing revision selection contract', async () => {
    vi.mocked(api.getLog).mockImplementation(async (options = {}) => ({
      commits: options.path
        ? [commit('file-sha', NOW, 'File version', ['inbox/agents.md'])]
        : [commit('file-sha', NOW, 'File version', ['inbox/agents.md'])],
    }))
    const fileHistory = useFileHistory(ref('en-US'))
    await fileHistory.open({ documentPath: 'inbox/agents', documentTitle: 'AGENTS' })
    const { wrapper } = mountPanel({ fileHistory })
    await flushPromises()

    await wrapper.get('.history-file-commit-row').trigger('click')
    expect(wrapper.emitted('open-revision')).toEqual([[{
      documentPath: 'inbox/agents',
      documentTitle: 'AGENTS',
      revisionId: 'file-sha',
      parentRevisionId: null,
      revisionTime: NOW,
      summary: 'File version',
    }]])
  })

  it('refreshes the fixed file timeline after a commit includes that file', async () => {
    vi.mocked(api.getLog).mockImplementation(async (options = {}) => ({
      commits: options.path
        ? [commit('file-sha', NOW, 'File version', ['inbox/agents.md'])]
        : [commit('file-sha', NOW, 'File version', ['inbox/agents.md'])],
    }))
    const fileHistory = useFileHistory(ref('en-US'))
    await fileHistory.open({ documentPath: 'inbox/agents', documentTitle: 'AGENTS' })
    const refreshFile = vi.spyOn(fileHistory, 'refresh')
    const { historyCommit } = mountPanel({ fileHistory })
    await flushPromises()
    refreshFile.mockClear()

    historyCommit.lastCommittedPaths.value = ['inbox/agents.md']
    historyCommit.completionId.value += 1
    await flushPromises()

    expect(refreshFile).toHaveBeenCalledTimes(1)
    expect(fileHistory.selectedCommitId.value).toBeNull()
  })

  it('refreshes active file history after Withdraw completion', async () => {
    vi.mocked(api.getLog).mockImplementation(async (options = {}) => ({
      commits: options.path
        ? [commit('repository-head', NOW, 'File head', ['inbox/agents.md'])]
        : [commit('repository-head', NOW, 'Repository head', ['inbox/agents.md'])],
    }))
    const fileHistory = useFileHistory(ref('en-US'))
    await fileHistory.open({ documentPath: 'inbox/agents', documentTitle: 'AGENTS' })
    const refreshFile = vi.spyOn(fileHistory, 'refresh')
    const { withdraw } = mountPanel({ fileHistory })
    await flushPromises()
    refreshFile.mockClear()

    withdraw.completionId.value += 1
    await flushPromises()

    expect(refreshFile).toHaveBeenCalledTimes(1)
  })

  it('renders one multi-file commit once and expands its file children without another log request', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [commit('abcdef123456', NOW, 'Improve History timeline', [
        'inbox/getting-started.md',
        'literature/history-design.md',
        'src/not-a-document.ts',
      ])],
    })
    const { wrapper } = mountPanel({
      posts: [post('inbox/getting-started', 'Getting Started')],
    })
    await flushPromises()

    expect(wrapper.findAll('.history-timeline-group')).toHaveLength(1)
    expect(wrapper.findAll('.history-commit-row')).toHaveLength(0)
    expect(wrapper.get('.history-timeline-group-header').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.history-file-row').exists()).toBe(false)

    await expandFirstDate(wrapper)
    expect(wrapper.get('.history-commit-row').attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('.history-commit-row').text()).not.toContain('abcdef1')
    expect(wrapper.get('.history-commit-row').text()).toContain('2 files')
    expect(wrapper.find('.history-commit-sha').exists()).toBe(false)
    expect(wrapper.get('.history-row-title').attributes('title')).toBe('Improve History timeline · abcdef1')
    await expandFirstCommit(wrapper)
    expect(wrapper.findAll('.history-file-row')).toHaveLength(2)
    expect(wrapper.findAll('.history-file-row').map((row) => row.text())).toEqual([
      'Getting Started',
      'History Design',
    ])
    expect(api.getLog).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.getLog).mock.calls[0]?.[0]).toEqual({ path: undefined, limit: 200 })
  })

  it('collapses and expands date groups from the whole row with click, Enter, and Space', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [
        commit('today', NOW, 'Today', ['inbox/a.md']),
        commit('older', NOW - 2 * 86_400_000, 'Older', ['inbox/b.md']),
      ],
    })
    const { wrapper } = mountPanel()
    await flushPromises()
    const headers = wrapper.findAll('.history-timeline-group-header')
    expect(headers.map((row) => row.attributes('aria-expanded'))).toEqual(['false', 'false'])
    expect(wrapper.findAll('.history-commit-row')).toHaveLength(0)

    await headers[0]!.trigger('click')
    expect(wrapper.findAll('.history-commit-row')).toHaveLength(1)
    await headers[0]!.trigger('keydown', { key: 'Enter' })
    expect(wrapper.findAll('.history-commit-row')).toHaveLength(0)
    await headers[0]!.trigger('keydown', { key: ' ' })
    expect(wrapper.findAll('.history-commit-row')).toHaveLength(1)
  })

  it('toggles a commit from the whole row with click, Enter, and Space', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [commit('latest', NOW, 'Latest', ['inbox/a.md'])],
    })
    const { wrapper } = mountPanel()
    await flushPromises()
    await expandFirstDate(wrapper)
    const row = wrapper.get('.history-commit-row')

    await row.trigger('click')
    expect(wrapper.find('.history-file-row').exists()).toBe(true)
    expect(row.attributes('aria-expanded')).toBe('true')
    await row.trigger('keydown', { key: 'Enter' })
    expect(wrapper.find('.history-file-row').exists()).toBe(false)
    await row.trigger('keydown', { key: ' ' })
    expect(wrapper.find('.history-file-row').exists()).toBe(true)
  })

  it('emits the existing revision selection for metadata-backed and currently missing files', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [commit('historical-sha', NOW, 'Update two notes', [
        'inbox/known.md',
        'archive/deleted-note.md',
      ])],
    })
    const { wrapper } = mountPanel({ posts: [post('inbox/known', 'Known Title')] })
    await flushPromises()
    await expandFirstCommit(wrapper)
    const files = wrapper.findAll('.history-file-row')

    await files[0]!.trigger('click')
    await files[1]!.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open-revision')).toEqual([
      [{
          documentPath: 'inbox/known',
          documentTitle: 'Known Title',
          revisionId: 'historical-sha',
          parentRevisionId: null,
          revisionTime: NOW,
        summary: 'Update two notes',
      }],
      [{
          documentPath: 'archive/deleted-note',
          documentTitle: 'Deleted Note',
          revisionId: 'historical-sha',
          parentRevisionId: null,
          revisionTime: NOW,
        summary: 'Update two notes',
      }],
    ])
    expect(files[1]!.attributes('title')).toBe('archive/deleted-note.md')
  })

  it('shows parent paths only when file titles are ambiguous', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [commit('same-title', NOW, 'Duplicates', ['inbox/readme.md', 'archive/readme.md'])],
    })
    const { wrapper } = mountPanel()
    await flushPromises()
    await expandFirstCommit(wrapper)
    expect(wrapper.findAll('.history-file-row').map((row) => row.text())).toEqual([
      'Readmeinbox/',
      'Readmearchive/',
    ])
  })

  it('retains expanded dates and commits across refresh and removes stale expanded commits', async () => {
    const first = commit('first', NOW, 'First', ['inbox/a.md'])
    const older = commit('older', NOW - 2 * 86_400_000, 'Older', ['inbox/b.md'])
    vi.mocked(api.getLog).mockResolvedValue({ commits: [first, older] })
    const { wrapper, history } = mountPanel()
    await flushPromises()
    await wrapper.findAll('.history-timeline-group-header')[1]!.trigger('click')
    await wrapper.findAll('.history-commit-row')[0]!.trigger('click')

    vi.mocked(api.getLog).mockResolvedValue({
      commits: [commit('new', NOW + 60_000, 'New', ['inbox/c.md']), first, older],
    })
    await history.refreshLog()
    await flushPromises()
    expect(wrapper.findAll('.history-timeline-group-header')[1]!.attributes('aria-expanded')).toBe('true')
    const olderRow = wrapper.findAll('.history-commit-row').find((row) => row.text().includes('Older'))!
    expect(olderRow.attributes('aria-expanded')).toBe('true')

    vi.mocked(api.getLog).mockResolvedValue({ commits: [first] })
    await history.refreshLog()
    await flushPromises()
    expect(wrapper.text()).not.toContain('Older')
    expect(wrapper.findAll('.history-file-row')).toHaveLength(0)
  })

  it('expands a newly created newest date without expanding the new commit', async () => {
    const old = commit('old', NOW - 2 * 86_400_000, 'Old', ['inbox/a.md'])
    const fresh = commit('fresh', NOW, 'Fresh', ['inbox/a.md'])
    vi.mocked(api.getStatus)
      .mockResolvedValueOnce({ dirty: [{ path: 'inbox/a.md', index: ' ', worktree: 'M' }], available: true })
      .mockResolvedValue({ dirty: [], available: true })
    vi.mocked(api.getLog).mockImplementation(async () => ({
      commits: vi.mocked(api.createCommit).mock.calls.length ? [fresh, old] : [old],
    }))
    vi.mocked(api.createCommit).mockResolvedValue({ sha: 'fresh', filesCommitted: ['inbox/a.md'] })
    const { wrapper } = mountPanel()
    await flushPromises()
    await wrapper.get('#history-version-message').setValue('Fresh')
    await wrapper.get('.history-create-version').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.history-timeline-group-header')[0]!.attributes('aria-expanded')).toBe('true')
    expect(wrapper.findAll('.history-commit-row')[0]!.text()).toContain('Fresh')
    expect(wrapper.findAll('.history-commit-row')[0]!.attributes('aria-expanded')).toBe('false')
  })

  it('offers Withdraw only from the latest commit context menu and keeps the API contract', async () => {
    const latest = commit('latest', NOW, 'Latest', ['inbox/a.md'])
    const older = commit('older', NOW - 60_000, 'Older', ['inbox/a.md'])
    vi.mocked(api.getLog).mockImplementation(async () => ({
      commits: vi.mocked(api.dropCommit).mock.calls.length ? [older] : [latest, older],
    }))
    const { wrapper } = mountPanel({ attachTo: document.body })
    await flushPromises()
    await expandFirstDate(wrapper)
    const rows = wrapper.findAll('.history-commit-row')

    await rows[1]!.trigger('contextmenu', { clientX: 20, clientY: 30 })
    await flushPromises()
    expect(document.querySelector('.history-context-menu')).toBeNull()

    await rows[0]!.trigger('contextmenu', { clientX: 20, clientY: 30 })
    await flushPromises()
    const menu = document.querySelector<HTMLElement>('.history-context-menu')!
    expect(menu.textContent).toContain('Withdraw latest version')
    ;(menu.querySelector('button') as HTMLButtonElement).click()
    await flushPromises()
    expect(api.dropCommit).toHaveBeenCalledWith('latest')
    expect(wrapper.findAll('.history-commit-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('Older')
  })

  it('does not expose Withdraw on the newest visible Markdown commit when HEAD only changed another file type', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [
        commit('actual-head', NOW, 'Config only', ['settings.json']),
        commit('visible-older', NOW - 60_000, 'Visible note', ['inbox/a.md']),
      ],
    })
    const { wrapper } = mountPanel({ attachTo: document.body })
    await flushPromises()
    await expandFirstDate(wrapper)
    await wrapper.get('.history-commit-row').trigger('contextmenu', { clientX: 20, clientY: 30 })
    await flushPromises()
    expect(document.querySelector('.history-context-menu')).toBeNull()
  })

  it('closes the latest commit menu on Escape and restores focus', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [commit('latest', NOW, 'Latest', ['inbox/a.md'])],
    })
    const { wrapper } = mountPanel({ attachTo: document.body })
    await flushPromises()
    await expandFirstDate(wrapper)
    const row = wrapper.get<HTMLElement>('.history-commit-row')
    row.element.focus()
    await row.trigger('keydown', { key: 'ContextMenu' })
    await flushPromises()
    expect(document.querySelector('.history-context-menu')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('.history-context-menu')).toBeNull()
    expect(document.activeElement).toBe(row.element)
  })

  it('navigates visible date, commit, and file rows with Arrow keys', async () => {
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [commit('latest', NOW, 'Latest', ['inbox/a.md'])],
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { wrapper } = mountPanel({ attachTo: host })
    await flushPromises()
    await expandFirstCommit(wrapper)
    const date = wrapper.get<HTMLElement>('.history-timeline-group-header')
    const row = wrapper.get<HTMLElement>('.history-commit-row')
    const file = wrapper.get<HTMLElement>('.history-file-row')
    date.element.focus()
    await date.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row.element)
    await row.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(file.element)
    await file.trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement).toBe(row.element)
  })

  it('distinguishes loading, empty, and error states and retries the global log', async () => {
    let resolveLog!: (value: { commits: api.CommitRecord[] }) => void
    vi.mocked(api.getLog).mockReturnValueOnce(new Promise((resolve) => { resolveLog = resolve }))
    const { wrapper, history } = mountPanel()
    await flushPromises()
    expect(wrapper.get('.history-skeleton').attributes('aria-label')).toBe('Loading history...')

    resolveLog({ commits: [] })
    await flushPromises()
    expect(wrapper.get('.history-empty-inline').text()).toBe('No history yet.')

    vi.mocked(api.getLog).mockRejectedValueOnce(new Error('History API unavailable'))
    await history.refreshLog()
    await flushPromises()
    expect(wrapper.get('.history-error').text()).toContain('History API unavailable')

    vi.mocked(api.getLog).mockResolvedValueOnce({ commits: [] })
    await wrapper.get('.history-error button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.history-error').exists()).toBe(false)
  })

  it('preserves Create Version selection, save coordination, and exact path behavior', async () => {
    const dirty = [
      { path: 'inbox/a.md', index: ' ', worktree: 'M' },
      { path: 'inbox/b.md', index: '?', worktree: '?' },
    ]
    vi.mocked(api.getStatus)
      .mockResolvedValueOnce({ dirty, available: true })
      .mockResolvedValue({ dirty: [dirty[1]!], available: true })
    vi.mocked(api.createCommit).mockResolvedValue({ sha: 'new-version', filesCommitted: ['inbox/a.md'] })
    const saveBeforeCommit = vi.fn().mockResolvedValue(undefined)
    const { wrapper } = mountPanel({ saveBeforeCommit })
    await flushPromises()

    await wrapper.findAll('[role="checkbox"]')[1]!.trigger('click')
    await wrapper.get('#history-version-message').setValue('  Update A  ')
    await wrapper.get('.history-create-version').trigger('click')
    await flushPromises()
    expect(saveBeforeCommit).toHaveBeenCalledWith(['inbox/a.md'])
    expect(api.createCommit).toHaveBeenCalledWith(
      ['inbox/a.md'],
      'Update A',
      { 'inbox/a.md': 'a'.repeat(64) },
    )
  })

  it('renders consistent Chinese hierarchy labels', async () => {
    useI18n().setLocale('zh')
    vi.mocked(api.getLog).mockResolvedValue({
      commits: [commit('latest', NOW, '最新版本', ['inbox/a.md'])],
    })
    const { wrapper } = mountPanel()
    await flushPromises()
    await expandFirstDate(wrapper)
    expect(wrapper.get('.history-timeline-heading').text()).toContain('时间线')
    expect(wrapper.get('.history-timeline-group-header').text()).toContain('1 个提交')
    expect(wrapper.get('.history-commit-row').text()).toContain('1 个文件')
    expect(wrapper.get('.history-timeline-group-header').attributes('aria-label')).toContain('折叠')
  })
})
