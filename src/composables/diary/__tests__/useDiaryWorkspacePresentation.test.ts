import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { parseDiaryDate, type DiaryDate } from '../../../../shared/diaryProtocol'
import {
  useDiaryWorkspacePresentation,
  type DiaryPresentationFocusTarget,
} from '../useDiaryWorkspacePresentation'
import type { DiaryDateCommandResult } from '../useDiaryDateCommand'

function date(value: string): DiaryDate {
  const parsed = parseDiaryDate(value)
  if (!parsed) throw new Error(`invalid test date: ${value}`)
  return parsed
}

function setup() {
  const isDiaryScope = ref(false)
  const activeHistoryComparison = ref<unknown | null>(null)
  const activeWorkingTreeDiff = ref<unknown | null>(null)
  const activeDraftRecovery = ref<unknown | null>(null)
  const documentPaths = ref<string[]>([])
  const activePath = ref<string | null>(null)
  const presentation = useDiaryWorkspacePresentation({
    isDiaryScope,
    activeHistoryComparison,
    activeWorkingTreeDiff,
    activeDraftRecovery,
    documentPaths,
    activePath,
  })

  return {
    isDiaryScope,
    activeHistoryComparison,
    activeWorkingTreeDiff,
    activeDraftRecovery,
    documentPaths,
    activePath,
    presentation,
  }
}

type SuccessfulDiaryDateCommandResult = Extract<DiaryDateCommandResult, { status: 'opened' | 'created' }>

function opened(dateValue: string): SuccessfulDiaryDateCommandResult {
  const diaryDate = date(dateValue)
  return { status: 'opened', date: diaryDate, path: `diary/${diaryDate}` }
}

function requestDocument(state: ReturnType<typeof setup>, dateValue: string): void {
  const path = `diary/${dateValue}`
  state.presentation.recordDateCommandResult(opened(dateValue))
  state.activePath.value = path
  state.documentPaths.value = [path]
  state.presentation.requestDocument(date(dateValue), path)
}

