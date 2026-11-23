import type { DiaryCalendarMode } from '../../composables/appShellContext'
import type { WorkspaceKind } from '../../lib/workspace'

export interface AiQuickPrompt {
  label: string
  text: string
}

type Translator = (key: string) => string

interface PromptGroup {
  hint: string
  prompts: readonly [string, string][]
}

const noteWithDocument: PromptGroup = {
  hint: 'ai.empty_hint_note',
  prompts: [
    ['quick_prompts.with_note.summarize.label', 'quick_prompts.with_note.summarize.text'],
    ['quick_prompts.with_note.find_related.label', 'quick_prompts.with_note.find_related.text'],
    ['quick_prompts.with_note.suggest_tidy.label', 'quick_prompts.with_note.suggest_tidy.text'],
  ],
}

const noteWithoutDocument: PromptGroup = {
  hint: 'ai.empty_hint_vault',
  prompts: [
    ['quick_prompts.no_note.browse.label', 'quick_prompts.no_note.browse.text'],
    ['quick_prompts.no_note.find_unprocessed.label', 'quick_prompts.no_note.find_unprocessed.text'],
    ['quick_prompts.no_note.suggest_tidy.label', 'quick_prompts.no_note.suggest_tidy.text'],
  ],
}

const diaryPromptGroups: Record<DiaryCalendarMode, PromptGroup> = {
  diary: {
    hint: 'ai.empty_hint_diary_diary',
    prompts: [
      ['quick_prompts.diary.diary.mood.label', 'quick_prompts.diary.diary.mood.text'],
      ['quick_prompts.diary.diary.reflect.label', 'quick_prompts.diary.diary.reflect.text'],
      ['quick_prompts.diary.diary.habit.label', 'quick_prompts.diary.diary.habit.text'],
    ],
  },
  events: {
    hint: 'ai.empty_hint_diary_events',
    prompts: [
      ['quick_prompts.diary.events.schedule.label', 'quick_prompts.diary.events.schedule.text'],
      ['quick_prompts.diary.events.anniversary.label', 'quick_prompts.diary.events.anniversary.text'],
      ['quick_prompts.diary.events.activity.label', 'quick_prompts.diary.events.activity.text'],
    ],
  },
  tasks: {
    hint: 'ai.empty_hint_diary_tasks',
    prompts: [
      ['quick_prompts.diary.tasks.breakdown.label', 'quick_prompts.diary.tasks.breakdown.text'],
      ['quick_prompts.diary.tasks.prioritize.label', 'quick_prompts.diary.tasks.prioritize.text'],
      ['quick_prompts.diary.tasks.plan.label', 'quick_prompts.diary.tasks.plan.text'],
    ],
  },
}

const workspaceGroups: Record<'ledger' | 'board', PromptGroup> = {
  ledger: {
    hint: 'ai.empty_hint_ledger',
    prompts: [
      ['quick_prompts.ledger.review.label', 'quick_prompts.ledger.review.text'],
      ['quick_prompts.ledger.spending.label', 'quick_prompts.ledger.spending.text'],
      ['quick_prompts.ledger.trend.label', 'quick_prompts.ledger.trend.text'],
    ],
  },
  board: {
    hint: 'ai.empty_hint_board',
    prompts: [
      ['quick_prompts.board.brainstorm.label', 'quick_prompts.board.brainstorm.text'],
      ['quick_prompts.board.organize.label', 'quick_prompts.board.organize.text'],
      ['quick_prompts.board.structure.label', 'quick_prompts.board.structure.text'],
    ],
  },
}

export function resolveAiQuickPrompts(options: {
  workspace: WorkspaceKind
  diaryViewMode: DiaryCalendarMode
  hasActiveNote: boolean
  t: Translator
}): { prompts: AiQuickPrompt[]; emptyHint: string } {
  const { workspace, diaryViewMode, hasActiveNote, t } = options
  let group: PromptGroup | null = null

  if (workspace === 'vault') group = hasActiveNote ? noteWithDocument : noteWithoutDocument
  else if (workspace === 'diary') group = diaryPromptGroups[diaryViewMode]
  else if (workspace === 'ledger' || workspace === 'board') group = workspaceGroups[workspace]

  return {
    prompts: group?.prompts.map(([label, text]) => ({ label: t(label), text: t(text) })) ?? [],
    emptyHint: t(group?.hint ?? 'ai.empty_hint_general'),
  }
}
