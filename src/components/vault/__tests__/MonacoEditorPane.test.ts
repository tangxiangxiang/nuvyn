// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const imageMocks = vi.hoisted(() => ({ uploadNoteImage: vi.fn() }))

const mocks = vi.hoisted(() => {
  const changeListeners: Array<(event?: { changes: Array<{ range: { startLineNumber: number } }> }) => void> = []
  const blurListeners: Array<() => void> = []
  const compositionStartListeners: Array<() => void> = []
  const compositionEndListeners: Array<() => void> = []
  const keyDownListeners: Array<(event: any) => void> = []
  const scrollListeners: Array<(event: { scrollTopChanged: boolean; scrollLeftChanged: boolean }) => void> = []
  const mouseDownListeners: Array<(event: any) => void> = []
  const completionProviders: Array<any> = []
  const decorations = new Map<string, any>()
  let nextDecorationId = 0
  const createEditor = vi.fn()
  const chord = vi.fn(() => 123456)
  const model = {
    uri: { toString: () => 'nuvyn://vault/test' },
    value: '',
    getValue: vi.fn(() => model.value),
    setValue: vi.fn((value: string) => { model.value = value; changeListeners.forEach((fn) => fn()) }),
    getValueInRange: vi.fn((range?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => {
      if (!range || range.startLineNumber !== 1 || range.endLineNumber !== 1) return model.value
      return model.value.slice(range.startColumn - 1, range.endColumn - 1)
    }),
    deltaDecorations: vi.fn((oldIds: string[], newDecorations: Array<{ range: any }>) => {
      oldIds.forEach((id) => decorations.delete(id))
      return newDecorations.map(({ range }) => {
        const id = `tracked-${++nextDecorationId}`
        decorations.set(id, range)
        return id
      })
    }),
    getDecorationRange: vi.fn((id: string) => decorations.get(id) ?? null),
    getLineContent: vi.fn(() => ''),
    getLineCount: vi.fn(() => Math.max(1, model.value.split('\n').length)),
    getLineMaxColumn: vi.fn(() => 1),
    getOffsetAt: vi.fn(() => 0),
    getFullModelRange: vi.fn(() => {
      const lines = model.value.split('\n')
      return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines.at(-1)!.length + 1 }
    }),
    getPositionAt: vi.fn((offset: number) => {
      const prefix = model.value.slice(0, offset)
      const lines = prefix.split('\n')
      return { lineNumber: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
    }),
    findMatches: vi.fn((): Array<{ range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } }> => []),
    isDisposed: vi.fn(() => false),
    dispose: vi.fn(),
  }
  const editor = {
    saveViewState: vi.fn(() => ({ cursorState: [], viewState: {} })),
    restoreViewState: vi.fn(),
    deltaDecorations: vi.fn(() => []),
    onDidChangeModelContent: vi.fn((fn: (event?: { changes: Array<{ range: { startLineNumber: number } }> }) => void) => { changeListeners.push(fn) }),
    onDidBlurEditorWidget: vi.fn((fn: () => void) => { blurListeners.push(fn) }),
    onDidCompositionStart: vi.fn((fn: () => void) => { compositionStartListeners.push(fn) }),
    onDidCompositionEnd: vi.fn((fn: () => void) => { compositionEndListeners.push(fn) }),
    onKeyDown: vi.fn((fn: (event: any) => void) => { keyDownListeners.push(fn); return { dispose: vi.fn() } }),
    onMouseDown: vi.fn((fn: (event: any) => void) => { mouseDownListeners.push(fn) }),
    onDidScrollChange: vi.fn((fn: (event: { scrollTopChanged: boolean; scrollLeftChanged: boolean }) => void) => { scrollListeners.push(fn) }),
    getScrollHeight: vi.fn(() => 1000),
    getScrollTop: vi.fn(() => 250),
    getLayoutInfo: vi.fn(() => ({ height: 500 })),
    layout: vi.fn(),
    setScrollTop: vi.fn(),
    setPosition: vi.fn(),
    revealLineInCenter: vi.fn(),
    getVisibleRanges: vi.fn(() => [{ startLineNumber: 1, endLineNumber: 20 }]),
    getModel: vi.fn(() => model),
    getDomNode: vi.fn(() => mocks.editorNode),
    getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
    getTargetAtClientPoint: vi.fn(() => ({ position: { lineNumber: 1, column: 1 } })),
    hasTextFocus: vi.fn(() => true),
    pushUndoStop: vi.fn(() => true),
    addCommand: vi.fn(() => 'remember-link-command'),
    addAction: vi.fn(() => ({ dispose: vi.fn() })),
    createContextKey: vi.fn((_key: string, defaultValue: boolean) => ({ set: vi.fn(), get: vi.fn(() => defaultValue) })),
    getSelection: vi.fn(() => null),
    executeEdits: vi.fn((_source: string, edits: Array<{ range: any; text: string }>) => {
      const edit = edits[0]
      if (!edit || edit.range.startLineNumber !== 1 || edit.range.endLineNumber !== 1) return false
      const start = edit.range.startColumn - 1
      const end = edit.range.endColumn - 1
      model.value = `${model.value.slice(0, start)}${edit.text}${model.value.slice(end)}`
      changeListeners.forEach((fn) => fn({ changes: [{ range: { startLineNumber: 1 } }] }))
      return true
    }),
    setModel: vi.fn(),
    setSelection: vi.fn(),
    revealRangeInCenterIfOutsideViewport: vi.fn(),
    updateOptions: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  }
  return {
    changeListeners,
    blurListeners,
    compositionStartListeners,
    compositionEndListeners,
    keyDownListeners,
    scrollListeners,
    mouseDownListeners,
    completionProviders,
    decorations,
    createEditor,
    chord,
    editorNode: null as HTMLDivElement | null,
    model,
    editor,
    defineTheme: vi.fn(),
    setTheme: vi.fn(),
    completionDispose: vi.fn(),
    hoverDispose: vi.fn(),
    getPost: vi.fn(),
  }
})

vi.mock('monaco-editor/esm/vs/editor/editor.api.js', () => ({
  editor: {
    defineTheme: mocks.defineTheme,
    setTheme: mocks.setTheme,
    createModel: vi.fn((value: string) => { mocks.model.value = value; return mocks.model }),
    create: vi.fn((host?: HTMLElement) => {
      mocks.createEditor()
      if (host) {
        const root = document.createElement('div')
        root.className = 'monaco-editor'
        const overflowGuard = document.createElement('div')
        overflowGuard.className = 'overflow-guard'
        const input = document.createElement('textarea')
        input.className = 'inputarea'
        overflowGuard.append(input)
        root.append(overflowGuard)
        host.append(root)
        mocks.editorNode = root
      }
      return mocks.editor
    }),
    setModelMarkers: vi.fn(),
    TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
  },
  languages: {
    registerFoldingRangeProvider: vi.fn(() => ({ dispose: vi.fn() })),
    CompletionItemKind: { Reference: 1, Keyword: 2, Snippet: 3 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider: vi.fn((_language: string, provider: any) => {
      mocks.completionProviders.push(provider)
      return { dispose: mocks.completionDispose }
    }),
    registerHoverProvider: vi.fn(() => ({ dispose: mocks.hoverDispose })),
  },
  Uri: { parse: vi.fn((value: string) => value) },
  Range: class Range {
    public startLineNumber: number
    public startColumn: number
    public endLineNumber: number
    public endColumn: number

    constructor(startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) {
      this.startLineNumber = startLineNumber
      this.startColumn = startColumn
      this.endLineNumber = endLineNumber
      this.endColumn = endColumn
    }

    isEmpty() {
      return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn
    }
  },
  Selection: class Selection {
    public selectionStartLineNumber: number
    public selectionStartColumn: number
    public positionLineNumber: number
    public positionColumn: number

    constructor(
      selectionStartLineNumber: number,
      selectionStartColumn: number,
      positionLineNumber: number,
      positionColumn: number,
    ) {
      this.selectionStartLineNumber = selectionStartLineNumber
      this.selectionStartColumn = selectionStartColumn
      this.positionLineNumber = positionLineNumber
      this.positionColumn = positionColumn
    }

    isEmpty() {
      return this.selectionStartLineNumber === this.positionLineNumber
        && this.selectionStartColumn === this.positionColumn
    }
  },
  KeyCode: { Enter: 3, Tab: 2, KeyB: 31, KeyE: 33, KeyF: 36, KeyI: 38, KeyK: 40, KeyZ: 56, Escape: 9, Backquote: 85 },
  KeyMod: { Shift: 1024, CtrlCmd: 2048, chord: mocks.chord },
  MarkerSeverity: { Hint: 1 },
}))
vi.mock('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js', () => ({}))
vi.mock('monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js', () => ({}))
vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class WorkerStub {} }))
vi.mock('../../../lib/api', () => ({ getPost: mocks.getPost }))
vi.mock('../../../lib/noteImages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/noteImages')>()
  return { ...actual, uploadNoteImage: imageMocks.uploadNoteImage }
})

