import MarkdownIt from 'markdown-it'
import StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import deflist from 'markdown-it-deflist'
import footnote from 'markdown-it-footnote'
import {
  findClosingLine, findFencedCodeEnd, FLEX_GAPS, markdownContainersPlugin,
  MARKDOWN_BLOCK_SCAN_BUDGET, parseFencedCodeOpening, parseFlexOptions,
} from './markdownContainers'
import { markdownCodeGroupsPlugin, readCodeGroupMembers } from './markdownCodeGroups'
import { parseFenceMeta } from './fenceMeta'
import { parseMarkdownResourceDirective } from './markdownResources'
import { mathPlugin } from './math'

export const MARKDOWN_SYNTAX_LIMIT = 500_000
export const MAX_MARKDOWN_SYNTAX_DIAGNOSTICS = 30

export interface MarkdownSyntaxDiagnostic {
  line: number
  startColumn: number
  endColumn: number
  message: string
}

// Source only: no Reader, resource expansion, highlighting or diagram runtime.
const parser = new MarkdownIt({ html: true })
  .use(deflist)
  .use(footnote)
  .use(markdownContainersPlugin)
  .use(markdownCodeGroupsPlugin)
  .use(mathPlugin)

function flexIssue(options: string): { text: string; message: string } | null {
  if (parseFlexOptions(options)) return null
  const parts = options.trim().split(/[ \t]+/u)
  // Even a closed container may be mid-edit at its header.
  if (parts.some((part) => part.endsWith('='))) return null
  for (const part of parts) {
    if (parseFlexOptions(part)) continue
    return {
      text: part,
      message: part.startsWith('gap=')
        ? `Flex 的 ${part} 不受支持。允许值：${FLEX_GAPS.join('、')}。`
        : `Flex 参数 ${part} 无效，请检查参数名和取值。`,
    }
  }
  return { text: options, message: 'Flex 参数重复，请每个参数只指定一次。' }
}

function codeGroupIssue(state: StateBlock, start: number, close: number): { line: number; message: string } | null {
  if (readCodeGroupMembers(state, start + 1, close)) return null
  let line = start + 1
  let count = 0
  while (line < close) {
    line = state.skipEmptyLines(line)
    if (line >= close) break
    const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line])
    // Resources are expanded before production Code Group validation. Without
    // fetching them we cannot know the final member structure, so abstain.
    if (/^(?:<<<\s|<!--@include:)/u.test(text)) return null
    const opening = parseFencedCodeOpening(state, line)
    if (!opening) return { line, message: 'Code Group 只能包含带标签的代码围栏和空行。' }
    const end = findFencedCodeEnd(state, line, close, opening)
    if (end >= close) return null
    const meta = parseFenceMeta(text.slice(opening.markerLength))
    if (!meta.label?.trim()) return { line, message: 'Code Group 中的代码块需要非空的 [Label]。' }
    if (meta.malformed.length) return { line, message: 'Code Group 代码围栏的元数据无效，请检查标签、行范围和行号参数。' }
    count += 1
    line = end + 1
  }
  return count ? null : { line: start, message: 'Code Group 需要至少一个带 [Label] 的代码围栏。' }
}

function resourceIssue(text: string): string | null {
  // Require a path-like intent; ordinary prose such as "<<< hello" is not a
  // directive. Only a complete one-line Include comment is considered.
  const snippet = /^<<<[ \t]+(?:\.{1,2}\/|@\/)/u.test(text)
  const include = /^<!--@include:[ \t]*(?:\.{1,2}\/|@\/).*-->$/u.test(text)
    && text.indexOf('-->') === text.length - 3
  if ((!snippet && !include) || parseMarkdownResourceDirective(text)) return null
  // Missing closing metadata delimiters are usually unfinished typing.
  if ((text.includes('{') && !text.includes('}')) || (text.includes('[') && !text.includes(']'))) return null
  return snippet
    ? 'Snippet 指令格式无效，请检查行范围或元数据；从第 3 行到末尾可写为 {3,}。'
    : 'Include 指令格式无效，请检查选择范围；Include 不支持代码语言或标签参数。'
}

