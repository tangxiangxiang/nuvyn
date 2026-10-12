<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { acquireMarkdownModel } from './monacoModels'
import { bindMarkdownProviderContext, unbindMarkdownProviderContext } from './monacoMarkdownProviders'
import { resolveWikiTarget } from '../../../shared/linkResolve'
import { getPost } from '../../lib/api'
import { parseDoc } from '../../lib/frontmatter'
import { findMarkdownHeadingSourceLine } from '../../composables/vault/useMarkdownRender'
import { useEditorPreferences } from '../../composables/vault/useEditorPreferences'
import { useI18n } from '../../composables/useI18n'
import { useToast } from '../../composables/useToast'
import { isPotentialNoteImage, markdownImageReference, NoteImageError, uploadNoteImage } from '../../lib/noteImages'
import {
  indentMarkdownLine,
  getEmojiCompletionContext,
  filterMarkdownSlashCommands,
  MARKDOWN_CODE_LANGUAGES,
  MARKDOWN_WRAPS,
  markdownContinuation,
  markdownDecorationSpecs,
  markdownLinkFromPaste,
  markdownHeadingTargets,
  markdownWrapEdit,
  MarkdownFenceStateCache,
  rankWikiTargets,
  wikiLinkAtColumn,
  writingDiagnostics,
} from './monacoMarkdown'
import { MAX_EMOJI_SUGGESTIONS, rankEmojiSuggestions } from '../../lib/emoji'
import {
  NUVYN_BROWSER_STORAGE_KEYS,
  nuvynMonacoTheme,
  readStorageKey,
  writeStorageKey,
} from '../../technicalNamespace'

export interface EditorLinkTarget {
  path: string
  title: string
}

const props = defineProps<{
  modelValue: string
  path: string
  focusWidth?: boolean
  zenModeAvailable?: boolean
  zenMode?: boolean
  allowImageInsertion?: boolean
  linkTargets?: EditorLinkTarget[]
}>()
const preferences = useEditorPreferences()
const { t } = useI18n()
const toast = useToast()
const isLargeDocument = computed(() => props.modelValue.length >= 500_000)
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'open-link': [target: { path: string; anchor?: string }]
  'create-link': [ref: string]
  'toggle-view-mode': []
  'toggle-focus-width': []
  'toggle-zen-mode': []
  'exit-zen-mode': []
}>()

const host = ref<HTMLDivElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let model: monaco.editor.ITextModel | null = null
let suppressChange = false
let themeObserver: MutationObserver | null = null
let decorationIds: string[] = []
let pasteHandler: ((event: ClipboardEvent) => void) | null = null
let imageInput: HTMLInputElement | null = null
let mounted = false
let imageEditorGeneration = 0
let imageBatchSequence = 0
let nextImageBatchToInsert = 1
let filePickerIntent: ImageInsertionIntent | null = null
type ImageInsertionIntent = {
  sequence: number
  model: monaco.editor.ITextModel
  editor: monaco.editor.IStandaloneCodeEditor
  path: string
  generation: number
  decorationId: string
  replacesSelection: boolean
  selectedText: string
}
type ImageUploadBatch = {
  intent: ImageInsertionIntent
  completed: boolean
  references: string[]
  errors: unknown[]
  statusToastId: number
}
const imageUploadBatches = new Map<number, ImageUploadBatch>()
let rememberLinkCommand: string | null = null
let composing = false
let zenToggleAction: { dispose: () => void } | null = null
let focusWidthChordPending = false
let focusWidthChordTimer: ReturnType<typeof setTimeout> | null = null
let focusWidthChordListener: { dispose: () => void } | null = null
let zenEscapeAction: { dispose: () => void } | null = null
let zenOverlayContext: monaco.editor.IContextKey<boolean> | null = null
let zenOverlayObserver: MutationObserver | null = null
const observedZenOverlays = new Set<Element>()
const zenOverlaySelector = '[role="dialog"], [aria-modal="true"], [role="menu"], .n-modal, .n-dialog, .n-popover, .context-view, .monaco-hover, .suggest-widget, .find-widget'
let revealAnchorSequence = 0
let decorationTimer: ReturnType<typeof setTimeout> | null = null
let scrollbarHideTimer: ReturnType<typeof setTimeout> | null = null
let scrollbarPointerId: number | null = null
const VIEW_STATE_KEY = NUVYN_BROWSER_STORAGE_KEYS.editorMonacoViewState
const RECENT_LINKS_KEY = NUVYN_BROWSER_STORAGE_KEYS.editorRecentWikiLinks
const MONACO_SCROLLBAR_SELECTOR = '.monaco-scrollable-element > .scrollbar'
const SCROLLBAR_HIDE_DELAY_MS = 900
let linkPaths: string[] = []
let targetsByPath = new Map<string, EditorLinkTarget>()
const resolvedLinkCache = new Map<string, string | null>()
const headingCache = new Map<string, Promise<ReturnType<typeof markdownHeadingTargets>>>()
const fenceStateCache = new MarkdownFenceStateCache()

