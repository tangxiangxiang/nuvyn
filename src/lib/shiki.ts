import {
  bundledLanguages,
  bundledLanguagesBase,
  bundledLanguagesInfo,
  createHighlighter,
  type ShikiTransformer,
  type Highlighter,
} from 'shiki'
import {
  transformerMetaHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerStyleToClass,
} from '@shikijs/transformers'
import {
  getFenceMetaHighlightRaw,
  parseFenceMeta,
  type FenceMeta,
} from './fenceMeta'

const SHIKI_THEMES = ['github-light', 'github-dark'] as const
const SHIKI_CLASS_PREFIX = 'nuvyn-shiki-'
const SHIKI_GENERATED_STYLES_ID = 'nuvyn-shiki-generated-styles'

type ShikiHighlighter = Highlighter
type ShikiHighlighterFactory = typeof createHighlighter
type ShikiHighlighterOptions = Parameters<ShikiHighlighterFactory>[0]
type ShikiLanguageLoader = (typeof bundledLanguagesInfo)[number]['import']

const SHIKI_RUNTIME_OPTIONS: ShikiHighlighterOptions = {
  themes: [...SHIKI_THEMES],
  langs: [],
}

const styleTransformer = transformerStyleToClass({
  classPrefix: SHIKI_CLASS_PREFIX,
})

export const MAX_FOCUS_RANGE = 1_000

type FenceMetaInput = string | FenceMeta

function toFenceMeta(input: FenceMetaInput): FenceMeta {
  return typeof input === 'string' ? parseFenceMeta(input) : input
}

function isBoundedPositiveInteger(value: string, maximum: number): boolean {
  if (!/^\d+$/u.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum
}

/**
 * Shiki 4.4.3's notation transformers also accept a few range/case variants
 * that are outside the approved Nuvyn contract. This gate runs on the source
 * channel before those transformers. Gated markers are restored after the
 * notation code hooks, so they remain ordinary source rather than becoming a
 * silently shipped future feature.
 */
function shouldGateSourceNotation(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed === '++' || trimmed === '--') return false

  const match = /^([A-Za-z]+)(?::(.*))?$/u.exec(trimmed)
  if (!match) return false

  const [, name, suffix] = match
  const lowerName = name?.toLowerCase() ?? ''
  if (lowerName === 'highlight' || lowerName === 'hl') {
    // Nuvyn approves only the exact single-line `highlight` spelling.
    return !(name === 'highlight' && suffix === undefined)
  }

  if (lowerName === 'focus') {
    if (name !== 'focus') return true
    return suffix !== undefined && !isBoundedPositiveInteger(suffix, MAX_FOCUS_RANGE)
  }

  if (lowerName === 'warning' || lowerName === 'error' || lowerName === 'info') {
    return name !== lowerName || suffix !== undefined
  }

  return false
}

const DEFERRED_NOTATION_PREFIX = 'nuvyn-deferred-notation-'
const DEFERRED_NOTATION_MAX_CANDIDATES = 1_024

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Pick an invocation-local marker that cannot be mistaken for author source.
 * The bounded candidate loop handles normal inputs; the fallback contains a
 * NUL run longer than the source itself, which is therefore collision-free.
 */
function createDeferredNotationSentinel(source: string): string {
  for (let index = 0; index < DEFERRED_NOTATION_MAX_CANDIDATES; index += 1) {
    const candidate = `${DEFERRED_NOTATION_PREFIX}${index}-`
    if (!source.includes(candidate)) return candidate
  }

  return `${DEFERRED_NOTATION_PREFIX}fallback-${'\u0000'.repeat(source.length + 1)}`
}

function createSourceNotationGate(sentinel: string): ShikiTransformer {
  return {
    name: 'nuvyn:source-notation-scope-gate',
    preprocess(source) {
      return source.replace(/\[!code ([^\]]+)\]/gu, (full, body: string) => (
        shouldGateSourceNotation(body)
          ? `[!code ${sentinel} ${body}]`
          : full
      ))
    },
  }
}

