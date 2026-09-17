export interface MarkdownContinuation {
  insert: string
  removeMarkerFrom?: number
}

export function markdownContinuation(lineBeforeCursor: string): MarkdownContinuation {
  const match = /^(\s*)(?:(- \[[ xX]\])|([-+*])|(\d+)\.)(\s+)(.*)$/.exec(lineBeforeCursor)
  if (!match) return { insert: '\n' }
  const indent = match[1]
  const task = match[2]
  const bullet = match[3]
  const ordered = match[4]
  const content = match[6]
  if (!content.trim()) return { insert: '\n', removeMarkerFrom: indent.length }
  if (task) return { insert: `\n${indent}- [ ] ` }
  if (bullet) return { insert: `\n${indent}${bullet} ` }
  return { insert: `\n${indent}${Number(ordered) + 1}. ` }
}

export function markdownLinkFromPaste(label: string, pasted: string): string | null {
  const url = pasted.trim()
  if (!label || !/^https?:\/\/\S+$/i.test(url)) return null
  return `[${label.replace(/]/g, '\\]')}](${url.replace(/\)/g, '\\)')})`
}

export function markdownIndentUnit(line: string, tabSize = 2): string {
  if (line.startsWith('\t')) return '\t'
  const spaces = /^ +/.exec(line)?.[0].length ?? 0
  if (spaces >= 4 && spaces % 4 === 0) return '    '
  return ' '.repeat(tabSize)
}

export function indentMarkdownLine(line: string, outdent: boolean, tabSize = 2): string {
  const unit = markdownIndentUnit(line, tabSize)
  if (outdent) {
    if (line.startsWith('\t')) return line.slice(1)
    return line.startsWith(unit) ? line.slice(unit.length) : line.replace(/^ +/, '')
  }
  return `${unit}${line}`
}

export interface MarkdownSlashCommand {
  label: string
  detail: string
  insertText: string
  command?: { id: string; title: string }
}

export const MARKDOWN_SLASH_COMMANDS: readonly MarkdownSlashCommand[] = [
  { label: 'heading 1', detail: '一级标题', insertText: '# ${1:Heading}' },
  { label: 'heading 2', detail: '二级标题', insertText: '## ${1:Heading}' },
  { label: 'heading 3', detail: '三级标题', insertText: '### ${1:Heading}' },
  { label: 'bullet list', detail: '无序列表', insertText: '- ${1:Item}' },
  { label: 'numbered list', detail: '有序列表', insertText: '1. ${1:Item}' },
  { label: 'task', detail: '任务列表', insertText: '- [ ] ${1:Task}' },
  { label: 'quote', detail: '引用', insertText: '> ${1:Quote}' },
  { label: 'callout', detail: '提示块', insertText: '> [!NOTE]\n> ${1:Content}' },
  { label: 'inline math', detail: '行内公式', insertText: '$${1:x + y}$' },
  { label: 'math block', detail: '块级公式', insertText: '$$\n${1:E = mc^2}\n$$' },
  { label: 'code block', detail: '代码块', insertText: '```$1\n$2\n```' },
  { label: 'mermaid', detail: 'Mermaid 图表', insertText: '```mermaid\n${1:graph TD\n  A --> B}\n```' },
  { label: 'markmap', detail: 'Markmap 思维导图', insertText: '```markmap\n# ${1:Topic}\n- ${2:Branch}\n```' },
  { label: 'table', detail: 'Markdown 表格', insertText: '| ${1:Column} | ${2:Column} |\n| --- | --- |\n| ${3:Value} | ${4:Value} |' },
  { label: 'footnote', detail: '脚注', insertText: '${1:Text}[^${2:1}]\n\n[^${2:1}]: ${3:Footnote content}' },
  { label: 'highlight', detail: '高亮', insertText: '==${1:Highlighted text}==' },
  { label: 'definition list', detail: '定义列表', insertText: '${1:Term}\n: ${2:Definition}' },
  {
    label: 'wiki link',
    detail: 'Wiki 链接',
    insertText: '[[',
    // Monaco executes this after the snippet edit, reusing the existing Wiki provider.
    command: { id: 'editor.action.triggerSuggest', title: 'Trigger Wiki Link completion' },
  },
  {
    label: 'emoji',
    detail: '表情',
    insertText: ':',
    // The inserted colon is handled by the same Markdown completion provider.
    command: { id: 'editor.action.triggerSuggest', title: 'Trigger Emoji completion' },
  },
] as const

export interface EmojiCompletionContext {
  query: string
  startColumn: number
  endColumn: number
  valid: boolean
  inInlineCode: boolean
  inFencedCode: boolean
  reason?: 'missing-colon' | 'empty-query' | 'boundary' | 'url' | 'inline-code' | 'fenced-code'
}