function recentLinks(): string[] {
  try {
    const parsed: unknown = JSON.parse(readStorageKey(RECENT_LINKS_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  }
  catch { return [] }
}

function recordRecentLink(path: string) {
  const links = recentLinks().filter((item) => item !== path)
  writeStorageKey(RECENT_LINKS_KEY, JSON.stringify([path, ...links].slice(0, 20)))
}

function createImageInsertionIntent(rangeOverride?: monaco.Range): ImageInsertionIntent | null {
  if (!mounted || !editor || !model || model.isDisposed()) return null
  const selection = rangeOverride ?? editor.getSelection()
  const position = editor.getPosition()
  const range = selection ?? (position
    ? new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
    : null)
  if (!range) return null

  const replacesSelection = selection !== null && !selection.isEmpty()
  const decorationId = model.deltaDecorations([], [{
    range,
    options: {
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }])[0]
  if (!decorationId) return null
  return {
    sequence: 0,
    model,
    editor,
    path: props.path,
    generation: imageEditorGeneration,
    decorationId,
    replacesSelection,
    selectedText: replacesSelection ? model.getValueInRange(range) : '',
  }
}

function releaseImageInsertionIntent(intent: ImageInsertionIntent): void {
  if (intent.model.isDisposed()) return
  try { intent.model.deltaDecorations([intent.decorationId], []) } catch { /* Model may have been released. */ }
}

function imageUploadErrorMessage(error: unknown): string {
  if (!(error instanceof NoteImageError)) return t('editor.image_upload_failed')
  const messages: Record<NoteImageError['code'], string> = {
    unsupported: t('editor.image_unsupported'),
    'too-large': t('editor.image_too_large'),
    invalid: t('editor.image_invalid'),
    busy: t('editor.image_upload_busy'),
    network: t('editor.image_network_error'),
    unauthorized: t('auth.session_expired'),
    storage: t('editor.image_storage_error'),
    unknown: t('editor.image_upload_failed'),
  }
  return messages[error.code]
}

async function copyImageMarkdown(markdown: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(markdown)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = markdown
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) {
      toast.error(t('vault.copy_failed'))
      return
    }
  }
  toast.success(t('editor.image_markdown_copied'))
}

function offerImageMarkdownFallback(references: string[]): void {
  const markdown = references.join('\n')
  toast.action(
    t('editor.image_saved_not_inserted'),
    t('editor.copy_markdown'),
    () => copyImageMarkdown(markdown),
    12_000,
  )
}

function canInsertImageAt(intent: ImageInsertionIntent): monaco.Range | null {
  if (!mounted
    || intent.generation !== imageEditorGeneration
    || intent.editor !== editor
    || intent.model !== model
    || intent.path !== props.path
    || intent.model.isDisposed()
    || intent.editor.getModel() !== intent.model) return null
  const range = intent.model.getDecorationRange(intent.decorationId)
  if (!range) return null
  if (intent.replacesSelection && intent.model.getValueInRange(range) !== intent.selectedText) return null
  return range
}

function flushImageUploadBatches(): void {
  while (true) {
    const batch = imageUploadBatches.get(nextImageBatchToInsert)
    if (!batch || !batch.completed) return
    imageUploadBatches.delete(nextImageBatchToInsert)
    nextImageBatchToInsert += 1

    if (batch.references.length > 0) {
      const range = canInsertImageAt(batch.intent)
      let inserted = false
      if (range) {
        try {
          batch.intent.editor.pushUndoStop()
          inserted = batch.intent.editor.executeEdits('nuvyn.insert-note-image', [{
            range,
            text: batch.references.join('\n'),
          }]) !== false
          batch.intent.editor.pushUndoStop()
        } catch {
          inserted = false
        }
      }
      if (!inserted) offerImageMarkdownFallback(batch.references)
    }

    releaseImageInsertionIntent(batch.intent)
    if (batch.errors.length > 0) {
      const message = imageUploadErrorMessage(batch.errors[0])
      toast.error(batch.errors.length > 1
        ? t('editor.image_upload_some_failed', { count: batch.errors.length })
        : message)
    }
  }
}

function uploadImagesAtIntent(files: File[], capturedIntent: ImageInsertionIntent): void {
  const images = files.filter(isPotentialNoteImage)
  if (images.length === 0) {
    releaseImageInsertionIntent(capturedIntent)
    toast.error(t('editor.image_unsupported'))
    return
  }
  const intent = { ...capturedIntent, sequence: ++imageBatchSequence }
  const statusToastId = toast.info(t('editor.image_uploading', { count: images.length }), 0)
  const batch: ImageUploadBatch = { intent, completed: false, references: [], errors: [], statusToastId }
  imageUploadBatches.set(intent.sequence, batch)

  void Promise.all(images.map(async (file) => {
    try {
      const uploaded = await uploadNoteImage(file)
      return markdownImageReference(file.name, uploaded.markdownUrl)
    } catch (error) {
      batch.errors.push(error)
      return null
    }
  })).then((references) => {
    batch.references = references.filter((reference): reference is string => reference !== null)
    batch.completed = true
    toast.dismiss(batch.statusToastId)
    flushImageUploadBatches()
  })
}

function chooseImage(): void {
  if (props.allowImageInsertion === false) return
  const intent = createImageInsertionIntent()
  if (!intent || !imageInput) return
  filePickerIntent = intent
  imageInput.value = ''
  imageInput.click()
}

function onImageInputChange(): void {
  const intent = filePickerIntent
  filePickerIntent = null
  const files = Array.from(imageInput?.files ?? [])
  if (intent && files.length > 0) uploadImagesAtIntent(files, intent)
  else if (intent) releaseImageInsertionIntent(intent)
}

function onImageInputCancel(): void {
  if (filePickerIntent) releaseImageInsertionIntent(filePickerIntent)
  filePickerIntent = null
}

function filesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const files = Array.from(transfer.files)
  if (files.length > 0) return files.filter(isPotentialNoteImage)
  return Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && isPotentialNoteImage(file))
}

function onImageDragEnter(event: DragEvent): void {
  if (props.allowImageInsertion === false) return
  if (filesFromTransfer(event.dataTransfer).length === 0) return
  event.preventDefault()
  host.value?.classList.add('is-image-drag-over')
}