function restoreGatedSourceNotation(
  node: {
    type: string
    value?: string
    children?: Array<{
      type: string
      value?: string
      children?: Array<unknown>
    }>
  },
  deferredNotationPattern: RegExp,
): void {
  if (node.type === 'text' && typeof node.value === 'string') {
    node.value = node.value.replace(deferredNotationPattern, '[!code $1]')
    return
  }
  for (const child of node.children ?? []) {
    if (typeof child === 'object' && child !== null) {
      restoreGatedSourceNotation(
        child as Parameters<typeof restoreGatedSourceNotation>[0],
        deferredNotationPattern,
      )
    }
  }
}

function createSourceNotationRestore(sentinel: string): ShikiTransformer {
  const deferredNotationPattern = new RegExp(
    `\\[!code ${escapeRegExp(sentinel)} ([^\\]]+)\\]`,
    'gu',
  )

  return {
    name: 'nuvyn:source-notation-scope-restore',
    // This code hook is deliberately after the official notation transformers
    // and before the singleton style transformer in the array below.
    code(node) {
      restoreGatedSourceNotation(node, deferredNotationPattern)
      return node
    },
  }
}

const LINE_NUMBER_TRANSFORMER_NAME = 'nuvyn:line-numbers'

function hasHastClass(node: { properties: Record<string, unknown> }, className: string): boolean {
  const value = node.properties.class
  const classes = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(/\s+/u)
      : []
  return classes.includes(className)
}

function formatVisibleLineNumber(start: number, line: number): string {
  const offset = line - 1
  const value = start + offset
  if (Number.isSafeInteger(value)) return String(value)
  return (BigInt(start) + BigInt(offset)).toString()
}

function createLineNumberTransformer(meta: FenceMeta): ShikiTransformer {
  const start = meta.lineNumbers === 'start'
    && Number.isSafeInteger(meta.lineNumberStart)
    && (meta.lineNumberStart ?? 0) >= 1
    ? meta.lineNumberStart as number
    : 1

  return {
    name: LINE_NUMBER_TRANSFORMER_NAME,
    pre(node) {
      this.addClassToHast(node, 'nuvyn-line-numbers')
      return node
    },
    code(node) {
      const lineNodes = node.children.filter((child) => (
        child.type === 'element'
        && child.tagName === 'span'
        && hasHastClass(child, 'line')
      ))
      let line = 0
      const children = []

      for (const child of node.children) {
        if (child.type !== 'element' || child.tagName !== 'span') {
          // Shiki's classic structure uses text newlines between `.line`
          // nodes. Move each separator into the preceding content wrapper so
          // grid rows do not create anonymous blank lines while preserving
          // copy/textContent fidelity.
          if (child.type === 'text' && child.value === '\n') continue
          children.push(child)
          continue
        }

        if (!hasHastClass(child, 'line')) {
          children.push(child)
          continue
        }

        line += 1
        const contentChildren = [...child.children]
        // A trailing newline is represented by a final empty Shiki line. The
        // separator belongs to the preceding content wrapper, not a phantom
        // extra DOM line, so the fallback and Shiki paths share this contract.
        if (line < lineNodes.length) {
          contentChildren.push({ type: 'text', value: '\n' })
        }

        child.children = [
          {
            type: 'element',
            tagName: 'span',
            properties: {
              class: 'nuvyn-line-number',
              'aria-hidden': 'true',
            },
            children: [{
              type: 'text',
              value: formatVisibleLineNumber(start, line),
            }],
          },
          {
            type: 'element',
            tagName: 'span',
            properties: { class: 'nuvyn-line-content' },
            children: contentChildren,
          },
        ]
        children.push(child)
      }

      node.children = children
      return node
    },
  }
}

function createAnnotationTransformers(source: string, meta: FenceMeta): ShikiTransformer[] {
  const sentinel = createDeferredNotationSentinel(source)
  const transformers: ShikiTransformer[] = [
    transformerMetaHighlight(),
    createSourceNotationGate(sentinel),
    transformerNotationHighlight(),
    transformerNotationFocus(),
    transformerNotationDiff(),
    transformerNotationErrorLevel(),
    createSourceNotationRestore(sentinel),
  ]

  if (meta.lineNumbers !== 'off') {
    transformers.push(createLineNumberTransformer(meta))
  }

  // H8's one trusted token-style registry must remain the final transformer.
  transformers.push(styleTransformer)

  return transformers
}