export interface MarkdownFenceState {
  character: '`' | '~'
  length: number
}

export interface MarkdownFenceMarker extends MarkdownFenceState {
  trailing: string
}

/**
 * Parses the small subset of CommonMark fence syntax needed by completion.
 * The returned trailing text is used to distinguish openers from closers.
 */
export function markdownFenceMarker(line: string): MarkdownFenceMarker | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  const trailing = match[2]
  // CommonMark does not allow backticks in a backtick fence's info string.
  if (match[1][0] === '`' && trailing.includes('`')) return null
  return {
    character: match[1][0] as '`' | '~',
    length: match[1].length,
    trailing,
  }
}

export function advanceMarkdownFenceState(
  line: string,
  state: MarkdownFenceState | null,
): MarkdownFenceState | null {
  const marker = markdownFenceMarker(line)
  if (!marker) return state
  if (!state) return { character: marker.character, length: marker.length }
  if (
    marker.character === state.character
    && marker.length >= state.length
    && marker.trailing.trim() === ''
  ) {
    return null
  }
  return state
}

export function isMarkdownFenceMarkerLine(line: string): boolean {
  return markdownFenceMarker(line) !== null
}

export class MarkdownFenceStateCache {
  private readonly statesAfterLine: Array<MarkdownFenceState | null | undefined> = []
  private computedThrough = 0

  reset(): void {
    this.statesAfterLine.length = 0
    this.computedThrough = 0
  }

  invalidateFrom(lineNumber: number): void {
    const firstInvalidLine = Math.max(1, Math.floor(lineNumber))
    if (firstInvalidLine > this.computedThrough) return
    this.computedThrough = firstInvalidLine - 1
    this.statesAfterLine.length = this.computedThrough + 1
  }

  stateBeforeLine(lineNumber: number, getLineContent: (line: number) => string): MarkdownFenceState | null {
    const targetLine = Math.max(1, Math.floor(lineNumber))
    const targetStateLine = targetLine - 1
    if (targetStateLine <= this.computedThrough) {
      return targetStateLine > 0 ? (this.statesAfterLine[targetStateLine] ?? null) : null
    }

    let state = this.computedThrough > 0
      ? (this.statesAfterLine[this.computedThrough] ?? null)
      : null

    for (let currentLine = this.computedThrough + 1; currentLine <= targetStateLine; currentLine += 1) {
      state = advanceMarkdownFenceState(getLineContent(currentLine), state)
      this.statesAfterLine[currentLine] = state
    }
    if (targetStateLine > this.computedThrough) this.computedThrough = targetStateLine
    return state
  }

  isInsideOrOnFenceLine(lineNumber: number, getLineContent: (line: number) => string): boolean {
    const stateBefore = this.stateBeforeLine(lineNumber, getLineContent)
    return stateBefore !== null || isMarkdownFenceMarkerLine(getLineContent(lineNumber))
  }
}

interface EmojiCompletionContextOptions {
  explicitInvocation?: boolean
  inFencedCode?: boolean
}

