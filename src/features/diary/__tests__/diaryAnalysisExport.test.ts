// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { parseDiaryDate } from '../../../../shared/diaryProtocol'
import { parseTagQuery } from '../../../lib/tags'
import { projectFileTree } from '../../../components/vault/fileTreeProjection'
import { getPost, type PostDetail, type PostSummary, type TreeNode } from '../../../lib/api'
import {
  captureDiarySessionGeneration,
  isDiarySessionGenerationCurrent,
  resetDiaryAccessSessionForTesting,
  useDiaryAccessSession,
} from '../../../composables/diary/useDiaryAccessSession'
import { unlockDiaryAccess } from '../../../lib/diary-access-api'
import { downloadDiaryAnalysisExport, loadDiaryAnalysisExport, managedDiaryPathsInProjection, type DiaryAnalysisExportDto } from '../diaryAnalysisExport'

vi.mock('../../../lib/api', () => ({ getPost: vi.fn() }))
vi.mock('../../../lib/diary-access-api', () => ({
  getDiaryAccessStatus: vi.fn(), lockDiaryAccess: vi.fn(async () => {}),
  setupDiaryAccess: vi.fn(), unlockDiaryAccess: vi.fn(),
}))
const authState = ref<'authenticated' | 'unauthenticated'>('authenticated')
vi.mock('../../../composables/useAuth', () => ({
  useAuth: () => ({ state: authState, onSessionExpired: () => () => {} }),
}))

const dates = ['2026-10-01', '2026-09-02', '2026-08-31', '2026-09-01', '2026-09-18']
const moods = ['custom_mood_work', null, 'missing-mood', 'happy', 'angry']
const posts: PostSummary[] = dates.map((date, index) => ({
  path: `diary/${date}`, title: index % 2 ? '休息记录' : '工作记录', tags: index % 2 ? ['rest'] : ['work'],
  mood: moods[index], summary: 'body-only phrase', created: '', updated: '', size: 0, mtime: 0,
}))
const tree: TreeNode[] = [{
  kind: 'folder', name: 'content', path: '', children: [
    { kind: 'folder', name: 'diary', path: 'diary', children: [
      ...posts.map((post): TreeNode => ({ kind: 'file', name: post.path.slice(6), path: post.path, title: post.title, mtime: 0 })),
      { kind: 'file', name: 'legacy', path: 'diary/legacy', title: '工作记录', mtime: 0 },
    ] },
    { kind: 'folder', name: 'inbox', path: 'inbox', children: [
      { kind: 'file', name: 'note', path: 'inbox/note', title: '工作记录', mtime: 0 },
    ] },
  ],
}]

function detail(path: string, raw = `# ${path.slice(6)}\n\n完整正文\n`): PostDetail {
  return {
    path, raw, content: 'do not export this converted body', frontmatter: {}, size: 0, mtime: 0,
    metadata: { id: 'internal-id', path, title: 'internal-title', summary: '', tags: [], mood: posts.find((post) => post.path === path)?.mood ?? null, createdAt: 1, updatedAt: 2 },
  }
}

function snapshot(filter = '', exactPathFilter: string | null = null) {
  const projection = projectFileTree({ tree, posts, scope: 'diary', query: parseTagQuery(filter), exactPathFilter })
  const paths = managedDiaryPathsInProjection(projection)
  return { filter, documents: paths.map((path) => ({ path, mood: posts.find((post) => post.path === path)?.mood ?? null })) }
}

function options() {
  const generation = captureDiarySessionGeneration()
  const access = useDiaryAccessSession()
  return {
    isCurrent: () => access.isUnlocked.value && isDiarySessionGenerationCurrent(generation),
    liveRawForPath: vi.fn((_path: string): string | undefined => undefined),
    customIconNames: { custom_mood_work: '专注工作' },
    locale: 'zh' as const,
  }
}

beforeEach(async () => {
  authState.value = 'authenticated'
  resetDiaryAccessSessionForTesting()
  vi.mocked(getPost).mockReset().mockImplementation(async (path) => detail(path))
  vi.mocked(unlockDiaryAccess).mockResolvedValue({ state: 'UNLOCKED', capability: 'test-only-capability', epoch: 1 })
  await useDiaryAccessSession().unlock('test-only-password')
})