let highlighterFactory: ShikiHighlighterFactory = createHighlighter
let highlighterPromise: Promise<ShikiHighlighter> | null = null
let activeHighlighter: ShikiHighlighter | null = null

const canonicalLanguageByLookupId = new Map<string, string>()
for (const language of bundledLanguagesInfo) {
  const canonicalId = language.id.toLowerCase()
  canonicalLanguageByLookupId.set(canonicalId, canonicalId)
  for (const alias of language.aliases ?? []) {
    canonicalLanguageByLookupId.set(alias.toLowerCase(), canonicalId)
  }
}

const loadedLanguageSet = new Set<string>()
const inFlightLanguageLoads = new Map<string, Promise<PreparedShikiLanguage>>()
const unsupportedLanguageSet = new Set<string>()
let languageStateGeneration = 0

export type ShikiLanguageResolution =
  | {
      kind: 'empty'
      identifier: string
    }
  | {
      kind: 'special'
      identifier: string
      specialFence: 'markmap' | 'mermaid'
    }
  | {
      kind: 'unsupported'
      identifier: string
      normalizedId: string
    }
  | {
      kind: 'language'
      identifier: string
      normalizedId: string
      canonicalId: string
      loader: ShikiLanguageLoader
    }

export interface PreparedShikiLanguage {
  resolution: ShikiLanguageResolution
  status: 'skipped' | 'loaded' | 'already-loaded' | 'unavailable'
  error?: unknown
}

/**
 * Extract the canonical language portion from a fence info string.
 * MarkdownIt owns fence recognition; this helper only delegates to FenceMeta.
 */
export function extractFenceLanguageIdentifier(info: string): string {
  return parseFenceMeta(info).language
}

/**
 * Resolve a user-facing fence identifier through Shiki's official bundled
 * language metadata. Nuvyn special-fence semantics are checked before the
 * registry lookup and intentionally remain case-sensitive.
 */
export function resolveShikiLanguage(input: FenceMetaInput): ShikiLanguageResolution {
  const meta = toFenceMeta(input)
  const rawIdentifier = meta.language
  if (!rawIdentifier) {
    return { kind: 'empty', identifier: '' }
  }

  if (meta.specialFence) {
    return {
      kind: 'special',
      identifier: rawIdentifier,
      specialFence: meta.specialFence,
    }
  }

  const normalizedId = rawIdentifier.toLowerCase()
  if (unsupportedLanguageSet.has(normalizedId)) {
    return {
      kind: 'unsupported',
      identifier: rawIdentifier,
      normalizedId,
    }
  }

  const canonicalId = canonicalLanguageByLookupId.get(normalizedId)
  const registryLoader = bundledLanguages[normalizedId as keyof typeof bundledLanguages]
  const canonicalLoader = canonicalId
    ? bundledLanguagesBase[canonicalId as keyof typeof bundledLanguagesBase]
    : undefined

  if (!canonicalId || typeof registryLoader !== 'function' || typeof canonicalLoader !== 'function') {
    unsupportedLanguageSet.add(normalizedId)
    return {
      kind: 'unsupported',
      identifier: rawIdentifier,
      normalizedId,
    }
  }

  return {
    kind: 'language',
    identifier: rawIdentifier,
    normalizedId,
    canonicalId,
    loader: canonicalLoader,
  }
}

function syncLoadedLanguageState(runtime: ShikiHighlighter): void {
  for (const loadedLanguage of runtime.getLoadedLanguages()) {
    const canonicalId = canonicalLanguageByLookupId.get(loadedLanguage.toLowerCase())
    if (canonicalId) loadedLanguageSet.add(canonicalId)
  }
}

function skippedPreparation(resolution: ShikiLanguageResolution): PreparedShikiLanguage {
  return { resolution, status: 'skipped' }
}