function isEscapedAt(value: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

export function isInsideMarkdownInlineCode(lineBeforeCursor: string): boolean {
  let delimiterLength = 0
  for (let index = 0; index < lineBeforeCursor.length;) {
    if (lineBeforeCursor[index] !== '`' || isEscapedAt(lineBeforeCursor, index)) {
      index += 1
      continue
    }
    let end = index + 1
    while (lineBeforeCursor[end] === '`') end += 1
    const length = end - index
    if (delimiterLength === 0) delimiterLength = length
    else if (delimiterLength === length) delimiterLength = 0
    index = end
  }
  return delimiterLength > 0
}

function tokenBeforeColon(value: string, colonIndex: number): string {
  let start = colonIndex
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1
  return value.slice(start, colonIndex)
}

export function getEmojiCompletionContext(
  lineBeforeCursor: string,
  cursorColumn = lineBeforeCursor.length + 1,
  options: EmojiCompletionContextOptions = {},
): EmojiCompletionContext {
  const before = lineBeforeCursor.slice(0, Math.max(0, cursorColumn - 1))
  const match = /:([A-Za-z0-9_+\-]*)$/.exec(before)
  const inInlineCode = isInsideMarkdownInlineCode(before)
  const inFencedCode = options.inFencedCode ?? false
  if (!match || match.index === undefined) {
    return {
      query: '',
      startColumn: cursorColumn,
      endColumn: cursorColumn,
      valid: false,
      inInlineCode,
      inFencedCode,
      reason: 'missing-colon',
    }
  }

  const colonIndex = match.index
  const query = match[1]
  const previous = before[colonIndex - 1] ?? ''
  const token = tokenBeforeColon(before, colonIndex).replace(/^[\[<]/, '')
  const url = /^(?:https?|ftp):\/\//i.test(token) || /:\/\/$/.test(before.slice(0, colonIndex + 1))
  const boundary = previous !== '' && /[A-Za-z0-9_+\-:]/.test(previous)
  let reason: EmojiCompletionContext['reason']
  if (inInlineCode) reason = 'inline-code'
  else if (inFencedCode) reason = 'fenced-code'
  else if (url) reason = 'url'
  else if (boundary) reason = 'boundary'
  else if (!query && !options.explicitInvocation) reason = 'empty-query'

  return {
    query,
    startColumn: colonIndex + 2,
    endColumn: cursorColumn,
    valid: reason === undefined,
    inInlineCode,
    inFencedCode,
    reason,
  }
}

export function filterMarkdownSlashCommands(query: string): readonly MarkdownSlashCommand[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return MARKDOWN_SLASH_COMMANDS
  return MARKDOWN_SLASH_COMMANDS.filter((command) =>
    `${command.label} ${command.detail}`.toLocaleLowerCase().includes(needle),
  )
}

export interface MarkdownHeadingTarget {
  title: string
  anchor: string
  level: number
}

export function markdownHeadingTargets(markdown: string): MarkdownHeadingTarget[] {
  const headings: MarkdownHeadingTarget[] = []
  const counts = new Map<string, number>()
  let fence: string | null = null
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0]
      else if (fence === fenceMatch[1][0]) fence = null
      continue
    }
    if (fence) continue
    const match = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const title = match[2].replace(/[*_`~\[\]]/g, '').trim()
    const base = title.toLowerCase().trim()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!base) continue
    const count = (counts.get(base) ?? 0) + 1
    counts.set(base, count)
    headings.push({ title, anchor: count === 1 ? base : `${base}-${count}`, level: match[1].length })
  }
  return headings
}

export interface WritingDiagnostic {
  line: number
  startColumn: number
  endColumn: number
  message: string
}

const COMMON_TYPOS: Record<string, string> = {
  teh: 'the', recieve: 'receive', seperate: 'separate', occured: 'occurred', definately: 'definitely',
  adress: 'address', goverment: 'government', untill: 'until', wich: 'which', becuase: 'because',
}

export function writingDiagnostics(markdown: string): WritingDiagnostic[] {
  const out: WritingDiagnostic[] = []
  let fenced = false
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return }
    if (fenced) return
    const visible = line.replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length))
    const trailing = /\s+$/.exec(line)
    if (trailing) out.push({ line: index + 1, startColumn: trailing.index + 1, endColumn: line.length + 1, message: 'Trailing whitespace' })
    for (const match of visible.matchAll(/\b(teh|recieve|seperate|occured|definately|adress|goverment|untill|wich|becuase)\b/gi)) {
      const word = match[0].toLowerCase()
      out.push({ line: index + 1, startColumn: (match.index ?? 0) + 1, endColumn: (match.index ?? 0) + match[0].length + 1, message: `Possible typo: ${match[0]} → ${COMMON_TYPOS[word]}` })
    }
    for (const match of visible.matchAll(/\s+([,.;!?])/g)) {
      out.push({ line: index + 1, startColumn: (match.index ?? 0) + 1, endColumn: (match.index ?? 0) + match[0].length, message: `Remove the space before “${match[1]}”` })
    }
    for (const match of visible.matchAll(/([一-龥])([A-Za-z0-9])|([A-Za-z0-9])([一-龥])/g)) {
      const boundary = (match.index ?? 0) + (match[1] ? 1 : match[3].length)
      out.push({ line: index + 1, startColumn: boundary + 1, endColumn: boundary + 1, message: 'Add a space between Chinese and Latin text' })
    }
    for (const match of visible.matchAll(/([一-龥])([,!?;:])/g)) {
      out.push({ line: index + 1, startColumn: (match.index ?? 0) + 2, endColumn: (match.index ?? 0) + 3, message: 'Use full-width punctuation in Chinese prose' })
    }
  })
  return out.slice(0, 200)
}

export interface MarkdownWrap {
  before: string
  after: string
  placeholder: string
}

export const MARKDOWN_WRAPS = {
  bold: { before: '**', after: '**', placeholder: 'bold text' },
  italic: { before: '*', after: '*', placeholder: 'italic text' },
  code: { before: '`', after: '`', placeholder: 'code' },
  link: { before: '[', after: '](https://)', placeholder: 'link text' },
} as const satisfies Record<string, MarkdownWrap>

export function toggleMarkdownWrap(text: string, wrap: MarkdownWrap): string {
  if (text.startsWith(wrap.before) && text.endsWith(wrap.after)) {
    return text.slice(wrap.before.length, text.length - wrap.after.length)
  }
  return `${wrap.before}${text || wrap.placeholder}${wrap.after}`
}

export interface MarkdownWrapEdit {
  text: string
  selectionOffset: number
  selectionLength: number
}

export function markdownWrapEdit(text: string, wrap: MarkdownWrap): MarkdownWrapEdit {
  const unwrapping = text.startsWith(wrap.before) && text.endsWith(wrap.after)
  if (unwrapping) {
    const unwrapped = text.slice(wrap.before.length, text.length - wrap.after.length)
    return { text: unwrapped, selectionOffset: 0, selectionLength: unwrapped.length }
  }
  const inner = text || wrap.placeholder
  return {
    text: `${wrap.before}${inner}${wrap.after}`,
    selectionOffset: wrap.before.length,
    selectionLength: inner.length,
  }
}

export function rankWikiTargets<T extends { path: string; title: string }>(
  targets: T[], query: string, recent: string[], currentPath: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  const score = (target: T) => {
    const title = target.title.toLocaleLowerCase()
    const path = target.path.toLocaleLowerCase()
    const recentIndex = recent.indexOf(target.path)
    let relevance = 0
    if (needle) {
      if (title === needle || path === needle) relevance = 100
      else if (title.startsWith(needle)) relevance = 80
      else if (path.startsWith(needle)) relevance = 70
      else if (title.includes(needle)) relevance = 60
      else if (path.includes(needle)) relevance = 50
      else {
        let cursor = 0
        for (const char of `${title} ${path}`) if (char === needle[cursor]) cursor += 1
        if (cursor !== needle.length) return null
        relevance = 20
      }
    }
    return relevance + (recentIndex < 0 ? 0 : Math.max(1, 15 - recentIndex))
  }
  return targets
    .filter((target) => target.path !== currentPath)
    .map((target) => ({ target, score: score(target) }))
    .filter((item): item is { target: T; score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || (a.target.title || a.target.path).localeCompare(b.target.title || b.target.path, 'zh-CN'))
    .map(({ target }) => target)
}

export function wikiLinkAtColumn(line: string, column: number): string | null {
  for (const match of line.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|[^\]\n]+)?\]\]/g)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (column >= start && column <= end) return match[1]
  }
  return null
}

export const MARKDOWN_CODE_LANGUAGES = [
  'typescript', 'javascript', 'python', 'json', 'yaml', 'bash',
  'html', 'css', 'sql', 'vue', 'markdown', 'text',
] as const

export type MonacoDecorationSpec = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  className?: string
  inlineClassName?: string
}

export function markdownDecorationSpecs(
  text: string,
  validWikiPaths?: ReadonlySet<string> | ((ref: string) => boolean),
  lineOffset = 0,
): MonacoDecorationSpec[] {
  const specs: MonacoDecorationSpec[] = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const lineNumber = lineOffset + index + 1
    const trimmed = line.trimStart()
    const leading = line.length - trimmed.length
    const heading = /^(#{1,6})\s/.exec(trimmed)
    const mark = heading?.[1] ?? (/^>/.test(trimmed) ? '>' : /^(?:[-+*]|\d+\.)/.exec(trimmed)?.[0])
    if (mark) specs.push({ startLineNumber: lineNumber, startColumn: leading + 1, endLineNumber: lineNumber, endColumn: leading + mark.length + 1, inlineClassName: 'monaco-md-marker' })
    const patterns: Array<[RegExp, string]> = [
      [/`[^`\n]+`/g, 'monaco-md-code'],
      [/\*\*[^*\n]+\*\*/g, 'monaco-md-strong'],
      [/\[[^\]\n]+\]\(https?:\/\/(?:[^()\s]|\([^()\s]*\))*\)/g, 'monaco-md-link'],
    ]
    for (const [pattern, className] of patterns) {
      for (const match of line.matchAll(pattern)) {
        specs.push({ startLineNumber: lineNumber, startColumn: (match.index ?? 0) + 1, endLineNumber: lineNumber, endColumn: (match.index ?? 0) + match[0].length + 1, inlineClassName: className })
      }
    }
    for (const match of line.matchAll(/\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|[^\]\n]+)?\]\]/g)) {
      const valid = typeof validWikiPaths === 'function'
        ? validWikiPaths(match[1])
        : validWikiPaths?.has(match[1])
      const className = validWikiPaths && !valid ? 'monaco-md-link-invalid' : 'monaco-md-link'
      specs.push({ startLineNumber: lineNumber, startColumn: (match.index ?? 0) + 1, endLineNumber: lineNumber, endColumn: (match.index ?? 0) + match[0].length + 1, inlineClassName: className })
    }
  })
  return specs
}