afterEach(() => {
  resetDiaryAccessSessionForTesting()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Diary analysis export scope and entries', () => {
  it.each([
    ['', null, ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-18', '2026-10-01']],
    ['2026-09', null, ['2026-09-01', '2026-09-02', '2026-09-18']],
    ['2026-09-01', null, ['2026-09-01']],
    ['2026-09', 'diary/2026-09-18', ['2026-09-18']],
    ['#work -#rest 2026-09', null, ['2026-09-18']],
    ['休息 2026-09', null, ['2026-09-01', '2026-09-02']],
  ])('exports only the shared projection for filter %s / exact %s', async (filter, exact, expectedDates) => {
    const data = await loadDiaryAnalysisExport(snapshot(filter as string, exact as string | null), options())
    expect(data?.entries.map(({ date }) => date)).toEqual(expectedDates)
    expect(data?.filter).toBe(filter)
    expect(vi.mocked(getPost).mock.calls.map(([path]) => path)).toEqual((expectedDates as string[]).map((date) => `diary/${date}`))
  })

  it.each(['not-a-match', 'body-only phrase', '#unknown'])('does nothing for a zero-match query: %s', async (filter) => {
    expect(await loadDiaryAnalysisExport(snapshot(filter), options())).toBeNull()
    expect(getPost).not.toHaveBeenCalled()
  })

  it('does not export an exact path which the query excludes or which is missing', async () => {
    expect(await loadDiaryAnalysisExport(snapshot('2026-08', 'diary/2026-09-01'), options())).toBeNull()
    expect(await loadDiaryAnalysisExport(snapshot('', 'diary/2026-09-30'), options())).toBeNull()
    expect(getPost).not.toHaveBeenCalled()
  })

  it('whitelists the schema, keeps complete Markdown bytes, and resolves mood labels', async () => {
    const raw = '  # 日记\r\n\r\n**没有截断**\r\n\n```text\n原样\n```\n\n  '
    vi.mocked(getPost).mockImplementation(async (path) => detail(path, raw))
    const data = (await loadDiaryAnalysisExport(snapshot(), options()))!
    expect(Object.keys(data)).toEqual(['version', 'exportedAt', 'filter', 'entries'])
    expect(data.version).toBe(1)
    expect(new Date(data.exportedAt).toISOString()).toBe(data.exportedAt)
    expect(data.entries.map(({ mood }) => mood)).toEqual([
      { id: 'missing-mood', label: null }, { id: 'happy', label: '开心' }, null,
      { id: 'angry', label: '愤怒' }, { id: 'custom_mood_work', label: '专注工作' },
    ])
    for (const entry of data.entries) {
      expect(Object.keys(entry)).toEqual(['date', 'mood', 'content'])
      expect(entry.content).toBe(raw)
    }
    expect(JSON.stringify(data)).not.toMatch(/internal-id|internal-title|customIcons|asset|svg|metadata|mtime|revision/)
  })

  it('uses canonical English labels when that is the current locale', async () => {
    const data = await loadDiaryAnalysisExport(snapshot('2026-09-01'), { ...options(), locale: 'en' })
    expect(data?.entries[0]?.mood).toEqual({ id: 'happy', label: 'Happy' })
  })

  it('uses live unsaved raw, including the empty string, without saving or fetching it', async () => {
    const currentOptions = options()
    currentOptions.liveRawForPath.mockImplementation((path) => path === 'diary/2026-09-01' ? '' : '# unsaved\n\n刚写完的正文\n')
    const data = await loadDiaryAnalysisExport(snapshot('2026-09'), currentOptions)
    expect(data?.entries.map(({ content }) => content)).toEqual(['', '# unsaved\n\n刚写完的正文\n', '# unsaved\n\n刚写完的正文\n'])
    expect(getPost).not.toHaveBeenCalled()
  })

  it('uses fresh canonical metadata for server bodies and null for missing custom labels', async () => {
    vi.mocked(getPost).mockImplementation(async (path) => ({
      ...detail(path), metadata: { ...detail(path).metadata!, mood: 'custom_mood_removed' },
    }))
    const data = await loadDiaryAnalysisExport(snapshot('2026-09-01'), options())
    expect(data?.entries[0]?.mood).toEqual({ id: 'custom_mood_removed', label: null })
  })

  it('does not treat an inherited property as a configured mood label', async () => {
    vi.mocked(getPost).mockImplementation(async (path) => ({
      ...detail(path), metadata: { ...detail(path).metadata!, mood: 'toString' },
    }))
    const data = await loadDiaryAnalysisExport(snapshot('2026-09-01'), options())
    expect(data?.entries[0]?.mood).toEqual({ id: 'toString', label: null })
  })

  it('ignores unmanaged paths even if a caller supplies them alongside a valid path', async () => {
    const invalidPaths = ['diary', 'inbox/note', 'diary/legacy', 'diary/2026-02-30', 'diary/2026-09-01.md', 'diary/2026-09-01/child']
    const data = await loadDiaryAnalysisExport({ filter: '', documents: [...invalidPaths, 'diary/2026-09-01'].map((path) => ({ path, mood: null })) }, options())
    expect(data?.entries.map(({ date }) => date)).toEqual(['2026-09-01'])
    expect(getPost).toHaveBeenCalledExactlyOnceWith('diary/2026-09-01')
  })

  it('freezes paths and descriptive filter before the first asynchronous read', async () => {
    let resolve!: (value: PostDetail) => void
    vi.mocked(getPost).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const input = snapshot('2026-09')
    const pending = loadDiaryAnalysisExport(input, options())
    input.filter = '2026-08'
    input.documents.splice(0, input.documents.length, { path: 'diary/2026-08-31', mood: null })
    resolve(detail('diary/2026-09-01'))
    const data = await pending
    expect(data?.filter).toBe('2026-09')
    expect(data?.entries.map(({ date }) => date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-18'])
  })

  it('rejects an incomplete read rather than publishing a partial export', async () => {
    vi.mocked(getPost).mockResolvedValueOnce(detail('diary/2026-08-31')).mockRejectedValueOnce(new Error('private failure context'))
    await expect(loadDiaryAnalysisExport(snapshot(), options())).rejects.toThrow()
    expect(getPost).toHaveBeenCalledTimes(2)
  })
})

describe('Diary analysis session fencing', () => {
  it.each(['locked', 'uninitialized'])('does not read any body when %s', async (state) => {
    if (state === 'locked') await useDiaryAccessSession().lock()
    else resetDiaryAccessSessionForTesting()
    expect(await loadDiaryAnalysisExport(snapshot(), options())).toBeNull()
    expect(getPost).not.toHaveBeenCalled()
  })

  it.each(['lock', 'replace', 'invalidate'])('stops after a pending read when the owner triggers %s', async (transition) => {
    let resolve!: (value: PostDetail) => void
    vi.mocked(getPost).mockResolvedValueOnce(detail('diary/2026-08-31'))
      .mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const pending = loadDiaryAnalysisExport(snapshot(), options())
    await Promise.resolve()
    expect(getPost).toHaveBeenCalledTimes(2)
    const access = useDiaryAccessSession()
    if (transition === 'lock') await access.lock()
    else if (transition === 'replace') await access.unlock('replacement-password')
    else access.clear()
    resolve(detail('diary/2026-09-01', '# late plaintext\n'))
    expect(await pending).toBeNull()
    expect(getPost).toHaveBeenCalledTimes(2)
  })

  it('never aggregates a live buffer after its generation changes', async () => {
    const currentOptions = options()
    currentOptions.liveRawForPath.mockImplementation(() => {
      useDiaryAccessSession().clear()
      return '# stale plaintext\n'
    })
    expect(await loadDiaryAnalysisExport(snapshot(), currentOptions)).toBeNull()
    expect(getPost).not.toHaveBeenCalled()
  })

  it('also fails closed when the Vault owner is disposed during an async read', async () => {
    let current = true
    let resolve!: (value: PostDetail) => void
    vi.mocked(getPost).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const pending = loadDiaryAnalysisExport(snapshot(), { ...options(), isCurrent: () => current })
    current = false
    resolve(detail('diary/2026-08-31'))
    expect(await pending).toBeNull()
    expect(getPost).toHaveBeenCalledOnce()
  })
})

describe('Diary analysis download', () => {
  const data: DiaryAnalysisExportDto = {
    version: 1, exportedAt: '2026-10-03T18:00:00.000Z', filter: '#工作/2026-09:*?',
    entries: [{ date: parseDiaryDate('2026-09-01')!, mood: { id: 'happy', label: '开心' }, content: '# 测试\r\n\r\n原样正文\n' }],
  }

  function downloadMocks() {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:test-diary-analysis')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
    vi.stubGlobal('Blob', NodeBlob)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    return { createObjectURL, revokeObjectURL, click }
  }

  it('downloads pretty UTF-8 JSON without BOM, then removes the anchor and URL', async () => {
    const { createObjectURL, revokeObjectURL, click } = downloadMocks()
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026)
    vi.spyOn(Date.prototype, 'getMonth').mockReturnValue(9)
    vi.spyOn(Date.prototype, 'getDate').mockReturnValue(4)
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(2)
    vi.spyOn(Date.prototype, 'getMinutes').mockReturnValue(3)
    vi.spyOn(Date.prototype, 'getSeconds').mockReturnValue(4)
    let filename = ''
    click.mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download
      expect(this.hidden).toBe(true)
      expect(document.body.contains(this)).toBe(true)
    })
    downloadDiaryAnalysisExport(data, () => true)
    const blob = createObjectURL.mock.calls[0]![0] as unknown as NodeBlob
    expect(blob.type).toBe('application/json')
    expect(await blob.text()).toBe(JSON.stringify(data, null, 2))
    expect((await blob.text()).charCodeAt(0)).not.toBe(0xfeff)
    expect(filename).toBe('nuvyn-diary-2026-10-04_02-03-04.json')
    expect(filename).not.toMatch(/[<>:"/\\|?*]/)
    expect(click).toHaveBeenCalledOnce()
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-diary-analysis')
  })

  it('uses the full browser-local timestamp even on the western side of UTC', () => {
    const { click } = downloadMocks()
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026)
    vi.spyOn(Date.prototype, 'getMonth').mockReturnValue(9)
    vi.spyOn(Date.prototype, 'getDate').mockReturnValue(2)
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(23)
    vi.spyOn(Date.prototype, 'getMinutes').mockReturnValue(5)
    vi.spyOn(Date.prototype, 'getSeconds').mockReturnValue(6)
    click.mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('nuvyn-diary-2026-10-02_23-05-06.json')
    })
    downloadDiaryAnalysisExport(data, () => true)
  })

  it('distinguishes repeated exports on the same date down to the second', () => {
    const { click } = downloadMocks()
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026)
    vi.spyOn(Date.prototype, 'getMonth').mockReturnValue(9)
    vi.spyOn(Date.prototype, 'getDate').mockReturnValue(4)
    vi.spyOn(Date.prototype, 'getHours').mockReturnValue(2)
    vi.spyOn(Date.prototype, 'getMinutes').mockReturnValue(0)
    vi.spyOn(Date.prototype, 'getSeconds').mockReturnValueOnce(0).mockReturnValueOnce(1)
    const filenames: string[] = []
    click.mockImplementation(function (this: HTMLAnchorElement) {
      filenames.push(this.download)
    })

    downloadDiaryAnalysisExport(data, () => true)
    downloadDiaryAnalysisExport({ ...data, exportedAt: '2026-10-03T18:00:01.000Z' }, () => true)

    expect(filenames).toEqual(['nuvyn-diary-2026-10-04_02-00-00.json', 'nuvyn-diary-2026-10-04_02-00-01.json'])
  })

  it('creates no Blob if the generation changes between loading and download', async () => {
    const currentOptions = options()
    const loaded = (await loadDiaryAnalysisExport(snapshot(), currentOptions))!
    const { createObjectURL, click } = downloadMocks()
    const blob = vi.fn()
    vi.stubGlobal('Blob', blob)
    await useDiaryAccessSession().unlock('replacement-password')
    downloadDiaryAnalysisExport(loaded, currentOptions.isCurrent)
    expect(blob).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('does not create a plaintext artifact for zero results', () => {
    const { createObjectURL, click } = downloadMocks()
    const blob = vi.fn()
    vi.stubGlobal('Blob', blob)
    downloadDiaryAnalysisExport({ ...data, entries: [] }, () => true)
    expect(blob).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it.each(['invalidation', 'click failure'])('cleans up an allocated URL after %s', (failure) => {
    const { createObjectURL, revokeObjectURL, click } = downloadMocks()
    let current = true
    if (failure === 'invalidation') createObjectURL.mockImplementation(() => { current = false; return 'blob:test-diary-analysis' })
    else click.mockImplementation(() => { throw new Error('download unavailable') })
    if (failure === 'click failure') expect(() => downloadDiaryAnalysisExport(data, () => current)).toThrow('download unavailable')
    else {
      downloadDiaryAnalysisExport(data, () => current)
      expect(click).not.toHaveBeenCalled()
    }
    expect(document.querySelector('a[download]')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-diary-analysis')
  })
})
