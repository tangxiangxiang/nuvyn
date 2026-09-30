import { watch, type Ref, type WatchSource } from 'vue'

export type DiaryFilterOwnership = 'none' | 'calendar' | 'user'

export interface DiaryFilterScopeExitOptions {
  isDiaryScope: WatchSource<boolean>
  statusResolved: WatchSource<boolean>
  filesFilter: Ref<string>
  diaryFilterSeed: Ref<string>
  diaryFilterOwnership: Ref<DiaryFilterOwnership>
  clearPendingMoodFirstPresentation: () => void
}

/** Clear presentation-owned Calendar state after leaving Diary and resolving access. */
export function watchDiaryFilterScopeExit({
  isDiaryScope,
  statusResolved,
  filesFilter,
  diaryFilterSeed,
  diaryFilterOwnership,
  clearPendingMoodFirstPresentation,
}: DiaryFilterScopeExitOptions): () => void {
  return watch(
    [isDiaryScope, statusResolved],
    ([inDiaryScope, accessResolved]) => {
      // A persisted Diary selection can normalize to Note before its fresh
      // browser-process access status arrives. Keep the state until that
      // authoritative result lands, then this same watcher gets another turn.
      if (inDiaryScope || !accessResolved) return

      clearPendingMoodFirstPresentation()

      // Calendar-owned filters are presentation context. Preserve any filter
      // whose provenance has moved to the user, including an intentional ''.
      if (
        diaryFilterOwnership.value === 'calendar'
        && filesFilter.value === diaryFilterSeed.value
      ) {
        filesFilter.value = ''
      }
      diaryFilterSeed.value = ''
      if (diaryFilterOwnership.value === 'calendar') {
        diaryFilterOwnership.value = 'none'
      }
    },
    { immediate: true },
  )
}