function onImageDragOver(event: DragEvent): void {
  if (props.allowImageInsertion === false) return
  if (filesFromTransfer(event.dataTransfer).length === 0) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  host.value?.classList.add('is-image-drag-over')
}

function onImageDragLeave(event: DragEvent): void {
  if (event.relatedTarget instanceof Node && host.value?.contains(event.relatedTarget)) return
  host.value?.classList.remove('is-image-drag-over')
}

function onImageDrop(event: DragEvent): void {
  if (props.allowImageInsertion === false) return
  const files = filesFromTransfer(event.dataTransfer)
  if (files.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  host.value?.classList.remove('is-image-drag-over')
  const target = editor?.getTargetAtClientPoint(event.clientX, event.clientY)
  const position = target?.position
  const range = position
    ? new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column)
    : undefined
  const intent = createImageInsertionIntent(range)
  if (intent) uploadImagesAtIntent(files, intent)
}

function clipboardHasMeaningfulHtml(html: string): boolean {
  if (!html.trim()) return false
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return Boolean(parsed.body.textContent?.trim() || parsed.body.querySelector('a[href], video, audio, table, canvas, svg'))
}

function clipboardImageFiles(clipboard: DataTransfer): File[] {
  const files = Array.from(clipboard.files)
  if (files.length > 0) return files.filter(isPotentialNoteImage)
  return Array.from(clipboard.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null && isPotentialNoteImage(file))
}

const monacoGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment?: { getWorker: () => Worker }
}
monacoGlobal.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

function activeTheme(): 'nuvyn-light' | 'nuvyn-dark' {
  return nuvynMonacoTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark') as 'nuvyn-light' | 'nuvyn-dark'
}

function clearScrollbarHideTimer() {
  if (scrollbarHideTimer !== null) clearTimeout(scrollbarHideTimer)
  scrollbarHideTimer = null
}

function revealEditorScrollbars() {
  if (!host.value) return
  clearScrollbarHideTimer()
  host.value.classList.add('is-scrollbar-visible')
  if (scrollbarPointerId !== null) return
  scrollbarHideTimer = setTimeout(() => {
    host.value?.classList.remove('is-scrollbar-visible')
    scrollbarHideTimer = null
  }, SCROLLBAR_HIDE_DELAY_MS)
}

function finishScrollbarDrag(event?: PointerEvent) {
  if (scrollbarPointerId === null || (event && event.pointerId !== scrollbarPointerId)) return
  scrollbarPointerId = null
  window.removeEventListener('pointerup', onScrollbarPointerEnd)
  window.removeEventListener('pointercancel', onScrollbarPointerEnd)
  window.removeEventListener('blur', onScrollbarWindowBlur)
  document.removeEventListener('visibilitychange', onScrollbarVisibilityChange)
  revealEditorScrollbars()
}

function onScrollbarPointerEnd(event: PointerEvent) {
  finishScrollbarDrag(event)
}

function onScrollbarWindowBlur() {
  finishScrollbarDrag()
}

function onScrollbarVisibilityChange() {
  if (document.hidden) finishScrollbarDrag()
}

function onHostPointerDown(event: PointerEvent) {
  const target = event.target
  if (!(target instanceof Element) || !target.closest(MONACO_SCROLLBAR_SELECTOR)) return
  clearScrollbarHideTimer()
  scrollbarPointerId = event.pointerId
  host.value?.classList.add('is-scrollbar-visible')
  window.addEventListener('pointerup', onScrollbarPointerEnd)
  window.addEventListener('pointercancel', onScrollbarPointerEnd)
  window.addEventListener('blur', onScrollbarWindowBlur)
  document.addEventListener('visibilitychange', onScrollbarVisibilityChange)
}

monaco.editor.defineTheme('nuvyn-light', {
  base: 'vs', inherit: true,
  rules: [
    { token: 'markup.heading.markdown', foreground: '0969DA', fontStyle: 'bold' },
    { token: 'string.link.markdown', foreground: '0969DA' },
    { token: 'variable', foreground: '953800' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f5f7f9',
    'editorGutter.background': '#ffffff',
  },
})
monaco.editor.defineTheme('nuvyn-dark', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'markup.heading.markdown', foreground: '61AFEF', fontStyle: 'bold' },
    { token: 'string.link.markdown', foreground: '61AFEF' },
  ],
  colors: {
    'editor.background': '#1e1e1e',
    'editor.lineHighlightBackground': '#252526',
    'editorGutter.background': '#1e1e1e',
  },
})

function readViewState(path = props.path): monaco.editor.ICodeEditorViewState | null {
  try {
    const all = JSON.parse(readStorageKey(VIEW_STATE_KEY) ?? '{}') as Record<string, monaco.editor.ICodeEditorViewState>
    return all[path] ?? null
  } catch { return null }
}

function saveViewState(path = props.path) {
  if (!editor) return
  try {
    const all = JSON.parse(readStorageKey(VIEW_STATE_KEY) ?? '{}') as Record<string, monaco.editor.ICodeEditorViewState>
    delete all[path]
    all[path] = editor.saveViewState()!
    writeStorageKey(VIEW_STATE_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-100))))
  } catch { /* best effort */ }
}

function revealText(text: string): boolean {
  const needle = text.trim()
  if (!editor || !model || !needle) return false

  const raw = model.getValue()
  const { content } = parseDoc(raw)
  const bodyStartOffset = raw.length - content.length
  const bodyStart = model.getPositionAt(bodyStartOffset)
  const modelEnd = model.getFullModelRange()
  const bodyRange = new monaco.Range(
    bodyStart.lineNumber,
    bodyStart.column,
    modelEnd.endLineNumber,
    modelEnd.endColumn,
  )
  const match = model.findMatches(needle, bodyRange, false, false, null, false, 1)[0]
  if (!match) return false

  const { range } = match
  const selection = new monaco.Selection(
    range.startLineNumber,
    range.startColumn,
    range.endLineNumber,
    range.endColumn,
  )
  editor.setSelection(selection)
  editor.revealRangeInCenterIfOutsideViewport(range)
  return true
}