describe('useDiaryWorkspacePresentation', () => {
  it('starts at HOME and is eligible only for a plain Diary scope', async () => {
    const state = setup()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.isHome.value).toBe(false)

    state.isDiaryScope.value = true
    await nextTick()
    expect(state.presentation.diaryPresentationEligible.value).toBe(true)
    expect(state.presentation.isHome.value).toBe(true)
  })

  it.each([
    ['History Comparison', 'activeHistoryComparison'],
    ['Working Tree Diff', 'activeWorkingTreeDiff'],
    ['Recovery', 'activeDraftRecovery'],
  ] as const)('yields to %s and returns to safe HOME without reopening', async (_label, key) => {
    const state = setup()
    state.isDiaryScope.value = true
    requestDocument(state, '2026-08-24')
    expect(state.presentation.isDocument.value).toBe(true)

    state[key].value = { active: true }
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()

    state[key].value = null
    await nextTick()
    expect(state.presentation.isHome.value).toBe(true)
    expect(state.presentation.isDocument.value).toBe(false)
  })

  it.each(['opened', 'created'] as const)('records %s without implicitly opening DOCUMENT', async (status) => {
    const state = setup()
    state.isDiaryScope.value = true
    const result = { ...opened('2026-08-24'), status }

    state.presentation.recordDateCommandResult(result)

    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.selectedDiaryDate.value).toBe('2026-08-24')
    expect(state.presentation.backingPath.value).toBe('diary/2026-08-24')
    expect(state.presentation.focusReturnTarget.value).toEqual<DiaryPresentationFocusTarget>({
      kind: 'calendar-date',
      date: date('2026-08-24'),
    })
  })

  it('opens DOCUMENT only for an explicit successful path that is already active', () => {
    const state = setup()
    state.isDiaryScope.value = true
    const result = opened('2026-08-24')
    state.presentation.recordDateCommandResult(result)

    state.presentation.requestDocument(result.date, result.path)
    expect(state.presentation.presentationMode.value).toBe('home')

    state.activePath.value = result.path
    state.documentPaths.value = [result.path]
    state.presentation.requestDocument(result.date, result.path)
    expect(state.presentation.presentationMode.value).toBe('document')
    expect(state.presentation.isDocument.value).toBe(true)
  })

  it('cannot enter DOCUMENT from activePath without a recorded successful date command', () => {
    const state = setup()
    state.isDiaryScope.value = true
    state.activePath.value = 'diary/2026-08-24'
    state.documentPaths.value = ['diary/2026-08-24']

    state.presentation.requestDocument(date('2026-08-24'), 'diary/2026-08-24')

    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()
  })

  it('treats activePath only as a closing signal and never an opening signal', async () => {
    const state = setup()
    state.isDiaryScope.value = true
    state.activePath.value = 'diary/2026-08-24'
    state.documentPaths.value = ['diary/2026-08-24']
    await nextTick()

    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()

    requestDocument(state, '2026-08-24')
    state.activePath.value = 'inbox/ordinary'
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()
  })

  it('resets on scope exit without changing the backing document lifecycle', async () => {
    const state = setup()
    state.isDiaryScope.value = true
    requestDocument(state, '2026-08-24')

    state.isDiaryScope.value = false
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()
    expect(state.activePath.value).toBe('diary/2026-08-24')
    expect(state.documentPaths.value).toEqual(['diary/2026-08-24'])

    state.isDiaryScope.value = true
    await nextTick()
    expect(state.presentation.isHome.value).toBe(true)
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.activePath.value).toBe('diary/2026-08-24')
  })

  it('does not reopen after activePath moves away and later returns', async () => {
    const state = setup()
    state.isDiaryScope.value = true
    requestDocument(state, '2026-08-24')
    state.documentPaths.value = ['diary/2026-08-24', 'diary/2026-08-25']

    state.activePath.value = 'diary/2026-08-25'
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()

    state.activePath.value = 'diary/2026-08-24'
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.isDocument.value).toBe(false)
  })

  it('does not retarget DOCUMENT when another Diary becomes active', async () => {
    const state = setup()
    state.isDiaryScope.value = true
    requestDocument(state, '2026-08-24')
    state.documentPaths.value.push('diary/2026-08-25')

    state.activePath.value = 'diary/2026-08-25'
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.selectedDiaryDate.value).toBeNull()
  })

  it('returns HOME when the backing tab is actually removed', async () => {
    const state = setup()
    state.isDiaryScope.value = true
    requestDocument(state, '2026-08-24')

    state.documentPaths.value = []
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()
  })

  it('does not reopen when a removed backing tab is later restored', async () => {
    const state = setup()
    state.isDiaryScope.value = true
    requestDocument(state, '2026-08-24')

    state.documentPaths.value = []
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()

    state.documentPaths.value = ['diary/2026-08-24']
    state.activePath.value = 'diary/2026-08-24'
    await nextTick()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.isDocument.value).toBe(false)
  })

  it('closes presentation-only while retaining backing date/path for focus and reopen context', () => {
    const state = setup()
    state.isDiaryScope.value = true
    requestDocument(state, '2026-08-24')

    state.presentation.closePresentation()
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBe('diary/2026-08-24')
    expect(state.presentation.selectedDiaryDate.value).toBe('2026-08-24')
    expect(state.activePath.value).toBe('diary/2026-08-24')
    expect(state.documentPaths.value).toContain('diary/2026-08-24')
  })

  it('invalidates stale asynchronous date intents', () => {
    const state = setup()
    const first = state.presentation.beginDateIntent()
    const second = state.presentation.beginDateIntent()
    expect(state.presentation.isDateIntentCurrent(first)).toBe(false)
    expect(state.presentation.isDateIntentCurrent(second)).toBe(true)
    state.presentation.closePresentation()
    expect(state.presentation.isDateIntentCurrent(second)).toBe(false)
  })

  it('keeps failures and future results at HOME with no exact context', () => {
    const state = setup()
    state.isDiaryScope.value = true
    requestDocument(state, '2026-08-24')

    state.presentation.recordDateCommandResult({
      status: 'future',
      date: date('2026-08-25'),
      path: 'diary/2026-08-25',
    })
    expect(state.presentation.presentationMode.value).toBe('home')
    expect(state.presentation.backingPath.value).toBeNull()
  })
})
