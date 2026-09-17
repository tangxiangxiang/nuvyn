import MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'

const MATH_CHAR = 0x24 // $

function isWhitespace(value: string): boolean {
  return /^\s$/.test(value)
}

function isEscaped(source: string, position: number): boolean {
  let slashCount = 0
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    slashCount += 1
  }
  return slashCount % 2 === 1
}

function renderPlaceholder(kind: 'inline' | 'block', content: string): string {
  return `<${kind === 'inline' ? 'span' : 'div'} class="math-mount math-${kind}" data-content="${encodeURIComponent(content)}"></${kind === 'inline' ? 'span' : 'div'}>`
}

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos
  const source = state.src

  if (source.charCodeAt(start) !== MATH_CHAR) return false
  // `$$` is the block delimiter. Keeping it out of this rule also prevents
  // a double delimiter from being split into an accidental inline formula.
  if (source.charCodeAt(start + 1) === MATH_CHAR) return false
  if (isEscaped(source, start)) return false

  const first = start + 1
  if (first >= state.posMax || source[first] === '\n' || isWhitespace(source[first])) return false

  for (let end = first; end < state.posMax; end += 1) {
    const character = source[end]
    if (character === '\n') return false
    if (source.charCodeAt(end) !== MATH_CHAR || isEscaped(source, end)) continue
    // Do not use either side of a `$$` pair as an inline delimiter.
    if (source.charCodeAt(end - 1) === MATH_CHAR || source.charCodeAt(end + 1) === MATH_CHAR) continue

    const content = source.slice(first, end)
    // The first unescaped `$` is the closing delimiter. If its contents
    // have edge whitespace, leave the whole sequence as ordinary text
    // instead of searching farther and swallowing unrelated prose.
    if (!content || isWhitespace(content[0]) || isWhitespace(content.at(-1) ?? '')) return false

    state.pos = end + 1
    if (silent) return true
    const token = state.push('math_inline', 'span', 0)
    token.content = content
    token.markup = '$'
    return true
  }

  return false
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]

  // Match fence-like indentation rules: deeply indented content remains a
  // code block, never a math block.
  if (state.sCount[startLine] - state.blkIndent >= 4) return false

  const line = state.src.slice(start, max)
  const singleLine = /^\$\$(.*?)\$\$\s*$/.exec(line)
  if (singleLine && singleLine[1].trim()) {
    if (silent) return true
    const token = state.push('math_block', 'div', 0)
    token.content = singleLine[1]
    token.markup = '$$'
    token.map = [startLine, startLine + 1]
    token.block = true
    state.line = startLine + 1
    return true
  }

  if (line.trim() !== '$$') return false

  let nextLine = startLine + 1
  for (; nextLine < endLine; nextLine += 1) {
    const nextStart = state.bMarks[nextLine] + state.tShift[nextLine]
    const nextMax = state.eMarks[nextLine]
    if (state.src.slice(nextStart, nextMax).trim() === '$$') break
  }
  if (nextLine >= endLine) return false
  if (silent) return true

  state.line = nextLine + 1
  const token = state.push('math_block', 'div', 0)
  token.content = state.getLines(startLine + 1, nextLine, state.sCount[startLine], true)
  token.markup = '$$'
  token.map = [startLine, state.line]
  token.block = true
  return true
}

export function mathPlugin(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'nuvyn_math_block', mathBlockRule)
  md.inline.ruler.before('escape', 'nuvyn_math_inline', mathInlineRule)
  md.renderer.rules.math_inline = (tokens, index) => renderPlaceholder('inline', tokens[index].content)
  md.renderer.rules.math_block = (tokens, index) => `${renderPlaceholder('block', tokens[index].content)}\n`
}