async function ensureResolvedShikiLanguage(
  resolution: Extract<ShikiLanguageResolution, { kind: 'language' }>,
): Promise<PreparedShikiLanguage> {
  const { canonicalId, loader } = resolution

  if (loadedLanguageSet.has(canonicalId)) {
    return { resolution, status: 'already-loaded' }
  }

  const existingLoad = inFlightLanguageLoads.get(canonicalId)
  if (existingLoad) return existingLoad

  const generation = languageStateGeneration
  const loadPromise = (async (): Promise<PreparedShikiLanguage> => {
    // Runtime initialization is a system-level failure. Let getShikiRuntime()
    // reject so its existing singleton retry handler can clear the rejected
    // promise and the caller can observe the async render failure.
    const runtime = await getShikiRuntime()
    if (generation !== languageStateGeneration) {
      return { resolution, status: 'unavailable' }
    }

    // Shiki is the source of truth for languages loaded outside this
    // helper. The set is only a canonicalized fast path for later calls.
    syncLoadedLanguageState(runtime)
    if (loadedLanguageSet.has(canonicalId)) {
      return { resolution, status: 'already-loaded' }
    }

    try {
      await runtime.loadLanguage(loader)
    } catch (error) {
      // A known grammar can fail transiently. Do not poison the singleton or
      // put the identifier in the deterministic unsupported set; the next
      // render may retry this loader.
      return { resolution, status: 'unavailable', error }
    }

    if (generation !== languageStateGeneration) {
      return { resolution, status: 'unavailable' }
    }

    syncLoadedLanguageState(runtime)
    loadedLanguageSet.add(canonicalId)
    return { resolution, status: 'loaded' }
  })()

  inFlightLanguageLoads.set(canonicalId, loadPromise)
  void loadPromise.then(
    () => {
      if (inFlightLanguageLoads.get(canonicalId) === loadPromise) {
        inFlightLanguageLoads.delete(canonicalId)
      }
    },
    () => {
      if (inFlightLanguageLoads.get(canonicalId) === loadPromise) {
        inFlightLanguageLoads.delete(canonicalId)
      }
    },
  )
  return loadPromise
}

/**
 * Prepare the unique supported languages requested by one or more Markdown
 * fences. Unknown and Nuvyn-special identifiers are intentionally skipped;
 * known loader failures are reported as unavailable but do not reject the
 * caller or poison the shared highlighter. Runtime initialization failures
 * intentionally reject the caller and remain retryable through the singleton.
 */
export async function prepareShikiLanguages(
  identifiers: readonly FenceMetaInput[],
): Promise<PreparedShikiLanguage[]> {
  const uniqueResolutions: ShikiLanguageResolution[] = []
  const seen = new Set<string>()

  for (const identifier of identifiers) {
    const resolution = resolveShikiLanguage(identifier)
    const key = resolution.kind === 'language'
      ? `language:${resolution.canonicalId}`
      : `${resolution.kind}:${'normalizedId' in resolution ? resolution.normalizedId : resolution.identifier}`
    if (seen.has(key)) continue
    seen.add(key)
    uniqueResolutions.push(resolution)
  }

  return Promise.all(uniqueResolutions.map((resolution) => {
    if (resolution.kind !== 'language') {
      return Promise.resolve(skippedPreparation(resolution))
    }
    return ensureResolvedShikiLanguage(resolution)
  }))
}

export async function ensureShikiLanguage(identifier: FenceMetaInput): Promise<PreparedShikiLanguage> {
  const [result] = await prepareShikiLanguages([identifier])
  return result ?? {
    resolution: { kind: 'empty', identifier: '' },
    status: 'skipped',
  }
}

/**
 * Render one already-prepared normal Markdown fence synchronously.
 *
 * MarkdownIt's highlight callback cannot await a Promise. H2 therefore owns
 * all runtime and grammar preparation before md.render(), while H3/H4 use
 * only this ready-runtime path inside the callback. A missing runtime or
 * grammar is a per-fence fallback condition; it must never initialize Shiki
 * here.
 */
