// markdown-it plugin that recognizes inter-note links in two forms:
//
//   1. Wiki-style: [[target]], [[target|alias]], [[target#anchor]],
//      [[target#anchor|alias]]
//   2. Standard markdown: [text](path.md) where `path` resolves to a
//      vault note (we don't try to resolve here — that's the
//      resolver's job, called via `opts.resolve`)
//
// Both are emitted as `<a class="wiki-link" data-target="…" data-missing="…">`.
// Broken links (target doesn't resolve) get the `wiki-link-missing` class.
//
// The plugin is added to the `inline` ruler for `[[…]]` and to the
// `core` ruler (after `inline`) for the `link_open` upgrade. Putting
// the upgrade in `core` (rather than `inline`) avoids re-parsing the
// link: markdown-it's `link` rule has already produced the `link_open`
// token with the right `href`, we just append our attrs.
//
// Code-block handling: markdown-it's inline rules run only on the
// *non-code* portions of a document. Fenced / indented code blocks
// are leaf blocks that never reach the inline parser; inline `…​`
// spans are consumed by the `backticks` rule before our `wiki_link`
// rule fires. So we don't need an explicit "am I inside code?" check.

import MarkdownIt from 'markdown-it'
import { findMarkdownInlineSourceOwnership } from './markdownInlineSource'

export interface WikiLinkResolutionContext {
  /** Canonical source identity for the Markdown line being resolved. */
  sourcePath?: string
}

export type Resolver = (ref: string, anchor?: string, context?: WikiLinkResolutionContext) => {
  /** Resolved vault path (no .md, no #anchor) or null if the target
   *  doesn't exist. */
  target: string | null
  /** Optional display text (used as the link body for wiki links). */
  alias?: string
}

export interface WikiLinkOptions {
  /** Called for every `[[…]]` ref and every internal `[t](path.md)`
   *  link. Receives the ref as-written and the optional anchor.
   *  Returns the resolved target (or null for broken links) and an
   *  optional display alias.
   *
   *  This is a fallback for callers that use the plugin directly. The
   *  application passes a render-scoped resolver through `env.wikiResolver`
   *  instead, so separate renders never share resolver state. */
  resolve?: Resolver
}

export interface WikiLinkEnv {
  wikiResolver?: Resolver
  /** Opaque render-scoped provenance for generated external Markdown links. */
  externalLinkProvenance?: string
  /** Opaque render-scoped namespace for generated code-group IDs. */
  codeGroupRenderScope?: string
  /** Source identity for each flattened Markdown line in resource-aware renders. */
  resourceSourcePathByLine?: Array<string | undefined>
  /** Defer [[wiki]] resolution until inline tokens have source context. */
  deferWikiResolution?: boolean
}

/** Temporary marker used only between MarkdownIt rendering and sanitization. */
export const EXTERNAL_LINK_PROVENANCE_ATTR = 'data-nuvyn-external-provenance'

const identityResolver: Resolver = (ref) => ({ target: ref })

function resolverFromEnv(env: unknown, opts: WikiLinkOptions): Resolver {
  if (typeof env === 'object' && env !== null) {
    const candidate = (env as { wikiResolver?: unknown }).wikiResolver
    if (typeof candidate === 'function') return candidate as Resolver
  }
  return opts.resolve ?? identityResolver
}

// Minimal structural types for the bits of markdown-it's state /
// token API we touch. Using `any` for the rest keeps the plugin
// decoupled from markdown-it's complex (and hard-to-import-cleanly)
// type namespace. The runtime contract is what matters; the
// structural fields below are enough for vue-tsc to verify usage
// at the call sites we care about.
type MdToken = {
  type: string
  attrs: [string, string][] | null
  content: string
  attrGet: (name: string) => string | null | undefined
  attrSet: (name: string, value: string) => void
  attrJoin: (name: string, value: string) => void
  map?: [number, number] | null
  children?: MdToken[] | null
  markup?: string
  meta?: Record<string, unknown>
}
type MdRenderer = { renderToken(tokens: MdToken[], idx: number, options: unknown): string }