function rebuildLinkIndex() {
  linkPaths = (props.linkTargets ?? []).map((target) => target.path)
  targetsByPath = new Map((props.linkTargets ?? []).map((target) => [target.path, target]))
  resolvedLinkCache.clear()
}

function hasBlockingOverlay(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(zenOverlaySelector)).some((element) => {
    if (element.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

function updateZenOverlayContext(): void {
  if (!zenOverlayContext || !zenOverlayObserver) return
  document.querySelectorAll<HTMLElement>(zenOverlaySelector).forEach((element) => {
    if (observedZenOverlays.has(element)) return
    observedZenOverlays.add(element)
    zenOverlayObserver?.observe(element, {
      attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'style'],
      childList: true,
    })
  })
  zenOverlayContext.set(hasBlockingOverlay())
}

function resetFocusWidthChord(): void {
  focusWidthChordPending = false
  if (focusWidthChordTimer) clearTimeout(focusWidthChordTimer)
  focusWidthChordTimer = null
}

// Keep the second stroke unmodified and scoped to Monaco so Ctrl+K, Ctrl+F
// remains available to Monaco's built-in Format Selection command.
function onFocusWidthChordKeydown(event: monaco.IKeyboardEvent): void {
  const nativeEvent = event.browserEvent
  if (
    composing
    || nativeEvent.isComposing
    || nativeEvent.keyCode === 229
    || nativeEvent.defaultPrevented
    || hasBlockingOverlay()
  ) {
    resetFocusWidthChord()
    return
  }

  if (focusWidthChordPending) {
    resetFocusWidthChord()
    if (
      event.keyCode === monaco.KeyCode.KeyF
      && !nativeEvent.ctrlKey
      && !nativeEvent.metaKey
      && !nativeEvent.altKey
      && !nativeEvent.shiftKey
    ) {
      event.preventDefault()
      event.stopPropagation()
      emit('toggle-focus-width')
    }
    return
  }

  if (
    event.keyCode === monaco.KeyCode.KeyK
    && (nativeEvent.ctrlKey || nativeEvent.metaKey)
    && !nativeEvent.altKey
    && !nativeEvent.shiftKey
    && !nativeEvent.repeat
  ) {
    focusWidthChordPending = true
    focusWidthChordTimer = setTimeout(resetFocusWidthChord, 1000)
  }
}

function syncZenModeActions(): void {
  if (!editor) return

  if (props.zenModeAvailable && !zenToggleAction) {
    zenToggleAction = editor.addAction({
      id: 'nuvyn.toggle-zen-mode',
      label: 'Toggle Zen Mode',
      keybindingContext: '!suggestWidgetVisible && !findWidgetVisible && !nuvynZenBlockingOverlay',
      keybindings: [monaco.KeyMod.chord(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,
        monaco.KeyCode.KeyZ,
      )],
      run() {
        if (props.zenModeAvailable && !composing) emit('toggle-zen-mode')
      },
    })
  } else if (!props.zenModeAvailable && zenToggleAction) {
    zenToggleAction.dispose()
    zenToggleAction = null
  }

  if (props.zenMode && !zenEscapeAction) {
    zenEscapeAction = editor.addAction({
      id: 'nuvyn.exit-zen-mode',
      label: 'Exit Zen Mode',
      keybindings: [monaco.KeyCode.Escape],
      keybindingContext: '!suggestWidgetVisible && !findWidgetVisible && !nuvynZenBlockingOverlay',
      run() {
        if (props.zenMode && !composing && !hasBlockingOverlay()) emit('exit-zen-mode')
      },
    })
  } else if (!props.zenMode && zenEscapeAction) {
    zenEscapeAction.dispose()
    zenEscapeAction = null
  }

}

watch(() => [props.zenModeAvailable, props.zenMode], syncZenModeActions, { flush: 'sync' })

rebuildLinkIndex()

function refreshMarkdownDecorations() {
  if (!editor || !model) return
  if (isLargeDocument.value) {
    decorationIds = editor.deltaDecorations(decorationIds, [])
    monaco.editor.setModelMarkers(model, 'nuvyn-writing', [])
    return
  }
  monaco.editor.setModelMarkers(model, 'nuvyn-writing', preferences.typography.value
    ? writingDiagnostics(model.getValue()).map((item) => ({
        severity: monaco.MarkerSeverity.Hint,
        message: item.message,
        startLineNumber: item.line,
        endLineNumber: item.line,
        startColumn: item.startColumn,
        endColumn: item.endColumn,
      }))
    : [])
  const visible = editor.getVisibleRanges()[0]
  const startLine = Math.max(1, (visible?.startLineNumber ?? 1) - 100)
  const endLine = Math.min(model.getLineCount(), (visible?.endLineNumber ?? Math.min(300, model.getLineCount())) + 100)
  const text = model.getValueInRange(new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)))
  const decorations: monaco.editor.IModelDeltaDecoration[] = markdownDecorationSpecs(
    text,
    (ref) => resolvedWikiPath(ref) !== null,
    startLine - 1,
  ).map((spec) => ({
    range: new monaco.Range(spec.startLineNumber, spec.startColumn, spec.endLineNumber, spec.endColumn),
    options: {
      isWholeLine: Boolean(spec.className),
      className: spec.className,
      inlineClassName: spec.inlineClassName,
    },
  }))
  decorationIds = editor.deltaDecorations(decorationIds, decorations)
}