export function highlightShikiFence(source: string, input: FenceMetaInput): string | null {
  const meta = toFenceMeta(input)
  const resolution = resolveShikiLanguage(meta)
  if (resolution.kind !== 'language' || !activeHighlighter || !loadedLanguageSet.has(resolution.canonicalId)) {
    return null
  }

  try {
    const highlightRaw = getFenceMetaHighlightRaw(meta)
    return activeHighlighter.codeToHtml(source, {
      lang: resolution.canonicalId,
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      defaultColor: false,
      ...(highlightRaw ? { meta: { __raw: highlightRaw } } : {}),
      transformers: createAnnotationTransformers(source, meta),
    })
  } catch {
    // A single fence rendering failure must not poison the shared runtime or
    // reject the whole Markdown document.
    return null
  }
}

/**
 * Return the one long-lived Shiki runtime promise.
 *
 * H1 established the themes and H2 now prepares only the canonical languages
 * requested by the current document. H3/H4 consume the ready runtime
 * synchronously from MarkdownIt's highlight callback.
 */
export function getShikiRuntime(): Promise<ShikiHighlighter> {
  if (highlighterPromise) {
    return highlighterPromise
  }

  let pending: Promise<ShikiHighlighter>
  try {
    pending = highlighterFactory({
      themes: [...SHIKI_RUNTIME_OPTIONS.themes],
      langs: [...SHIKI_RUNTIME_OPTIONS.langs],
    })
  } catch (error) {
    // A synchronous factory failure must not be cached either.
    return Promise.reject(error)
  }

  highlighterPromise = pending

  void pending.then(
    (highlighter) => {
      if (highlighterPromise === pending) {
        activeHighlighter = highlighter
      } else {
        // A test reset may have happened while initialization was pending.
        highlighter.dispose()
      }
    },
    () => {
      // Do not permanently cache a rejected initialization promise.
      if (highlighterPromise === pending) {
        highlighterPromise = null
        activeHighlighter = null
      }
    },
  )

  return pending
}

/** Return the one class-based transformer used by production Shiki output. */
export function getShikiStyleTransformer() {
  return styleTransformer
}

/** Return the transformer's current trusted CSS snapshot. */
export function getGeneratedShikiCss(): string {
  return styleTransformer.getCSS()
}

/**
 * Synchronize the complete trusted transformer snapshot to one stable head
 * stylesheet. This is deliberately separate from article sanitization: the
 * CSS is produced only by Shiki's bundled themes and never enters Markdown
 * HTML. DOM availability/write failures are best-effort and must not turn a
 * safe rendered article into an application-wide render failure.
 */
export function syncGeneratedShikiStylesheet(): void {
  try {
    const css = getGeneratedShikiCss()
    if (!css || typeof document === 'undefined' || !document.head) return

    let owner = document.head.querySelector<HTMLStyleElement>(
      `style#${SHIKI_GENERATED_STYLES_ID}`,
    )
    if (!owner) {
      owner = document.createElement('style')
      owner.id = SHIKI_GENERATED_STYLES_ID
      document.head.appendChild(owner)
    }

    if (owner.textContent !== css) {
      owner.textContent = css
    }
  } catch {
    // A missing/hostile DOM must not change Markdown's safe HTML result. The
    // next complete render can retry synchronization when head is available.
  }
}

/**
 * Narrow H1/H2 test seam for exercising single-flight, retry and reset
 * semantics without changing normal application behavior or exposing
 * mutable runtime state.
 */
function resetForTesting(): void {
  languageStateGeneration += 1
  loadedLanguageSet.clear()
  inFlightLanguageLoads.clear()
  unsupportedLanguageSet.clear()
  activeHighlighter?.dispose()
  activeHighlighter = null
  highlighterPromise = null
  highlighterFactory = createHighlighter
  styleTransformer.clearRegistry()

  if (typeof document !== 'undefined' && document.head) {
    const managedOwner = document.head.querySelector<HTMLStyleElement>(
      `style#${SHIKI_GENERATED_STYLES_ID}`,
    )
    managedOwner?.remove()
  }
}

export const __testing__ = {
  reset: resetForTesting,

  setHighlighterFactory(factory: ShikiHighlighterFactory): void {
    resetForTesting()
    highlighterFactory = factory
  },
}