interface WikiLinkInlineState {
  // The actual state is MarkdownIt's StateInline. We use a
  // structural type so the rule can read the per-render env without
  // coupling the plugin to markdown-it's full type namespace.
  pos: number
  posMax: number
  src: string
  push: (type: string, tag: string, nesting: number) => MdToken
  env: Record<string, unknown>
}

const DEFERRED_WIKI_META = 'nuvynDeferredWiki'
const SOURCE_PATH_META = 'nuvynSourcePath'

type DeferredWiki = {
  ref: string
  anchor?: string
  alias?: string
}

function getTokenSourcePath(token: MdToken): string | undefined {
  const value = token.meta?.[SOURCE_PATH_META]
  return typeof value === 'string' && value ? value : undefined
}

function getDeferredWiki(token: MdToken): DeferredWiki | null {
  const value = token.meta?.[DEFERRED_WIKI_META]
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<DeferredWiki>
  if (typeof candidate.ref !== 'string' || !candidate.ref) return null
  return {
    ref: candidate.ref,
    ...(typeof candidate.anchor === 'string' ? { anchor: candidate.anchor } : {}),
    ...(typeof candidate.alias === 'string' ? { alias: candidate.alias } : {}),
  }
}

function wikiLinkRule(
  state: WikiLinkInlineState,
  silent: boolean,
  opts: WikiLinkOptions,
): boolean {
  const start = state.pos
  const src = state.src
  // Quick prefix check.
  if (src.charCodeAt(start) !== 0x5B /* [ */) return false
  if (src.charCodeAt(start + 1) !== 0x5B) return false
  const end = src.indexOf(']]', start + 2)
  if (end === -1) return false
  // No newlines inside the wiki link. indexOf returns -1 if no
  // newline; -1 < end is true, which would falsely reject valid
  // matches. Guard with the `!== -1` check.
  const nlIdx = src.indexOf('\n', start + 2)
  if (nlIdx !== -1 && nlIdx < end) return false

  const inner = src.slice(start + 2, end)
  if (!inner) return false
  // Parse out ref / #anchor / |alias.
  let ref = inner
  let anchor: string | undefined
  let alias: string | undefined
  const hashIdx = inner.indexOf('#')
  if (hashIdx !== -1) {
    ref = inner.slice(0, hashIdx)
    const afterHash = inner.slice(hashIdx + 1)
    const pipeIdx = afterHash.indexOf('|')
    anchor = (pipeIdx === -1 ? afterHash : afterHash.slice(0, pipeIdx)).trim() || undefined
    if (pipeIdx !== -1) alias = afterHash.slice(pipeIdx + 1).trim() || undefined
  } else {
    const pipeIdx = inner.indexOf('|')
    if (pipeIdx !== -1) {
      ref = inner.slice(0, pipeIdx)
      alias = inner.slice(pipeIdx + 1).trim() || undefined
    }
  }
  ref = ref.trim()
  if (!ref) return false

  if (silent) return true  // validation only

  const defer = state.env.deferWikiResolution === true
  const display = alias ?? ref
  if (defer) {
    const open = state.push('link_open', 'a', 1)
    open.attrs = [
      ['class', 'wiki-link wiki-link-missing'],
      ['href', '#'],
      ['data-target', ref],
      ['data-missing', 'true'],
    ]
    if (anchor) open.attrs.push(['data-anchor', anchor])
    open.meta = {
      ...(open.meta ?? {}),
      [DEFERRED_WIKI_META]: { ref, ...(anchor ? { anchor } : {}), ...(alias ? { alias } : {}) },
    }
    const text = state.push('text', '', 0)
    text.content = display
    state.push('link_close', 'a', -1)
    state.pos = end + 2
    return true
  }

  const resolved = resolverFromEnv(state.env, opts)(ref, anchor)
  // data-target is the as-written ref for missing links; for
  // resolved links, it's the resolved path (so the click handler
  // can navigate to the right note).
  const target = resolved?.target ?? ref
  const missing = resolved?.target ? 'false' : 'true'
  const href = resolved?.target
    ? '/vault/' + encodeURI(resolved.target) + (anchor ? '#' + encodeURIComponent(anchor) : '')
    : '#'

  const open = state.push('link_open', 'a', 1)
  open.attrs = [
    ['class', 'wiki-link' + (missing === 'true' ? ' wiki-link-missing' : '')],
    ['href', href],
    ['data-target', target],
    ['data-missing', missing],
  ]
  if (anchor) open.attrs.push(['data-anchor', anchor])

  const text = state.push('text', '', 0)
  text.content = display

  state.push('link_close', 'a', -1)

  state.pos = end + 2
  return true
}