function resolvedWikiPath(ref: string): string | null {
  if (!resolvedLinkCache.has(ref)) resolvedLinkCache.set(ref, resolveWikiTarget(ref, props.path, linkPaths))
  return resolvedLinkCache.get(ref) ?? null
}

function headingsFor(path: string) {
  let pending = headingCache.get(path)
  if (!pending) {
    pending = getPost(path).then((post) => markdownHeadingTargets(post.content)).catch(() => [])
    headingCache.set(path, pending)
  }
  return pending
}

function wikiCompletionRange(
  currentModel: monaco.editor.ITextModel,
  position: monaco.Position,
  typedLength: number,
): monaco.IRange {
  const suffix = currentModel.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: Math.min(currentModel.getLineMaxColumn(position.lineNumber), position.column + 2),
  })
  const existingClosingLength = suffix.startsWith(']]') ? 2 : 0
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column - typedLength,
    endLineNumber: position.lineNumber,
    endColumn: position.column + existingClosingLength,
  }
}

function scheduleMarkdownDecorations() {
  if (decorationTimer) clearTimeout(decorationTimer)
  decorationTimer = setTimeout(refreshMarkdownDecorations, 120)
}

function isInsideFencedCode(currentModel: monaco.editor.ITextModel, lineNumber: number): boolean {
  return fenceStateCache.isInsideOrOnFenceLine(lineNumber, (line) => currentModel.getLineContent(line))
}

const completionProvider: monaco.languages.CompletionItemProvider = {
  triggerCharacters: ['[', '`', '/', ':'],
  async provideCompletionItems(currentModel, position, context) {
    if (currentModel !== model) return { suggestions: [] }
    const before = currentModel.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    })
    const slash = /^\s*\/([^\s/]*)$/.exec(before)
    if (slash) {
      return {
        suggestions: filterMarkdownSlashCommands(slash[1]).map((command) => ({
          label: command.label,
          detail: command.detail,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: command.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          command: command.command,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: before.lastIndexOf('/') + 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
        })),
      }
    }
    const fence = /^```([A-Za-z0-9_-]*)$/.exec(before)
    if (fence) {
      return {
        suggestions: MARKDOWN_CODE_LANGUAGES.map((language) => ({
          label: language,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: language,
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column - fence[1].length,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
        })),
      }
    }
    if (!composing) {
      const emojiContext = getEmojiCompletionContext(
        before,
        position.column,
        {
          explicitInvocation: context?.triggerKind === 0,
          inFencedCode: isInsideFencedCode(currentModel, position.lineNumber),
        },
      )
      if (emojiContext.valid) {
        const suggestions = rankEmojiSuggestions(emojiContext.query, { allowEmpty: context?.triggerKind === 0 })
        return {
          suggestions: suggestions.slice(0, MAX_EMOJI_SUGGESTIONS).map((entry) => ({
            label: `${entry.glyph} :${entry.name}:`,
            detail: 'Emoji',
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: `${entry.name}:`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range: {
              startLineNumber: position.lineNumber,
              startColumn: emojiContext.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: emojiContext.endColumn,
            },
          })),
        }
      }
    }
    const match = /\[\[([^\]\n]*)$/.exec(before)
    if (!match || match[1].includes('|')) return { suggestions: [] }
    const anchorMatch = /^([^#]+)#([^#]*)$/.exec(match[1])
    if (anchorMatch) {
      const targetPath = resolvedWikiPath(anchorMatch[1])
      if (!targetPath) return { suggestions: [] }
      const query = anchorMatch[2].toLocaleLowerCase()
      const headings = await headingsFor(targetPath)
      const range = wikiCompletionRange(currentModel, position, anchorMatch[2].length)
      return {
        suggestions: headings
          .filter((heading) => `${heading.title} ${heading.anchor}`.toLocaleLowerCase().includes(query))
          .map((heading) => ({
            label: heading.title,
            detail: `${'#'.repeat(heading.level)} · ${heading.anchor}`,
            kind: monaco.languages.CompletionItemKind.Reference,
            insertText: `${heading.anchor}]]`,
            range,
          })),
      }
    }
    const range = wikiCompletionRange(currentModel, position, match[1].length)
    const recency = recentLinks()
    return {
      suggestions: rankWikiTargets(props.linkTargets ?? [], match[1], recency, props.path)
        .flatMap((target) => {
          const common = {
            filterText: `${target.title} ${target.path}`,
            kind: monaco.languages.CompletionItemKind.Reference,
            command: rememberLinkCommand
              ? { id: rememberLinkCommand, title: 'Remember wiki link', arguments: [target.path] }
              : undefined,
            range,
          }
          const direct = { ...common, label: target.title || target.path, detail: target.path, insertText: `${target.path}]]` }
          return target.title && target.title !== target.path
            ? [direct, { ...common, label: `${target.title} (alias)`, detail: `${target.path} · 以标题显示`, insertText: `${target.path}|${target.title}]]` }]
            : [direct]
        }),
    }
  },
}

const hoverProvider: monaco.languages.HoverProvider = {
  provideHover(currentModel, position) {
    if (currentModel !== model) return null
    const line = currentModel.getLineContent(position.lineNumber)
    const targetRef = wikiLinkAtColumn(line, position.column - 1)
    if (!targetRef) return null
    const resolvedPath = resolvedWikiPath(targetRef.ref)
    const target = resolvedPath ? targetsByPath.get(resolvedPath) : undefined
    return {
      contents: target
        ? [{ value: `**${target.title || target.path}**` }, { value: `\`${target.path}\`` }]
        : [{ value: '**Missing note**' }, { value: `\`${targetRef.ref}\`` }, { value: 'Cmd/Ctrl-click to create it in `inbox/`.' }],
    }
  },
}