export function markdownSyntaxDiagnostics(source: string): MarkdownSyntaxDiagnostic[] {
  if (!source || source.length >= MARKDOWN_SYNTAX_LIMIT) return []
  const lines = source.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u)
  let offset = 0
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    if (close === -1) return []
    offset = close + 1
  }
  const body = lines.slice(offset)
  // Bound the production delimiter scanner's recursive lookahead as well as
  // Markdown-it's token nesting. Dense/pathological container source is left
  // unchecked, rather than introducing a separate delimiter grammar.
  if (body.filter((line) => /^ {0,3}:{3,}[ \t]+[a-z]/u.test(line)).length > 128) return []
  const text = body.join('\n')
  const diagnostics: MarkdownSyntaxDiagnostic[] = []
  try {
    const env = { [MARKDOWN_BLOCK_SCAN_BUDGET]: { remaining: 50_000 } }
    const tokens = parser.parse(text, env)
    const state = new StateBlock(text, parser, env, [])
    const candidates = new Map<number, number>()
    const scopes: Array<{ type: string; end: number }> = []
    for (const token of tokens) {
      if (token.nesting === -1) { scopes.pop(); continue }
      const parent = scopes.at(-1)
      const excluded = scopes.some(({ type }) => /^(?:blockquote|bullet_list|ordered_list|table|dd|footnote)_open$/u.test(type))
      if (!excluded && token.map) {
        // Token ownership matters: invalid extensions fall back to paragraphs.
        // Ignore entire ambiguous inline/HTML paragraphs instead of guessing
        // at multiline code spans or inline HTML source coordinates.
        const paragraph = token.type === 'inline' && parent?.type === 'paragraph_open'
          && !token.children?.some((child) => child.type === 'code_inline' || child.type === 'html_inline')
        const includeComment = token.type === 'html_block' && token.map[1] === token.map[0] + 1
          && /^ {0,3}<!--@include:/u.test(token.content)
        if (paragraph || includeComment) {
          const end = Math.min(...scopes.map((scope) => scope.end), body.length)
          for (let line = token.map[0]; line < token.map[1]; line += 1) {
            if (/^ {0,3}(?::{3,}[ \t]+(?:flex|code-group)\b|<<<[ \t]|<!--@include:)/u.test(body[line]!)) candidates.set(line, end)
          }
        }
      }
      if (token.nesting === 1) scopes.push({
        type: token.type,
        end: token.map && token.type.startsWith('nuvyn_') ? token.map[1] - 1 : parent?.end ?? body.length,
      })
    }
    const add = (line: number, message: string, fragment?: string) => {
      const raw = body[line]!
      const start = fragment ? raw.indexOf(fragment) : raw.search(/\S/u)
      const bom = line + offset === 0 && source.startsWith('\uFEFF') ? 1 : 0
      diagnostics.push({
        line: line + offset + 1,
        startColumn: Math.max(0, start) + 1 + bom,
        endColumn: (fragment ? Math.max(0, start) + fragment.length : raw.trimEnd().length) + 1 + bom,
        message,
      })
    }
    let skipThrough = -1
    for (const [line, end] of candidates) {
      if (diagnostics.length >= MAX_MARKDOWN_SYNTAX_DIAGNOSTICS) break
      if (line <= skipThrough || !/^ {0,3}\S/u.test(body[line]!)) continue
      const raw = body[line]!.trim()
      const opening = /^(:{3,})[ \t]+(flex|code-group)(?:[ \t]+(.*))?$/u.exec(raw)
      if (opening) {
        const kind = opening[2]
        const options = opening[3] ?? ''
        if (kind === 'code-group' && options) continue
        const close = findClosingLine(state, line + 1, end, opening[1]!.length, kind === 'flex' ? 'nested' : 'shorter')
        if (close === -1) continue
        if (kind === 'flex') {
          const issue = flexIssue(options)
          if (issue) add(line, issue.message, issue.text)
        } else {
          const issue = codeGroupIssue(state, line, close)
          if (issue) { add(issue.line, issue.message); skipThrough = close }
        }
      } else {
        const issue = resourceIssue(raw)
        if (issue) add(line, issue)
      }
    }
  } catch {
    // Diagnostics are optional and never turn parser fallback into an error.
    return []
  }
  return diagnostics
}
