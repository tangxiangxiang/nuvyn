import MarkdownIt from 'markdown-it'
import type { DiaryPlanItem } from '../shared/diaryPlan.js'

const markdown = new MarkdownIt({ html: true })

// Match the Reader task-list plugin's token shape. A blank template entry
// stays blank in the calendar, and fenced/indented examples are code tokens.
export function summarizeDiaryTasks(raw: string): { total: number; completed: number } {
  // Skip a leading frontmatter block without invoking a data parser or
  // caching private Markdown. An unterminated header has no visible body.
  const source = raw.replace(/^\uFEFF/, '')
  const body = /^---[^\r\n]*\r?\n/.exec(source)
  const text = body ? source.slice(body[0].length) : source
  const closing = body ? /^---[ \t]*\r?$(?:\n)?/mu.exec(text) : null
  const tokens = markdown.parse(body ? closing ? text.slice(closing.index + closing[0].length) : '' : text, {})
  let total = 0
  let completed = 0
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type !== 'inline' || tokens[i - 1]?.type !== 'paragraph_open'
      || tokens[i - 2]?.type !== 'list_item_open') continue
    const marker = /^\[([ xX])\] \s*\S/.exec(token.content)
    if (!marker) continue
    total++
    if (marker[1] !== ' ') completed++
  }
  return { total, completed }
}

type MigratingItem = Pick<DiaryPlanItem, 'title' | 'plannedTime' | 'completedAt'>

export function appendDiaryPlanItems(raw: string, items: readonly MigratingItem[]): string {
  const tasks = items.map(({ title, plannedTime, completedAt }) => {
    const text = title.replace(/[\r\n\t\u0000-\u001f]/g, ' ')
      .replace(/[!-/:-@\[-`{-~]/g, '\\$&')
    return `- [${completedAt === null ? ' ' : 'x'}] ${plannedTime ? `${plannedTime} ` : ''}${text}`
  })
  const before = summarizeDiaryTasks(raw)
  const next = `${raw}\n\n## 计划\n\n${tasks.join('\n')}\n`
  const after = summarizeDiaryTasks(next)
  if (after.total !== before.total + items.length
    || after.completed !== before.completed + items.filter((item) => item.completedAt !== null).length) {
    throw new Error('Diary Markdown cannot safely accept the migrated items')
  }
  return next
}
