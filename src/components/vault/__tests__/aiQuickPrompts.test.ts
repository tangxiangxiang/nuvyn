import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useI18n } from '../../../composables/useI18n'
import { resolveAiQuickPrompts } from '../aiQuickPrompts'

const { t, setLocale } = useI18n()

describe('AI quick prompts by workspace', () => {
  beforeEach(() => setLocale('zh'))
  afterEach(() => setLocale('zh'))

  it('keeps the existing Note prompt groups and only uses Note context in Note', () => {
    const withNote = resolveAiQuickPrompts({ workspace: 'vault', diaryViewMode: 'diary', hasActiveNote: true, t })
    const withoutNote = resolveAiQuickPrompts({ workspace: 'vault', diaryViewMode: 'diary', hasActiveNote: false, t })

    expect(withNote.prompts.map(({ label }) => label)).toEqual(['提炼要点', '查找关联', '优化笔记'])
    expect(withNote.prompts[0]?.text).toBe(t('quick_prompts.with_note.summarize.text'))
    expect(withNote.emptyHint).toBe('可以结合当前笔记和知识库提供帮助。')
    expect(withoutNote.prompts.map(({ label }) => label)).toEqual(['概览知识库', '找待整理笔记', '规划整理'])
    expect(withoutNote.emptyHint).toBe('可以帮助你查找知识和整理笔记。')
  })

  it('selects the three Diary prompts and matching hint for each view', () => {
    const diary = resolveAiQuickPrompts({ workspace: 'diary', diaryViewMode: 'diary', hasActiveNote: true, t })
    const events = resolveAiQuickPrompts({ workspace: 'diary', diaryViewMode: 'events', hasActiveNote: true, t })
    const tasks = resolveAiQuickPrompts({ workspace: 'diary', diaryViewMode: 'tasks', hasActiveNote: true, t })

    expect(diary.prompts.map(({ label }) => label)).toEqual(['梳理心情', '自我反思', '培养记录习惯'])
    expect(diary.prompts[0]?.text).toBe('我想梳理一下最近的心情。请通过提问帮助我理解自己的感受，不要替我写日记。')
    expect(diary.emptyHint).toBe('可以帮你梳理心情和思考，不会读取你的日记。')
    expect(events.prompts.map(({ label }) => label)).toEqual(['规划重要日程', '准备生日纪念日', '制定活动计划'])
    expect(events.prompts[0]?.text).toBe('我想规划一项重要日程。请先了解日期、目标和限制条件，再帮我制定安排。')
    expect(events.emptyHint).toBe('可以帮你规划重要日期和活动安排。')
    expect(tasks.prompts.map(({ label }) => label)).toEqual(['拆解复杂任务', '梳理任务优先级', '制定执行计划'])
    expect(tasks.prompts[0]?.text).toBe('我有一项比较复杂的任务。请先了解目标、截止日期和限制条件，再帮我拆解为可执行的步骤。')
    expect(tasks.emptyHint).toBe('可以帮你拆解任务、梳理优先级。')
  })

  it('describes Ledger analysis and Board assistance for their workspaces', () => {
    const ledger = resolveAiQuickPrompts({ workspace: 'ledger', diaryViewMode: 'diary', hasActiveNote: false, t })
    const board = resolveAiQuickPrompts({ workspace: 'board', diaryViewMode: 'diary', hasActiveNote: false, t })

    expect(ledger.prompts.map(({ label }) => label)).toEqual(['分析本月收支', '分析消费结构', '查看财务趋势'])
    expect(ledger.emptyHint).toBe('可以分析最新账本的收支、还款和账户余额。')
    expect(board.prompts.map(({ label }) => label)).toEqual(['头脑风暴', '整理思路', '设计信息结构'])
    expect(board.emptyHint).toBe('可以帮助你头脑风暴和整理思路。')
  })

  it('resolves translated prompts and hints in English', () => {
    setLocale('en')
    const result = resolveAiQuickPrompts({ workspace: 'diary', diaryViewMode: 'tasks', hasActiveNote: false, t })

    expect(result.prompts.map(({ label }) => label)).toEqual([
      'Break down a complex task', 'Prioritize tasks', 'Make an execution plan',
    ])
    expect(result.prompts[0]?.text).toBe(t('quick_prompts.diary.tasks.breakdown.text'))
    expect(result.emptyHint).toBe('I can help break down tasks and set priorities.')
  })

  it('does not show Note prompts when there is no active workspace', () => {
    const result = resolveAiQuickPrompts({ workspace: null, diaryViewMode: 'diary', hasActiveNote: true, t })

    expect(result.prompts).toEqual([])
    expect(result.emptyHint).toBe('可以和我讨论一般问题。')
  })
})