// Vault-internal markdown link: href starts with a kebab segment, no
// scheme, not absolute. Matches foo, foo.md, foo/bar, foo/bar.md,
// foo.md#a, foo#a.
const INTERNAL_HREF_RE = /^(?:(?:\.\/|\.\.\/)+|@\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*(?:\.md)?(?:#[^\s)]*)?$/iu

/** Classify a single `link_open` token in-place. Used by the renderer
 *  rule below — we can't iterate the token stream in a `core` rule
 *  because `link_open` tokens are nested inside `inline` tokens, not
 *  at the top level of `state.tokens`. The renderer fires for every
 *  `link_open` as it's emitted, which is exactly what we want. */
function classifyLinkOpenToken(
  tokens: MdToken[],
  idx: number,
  resolve: Resolver,
): void {
  const t = tokens[idx]
  if (t.type !== 'link_open') return
  const deferred = getDeferredWiki(t)
  if (deferred) {
    const sourcePath = getTokenSourcePath(t)
    const resolved = sourcePath
      ? resolve(deferred.ref, deferred.anchor, { sourcePath })
      : resolve(deferred.ref, deferred.anchor)
    const missing = resolved?.target ? 'false' : 'true'
    const target = resolved?.target ?? deferred.ref
    const href = resolved?.target
      ? '/vault/' + encodeURI(resolved.target) + (deferred.anchor ? '#' + encodeURIComponent(deferred.anchor) : '')
      : '#'
    t.attrSet('class', `wiki-link${missing === 'true' ? ' wiki-link-missing' : ''}`)
    t.attrSet('href', href)
    t.attrSet('data-target', target)
    t.attrSet('data-missing', missing)
    if (deferred.anchor) t.attrSet('data-anchor', deferred.anchor)
    return
  }
  if (t.attrGet('class')?.includes('wiki-link')) return  // already classified by inline rule
  const hrefAttr = t.attrGet('href')
  if (!hrefAttr) return
  if (!INTERNAL_HREF_RE.test(hrefAttr)) return
  // Split path and anchor.
  const hashIdx = hrefAttr.indexOf('#')
  const pathPart = hashIdx === -1 ? hrefAttr : hrefAttr.slice(0, hashIdx)
  const hash = hashIdx === -1 ? '' : hrefAttr.slice(hashIdx + 1)
  const cleanPath = pathPart.replace(/\.md$/i, '')
  if (!cleanPath) return
  const sourcePath = getTokenSourcePath(t)
  if (/^(?:\.\/|\.\.\/|@\/)/u.test(pathPart) && !sourcePath) return
  const resolved = sourcePath
    ? resolve(cleanPath, hash || undefined, { sourcePath })
    : resolve(cleanPath, hash || undefined)
  const missing = resolved?.target ? 'false' : 'true'
  const target = resolved?.target ?? cleanPath
  const newHref = resolved?.target
    ? '/vault/' + encodeURI(resolved.target) + (hash ? '#' + hash : '')
    : hrefAttr  // leave the original href so a click still goes somewhere
  const existing = t.attrGet('class') ?? ''
  t.attrSet('class', (existing + ' wiki-link' + (missing === 'true' ? ' wiki-link-missing' : '')).trim())
  t.attrSet('href', newHref)
  t.attrSet('data-target', target)
  t.attrSet('data-missing', missing)
  if (hash) t.attrSet('data-anchor', hash)
}

function applyGeneratedExternalLinkPolicy(
  tokens: MdToken[],
  idx: number,
  provenance: string | undefined,
): void {
  const token = tokens[idx]
  if (token.type !== 'link_open') return

  // WikiLinks and Nuvyn .md links are already classified by the owner above.
  // They are vault navigation even when their final href is absolute-looking.
  if (token.attrGet('class')?.includes('wiki-link')) return

  const href = token.attrGet('href')
  if (!href || !/^https?:/i.test(href)) return

  // This policy is intentionally applied at the generated Markdown/linkify
  // link_open boundary. Raw semantic HTML anchors are html_inline tokens and
  // never pass through this function.
  token.attrJoin('class', 'nuvyn-external-link')
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer')
  if (provenance) token.attrSet(EXTERNAL_LINK_PROVENANCE_ATTR, provenance)
}

/** Plugin signature: `(md, opts) => void`. markdown-it's `md.use`
 *  calls plugins with `(md, options?)` — so this is `PluginWithOptions`
 *  in markdown-it's terms. Currying `(opts) => (md) => void` would NOT
 *  work because `md.use` would call our outer function with `(md, opts)`
 *  and never invoke the returned closure. */
export function wikiLinkPlugin(
  md: MarkdownIt,
  opts: WikiLinkOptions = {},
): void {
  md.inline.ruler.before('text', 'wiki_link', (state, silent) => {
    const inlineState = state as unknown as WikiLinkInlineState
    return wikiLinkRule(inlineState, silent, opts)
  })
  md.core.ruler.after('inline', 'nuvyn-wiki-source-context', (state) => {
    const env = state.env as WikiLinkEnv
    const sourcePaths = env.resourceSourcePathByLine
    if (!sourcePaths) return
    for (const token of state.tokens as unknown as MdToken[]) {
      if (token.type !== 'inline' || !token.children || !token.map) continue
      let currentLine = token.map[0]
      const ownership = findMarkdownInlineSourceOwnership(
        token.content,
        token.children,
        {
          ...state.md.helpers,
          normalizeLink: state.md.normalizeLink.bind(state.md),
        },
      )
      const codeSpanRanges = ownership.topLevelCodeRanges
      let codeSpanIndex = 0
      for (const [childIndex, child] of token.children.entries()) {
        const sourcePath = sourcePaths[currentLine]
        if (sourcePath) {
          child.meta = { ...(child.meta ?? {}), [SOURCE_PATH_META]: sourcePath }
        }
        // MarkdownIt keeps soft/hard line breaks as inline children. The
        // break belongs to the line before it; the next child starts on the
        // following flattened source line.
        if (child.type === 'softbreak' || child.type === 'hardbreak') currentLine += 1
        if (child.type === 'image') {
          const imageRange = ownership.childSourceRanges[childIndex]
          if (imageRange) {
            currentLine += token.content.slice(imageRange.start, imageRange.end).split('\n').length - 1
          } else {
            // An unproven image surface must not let later links inherit a
            // guessed source path after the ownership walk failed closed.
            currentLine = sourcePaths.length
          }
        }
        if (child.type === 'code_inline') {
          const span = codeSpanRanges[codeSpanIndex]
          if (span) {
            currentLine += token.content.slice(span.start, span.end).split('\n').length - 1
          }
          codeSpanIndex += 1
        }
      }
    }
  })
  // Renderer rule for `link_open`: classifies standard `[t](path.md)`
  // links into wiki-links. Runs once per `link_open` token as the
  // renderer walks the flattened stream.
  md.renderer.rules.link_open = function (
    tokens: MdToken[],
    idx: number,
    options: unknown,
    env: unknown,
    self: MdRenderer,
  ): string {
    classifyLinkOpenToken(tokens, idx, resolverFromEnv(env, opts))
    const renderEnv = env as WikiLinkEnv
    applyGeneratedExternalLinkPolicy(tokens, idx, renderEnv?.externalLinkProvenance)
    return self.renderToken(tokens, idx, options)
  }
}

// Exposed for tests: regexes used by the plugin.
export const __testing__ = {
  INTERNAL_HREF_RE,
  DEFERRED_WIKI_META,
  SOURCE_PATH_META,
}