onMounted(() => {
  if (!host.value) return
  mounted = true
  imageEditorGeneration += 1
  imageInput = document.createElement('input')
  imageInput.className = 'note-image-file-input'
  imageInput.type = 'file'
  imageInput.accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif'
  imageInput.multiple = true
  imageInput.addEventListener('change', onImageInputChange)
  imageInput.addEventListener('cancel', onImageInputCancel)
  document.body.append(imageInput)
  host.value.addEventListener('pointerdown', onHostPointerDown)
  host.value.addEventListener('dragenter', onImageDragEnter)
  host.value.addEventListener('dragover', onImageDragOver)
  host.value.addEventListener('dragleave', onImageDragLeave)
  host.value.addEventListener('drop', onImageDrop)
  model = acquireMarkdownModel(props.path, props.modelValue)
  fenceStateCache.reset()
  bindMarkdownProviderContext(model, { completion: completionProvider, hover: hoverProvider })
  editor = monaco.editor.create(host.value, {
    model,
    theme: activeTheme(),
    automaticLayout: true,
    wordWrap: props.focusWidth ? 'wordWrapColumn' : 'on',
    wordWrapColumn: preferences.wrapColumn.value,
    minimap: { enabled: false },
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: !isLargeDocument.value,
    fontFamily: preferences.fontFamily.value.trim() || 'var(--mono)',
    fontSize: preferences.fontSize.value,
    lineHeight: preferences.lineHeight.value,
    tabSize: preferences.tabSize.value,
    insertSpaces: true,
    detectIndentation: false,
    padding: { top: 10, bottom: 48 },
    // Disable Monaco's "extra space on top" view zone for the find
    // widget. By default Monaco inserts a ~25px blank view zone above
    // line 1 when the find widget opens (height = widget height -
    // padding.top), which shows up as a visible empty strip between
    // the editor's top edge and the first line of content. The widget
    // itself is position:absolute and overlays line 1's row, so
    // turning the view zone off removes the gap with no functional
    // regression — line 1's text is short enough that the widget's
    // right-aligned bar doesn't visually overlap it.
    find: { addExtraSpaceOnTop: false },
    renderLineHighlight: 'line',
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    scrollbar: {
      verticalScrollbarSize: 6,
      horizontalScrollbarSize: 6,
      verticalSliderSize: 6,
      horizontalSliderSize: 6,
      useShadows: false,
    },
    stickyScroll: { enabled: false },
    bracketPairColorization: { enabled: false },
    // Full-width Chinese punctuation such as `）` is ordinary prose in
    // this Markdown vault. Keep Monaco's invisible-character checks, but
    // do not flag every CJK lookalike as a source-code security warning.
    unicodeHighlight: { ambiguousCharacters: false },
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    // Monaco's built-in occurrence highlighter schedules a cancellable
    // promise on focus. Disposing the editor during a view-mode switch can
    // reject that promise as an unhandled CancellationError; Nuvyn already
    // owns its Markdown decorations and does not use occurrence highlights.
    occurrencesHighlight: 'off',
  })
  zenOverlayContext = editor.createContextKey('nuvynZenBlockingOverlay', false)
  zenOverlayObserver = new MutationObserver(updateZenOverlayContext)
  // Watch only portal roots and the overlay containers themselves: observing
  // Monaco's entire DOM would re-scan it during every editor token update.
  zenOverlayObserver.observe(document.body, { childList: true })
  updateZenOverlayContext()
  rememberLinkCommand = editor.addCommand(0, (_context, path: string) => recordRecentLink(path))
  const saved = readViewState()
  if (saved) editor.restoreViewState(saved)
  refreshMarkdownDecorations()
  editor.onDidChangeModelContent((event) => {
    const firstAffectedLine = event?.changes.reduce(
      (line, change) => Math.min(line, change.range.startLineNumber),
      Number.POSITIVE_INFINITY,
    )
    fenceStateCache.invalidateFrom(Number.isFinite(firstAffectedLine) ? firstAffectedLine : 1)
    scheduleMarkdownDecorations()
    if (suppressChange || composing || !model) return
    emit('update:modelValue', model.getValue())
  })
  for (const [id, label, keybinding, wrap] of [
    ['nuvyn.markdown-bold', 'Toggle bold', monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, MARKDOWN_WRAPS.bold],
    ['nuvyn.markdown-italic', 'Toggle italic', monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, MARKDOWN_WRAPS.italic],
    ['nuvyn.markdown-code', 'Toggle inline code', monaco.KeyMod.CtrlCmd | monaco.KeyCode.Backquote, MARKDOWN_WRAPS.code],
  ] as const) {
    editor.addAction({
      id,
      label,
      keybindings: [keybinding],
      run(instance) {
        if (!model) return
        const selection = instance.getSelection()
        if (!selection) return
        const selected = model.getValueInRange(selection)
        const edit = markdownWrapEdit(selected, wrap)
        instance.executeEdits(id, [{ range: selection, text: edit.text }])
        const start = model.getPositionAt(model.getOffsetAt(selection.getStartPosition()) + edit.selectionOffset)
        const end = model.getPositionAt(model.getOffsetAt(start) + edit.selectionLength)
        instance.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column))
      },
    })
  }
  // Keep link wrapping available in Monaco's context menu without reserving
  // Ctrl/Cmd+K, which now begins the Zen Mode chord.
  editor.addAction({
    id: 'nuvyn.markdown-link',
    label: 'Insert Markdown link',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run(instance) {
      if (!model) return
      const selection = instance.getSelection()
      if (!selection) return
      const edit = markdownWrapEdit(model.getValueInRange(selection), MARKDOWN_WRAPS.link)
      instance.executeEdits('nuvyn.markdown-link', [{ range: selection, text: edit.text }])
      const start = model.getPositionAt(model.getOffsetAt(selection.getStartPosition()) + edit.selectionOffset)
      const end = model.getPositionAt(model.getOffsetAt(start) + edit.selectionLength)
      instance.setSelection(new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column))
    },
  })
  editor.addAction({
    id: 'nuvyn.insert-note-image',
    label: t('editor.insert_image'),
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 3,
    run() {
      chooseImage()
    },
  })
  editor.addAction({
    id: 'nuvyn.toggle-view-mode',
    label: 'Toggle Edit / Reading Mode',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE],
    run() {
      emit('toggle-view-mode')
    },
  })
  editor.onDidCompositionStart(() => { composing = true })
  editor.onDidCompositionEnd(() => {
    composing = false
    resetFocusWidthChord()
    if (!suppressChange && model) emit('update:modelValue', model.getValue())
  })
  focusWidthChordListener = editor.onKeyDown(onFocusWidthChordKeydown)
  editor.onDidBlurEditorWidget(resetFocusWidthChord)
  syncZenModeActions()
  editor.onDidScrollChange((event) => {
    if (event.scrollTopChanged || event.scrollLeftChanged) revealEditorScrollbars()
    if (!editor || !event.scrollTopChanged) return
    if (isLargeDocument.value) return
    scheduleMarkdownDecorations()
  })
  editor.addAction({
    id: 'nuvyn.markdown-enter',
    label: 'Continue Markdown list',
    keybindings: [monaco.KeyCode.Enter],
    keybindingContext: '!suggestWidgetVisible',
    run(instance) {
      if (!model) return
      const selection = instance.getSelection()
      if (!selection) return
      const position = selection.getPosition()
      const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column))
      const continuation = markdownContinuation(before)
      if (continuation.removeMarkerFrom !== undefined && selection.isEmpty()) {
        instance.executeEdits('markdown-enter', [{
          range: new monaco.Range(position.lineNumber, continuation.removeMarkerFrom + 1, position.lineNumber, position.column),
          text: `\n${' '.repeat(continuation.removeMarkerFrom)}`,
        }])
      } else {
        instance.executeEdits('markdown-enter', [{ range: selection, text: continuation.insert }])
      }
    },
  })
  for (const [id, label, keybinding, outdent] of [
    ['nuvyn.markdown-indent', 'Indent Markdown line', monaco.KeyCode.Tab, false],
    ['nuvyn.markdown-outdent', 'Outdent Markdown line', monaco.KeyMod.Shift | monaco.KeyCode.Tab, true],
  ] as const) {
    editor.addAction({
      id,
      label,
      keybindings: [keybinding],
      run(instance) {
        if (!model) return
        const selection = instance.getSelection()
        if (!selection) return
        const isMultiLine = selection.startLineNumber !== selection.endLineNumber
        const currentLine = model.getLineContent(selection.startLineNumber)
        const isList = /^\s*(?:[-+*]|\d+\.|- \[[ xX]\])\s/.test(currentLine)
        if (!isMultiLine && !isList) {
          instance.executeEdits(id, [{ range: selection, text: '\t' }])
          return
        }
        const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
          ? selection.endLineNumber - 1
          : selection.endLineNumber
        const edits: monaco.editor.IIdentifiedSingleEditOperation[] = []
        let firstDelta = 0
        let lastDelta = 0
        for (let lineNumber = selection.startLineNumber; lineNumber <= endLine; lineNumber += 1) {
          const line = model.getLineContent(lineNumber)
          const next = indentMarkdownLine(line, outdent)
          if (next !== line) {
            const delta = next.length - line.length
            if (lineNumber === selection.startLineNumber) firstDelta = delta
            if (lineNumber === endLine) lastDelta = delta
            edits.push({ range: new monaco.Range(lineNumber, 1, lineNumber, line.length + 1), text: next })
          }
        }
        instance.executeEdits(id, edits)
        instance.setSelection(new monaco.Selection(
          selection.startLineNumber,
          Math.max(1, selection.startColumn + firstDelta),
          selection.endLineNumber,
          Math.max(1, selection.endColumn + lastDelta),
        ))
      },
    })
  }
  editor.onMouseDown((event) => {
    const position = event.target.position
    if (!model || !position || (!event.event.ctrlKey && !event.event.metaKey)) return
    const targetRef = wikiLinkAtColumn(model.getLineContent(position.lineNumber), position.column - 1)
    if (!targetRef) return
    const path = resolvedWikiPath(targetRef.ref)
    if (!path) {
      emit('create-link', targetRef.ref)
      return
    }
    recordRecentLink(path)
    emit('open-link', { path, ...(targetRef.anchor ? { anchor: targetRef.anchor } : {}) })
  })
  pasteHandler = (event) => {
    if (!editor || !model) return
    const selection = editor.getSelection()
    const clipboard = event.clipboardData
    if (!clipboard || editor.hasTextFocus() === false) return

    if (selection && !selection.isEmpty()) {
      const label = model.getValueInRange(selection)
      const replacement = markdownLinkFromPaste(label, clipboard.getData('text/plain') ?? '')
      if (replacement) {
        event.preventDefault()
        event.stopImmediatePropagation()
        editor.executeEdits('markdown-link-paste', [{ range: selection, text: replacement }])
        return
      }
    }

    // Text-bearing clipboard payloads take precedence over a companion image
    // file (common when copying a web selection). HTML containing only an
    // actual local image file is still eligible; remote image URLs are never fetched.
    const plainText = clipboard.getData('text/plain') ?? ''
    const html = clipboard.getData('text/html') ?? ''
    if (props.allowImageInsertion === false || plainText.trim() || clipboardHasMeaningfulHtml(html)) return
    const files = clipboardImageFiles(clipboard)
    if (files.length === 0) return
    const intent = createImageInsertionIntent()
    if (!intent) return
    event.preventDefault()
    event.stopImmediatePropagation()
    uploadImagesAtIntent(files, intent)
  }
  host.value.addEventListener('paste', pasteHandler, true)
  editor.onDidBlurEditorWidget(() => saveViewState())
  themeObserver = new MutationObserver(() => monaco.editor.setTheme(activeTheme()))
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

