import { computed, ref, watch, type Ref } from 'vue'
import type { DiaryDate } from '../../../shared/diaryProtocol'
import type { DiaryDateCommandResult } from './useDiaryDateCommand'

export type DiaryPresentationMode = 'home' | 'document'
export type DiaryPresentationFocusOrigin = 'calendar' | 'document'

export interface DiaryPresentationFocusTarget {
  kind: 'calendar-date'
  date: DiaryDate
}

export interface DiaryWorkspacePresentationOptions {
  isDiaryScope: Readonly<Ref<boolean>>
  activeHistoryComparison: Readonly<Ref<unknown | null>>
  activeWorkingTreeDiff: Readonly<Ref<unknown | null>>
  activeDraftRecovery: Readonly<Ref<unknown | null>>
  documentPaths: Readonly<Ref<readonly string[]>>
  activePath: Readonly<Ref<string | null>>
}

/**
 * Own the Calendar Home / native-document presentation handoff without
 * becoming another document lifecycle. Tabs, activePath, route, raw content,
 * save state, and document identity remain owned by Vault.
 */
export function useDiaryWorkspacePresentation(options: DiaryWorkspacePresentationOptions) {
  const presentationMode = ref<DiaryPresentationMode>('home')
  const selectedDiaryDate = ref<DiaryDate | null>(null)
  const backingPath = ref<string | null>(null)
  const focusOrigin = ref<DiaryPresentationFocusOrigin | null>(null)
  const focusReturnTarget = ref<DiaryPresentationFocusTarget | null>(null)
  let dateIntentEpoch = 0

  function invalidatePendingDateIntent(): void {
    dateIntentEpoch += 1
  }

  function beginDateIntent(): number {
    invalidatePendingDateIntent()
    return dateIntentEpoch
  }

  function isDateIntentCurrent(intent: number): boolean {
    return intent === dateIntentEpoch
  }

  const diaryPresentationEligible = computed(() => (
    options.isDiaryScope.value
    && !options.activeHistoryComparison.value
    && !options.activeWorkingTreeDiff.value
    && !options.activeDraftRecovery.value
  ))

  const isHome = computed(() => (
    diaryPresentationEligible.value && presentationMode.value === 'home'
  ))

  const isDocument = computed(() => (
    diaryPresentationEligible.value && presentationMode.value === 'document'
  ))

  function reset(): void {
    invalidatePendingDateIntent()
    presentationMode.value = 'home'
    selectedDiaryDate.value = null
    backingPath.value = null
    focusOrigin.value = null
    focusReturnTarget.value = null
  }

  function closePresentation(): void {
    invalidatePendingDateIntent()
    // Presentation-only close deliberately preserves the backing reference,
    // tab, activePath, route, raw, model, and dirty state. The retained date
    // supplies semantic Calendar focus restoration and same-date context.
    presentationMode.value = 'home'
    focusOrigin.value = 'calendar'
  }

  function recordDateCommandResult(result: DiaryDateCommandResult): void {
    if (result.status !== 'opened' && result.status !== 'created') {
      reset()
      return
    }

    selectedDiaryDate.value = result.date
    backingPath.value = result.path
    focusOrigin.value = 'calendar'
    focusReturnTarget.value = {
      kind: 'calendar-date',
      date: result.date,
    }
    // Adoption stays explicit. Merely recording a result or observing an
    // activePath must never open native Diary document presentation.
    presentationMode.value = 'home'
  }

  function requestDocument(date: DiaryDate, path: string): void {
    if (
      !diaryPresentationEligible.value
      || selectedDiaryDate.value !== date
      || backingPath.value !== path
      || options.activePath.value !== path
    ) return
    selectedDiaryDate.value = date
    backingPath.value = path
    focusOrigin.value = 'calendar'
    focusReturnTarget.value = {
      kind: 'calendar-date',
      date,
    }
    presentationMode.value = 'document'
  }

  // Special Vault surfaces and scope exit own visible-surface precedence.
  // Returning from them stays at the safe Calendar Home state.
  watch(
    [
      options.isDiaryScope,
      options.activeHistoryComparison,
      options.activeWorkingTreeDiff,
      options.activeDraftRecovery,
    ],
    ([inDiaryScope, historyComparison, workingTreeDiff, draftRecovery]) => {
      if (!inDiaryScope || historyComparison || workingTreeDiff || draftRecovery) reset()
    },
    { flush: 'sync' },
  )

  watch(
    [options.documentPaths, backingPath, presentationMode],
    ([paths, backing, mode]) => {
      if (mode === 'document' && backing && !paths.includes(backing)) reset()
    },
    { flush: 'sync' },
  )

  // activePath is passive reconciliation only: it may close a stale native
  // Diary presentation, but it can never open or retarget one.
  watch(
    [options.activePath, backingPath, presentationMode],
    ([active, backing, mode]) => {
      if (mode === 'document' && backing !== null && active !== backing) reset()
    },
    { flush: 'sync' },
  )

  return {
    presentationMode,
    selectedDiaryDate,
    backingPath,
    focusOrigin,
    focusReturnTarget,
    diaryPresentationEligible,
    isHome,
    isDocument,
    beginDateIntent,
    isDateIntentCurrent,
    recordDateCommandResult,
    requestDocument,
    closePresentation,
    reset,
  }
}