import EditorPane from '../EditorPane.vue'
import AttachmentPickerDialog from '../AttachmentPickerDialog.vue'
import { resetMarkdownModelsForTesting } from '../monacoModels'
import { parseDoc } from '../../../lib/frontmatter'
import { useToast } from '../../../composables/useToast'

describe('Monaco EditorPane', () => {
  function registeredActions() {
    return mocks.editor.addAction.mock.calls as unknown as Array<[{
      id: string
      label?: string
      keybindings?: number[]
      keybindingContext?: string
      contextMenuGroupId?: string
      contextMenuOrder?: number
      run?: () => void
    }]>
  }

  function setDocumentLines(lines: string[]) {
    mocks.model.value = lines.join('\n')
    mocks.model.getLineContent.mockImplementation((lineNumber?: number) => lines[(lineNumber ?? 1) - 1] ?? '')
    mocks.model.getLineCount.mockImplementation(() => lines.length)
    mocks.model.getValueInRange.mockImplementation((range?: { startLineNumber: number; endLineNumber: number; endColumn: number }) => {
      if (!range) return ''
      if (range.startLineNumber !== range.endLineNumber) return ''
      return (lines[range.startLineNumber - 1] ?? '').slice(0, Math.max(0, range.endColumn - 1))
    })
  }

  async function completeEmojiAt(provider: any, lines: string[], lineNumber: number) {
    setDocumentLines(lines)
    return provider.provideCompletionItems(
      mocks.model,
      { lineNumber, column: 5 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
  }

  beforeEach(() => {
    resetMarkdownModelsForTesting()
    localStorage.clear()
    mocks.changeListeners.length = 0
    mocks.blurListeners.length = 0
    mocks.compositionStartListeners.length = 0
    mocks.compositionEndListeners.length = 0
    mocks.keyDownListeners.length = 0
    mocks.scrollListeners.length = 0
    mocks.mouseDownListeners.length = 0
    mocks.editorNode = null
    vi.clearAllMocks()
    mocks.model.getValueInRange.mockReset()
    mocks.model.getValueInRange.mockImplementation((range?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => {
      if (!range || range.startLineNumber !== 1 || range.endLineNumber !== 1) return mocks.model.value
      return mocks.model.value.slice(range.startColumn - 1, range.endColumn - 1)
    })
    mocks.model.getLineContent.mockReset()
    mocks.model.getLineContent.mockImplementation(() => '')
    mocks.model.getLineMaxColumn.mockReset()
    mocks.model.getLineMaxColumn.mockImplementation(() => 1)
    mocks.model.value = ''
    mocks.editor.getSelection.mockReturnValue(null)
    mocks.editor.getPosition.mockReturnValue({ lineNumber: 1, column: 1 })
    mocks.editor.hasTextFocus.mockReturnValue(true)
    mocks.editor.getModel.mockReturnValue(mocks.model)
    mocks.decorations.clear()
    imageMocks.uploadNoteImage.mockReset()
    const { toasts, dismiss } = useToast()
    toasts.value.forEach((toast) => dismiss(toast.id))
    mocks.model.getLineContent.mockReturnValue('')
    mocks.model.findMatches.mockReset()
    mocks.model.findMatches.mockReturnValue([])
    mocks.model.getFullModelRange.mockReset()
    mocks.model.getFullModelRange.mockImplementation(() => {
      const lines = mocks.model.value.split('\n')
      return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines.at(-1)!.length + 1 }
    })
    document.documentElement.setAttribute('data-theme', 'light')
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  function imageFile(name = 'diagram.png'): File {
    return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], name, { type: 'image/png' })
  }

  function cursorSelection(column: number, endColumn = column) {
    return {
      startLineNumber: 1,
      startColumn: column,
      endLineNumber: 1,
      endColumn,
      isEmpty: () => column === endColumn,
    }
  }

  function pasteImage(
    file: File,
    values: Record<string, string> = {},
    types = ['Files'],
    files = [file],
  ): ClipboardEvent {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    const clipboardData = {
      files,
      items: [{ kind: 'file', getAsFile: () => file }],
      types,
      getData: (type: string) => values[type] ?? '',
    }
    Object.defineProperty(event, 'clipboardData', { value: clipboardData })
    return event as ClipboardEvent
  }

  function editorHost(wrapper: { element: Element }): HTMLElement {
    if (wrapper.element instanceof HTMLElement && wrapper.element.matches('.monaco-host')) return wrapper.element
    return wrapper.element.querySelector<HTMLElement>('.monaco-host')!
  }

  function dispatchEditorPaste(
    wrapper: { element: Element },
    event: Event,
    targetKind: 'textarea' | 'native-edit-context' = 'textarea',
  ): void {
    if (!wrapper.element.isConnected) document.body.append(wrapper.element)
    const editorNode = editorHost(wrapper).querySelector<HTMLElement>('.monaco-editor')!
    let target: HTMLElement
    if (targetKind === 'native-edit-context') {
      target = document.createElement('div')
      target.className = 'native-edit-context'
      target.tabIndex = 0
      editorNode.querySelector('.overflow-guard')!.append(target)
    } else {
      target = editorNode.querySelector<HTMLElement>('textarea.inputarea')!
    }
    target.focus()
    target.dispatchEvent(event)
  }

  function uploadedImage(file: File) {
    return {
      id: '550e8400-e29b-41d4-a716-446655440000',
      path: 'attachments/images/550e8400-e29b-41d4-a716-446655440000.png',
      markdownUrl: '@/attachments/images/550e8400-e29b-41d4-a716-446655440000.png',
      mimeType: 'image/png' as const,
      byteSize: file.size,
    }
  }

  it('keeps normal text and URL-to-Markdown-link paste behavior ahead of clipboard images', () => {
    const wrapper = mount(EditorPane, { props: { modelValue: 'label', path: 'inbox/test', allowImageInsertion: true } })
    mocks.model.value = 'label'
    mocks.editor.getSelection.mockReturnValue(cursorSelection(1, 6) as any)
    const textPaste = pasteImage(imageFile(), { 'text/plain': 'copied web text', 'text/html': '<p>copied web text</p>' })
    dispatchEditorPaste(wrapper, textPaste)
    expect(textPaste.defaultPrevented).toBe(false)
    expect(imageMocks.uploadNoteImage).not.toHaveBeenCalled()

    const urlPaste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(urlPaste, 'clipboardData', {
      value: { files: [], items: [], getData: (type: string) => type === 'text/plain' ? 'https://example.com' : '' },
    })
    dispatchEditorPaste(wrapper, urlPaste)
    expect(urlPaste.defaultPrevented).toBe(true)
    expect(mocks.editor.executeEdits).toHaveBeenCalledWith(
      'markdown-link-paste',
      [expect.objectContaining({ text: '[label](https://example.com)' })],
    )
    expect(imageMocks.uploadNoteImage).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not intercept image paste when Monaco does not have text focus', () => {
    const wrapper = mount(EditorPane, { props: { modelValue: 'unchanged', path: 'inbox/test', allowImageInsertion: true } })
    mocks.model.value = 'unchanged'
    mocks.editor.hasTextFocus.mockReturnValueOnce(false)
    const event = pasteImage(imageFile())

    dispatchEditorPaste(wrapper, event)

    expect(event.defaultPrevented).toBe(false)
    expect(imageMocks.uploadNoteImage).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('accepts a focused Safari native-edit-context paste even when Monaco reports no text focus', () => {
    const file = imageFile()
    const wrapper = mount(EditorPane, { props: { modelValue: 'unchanged', path: 'inbox/test', allowImageInsertion: true } })
    mocks.model.value = 'unchanged'
    mocks.editor.hasTextFocus.mockReturnValue(false)
    const event = pasteImage(file)

    dispatchEditorPaste(wrapper, event, 'native-edit-context')

    expect(event.defaultPrevented).toBe(true)
    expect(imageMocks.uploadNoteImage).toHaveBeenCalledWith(file)
    wrapper.unmount()
  })

  it('uploads a local image when clipboard HTML and plain text only label that file', () => {
    const file = imageFile('diagram.png')
    const wrapper = mount(EditorPane, { props: { modelValue: 'unchanged', path: 'inbox/test', allowImageInsertion: true } })
    mocks.model.value = 'unchanged'
    const event = pasteImage(file, {
      'text/plain': 'diagram.png',
      'text/html': '<div><img src="https://example.com/diagram.png" alt="diagram"></div>',
    })

    dispatchEditorPaste(wrapper, event, 'native-edit-context')

    expect(event.defaultPrevented).toBe(true)
    expect(imageMocks.uploadNoteImage).toHaveBeenCalledWith(file)
    wrapper.unmount()
  })

  it('reads image files from clipboard items when the files list is empty', () => {
    const file = imageFile()
    const wrapper = mount(EditorPane, { props: { modelValue: 'unchanged', path: 'inbox/test', allowImageInsertion: true } })
    const event = pasteImage(file, {}, ['Files'], [])

    dispatchEditorPaste(wrapper, event, 'native-edit-context')

    expect(event.defaultPrevented).toBe(true)
    expect(imageMocks.uploadNoteImage).toHaveBeenCalledWith(file)
    wrapper.unmount()
  })

  it('does not upload images when the active workspace disallows Note image insertion', () => {
    const file = imageFile()
    const wrapper = mount(EditorPane, { props: { modelValue: 'unchanged', path: 'diary/2026-10-13', allowImageInsertion: false } })
    const event = pasteImage(file)

    dispatchEditorPaste(wrapper, event, 'native-edit-context')

    expect(event.defaultPrevented).toBe(false)
    expect(imageMocks.uploadNoteImage).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('registers the image context action only while Note image insertion is allowed', async () => {
    const wrapper = mount(EditorPane, {
      props: { modelValue: 'unchanged', path: 'diary/2026-10-13', allowImageInsertion: false },
    })
    const imageActionIndex = () => registeredActions().findIndex(([options]) => options.id === 'nuvyn.insert-note-image')

    try {
      expect(imageActionIndex()).toBe(-1)
      ;(wrapper.vm as any).chooseImage()
      expect(wrapper.findComponent(AttachmentPickerDialog).props('show')).toBe(false)

      await wrapper.setProps({ allowImageInsertion: true })
      const index = imageActionIndex()
      expect(index).toBeGreaterThanOrEqual(0)
      const action = registeredActions()[index]![0]
      const disposable = mocks.editor.addAction.mock.results[index]!.value as { dispose: ReturnType<typeof vi.fn> }
      expect(action).toMatchObject({
        contextMenuGroupId: '1_modification',
        contextMenuOrder: 3,
      })
      action.run?.()
      await nextTick()
      expect(wrapper.findComponent(AttachmentPickerDialog).props('show')).toBe(true)

      await wrapper.setProps({ allowImageInsertion: false })
      expect(disposable.dispose).toHaveBeenCalledOnce()
      action.run?.()
      await nextTick()
      expect(wrapper.findComponent(AttachmentPickerDialog).props('show')).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('does not handle clipboard images from outside this Note editor or after unmount', () => {
    const file = imageFile()
    const wrapper = mount(EditorPane, { props: { modelValue: 'unchanged', path: 'inbox/test', allowImageInsertion: true } })
    const outsideInput = document.createElement('textarea')
    document.body.append(outsideInput)
    outsideInput.focus()
    const outsideEvent = pasteImage(file)
    outsideInput.dispatchEvent(outsideEvent)
    expect(outsideEvent.defaultPrevented).toBe(false)
    expect(imageMocks.uploadNoteImage).not.toHaveBeenCalled()

    const editorNode = editorHost(wrapper).querySelector<HTMLElement>('.monaco-editor')!
    const nativeTarget = document.createElement('div')
    nativeTarget.className = 'native-edit-context'
    nativeTarget.tabIndex = 0
    editorNode.querySelector('.overflow-guard')!.append(nativeTarget)
    nativeTarget.focus()
    wrapper.unmount()
    const afterUnmountEvent = pasteImage(file)
    nativeTarget.dispatchEvent(afterUnmountEvent)
    expect(afterUnmountEvent.defaultPrevented).toBe(false)
    expect(imageMocks.uploadNoteImage).not.toHaveBeenCalled()
    outsideInput.remove()
  })

  it('shares one document paste delegate and removes it after the last editor unmounts', () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const first = mount(EditorPane, { props: { modelValue: 'one', path: 'inbox/one', allowImageInsertion: true } })
    const second = mount(EditorPane, { props: { modelValue: 'two', path: 'inbox/two', allowImageInsertion: true } })
    const pasteAdds = () => addListener.mock.calls.filter(([type]) => type === 'paste')
    const pasteRemoves = () => removeListener.mock.calls.filter(([type]) => type === 'paste')
    expect(pasteAdds()).toHaveLength(1)
    expect(pasteRemoves()).toHaveLength(0)

    first.unmount()
    expect(pasteRemoves()).toHaveLength(0)
    second.unmount()
    expect(pasteRemoves()).toHaveLength(1)
    addListener.mockRestore()
    removeListener.mockRestore()
  })

  it('uploads a pasted image and inserts at its captured cursor after typing continues', async () => {
    const file = imageFile()
    let resolveUpload!: (result: ReturnType<typeof uploadedImage>) => void
    imageMocks.uploadNoteImage.mockReturnValue(new Promise((resolve) => { resolveUpload = resolve }))
    const wrapper = mount(EditorPane, { props: { modelValue: 'abcd', path: 'inbox/test', allowImageInsertion: true } })
    mocks.model.value = 'abcd'
    mocks.editor.getSelection.mockReturnValue(cursorSelection(2) as any)

    const event = pasteImage(file)
    dispatchEditorPaste(wrapper, event)
    expect(event.defaultPrevented).toBe(true)
    expect(imageMocks.uploadNoteImage).toHaveBeenCalledWith(file)
    expect(useToast().toasts.value.some((toast) => toast.type === 'info')).toBe(true)

    mocks.model.value = 'abcd!'
    mocks.changeListeners.forEach((listener) => listener({ changes: [{ range: { startLineNumber: 1 } }] }))
    resolveUpload(uploadedImage(file))
    await flushPromises()
    expect(useToast().toasts.value.some((toast) => toast.type === 'info')).toBe(false)
    expect(mocks.editor.executeEdits).toHaveBeenCalledOnce()
    expect(mocks.editor.executeEdits.mock.calls[0]?.[1][0]?.range.startColumn).toBe(2)
    expect(mocks.model.value).toBe('a![diagram](@/attachments/images/550e8400-e29b-41d4-a716-446655440000.png)bcd!')
    expect(mocks.editor.pushUndoStop).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('inserts dropped images at the pointer position without intercepting ordinary drops', async () => {
    const file = imageFile()
    imageMocks.uploadNoteImage.mockResolvedValue(uploadedImage(file))
    const wrapper = mount(EditorPane, { props: { modelValue: 'abcd', path: 'inbox/test', allowImageInsertion: true } })
    mocks.model.value = 'abcd'
    mocks.editor.getTargetAtClientPoint.mockReturnValue({ position: { lineNumber: 1, column: 3 } } as any)
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      dataTransfer: { value: { files: [file], items: [] } },
      clientX: { value: 10 },
      clientY: { value: 12 },
    })
    editorHost(wrapper).dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(mocks.editor.executeEdits.mock.calls[0]?.[1][0]?.range.startColumn).toBe(3)

    const ordinaryDrop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(ordinaryDrop, 'dataTransfer', { value: { files: [], items: [] } })
    editorHost(wrapper).dispatchEvent(ordinaryDrop)
    expect(ordinaryDrop.defaultPrevented).toBe(false)
    wrapper.unmount()
  })

  it('opens the attachment picker and leaves the document unchanged when it is cancelled', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: 'unchanged', path: 'inbox/test', allowImageInsertion: true } })
    ;(wrapper.vm as any).chooseImage()
    await nextTick()
    const picker = wrapper.getComponent(AttachmentPickerDialog)
    expect(picker.props('show')).toBe(true)
    picker.vm.$emit('close')
    await flushPromises()
    expect(picker.props('show')).toBe(false)
    expect(mocks.editor.executeEdits).not.toHaveBeenCalled()
    expect(mocks.model.value).toBe('unchanged')
    wrapper.unmount()
  })

  it('offers a copy fallback instead of inserting after the selected text changed', async () => {
    const file = imageFile()
    imageMocks.uploadNoteImage.mockResolvedValue(uploadedImage(file))
    const wrapper = mount(EditorPane, { props: { modelValue: 'replace me', path: 'inbox/test', allowImageInsertion: true } })
    mocks.model.value = 'replace me'
    mocks.editor.getSelection.mockReturnValue(cursorSelection(1, 11) as any)
    dispatchEditorPaste(wrapper, pasteImage(file))
    mocks.model.value = 'changed text'
    await flushPromises()
    expect(mocks.editor.executeEdits).not.toHaveBeenCalled()
    const toast = useToast().toasts.value.find((item) => item.action)
    expect(toast?.message).toBeTruthy()
    expect(toast?.action?.label).toBeTruthy()
    wrapper.unmount()
  })

  it('reveals Monaco scrollbars while scrolling and hides them after 900ms idle', () => {
    vi.useFakeTimers()
    const wrapper = mount(EditorPane, { props: { modelValue: 'start', path: 'inbox/test' } })
    const host = editorHost(wrapper)

    expect(host.classList.contains('is-scrollbar-visible')).toBe(false)
    mocks.scrollListeners.forEach((fn) => fn({ scrollTopChanged: true, scrollLeftChanged: false }))
    expect(host.classList.contains('is-scrollbar-visible')).toBe(true)

    vi.advanceTimersByTime(899)
    expect(host.classList.contains('is-scrollbar-visible')).toBe(true)
    mocks.scrollListeners.forEach((fn) => fn({ scrollTopChanged: false, scrollLeftChanged: true }))
    vi.advanceTimersByTime(899)
    expect(host.classList.contains('is-scrollbar-visible')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(host.classList.contains('is-scrollbar-visible')).toBe(false)
    wrapper.unmount()
  })

  it('keeps Monaco scrollbars visible while dragging and starts the idle delay on release', () => {
    vi.useFakeTimers()
    const wrapper = mount(EditorPane, { props: { modelValue: 'start', path: 'inbox/test' } })
    const host = editorHost(wrapper)
    const scrollable = document.createElement('div')
    scrollable.className = 'monaco-scrollable-element'
    const scrollbar = document.createElement('div')
    scrollbar.className = 'scrollbar vertical'
    scrollable.append(scrollbar)
    host.append(scrollable)

    const pointerDown = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(pointerDown, 'pointerId', { value: 7 })
    scrollbar.dispatchEvent(pointerDown)
    vi.advanceTimersByTime(1200)
    expect(host.classList.contains('is-scrollbar-visible')).toBe(true)

    const pointerUp = new Event('pointerup')
    Object.defineProperty(pointerUp, 'pointerId', { value: 7 })
    window.dispatchEvent(pointerUp)
    vi.advanceTimersByTime(899)
    expect(host.classList.contains('is-scrollbar-visible')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(host.classList.contains('is-scrollbar-visible')).toBe(false)
    wrapper.unmount()
  })

  it('emits local model changes once', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: 'start', path: 'inbox/test' } })
    mocks.model.value = 'changed'
    mocks.changeListeners.forEach((fn) => fn())
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:modelValue')).toEqual([['changed']])
    wrapper.unmount()
  })

  it('applies external content without echoing it back', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: 'start', path: 'inbox/test' } })
    await wrapper.setProps({ modelValue: 'server value' })
    expect(mocks.model.setValue).toHaveBeenCalledWith('server value')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('restores view state and keeps the tab model for Undo/Redo', () => {
    localStorage.setItem('nuvyn.monaco.view-state', JSON.stringify({ 'inbox/test': { cursorState: [], viewState: {} } }))
    const wrapper = mount(EditorPane, { props: { modelValue: 'start', path: 'inbox/test' } })
    expect(mocks.editor.restoreViewState).toHaveBeenCalled()
    wrapper.unmount()
    expect(mocks.editor.dispose).toHaveBeenCalledOnce()
    expect(mocks.model.dispose).not.toHaveBeenCalled()
    expect(mocks.completionDispose).not.toHaveBeenCalled()
    expect(mocks.hoverDispose).not.toHaveBeenCalled()
  })

  it('reveals a body search match using the raw Monaco model after frontmatter', () => {
    const raw = '---\ntitle: Redis\n---\n\n# Note\n\nThis contains transaction isolation guarantees.'
    const wrapper = mount(EditorPane, { props: { modelValue: raw, path: 'inbox/search-reveal' } })
    const original = mocks.model.getValue()
    const bodyStartOffset = raw.length - parseDoc(raw).content.length
    const bodyStart = mocks.model.getPositionAt(bodyStartOffset)
    const modelEnd = mocks.model.getFullModelRange()
    const matchRange = { startLineNumber: 7, startColumn: 15, endLineNumber: 7, endColumn: 36 }
    mocks.model.getPositionAt.mockClear()
    mocks.model.findMatches.mockReturnValueOnce([{ range: matchRange }])

    const revealText = (wrapper.vm as unknown as { revealText(text: string): boolean }).revealText
    expect(revealText('transaction isolation')).toBe(true)
    expect(mocks.model.getPositionAt).toHaveBeenCalledOnce()
    expect(mocks.model.getPositionAt).toHaveBeenCalledWith(bodyStartOffset)
    expect(mocks.model.findMatches).toHaveBeenCalledWith(
      'transaction isolation',
      expect.objectContaining({
        startLineNumber: bodyStart.lineNumber,
        startColumn: bodyStart.column,
        endLineNumber: modelEnd.endLineNumber,
        endColumn: modelEnd.endColumn,
      }),
      false,
      false,
      null,
      false,
      1,
    )
    expect(mocks.editor.setSelection).toHaveBeenCalledWith(expect.objectContaining({
      selectionStartLineNumber: matchRange.startLineNumber,
      selectionStartColumn: matchRange.startColumn,
      positionLineNumber: matchRange.endLineNumber,
      positionColumn: matchRange.endColumn,
    }))
    expect(mocks.editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(matchRange)
    expect(mocks.model.getValue()).toBe(original)
    expect(mocks.model.setValue).not.toHaveBeenCalled()
    expect(mocks.editor.executeEdits).not.toHaveBeenCalled()
    expect(mocks.editor.focus).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('reveals the body occurrence when frontmatter contains the same query first', () => {
    const raw = '---\ncustom: transaction isolation\n---\n\n# Note\n\nThe body contains transaction isolation guarantees.'
    const wrapper = mount(EditorPane, { props: { modelValue: raw, path: 'inbox/duplicate-search-reveal' } })
    const bodyStartOffset = raw.length - parseDoc(raw).content.length
    const bodyStart = mocks.model.getPositionAt(bodyStartOffset)
    const bodyMatchStartColumn = raw.split('\n')[6].indexOf('transaction isolation') + 1
    const bodyMatchRange = {
      startLineNumber: 7,
      startColumn: bodyMatchStartColumn,
      endLineNumber: 7,
      endColumn: bodyMatchStartColumn + 'transaction isolation'.length,
    }
    mocks.model.getPositionAt.mockClear()
    mocks.model.findMatches.mockReturnValueOnce([{ range: bodyMatchRange }])

    const revealText = (wrapper.vm as unknown as { revealText(text: string): boolean }).revealText
    expect(revealText('transaction isolation')).toBe(true)
    expect(mocks.model.findMatches).toHaveBeenCalledWith(
      'transaction isolation',
      expect.objectContaining({ startLineNumber: bodyStart.lineNumber, startColumn: bodyStart.column }),
      false,
      false,
      null,
      false,
      1,
    )
    expect(mocks.editor.setSelection).toHaveBeenCalledWith(expect.objectContaining({
      selectionStartLineNumber: bodyMatchRange.startLineNumber,
      selectionStartColumn: bodyMatchRange.startColumn,
      positionLineNumber: bodyMatchRange.endLineNumber,
      positionColumn: bodyMatchRange.endColumn,
    }))
    expect(mocks.editor.setSelection.mock.calls[0][0].selectionStartLineNumber).toBeGreaterThan(bodyStart.lineNumber - 1)
    expect(mocks.editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(bodyMatchRange)
    wrapper.unmount()
  })

  it('uses Monaco’s original-model Range for matches after Unicode case-folding prefixes', () => {
    const raw = '---\ntitle: Unicode\n---\n\n# Note\n\nİ prefix text\ntransaction isolation target'
    const wrapper = mount(EditorPane, { props: { modelValue: raw, path: 'inbox/unicode-search-reveal' } })
    const bodyStartOffset = raw.length - parseDoc(raw).content.length
    const bodyStart = mocks.model.getPositionAt(bodyStartOffset)
    const matchRange = { startLineNumber: 8, startColumn: 1, endLineNumber: 8, endColumn: 22 }
    mocks.model.getPositionAt.mockClear()
    mocks.model.findMatches.mockReturnValueOnce([{ range: matchRange }])

    const revealText = (wrapper.vm as unknown as { revealText(text: string): boolean }).revealText
    expect(revealText('transaction isolation')).toBe(true)
    expect(mocks.model.getPositionAt).toHaveBeenCalledOnce()
    expect(mocks.model.getPositionAt).toHaveBeenCalledWith(bodyStartOffset)
    expect(mocks.model.findMatches).toHaveBeenCalledWith(
      'transaction isolation',
      expect.objectContaining({ startLineNumber: bodyStart.lineNumber, startColumn: bodyStart.column }),
      false,
      false,
      null,
      false,
      1,
    )
    expect(mocks.editor.setSelection).toHaveBeenCalledWith(expect.objectContaining({
      selectionStartLineNumber: matchRange.startLineNumber,
      selectionStartColumn: matchRange.startColumn,
      positionLineNumber: matchRange.endLineNumber,
      positionColumn: matchRange.endColumn,
    }))
    expect(mocks.editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(matchRange)
    wrapper.unmount()
  })

  it('does not change the selection or content when a reveal query is stale', () => {
    const raw = '---\ntitle: Redis\n---\n\n# Note\n\nCurrent text.'
    const wrapper = mount(EditorPane, { props: { modelValue: raw, path: 'inbox/stale-search-reveal' } })
    const original = mocks.model.getValue()

    const revealText = (wrapper.vm as unknown as { revealText(text: string): boolean }).revealText
    expect(revealText('missing phrase')).toBe(false)
    expect(mocks.editor.setSelection).not.toHaveBeenCalled()
    expect(mocks.editor.revealRangeInCenterIfOutsideViewport).not.toHaveBeenCalled()
    expect(mocks.model.getValue()).toBe(original)
    expect(mocks.model.setValue).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('updates the Monaco theme without recreating the editor', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: '', path: 'inbox/theme' } })
    document.documentElement.setAttribute('data-theme', 'dark')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.setTheme).toHaveBeenCalledWith('nuvyn-dark')
    wrapper.unmount()
  })

  it('offers Markdown snippets after a slash command', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: '/mer', path: 'inbox/slash' } })
    const provider = mocks.completionProviders.at(-1)
    const result = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: 5 })
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({ label: 'mermaid', insertTextRules: 4 })
    wrapper.unmount()
  })

  it.each(['flex', 'code-group', 'details', 'snippet', 'include'])('offers /%s with a range replacing the entire slash, not indentation', async (label) => {
    const value = `  /${label}`
    const wrapper = mount(EditorPane, { props: { modelValue: value, path: `inbox/slash-${label}` } })
    const provider = mocks.completionProviders.at(-1)
    const count = mocks.completionProviders.length
    const result = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: value.length + 1 })
    expect(result.suggestions).toHaveLength(1)
    const item = result.suggestions[0]
    expect(item).toMatchObject({
      label, kind: 3, insertTextRules: 4,
      range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: value.length + 1 },
    })
    expect(item.insertText).toContain('${1:')
    expect(item.filterText).toBe(`/${label} /${item.detail}`)
    expect(item.insertText.endsWith('\n$0')).toBe(true)
    await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: value.length + 1 })
    expect(mocks.completionProviders).toHaveLength(count)
    wrapper.unmount()
  })

  it('leaves Tab and Shift+Tab to Monaco while a snippet or suggestion is active', () => {
    const wrapper = mount(EditorPane, { props: { modelValue: '', path: 'inbox/snippet-tabs' } })
    for (const id of ['nuvyn.markdown-indent', 'nuvyn.markdown-outdent']) {
      expect(mocks.editor.addAction).toHaveBeenCalledWith(expect.objectContaining({
        id, keybindingContext: '!inSnippetMode && !suggestWidgetVisible',
      }))
    }
    wrapper.unmount()
  })

  it('offers ranked Emoji snippets from the existing Markdown provider', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji' } })
    const provider = mocks.completionProviders.at(-1)
    const result = await provider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1, column: 5 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(result.suggestions[0]).toMatchObject({
      label: '😄 :smile:',
      detail: 'Emoji',
      insertText: 'smile:',
      insertTextRules: 4,
      kind: 3,
      range: { startColumn: 2, endColumn: 5 },
    })
    expect(result.suggestions.length).toBeLessThanOrEqual(30)

    const item = result.suggestions[0]
    const start = item.range.startColumn - 1
    const end = item.range.endColumn - 1
    const sourceAfterEdit = mocks.model.value.slice(0, start) + item.insertText + mocks.model.value.slice(end)
    expect(sourceAfterEdit).toBe(':smile:')
    wrapper.unmount()
  })

  it('keeps ordinary empty colon quiet but lets /emoji explicitly invoke the same provider', async () => {
    const ordinary = mount(EditorPane, { props: { modelValue: ':', path: 'inbox/ordinary-colon' } })
    const ordinaryProvider = mocks.completionProviders.at(-1)
    const ordinaryResult = await ordinaryProvider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1, column: 2 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(ordinaryResult.suggestions).toEqual([])
    ordinary.unmount()

    const slash = mount(EditorPane, { props: { modelValue: '/emoji', path: 'inbox/emoji-slash' } })
    const provider = mocks.completionProviders.at(-1)
    const slashResult = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: 6 })
    const command = slashResult.suggestions.find((item: any) => item.label === 'emoji')
    expect(command).toMatchObject({
      insertText: ':', insertTextRules: 4, kind: 3,
      command: { id: 'editor.action.triggerSuggest' },
    })

    mocks.model.value = ':'
    const explicitResult = await provider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1, column: 2 },
      { triggerKind: 0 },
    )
    expect(explicitResult.suggestions.length).toBe(30)
    expect(explicitResult.suggestions[0]).toMatchObject({ label: '👍 :+1:', insertText: '+1:' })
    slash.unmount()
  })

  it('suppresses Emoji completion in inline/fenced code, URLs, and during IME composition', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: '` :smi', path: 'inbox/emoji-guards' } })
    const provider = mocks.completionProviders.at(-1)
    const result = await provider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1, column: 6 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(result.suggestions).toEqual([])

    mocks.model.value = '```text\n:smi'
    mocks.model.getValueInRange.mockReturnValue(':smi')
    mocks.model.getLineContent.mockImplementation(((lineNumber: number) => lineNumber === 1 ? '```text' : ':smi') as any)
    const fencedResult = await provider.provideCompletionItems(
      mocks.model,
      { lineNumber: 2, column: 5 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(fencedResult.suggestions).toEqual([])

    mocks.model.value = 'https://example.com/:smi'
    mocks.model.getValueInRange.mockReturnValue('https://example.com/:smi')
    const urlResult = await provider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1, column: 26 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(urlResult.suggestions).toEqual([])

    mocks.compositionStartListeners.forEach((fn) => fn())
    mocks.model.value = ':smi'
    mocks.model.getValueInRange.mockReturnValue(':smi')
    const composingResult = await provider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1, column: 5 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(composingResult.suggestions).toEqual([])
    mocks.compositionEndListeners.forEach((fn) => fn())
    wrapper.unmount()
  })

  it('keeps Emoji completion available in ordinary documents after line 200', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-line-251' } })
    const provider = mocks.completionProviders.at(-1)
    const lines = [...Array.from({ length: 250 }, (_, index) => `normal ${index + 1}`), ':smi']
    const result = await completeEmojiAt(provider, lines, 251)
    expect(result.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    wrapper.unmount()
  })

  it('keeps Emoji completion available at line 1001 without a full-value read', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-line-1001' } })
    const provider = mocks.completionProviders.at(-1)
    const lines = [...Array.from({ length: 1000 }, (_, index) => `normal ${index + 1}`), ':smi']
    mocks.model.getValue.mockClear()
    const result = await completeEmojiAt(provider, lines, 1001)
    expect(result.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    expect(mocks.model.getValue).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reuses cached fence state when typing repeatedly on a distant line', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-cache' } })
    const provider = mocks.completionProviders.at(-1)
    const lines = [...Array.from({ length: 1000 }, (_, index) => `normal ${index + 1}`), ':smi']
    await completeEmojiAt(provider, lines, 1001)
    const readsAfterFirstCompletion = mocks.model.getLineContent.mock.calls.length
    lines[1000] = ':smil'
    setDocumentLines(lines)
    const result = await provider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1001, column: 6 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(result.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    expect(mocks.model.getLineContent.mock.calls.length - readsAfterFirstCompletion).toBe(1)
    wrapper.unmount()
  })

  it('suppresses Emoji inside a long open fence but resumes after a later close', async () => {
    const openWrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-long-open' } })
    const openProvider = mocks.completionProviders.at(-1)
    const openLines = Array.from({ length: 251 }, (_, index) => {
      if (index === 0) return '```text'
      if (index === 250) return ':smi'
      return `code ${index + 1}`
    })
    const openResult = await completeEmojiAt(openProvider, openLines, 251)
    expect(openResult.suggestions).toEqual([])
    openWrapper.unmount()

    const closedWrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-long-closed' } })
    const closedProvider = mocks.completionProviders.at(-1)
    const closedLines = Array.from({ length: 251 }, (_, index) => {
      if (index === 0) return '```text'
      if (index === 219) return '```'
      if (index === 250) return ':smi'
      return `code ${index + 1}`
    })
    const closedResult = await completeEmojiAt(closedProvider, closedLines, 251)
    expect(closedResult.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    closedWrapper.unmount()
  })

  it('suppresses Emoji inside nearby, tilde, and longer-fence code blocks', async () => {
    const nearbyWrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-nearby-fence' } })
    const nearbyProvider = mocks.completionProviders.at(-1)
    const nearbyLines = Array.from({ length: 230 }, (_, index) => {
      if (index === 224) return '```text'
      if (index === 229) return ':smi'
      return `normal ${index + 1}`
    })
    expect((await completeEmojiAt(nearbyProvider, nearbyLines, 230)).suggestions).toEqual([])
    nearbyWrapper.unmount()

    const tildeWrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-tilde-fence' } })
    const tildeProvider = mocks.completionProviders.at(-1)
    const tildeLines = ['~~~text', ':smi', '~~~', ':smi']
    expect((await completeEmojiAt(tildeProvider, tildeLines, 2)).suggestions).toEqual([])
    const tildeResult = await completeEmojiAt(tildeProvider, tildeLines, 4)
    expect(tildeResult.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    tildeWrapper.unmount()

    const lengthWrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-longer-fence' } })
    const lengthProvider = mocks.completionProviders.at(-1)
    const lengthLines = [' ````text', 'code', '```', ':smi', '````', ':smi']
    expect((await completeEmojiAt(lengthProvider, lengthLines, 4)).suggestions).toEqual([])
    const lengthResult = await completeEmojiAt(lengthProvider, lengthLines, 6)
    expect(lengthResult.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    lengthWrapper.unmount()
  })

  it('does not close a fence on trailing non-whitespace text and invalidates changed lines', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/emoji-fence-edit' } })
    const provider = mocks.completionProviders.at(-1)
    const lines = ['```text', '```not-close', ':smi']
    expect((await completeEmojiAt(provider, lines, 3)).suggestions).toEqual([])

    lines[0] = 'normal'
    lines[1] = 'code'
    setDocumentLines(lines)
    mocks.changeListeners.forEach((listener) => listener({ changes: [{ range: { startLineNumber: 1 } }] }))
    const result = await completeEmojiAt(provider, lines, 3)
    expect(result.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    wrapper.unmount()
  })

  it('keeps completion contexts isolated by model URI', async () => {
    const first = mount(EditorPane, { props: { modelValue: ':smi', path: 'inbox/first' } })
    const firstProvider = mocks.completionProviders.at(-1)
    const firstResult = await firstProvider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1, column: 5 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(firstResult.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    first.unmount()

    const second = mount(EditorPane, { props: { modelValue: '[[gui', path: 'inbox/second', linkTargets: [{ path: 'docs/guide', title: 'Guide' }] } })
    const secondProvider = mocks.completionProviders.at(-1)
    const secondResult = await secondProvider.provideCompletionItems(
      mocks.model,
      { lineNumber: 1, column: 6 },
      { triggerKind: 1, triggerCharacter: '[' },
    )
    expect(secondResult.suggestions[0]).toMatchObject({ label: 'Guide', insertText: 'docs/guide]]' })
    second.unmount()
  })

  it('does not read the full value while completing in a large document', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: 'x'.repeat(500_000) + '\n:smi', path: 'inbox/emoji-large' } })
    const provider = mocks.completionProviders.at(-1)
    mocks.model.getValue.mockClear()
    mocks.model.getValueInRange.mockReturnValue(':smi')
    mocks.model.getLineContent.mockReturnValue(':smi')
    const result = await provider.provideCompletionItems(
      mocks.model,
      { lineNumber: 2, column: 5 },
      { triggerKind: 1, triggerCharacter: ':' },
    )
    expect(result.suggestions[0]).toMatchObject({ label: '😄 :smile:' })
    expect(mocks.model.getValue).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('inserts the added Markdown slash commands through Monaco snippets', async () => {
    const expected = [
      ['footnote', '${1:Text}[^${2:1}]\n\n[^${2:1}]: ${3:Footnote content}'],
      ['highlight', '==${1:Highlighted text}=='],
      ['definition list', '${1:Term}\n: ${2:Definition}'],
    ] as const

    for (const [label, insertText] of expected) {
      const query = label === 'definition list' ? 'definition' : label
      const wrapper = mount(EditorPane, { props: { modelValue: `/${query}`, path: `inbox/${label}` } })
      const provider = mocks.completionProviders.at(-1)
      const result = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: query.length + 2 })
      expect(result.suggestions).toEqual(expect.arrayContaining([
        expect.objectContaining({ label, insertText, insertTextRules: 4, kind: 3 }),
      ]))
      wrapper.unmount()
    }
  })

  it('starts the existing Wiki Link completion after the wiki slash command', async () => {
    const wrapper = mount(EditorPane, {
      props: {
        modelValue: '/wiki',
        path: 'inbox/source',
        linkTargets: [{ path: 'docs/guide', title: 'Guide' }],
      },
    })
    const provider = mocks.completionProviders.at(-1)
    const slashResult = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: 6 })
    const wikiCommand = slashResult.suggestions.find((item: any) => item.label === 'wiki link')
    expect(wikiCommand).toMatchObject({
      insertText: '[[',
      insertTextRules: 4,
      command: { id: 'editor.action.triggerSuggest' },
    })

    mocks.model.value = wikiCommand.insertText
    const wikiResult = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: 3 })
    expect(wikiResult.suggestions).toContainEqual(expect.objectContaining({
      label: 'Guide', insertText: 'docs/guide]]', range: expect.objectContaining({ startColumn: 3, endColumn: 3 }),
    }))
    wrapper.unmount()
  })

  it('offers target headings after a Wiki Link hash', async () => {
    mocks.getPost.mockResolvedValue({ content: '# Intro\n\n## Setup Guide\n\n## 中文标题' })
    const wrapper = mount(EditorPane, {
      props: {
        modelValue: '[[docs/guide#set',
        path: 'inbox/source',
        linkTargets: [{ path: 'docs/guide', title: 'Guide' }],
      },
    })
    mocks.model.getValueInRange
      .mockReturnValueOnce('[[docs/guide#set')
      .mockReturnValueOnce(']]')
    mocks.model.getLineMaxColumn.mockReturnValue(20)
    const provider = mocks.completionProviders.at(-1)
    const result = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: 18 })
    expect(mocks.getPost).toHaveBeenCalledWith('docs/guide')
    expect(result.suggestions).toEqual([expect.objectContaining({
      label: 'Setup Guide',
      insertText: 'setup-guide]]',
      range: expect.objectContaining({ startColumn: 15, endColumn: 20 }),
    })])
    wrapper.unmount()
  })

  it('offers direct and title-alias Wiki Link insertions in stable order', async () => {
    const wrapper = mount(EditorPane, {
      props: { modelValue: '[[gui', path: 'inbox/source', linkTargets: [{ path: 'docs/guide', title: 'Guide title' }] },
    })
    const provider = mocks.completionProviders.at(-1)
    const result = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: 6 })
    expect(result.suggestions.map((item: any) => item.insertText)).toEqual([
      'docs/guide]]', 'docs/guide|Guide title]]',
    ])
    wrapper.unmount()
  })

  it('replaces an existing Wiki Link closing pair during completion', async () => {
    const wrapper = mount(EditorPane, {
      props: { modelValue: '[[]]', path: 'inbox/source', linkTargets: [{ path: 'docs/guide', title: 'Guide' }] },
    })
    mocks.model.getValueInRange
      .mockReturnValueOnce('[[')
      .mockReturnValueOnce(']]')
    mocks.model.getLineMaxColumn.mockReturnValue(5)
    const provider = mocks.completionProviders.at(-1)
    const result = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: 3 })

    expect(result.suggestions[0]).toMatchObject({
      insertText: 'docs/guide]]',
      range: { startColumn: 3, endColumn: 5 },
    })
    wrapper.unmount()
  })

  it('keeps supplying a Wiki Link closing pair when none exists', async () => {
    const wrapper = mount(EditorPane, {
      props: { modelValue: '[[gui', path: 'inbox/source', linkTargets: [{ path: 'docs/guide', title: 'Guide' }] },
    })
    mocks.model.getValueInRange
      .mockReturnValueOnce('[[gui')
      .mockReturnValueOnce('')
    mocks.model.getLineMaxColumn.mockReturnValue(6)
    const provider = mocks.completionProviders.at(-1)
    const result = await provider.provideCompletionItems(mocks.model, { lineNumber: 1, column: 6 })

    expect(result.suggestions[0]).toMatchObject({
      insertText: 'docs/guide]]',
      range: { startColumn: 3, endColumn: 6 },
    })
    wrapper.unmount()
  })

  it('leaves Enter to Monaco while the suggestion widget is visible', () => {
    const wrapper = mount(EditorPane, { props: { modelValue: '- item', path: 'inbox/source' } })
    const action = registeredActions()
      .map(([options]) => options)
      .find((options) => options.id === 'nuvyn.markdown-enter')

    expect(action).toMatchObject({ keybindingContext: '!suggestWidgetVisible' })
    wrapper.unmount()
  })

  it('uses Monaco-native Ctrl/Cmd+K then Z and keeps Markdown link wrapping in the context menu', () => {
    const wrapper = mount(EditorPane, {
      props: { modelValue: 'selected text', path: 'inbox/source', zenModeAvailable: true },
    })
    const actions = registeredActions().map(([options]) => options)
    const zenAction = actions.find((options) => options.id === 'nuvyn.toggle-zen-mode')
    const linkAction = actions.find((options) => options.id === 'nuvyn.markdown-link')

    expect(zenAction?.keybindings).toEqual([123456])
    expect(mocks.chord).toHaveBeenCalledWith(2048 | 40, 56)
    expect(linkAction).toMatchObject({
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2,
    })
    expect(linkAction).not.toHaveProperty('keybindings')

    zenAction?.run?.()
    expect(wrapper.emitted('toggle-zen-mode')).toEqual([[]])
    wrapper.unmount()
  })

  it('handles Ctrl/Cmd+K then F in the editor without conflicting with Format Selection', () => {
    const wrapper = mount(EditorPane, { props: { modelValue: 'body', path: 'inbox/source' } })
    const [onKeydown] = mocks.keyDownListeners
    const keydown = (keyCode: number, modifiers: Partial<KeyboardEvent> = {}) => onKeydown({
      keyCode,
      browserEvent: {
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
        keyCode,
        defaultPrevented: false,
        ...modifiers,
      },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    })

    keydown(40, { ctrlKey: true })
    const completeKey = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    onKeydown({
      keyCode: 36,
      browserEvent: { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 36, defaultPrevented: false },
      ...completeKey,
    })
    expect(wrapper.emitted('toggle-focus-width')).toEqual([[]])
    expect(completeKey.preventDefault).toHaveBeenCalledOnce()
    expect(completeKey.stopPropagation).toHaveBeenCalledOnce()

    keydown(40, { ctrlKey: true })
    keydown(56)
    keydown(36)
    expect(wrapper.emitted('toggle-focus-width')).toEqual([[]])

    mocks.compositionStartListeners.forEach((listener) => listener())
    keydown(40, { ctrlKey: true })
    keydown(36)
    expect(wrapper.emitted('toggle-focus-width')).toEqual([[]])
    wrapper.unmount()
  })

  it('preserves the existing Ctrl/Cmd+E edit/read shortcut in Zen Mode', async () => {
    const wrapper = mount(EditorPane, {
      props: { modelValue: 'body', path: 'inbox/source', zenModeAvailable: true },
    })
    const action = registeredActions()
      .map(([options]) => options)
      .find((options) => options.id === 'nuvyn.toggle-view-mode')
    expect(action?.keybindings).toEqual([2048 | 33])
    await wrapper.setProps({ zenMode: true })
    expect(registeredActions().map(([options]) => options.id)).not.toContain('nuvyn.toggle-view-mode-in-zen')
    action?.run?.()
    expect(wrapper.emitted('toggle-view-mode')).toEqual([[]])
    wrapper.unmount()
  })

  it('adds a context-aware Escape action only in Zen Mode and keeps the editor instance', async () => {
    const wrapper = mount(EditorPane, {
      props: { modelValue: 'body', path: 'inbox/source', zenModeAvailable: true },
    })
    const createCalls = mocks.createEditor.mock.calls.length
    await wrapper.setProps({ zenMode: true })
    const action = registeredActions()
      .map(([options]) => options)
      .find((options) => options.id === 'nuvyn.exit-zen-mode')

    expect(action).toMatchObject({
      keybindings: [9],
      keybindingContext: '!suggestWidgetVisible && !findWidgetVisible && !nuvynZenBlockingOverlay',
    })
    action?.run?.()
    expect(wrapper.emitted('exit-zen-mode')).toEqual([[]])
    expect(mocks.createEditor).toHaveBeenCalledTimes(createCalls)
    expect(mocks.editor.setModel).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('emits create-link when Cmd-clicking a missing Wiki Link', async () => {
    mocks.model.getLineContent.mockReturnValue('[[missing-note]]')
    const wrapper = mount(EditorPane, { props: { modelValue: '[[missing-note]]', path: 'inbox/source', linkTargets: [] } })
    mocks.mouseDownListeners.forEach((listener) => listener({
      target: { position: { lineNumber: 1, column: 4 } },
      event: { ctrlKey: false, metaKey: true },
    }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('create-link')).toEqual([['missing-note']])
    wrapper.unmount()
  })

  it('preserves the Wiki Link anchor when Cmd-clicking a resolved target', async () => {
    mocks.model.getLineContent.mockReturnValue('[[docs/target#section|Target]]')
    const wrapper = mount(EditorPane, {
      props: {
        modelValue: '[[docs/target#section|Target]]',
        path: 'inbox/source',
        linkTargets: [{ path: 'docs/target', title: 'Target' }],
      },
    })
    mocks.mouseDownListeners.forEach((listener) => listener({
      target: { position: { lineNumber: 1, column: 6 } },
      event: { ctrlKey: true, metaKey: false },
    }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('open-link')).toEqual([[{ path: 'docs/target', anchor: 'section' }]])
    wrapper.unmount()
  })

  it('reveals an exact renderer-generated heading id without editing or focusing the document', async () => {
    const raw = '## First {#stable-id}\n## stable-id'
    const wrapper = mount(EditorPane, { props: { modelValue: raw, path: 'notes/target' } })

    await expect((wrapper.vm as any).revealAnchor('stable-id-2')).resolves.toBe(true)
    expect(mocks.editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 })
    expect(mocks.editor.revealLineInCenter).toHaveBeenCalledWith(2)
    expect(mocks.model.getValue()).toBe(raw)
    expect(mocks.editor.focus).not.toHaveBeenCalled()
    expect(mocks.editor.setSelection).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('emits Chinese IME text only after composition ends', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: '', path: 'inbox/chinese' } })
    mocks.compositionStartListeners.forEach((fn) => fn())
    mocks.model.value = '中文输入'
    mocks.changeListeners.forEach((fn) => fn())
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    mocks.compositionEndListeners.forEach((fn) => fn())
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:modelValue')).toEqual([['中文输入']])
    wrapper.unmount()
  })

  it('resolves relative Wiki Links before marking them missing', () => {
    const wrapper = mount(EditorPane, {
      props: {
        modelValue: '[[note]] and [[missing]]',
        path: 'folder/source',
        linkTargets: [{ path: 'folder/note', title: 'Note' }],
      },
    })
    const calls = (mocks.editor.deltaDecorations as unknown as {
      mock: { calls: Array<[unknown, unknown]> }
    }).mock.calls
    const decorations = calls.at(-1)?.[1] as Array<{
      options: { inlineClassName?: string }
    }>
    expect(decorations.map((item) => item.options.inlineClassName)).toContain('monaco-md-link')
    expect(decorations.map((item) => item.options.inlineClassName)).toContain('monaco-md-link-invalid')
    wrapper.unmount()
  })

  it('disables expensive editor features for large documents', async () => {
    const wrapper = mount(EditorPane, { props: { modelValue: 'x'.repeat(500_000), path: 'inbox/large' } })
    const create = (await import('monaco-editor/esm/vs/editor/editor.api.js')).editor.create as any
    expect(create.mock.calls.at(-1)?.[1]).toMatchObject({ folding: false })
    wrapper.unmount()
  })
})
