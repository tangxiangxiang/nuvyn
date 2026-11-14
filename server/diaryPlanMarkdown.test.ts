import { describe, expect, it } from 'vitest'
import { appendDiaryPlanItems, summarizeDiaryTasks } from './diaryPlanMarkdown'

describe('Diary Markdown tasks', () => {
  it('recognizes nested and completed tasks and ignores code, ordinary text and a blank template item', () => {
    expect(summarizeDiaryTasks([
      '# Notes', '', '- [ ] Parent', '  - [X] Child', '', '- [ ] ', '',
      '```md', '- [x] Fenced example', '```', '', '    - [ ] Indented code', '',
      '[ ] Standalone', '', '- \\[ ] Escaped',
    ].join('\n'))).toEqual({ total: 2, completed: 1 })
  })

  it('preserves the original bytes and emits distinct checked and unchecked items with literal titles', () => {
    const original = '---\ncustom: true\n---\n# 日记\n\n自由书写  \n'
    const raw = appendDiaryPlanItems(original, [
      { title: '同名 [link](https://example.test)\n第二行', plannedTime: '09:00', completedAt: null },
      { title: '同名 [link](https://example.test)\n第二行', plannedTime: '09:00', completedAt: 0 },
    ])
    expect(raw.startsWith(original)).toBe(true)
    expect(raw).toContain('- [ ] 09:00 同名 \\[link\\]')
    expect(raw).toContain('- [x] 09:00 同名 \\[link\\]')
    expect(summarizeDiaryTasks(raw)).toEqual({ total: 2, completed: 1 })
  })

  it('fails closed when an open code block would swallow appended items', () => {
    expect(() => appendDiaryPlanItems('```md\nexample', [
      { title: 'Task', plannedTime: null, completedAt: null },
    ])).toThrow()
  })
})
