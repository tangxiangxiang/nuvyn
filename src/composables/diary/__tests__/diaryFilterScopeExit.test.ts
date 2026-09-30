import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { watchDiaryFilterScopeExit, type DiaryFilterOwnership } from '../diaryFilterScopeExit'

function createLifecycle(options: {
  isDiaryScope: boolean
  statusResolved: boolean
  filesFilter: string
  diaryFilterSeed: string
  diaryFilterOwnership: DiaryFilterOwnership
}) {
  const isDiaryScope = ref(options.isDiaryScope)
  const statusResolved = ref(options.statusResolved)
  const filesFilter = ref(options.filesFilter)
  const diaryFilterSeed = ref(options.diaryFilterSeed)
  const diaryFilterOwnership = ref(options.diaryFilterOwnership)
  const clearPendingMoodFirstPresentation = vi.fn()
  const scope = effectScope()

  scope.run(() => watchDiaryFilterScopeExit({
    isDiaryScope,
    statusResolved,
    filesFilter,
    diaryFilterSeed,
    diaryFilterOwnership,
    clearPendingMoodFirstPresentation,
  }))

  return {
    isDiaryScope,
    statusResolved,
    filesFilter,
    diaryFilterSeed,
    diaryFilterOwnership,
    clearPendingMoodFirstPresentation,
    stop: () => scope.stop(),
  }
}

describe('watchDiaryFilterScopeExit', () => {
  it('defers Calendar cleanup until access resolves even when the scope stays Note', async () => {
    const lifecycle = createLifecycle({
      isDiaryScope: false,
      statusResolved: false,
      filesFilter: '2026-09-02',
      diaryFilterSeed: '2026-09-02',
      diaryFilterOwnership: 'calendar',
    })

    expect(lifecycle.filesFilter.value).toBe('2026-09-02')
    expect(lifecycle.diaryFilterOwnership.value).toBe('calendar')
    expect(lifecycle.clearPendingMoodFirstPresentation).not.toHaveBeenCalled()

    lifecycle.statusResolved.value = true
    await nextTick()

    expect(lifecycle.filesFilter.value).toBe('')
    expect(lifecycle.diaryFilterSeed.value).toBe('')
    expect(lifecycle.diaryFilterOwnership.value).toBe('none')
    expect(lifecycle.clearPendingMoodFirstPresentation).toHaveBeenCalledOnce()
    lifecycle.stop()
  })

  it('clears a Calendar-owned filter on an ordinary resolved scope exit', async () => {
    const lifecycle = createLifecycle({
      isDiaryScope: true,
      statusResolved: true,
      filesFilter: '2026-09-02',
      diaryFilterSeed: '2026-09-02',
      diaryFilterOwnership: 'calendar',
    })

    lifecycle.isDiaryScope.value = false
    await nextTick()

    expect(lifecycle.filesFilter.value).toBe('')
    expect(lifecycle.diaryFilterSeed.value).toBe('')
    expect(lifecycle.diaryFilterOwnership.value).toBe('none')
    lifecycle.stop()
  })

  it('preserves user-owned non-empty and intentionally empty filters', async () => {
    for (const filter of ['工作', '']) {
      const lifecycle = createLifecycle({
        isDiaryScope: false,
        statusResolved: true,
        filesFilter: filter,
        diaryFilterSeed: '',
        diaryFilterOwnership: 'user',
      })
      await nextTick()

      expect(lifecycle.filesFilter.value).toBe(filter)
      expect(lifecycle.diaryFilterSeed.value).toBe('')
      expect(lifecycle.diaryFilterOwnership.value).toBe('user')
      lifecycle.stop()
    }
  })
})
