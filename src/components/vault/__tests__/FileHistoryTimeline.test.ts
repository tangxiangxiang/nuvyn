// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FileHistoryTimeline from '../FileHistoryTimeline.vue'
import { useFileHistory } from '../../../composables/vault/useFileHistory'
import { useI18n } from '../../../composables/useI18n'
import * as api from '../../../lib/history-api'

vi.mock('../../../lib/history-api', async () => {
  const actual = await vi.importActual<typeof api>('../../../lib/history-api')
  return { ...actual, getLog: vi.fn() }
})

const NOW = new Date(2026, 7, 1, 15, 33).getTime()
const record = (sha: string, offset: number, subject: string): api.CommitRecord => ({
  sha,
  parents: [],
  author: 'A',
  date: new Date(NOW - offset).toISOString(),
  subject,
  body: '',
  files: ['inbox/agents.md'],
})

beforeEach(() => {
  vi.clearAllMocks()
  useI18n().setLocale('en')
  vi.mocked(api.getLog).mockResolvedValue({ commits: [] })
})

async function mountTimeline(options: {
  commits?: api.CommitRecord[]
  repositoryHeadId?: string | null
  withdrawAvailable?: boolean
} = {}) {
  vi.mocked(api.getLog).mockResolvedValue({ commits: options.commits ?? [] })
  const fileHistory = useFileHistory(ref('en-US'))
  await fileHistory.open({ documentPath: 'inbox/agents', documentTitle: 'AGENTS' })
  const wrapper = mount(FileHistoryTimeline, {
    props: {
      fileHistory,
      repositoryHeadId: options.repositoryHeadId ?? null,
      withdrawAvailable: options.withdrawAvailable ?? false,
    },
  })
  return { wrapper, fileHistory }
}

describe('FileHistoryTimeline', () => {
  it('renders Date → Commit without file children and displays the fixed title', async () => {
    const { wrapper } = await mountTimeline({
      commits: [
        record('latest', 0, 'Latest version'),
        record('older', 60_000, 'Older version'),
      ],
    })

    expect(wrapper.get('.history-file-heading').classes()).toContain('history-timeline-heading')
    expect(wrapper.find('.history-file-heading > div').exists()).toBe(false)
    expect(wrapper.get('h2').text()).toBe('AGENTS')
    expect(wrapper.find('.history-file-heading .history-file-path').exists()).toBe(false)
    expect(wrapper.findAll('.history-timeline-group')).toHaveLength(1)
    expect(wrapper.findAll('.history-file-commit-row')).toHaveLength(2)
    expect(wrapper.find('.history-file-row').exists()).toBe(false)
    expect(wrapper.find('.history-disclosure').exists()).toBe(true)
    expect(wrapper.find('.history-file-commit-row').attributes('aria-expanded')).toBeUndefined()
    expect(wrapper.find('.history-commit-sha').exists()).toBe(false)
  })

  it('opens a commit with click and Enter using HistoryRevisionSelection and marks it selected', async () => {
    const { wrapper } = await mountTimeline({ commits: [record('abcdef123', 0, 'Update AGENTS')] })
    const row = wrapper.get('.history-file-commit-row')

    expect(row.text()).not.toContain('abcdef1')
    await row.trigger('click')
    expect(wrapper.emitted('open-revision')).toEqual([[{
      documentPath: 'inbox/agents',
      documentTitle: 'AGENTS',
      revisionId: 'abcdef123',
      parentRevisionId: null,
      revisionTime: NOW,
      summary: 'Update AGENTS',
    }]])
    expect(row.attributes('aria-selected')).toBe('true')

    await row.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open-revision')).toHaveLength(2)
  })

  it('emits Back to All History and supports date keyboard disclosure', async () => {
    const { wrapper } = await mountTimeline({ commits: [record('latest', 0, 'Latest')] })
    const group = wrapper.get('.history-timeline-group-header')
    expect(group.attributes('aria-expanded')).toBe('true')
    await group.trigger('keydown', { key: ' ' })
    expect(wrapper.find('.history-file-commit-row').exists()).toBe(false)
    await wrapper.get('.history-back-button').trigger('click')
    expect(wrapper.emitted('show-all')).toHaveLength(1)
  })

  it('exposes Withdraw only when the file commit is the actual repository HEAD', async () => {
    const { wrapper } = await mountTimeline({
      commits: [record('file-latest', 0, 'File latest'), record('repository-head', 60_000, 'HEAD')],
      repositoryHeadId: 'repository-head',
      withdrawAvailable: true,
    })
    const rows = wrapper.findAll('.history-file-commit-row')

    expect(rows[0]!.attributes('aria-haspopup')).toBeUndefined()
    expect(rows[1]!.attributes('aria-haspopup')).toBe('menu')
    await rows[0]!.trigger('contextmenu')
    expect(wrapper.emitted('contextmenu')).toBeUndefined()
    await rows[1]!.trigger('contextmenu')
    expect(wrapper.emitted('contextmenu')?.[0]?.[1]).toMatchObject({ id: 'repository-head' })
  })

  it('renders independent loading, empty, and error states and retries the file request', async () => {
    let resolveLog!: (value: { commits: api.CommitRecord[] }) => void
    vi.mocked(api.getLog).mockReturnValueOnce(new Promise((resolve) => { resolveLog = resolve }))
    const fileHistory = useFileHistory(ref('en-US'))
    const opening = fileHistory.open({ documentPath: 'inbox/agents', documentTitle: 'AGENTS' })
    const wrapper = mount(FileHistoryTimeline, {
      props: { fileHistory, repositoryHeadId: null, withdrawAvailable: false },
    })
    expect(wrapper.get('.history-skeleton').attributes('aria-label')).toBe('Loading history for AGENTS…')

    resolveLog({ commits: [] })
    await opening
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.history-empty-inline').text()).toBe('This file has no recorded versions yet.')

    vi.mocked(api.getLog).mockRejectedValueOnce(new Error('offline'))
    await fileHistory.refresh()
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.history-error').text()).toContain('Could not load history for this file.')

    vi.mocked(api.getLog).mockResolvedValueOnce({ commits: [] })
    await wrapper.get('.history-error button').trigger('click')
    await vi.waitFor(() => expect(fileHistory.error.value).toBeNull())
  })
})
