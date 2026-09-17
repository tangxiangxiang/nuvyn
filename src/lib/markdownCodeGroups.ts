import type MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import {
  findClosingLine,
  findFencedCodeEnd,
  parseFencedCodeOpening,
} from './markdownContainers'
import { parseFenceMeta, type FenceMeta } from './fenceMeta'

const CODE_GROUP_STATE = Symbol('nuvynCodeGroupState')
const CODE_GROUP_META_KEY = 'nuvynCodeGroup'

interface CodeGroupState {
  nextGroupIndex: number
}

interface CodeGroupOpening {
  markerLength: number
}

interface CodeGroupMember {
  meta: FenceMeta
}

interface CodeGroupMeta {
  groupIndex: number
  labels: string[]
}

interface CodeGroupFenceMeta {
  groupIndex: number
  panelIndex: number
  label: string
}

interface CodeGroupToken {
  type: string
  info?: string
  meta?: Record<string, unknown>
}

type RendererRule = (
  tokens: CodeGroupToken[],
  index: number,
  options: unknown,
  env: unknown,
  self: unknown,
) => string

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getLineStart(state: StateBlock, line: number): number {
  return state.bMarks[line] + state.tShift[line]
}

function getLineEnd(state: StateBlock, line: number): number {
  return state.eMarks[line]
}

function parseCodeGroupOpening(state: StateBlock, line: number): CodeGroupOpening | null {
  if (state.sCount[line] - state.blkIndent >= 4) return null

  const lineStart = getLineStart(state, line)
  const lineEnd = getLineEnd(state, line)
  if (lineStart >= lineEnd || state.src.charCodeAt(lineStart) !== 0x3a /* : */) return null

  let cursor = lineStart
  while (cursor < lineEnd && state.src.charCodeAt(cursor) === 0x3a) cursor += 1
  const markerLength = cursor - lineStart
  if (markerLength < 3) return null

  const rawRest = state.src.slice(cursor, lineEnd)
  if (!/^[ \t]/u.test(rawRest)) return null
  if (rawRest.trim() !== 'code-group') return null

  return { markerLength }
}

function readCodeGroupMembers(
  state: StateBlock,
  bodyStart: number,
  bodyEnd: number,
): CodeGroupMember[] | null {
  const members: CodeGroupMember[] = []
  let line = bodyStart

  while (line < bodyEnd) {
    line = state.skipEmptyLines(line)
    if (line >= bodyEnd) break

    const opening = parseFencedCodeOpening(state, line)
    if (!opening) return null

    const closeLine = findFencedCodeEnd(state, line, bodyEnd, opening)
    if (closeLine >= bodyEnd) return null

    const info = state.src.slice(
      getLineStart(state, line) + opening.markerLength,
      getLineEnd(state, line),
    )
    const meta = parseFenceMeta(info)
    if (!meta.label || meta.label.trim() === '' || meta.malformed.length > 0) return null

    members.push({ meta })
    line = closeLine + 1
  }

  return members.length > 0 ? members : null
}

function getCodeGroupState(state: StateBlock): CodeGroupState {
  const env = state.env as Record<PropertyKey, unknown>
  const existing = env[CODE_GROUP_STATE]
  if (existing && typeof existing === 'object' && 'nextGroupIndex' in existing) {
    return existing as CodeGroupState
  }

  const created: CodeGroupState = { nextGroupIndex: 0 }
  env[CODE_GROUP_STATE] = created
  return created
}

function rollbackBlockState(
  state: StateBlock,
  snapshot: {
    tokensLength: number
    line: number
    level: number
    parentType: StateBlock['parentType']
    tight: boolean
    ddIndent: number
    listIndent: number
  },
): void {
  state.tokens.length = snapshot.tokensLength
  state.line = snapshot.line
  state.level = snapshot.level
  state.parentType = snapshot.parentType
  state.tight = snapshot.tight
  state.ddIndent = snapshot.ddIndent
  state.listIndent = snapshot.listIndent
}

function nuvynCodeGroupRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const opening = parseCodeGroupOpening(state, startLine)
  if (!opening) return false

  const closeLine = findClosingLine(state, startLine + 1, endLine, opening.markerLength)
  if (closeLine === -1) return false

  // Validate source structure before touching the shared token stream. This
  // keeps malformed groups as ordinary Markdown and avoids needing to undo
  // resolver/reference side effects from a speculative nested parse.
  const members = readCodeGroupMembers(state, startLine + 1, closeLine)
  if (!members) return false
  if (silent) return true

  const snapshot = {
    tokensLength: state.tokens.length,
    line: state.line,
    level: state.level,
    parentType: state.parentType,
    tight: state.tight,
    ddIndent: state.ddIndent,
    listIndent: state.listIndent,
  }
  const codeGroupState = getCodeGroupState(state)
  const groupIndex = codeGroupState.nextGroupIndex
  const labels = members.map(({ meta }) => meta.label as string)
  const groupOpen = state.push('nuvyn_code_group_open', 'div', 1)
  groupOpen.map = [startLine, closeLine + 1]
  groupOpen.meta = {
    [CODE_GROUP_META_KEY]: { groupIndex, labels },
  }

  try {
    const memberTokenStart = state.tokens.length
    state.md.block.tokenize(state, startLine + 1, closeLine)
    const memberTokens = state.tokens.slice(memberTokenStart) as unknown as CodeGroupToken[]
    if (
      memberTokens.length !== members.length
      || memberTokens.some((token) => token.type !== 'fence')
    ) {
      rollbackBlockState(state, snapshot)
      return false
    }

    memberTokens.forEach((token, panelIndex) => {
      token.meta = {
        ...(token.meta ?? {}),
        [CODE_GROUP_META_KEY]: {
          groupIndex,
          panelIndex,
          label: labels[panelIndex],
        } satisfies CodeGroupFenceMeta,
      }
    })

    const groupClose = state.push('nuvyn_code_group_close', 'div', -1)
    groupClose.map = [closeLine, closeLine + 1]
    groupClose.meta = { [CODE_GROUP_META_KEY]: { groupIndex } }
    codeGroupState.nextGroupIndex += 1
    state.line = closeLine + 1
    return true
  } catch {
    rollbackBlockState(state, snapshot)
    return false
  }
}

function getSafeScope(env: unknown): string {
  const candidate = typeof env === 'object' && env !== null
    ? (env as { codeGroupRenderScope?: unknown }).codeGroupRenderScope
    : undefined
  const scope = typeof candidate === 'string' ? candidate : 'local'
  const safe = scope.replace(/[^a-zA-Z0-9_-]/gu, '-')
  return safe || 'local'
}

function getIds(scope: string, groupIndex: number, panelIndex: number) {
  const prefix = `nuvyn-cg-${scope}-g${groupIndex}`
  return {
    tabId: `${prefix}-tab-${panelIndex}`,
    panelId: `${prefix}-panel-${panelIndex}`,
  }
}

function getGroupMeta(token: CodeGroupToken): CodeGroupMeta | null {
  const meta = token.meta?.[CODE_GROUP_META_KEY]
  if (!meta || typeof meta !== 'object') return null
  const value = meta as Partial<CodeGroupMeta>
  if (!Number.isInteger(value.groupIndex) || !Array.isArray(value.labels)) return null
  return {
    groupIndex: value.groupIndex as number,
    labels: value.labels.filter((label): label is string => typeof label === 'string'),
  }
}

function getFenceMeta(token: CodeGroupToken): CodeGroupFenceMeta | null {
  const meta = token.meta?.[CODE_GROUP_META_KEY]
  if (!meta || typeof meta !== 'object') return null
  const value = meta as Partial<CodeGroupFenceMeta>
  if (
    !Number.isInteger(value.groupIndex)
    || !Number.isInteger(value.panelIndex)
    || typeof value.label !== 'string'
  ) return null
  return {
    groupIndex: value.groupIndex as number,
    panelIndex: value.panelIndex as number,
    label: value.label,
  }
}

export function markdownCodeGroupsPlugin(md: MarkdownIt): void {
  md.block.ruler.before(
    'nuvyn-container',
    'nuvyn-code-group',
    nuvynCodeGroupRule,
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] },
  )

  md.renderer.rules.nuvyn_code_group_open = (tokens, index, _options, env) => {
    const meta = getGroupMeta(tokens[index] as unknown as CodeGroupToken)
    if (!meta || meta.labels.length === 0) return ''
    const scope = getSafeScope(env)
    const tabs = meta.labels.map((label, panelIndex) => {
      const { tabId, panelId } = getIds(scope, meta.groupIndex, panelIndex)
      const active = panelIndex === 0
      return `<button class="nuvyn-code-group-tab${active ? ' is-active' : ''}" type="button" role="tab" id="${tabId}" aria-controls="${panelId}" aria-selected="${active}" tabindex="${active ? '0' : '-1'}">${escapeHtml(label)}</button>`
    }).join('')
    return `<div class="nuvyn-code-group" role="group" aria-label="Code examples"><div class="nuvyn-code-group-tabs" role="tablist">${tabs}</div><div class="nuvyn-code-group-panels">`
  }

  md.renderer.rules.nuvyn_code_group_close = () => '</div></div>\n'

  const defaultFenceRenderer = md.renderer.rules.fence as unknown as RendererRule
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index] as unknown as CodeGroupToken
    const meta = getFenceMeta(token)
    if (!meta) return defaultFenceRenderer(tokens, index, options, env, self)

    const scope = getSafeScope(env)
    const { tabId, panelId } = getIds(scope, meta.groupIndex, meta.panelIndex)
    const active = meta.panelIndex === 0
    const fenceHtml = defaultFenceRenderer(tokens, index, options, env, self)
    return `<div id="${panelId}" class="nuvyn-code-group-panel${active ? ' is-active' : ''}" role="tabpanel" aria-labelledby="${tabId}" aria-hidden="${!active}">${fenceHtml}</div>`
  }
}

export const __testing__ = {
  parseCodeGroupOpening,
  readCodeGroupMembers,
  getIds,
}