watch(() => props.modelValue, (value) => {
  if (!model || model.getValue() === value) return
  suppressChange = true
  model.setValue(value)
  suppressChange = false
})

watch(() => props.path, (nextPath, previousPath) => {
  if (!editor) return
  imageEditorGeneration += 1
  saveViewState(previousPath)
  if (model) unbindMarkdownProviderContext(model)
  model = acquireMarkdownModel(nextPath, props.modelValue)
  fenceStateCache.reset()
  bindMarkdownProviderContext(model, { completion: completionProvider, hover: hoverProvider })
  editor.setModel(model)
  const state = readViewState(nextPath)
  if (state) editor.restoreViewState(state)
  rebuildLinkIndex()
  refreshMarkdownDecorations()
})

watch(() => [props.focusWidth, props.zenMode] as const, async ([focused]) => {
  editor?.updateOptions({ wordWrap: focused ? 'wordWrapColumn' : 'on', wordWrapColumn: preferences.wrapColumn.value })
  await nextTick()
  editor?.layout()
}, { flush: 'post' })

watch(
  [preferences.fontSize, preferences.lineHeight, preferences.tabSize, preferences.wrapColumn, preferences.fontFamily],
  ([fontSize, lineHeight, tabSize, wrapColumn, fontFamily]) => editor?.updateOptions({
    fontSize, lineHeight, tabSize, wordWrapColumn: wrapColumn, fontFamily: fontFamily.trim() || 'var(--mono)',
  }),
)

watch(isLargeDocument, (large) => {
  editor?.updateOptions({ folding: !large, smoothScrolling: !large })
  refreshMarkdownDecorations()
})
watch(preferences.typography, refreshMarkdownDecorations)

watch(() => props.linkTargets, () => {
  rebuildLinkIndex()
  scheduleMarkdownDecorations()
})

onBeforeUnmount(() => {
  mounted = false
  imageEditorGeneration += 1
  if (filePickerIntent) releaseImageInsertionIntent(filePickerIntent)
  filePickerIntent = null
  imageInput?.removeEventListener('change', onImageInputChange)
  imageInput?.removeEventListener('cancel', onImageInputCancel)
  imageInput?.remove()
  imageInput = null
  for (const batch of imageUploadBatches.values()) releaseImageInsertionIntent(batch.intent)
  saveViewState()
  themeObserver?.disconnect()
  if (decorationTimer) clearTimeout(decorationTimer)
  clearScrollbarHideTimer()
  host.value?.removeEventListener('pointerdown', onHostPointerDown)
  host.value?.removeEventListener('dragenter', onImageDragEnter)
  host.value?.removeEventListener('dragover', onImageDragOver)
  host.value?.removeEventListener('dragleave', onImageDragLeave)
  host.value?.removeEventListener('drop', onImageDrop)
  host.value?.classList.remove('is-image-drag-over')
  if (scrollbarPointerId !== null) {
    scrollbarPointerId = null
    window.removeEventListener('pointerup', onScrollbarPointerEnd)
    window.removeEventListener('pointercancel', onScrollbarPointerEnd)
    window.removeEventListener('blur', onScrollbarWindowBlur)
    document.removeEventListener('visibilitychange', onScrollbarVisibilityChange)
  }
  host.value?.classList.remove('is-scrollbar-visible')
  if (pasteHandler && host.value) host.value.removeEventListener('paste', pasteHandler, true)
  resetFocusWidthChord()
  zenOverlayObserver?.disconnect()
  zenOverlayObserver = null
  observedZenOverlays.clear()
  zenOverlayContext = null
  zenToggleAction?.dispose()
  focusWidthChordListener?.dispose()
  zenEscapeAction?.dispose()
  zenToggleAction = null
  focusWidthChordListener = null
  zenEscapeAction = null
  editor?.dispose()
  if (model) unbindMarkdownProviderContext(model)
  editor = null
  model = null
})

async function revealAnchor(anchor: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!editor || !model || !anchor) return false
  const run = ++revealAnchorSequence
  const targetEditor = editor
  const targetModel = model
  const targetPath = props.path
  const targetRaw = targetModel.getValue()
  const lineNumber = await findMarkdownHeadingSourceLine(targetRaw, anchor, {
    sourcePath: targetPath,
  })
  if (
    !lineNumber
    || run !== revealAnchorSequence
    || editor !== targetEditor
    || model !== targetModel
    || props.path !== targetPath
    || targetModel.getValue() !== targetRaw
    || !isCurrent()
  ) return false
  targetEditor.revealLineInCenter(lineNumber)
  return true
}

defineExpose({
  focus: () => editor?.focus(),
  chooseImage,
  revealText,
  revealAnchor,
})
</script>

<template>
  <div ref="host" class="monaco-host" :class="{ 'focus-width': focusWidth, 'zen-mode-width': zenMode }" />
</template>
