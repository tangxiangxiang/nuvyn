import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  useHandleLibrary,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw'
import type {
  AppState,
  BinaryFiles,
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  LibraryItems,
} from '@excalidraw/excalidraw/types'
import type { FileId, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import '@excalidraw/excalidraw/index.css'
import { BoardReactErrorBoundary } from './ReactErrorBoundary'
import type { BoardRuntimeAsset, ExcalidrawRuntimeScene } from '../types'
import type { BoardMaterial } from '../../../../../shared/boardMaterialProtocol'
import {
  boardLibraryPersistenceAdapter,
  createBoardLibraryInstallHashGuard,
  currentBoardLibraryReturnUrl,
  persistBoardLibraryItems,
} from '../../library/libraryIntegration'

export type ExcalidrawIslandTheme = 'light' | 'dark'
export type ExcalidrawIslandLangCode = 'zh-CN' | 'en'

export interface BoardEditorMenuOptions {
  title: string
  saveStatusLabel: string
  favorite: boolean
  busy: boolean
  labels: {
    back: string
    rename: string
    favorite: string
    unfavorite: string
    exportPng: string
    exportSvg: string
    copy: string
    delete: string
    materials: string
    titleInput: string
  }
  onBack: () => void
  onRename: (title: string) => Promise<boolean>
  onToggleFavorite: () => void
  onExportPng: () => void
  onExportSvg: () => void
  onCopy: () => void
  onDelete: () => void
  onOpenMaterials: () => void
}

export interface ExcalidrawIslandMountOptions {
  container: HTMLElement
  initialScene: ExcalidrawRuntimeScene
  theme: ExcalidrawIslandTheme
  langCode: ExcalidrawIslandLangCode
  libraryReturnUrl?: string
  editorMenu?: BoardEditorMenuOptions
  onChange?: (scene: ExcalidrawRuntimeScene) => void
  onAssetsChanged?: (assets: readonly BoardRuntimeAsset[]) => void
  onAssetError?: (error: unknown) => void
  onLibrarySaveError?: (error: unknown) => void
  onApiReady?: (api: ExcalidrawImperativeAPI) => void
  onReady?: () => void
  onError?: (error: unknown) => void
}

export interface ExcalidrawIslandHandle {
  update(options: { theme: ExcalidrawIslandTheme, langCode: ExcalidrawIslandLangCode, editorMenu?: BoardEditorMenuOptions }): void
  insertSvgMaterial(material: BoardMaterial): Promise<void>
  unmount(): void
}

type ExcalidrawIslandRenderOptions = Omit<ExcalidrawIslandMountOptions, 'container'>

function BoardEditorMainMenu({ menu }: { menu: BoardEditorMenuOptions }): React.ReactNode {
  const [renaming, setRenaming] = React.useState(false)
  const [draftTitle, setDraftTitle] = React.useState(menu.title)
  const [renameBusy, setRenameBusy] = React.useState(false)
  const cancelRename = React.useRef(false)
  const composing = React.useRef(false)
  const renameSubmitting = React.useRef(false)

  React.useEffect(() => {
    if (!renaming) setDraftTitle(menu.title)
  }, [menu.title, renaming])

  const submitRename = async (): Promise<void> => {
    if (renameSubmitting.current) return
    const title = draftTitle.trim()
    if (!title || title === menu.title) {
      setDraftTitle(menu.title)
      setRenaming(false)
      return
    }
    renameSubmitting.current = true
    setRenameBusy(true)
    try {
      const renamed = await menu.onRename(title)
      if (renamed) setRenaming(false)
    } catch {
      // The parent owns the user-facing error notification. Keep the menu
      // usable if an integration callback rejects unexpectedly.
    } finally {
      renameSubmitting.current = false
      setRenameBusy(false)
    }
  }

  return React.createElement(
    MainMenu,
    null,
    React.createElement(
      MainMenu.ItemCustom,
      { className: 'nuvyn-board-menu-heading', children: React.createElement(
        'div',
        { style: { display: 'grid', gap: '4px', padding: '4px 2px 8px' } },
        renaming
          ? React.createElement('input', {
              value: draftTitle,
              autoFocus: true,
              disabled: renameBusy,
              'aria-label': menu.labels.titleInput,
              'data-testid': 'board-editor-title-input',
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraftTitle(event.target.value),
              onCompositionStart: () => { composing.current = true },
              onCompositionEnd: () => { composing.current = false },
              onBlur: () => {
                if (cancelRename.current || composing.current) {
                  cancelRename.current = false
                  return
                }
                void submitRename()
              },
              onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') {
                  if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
                  event.preventDefault()
                  void submitRename()
                  return
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelRename.current = true
                  setDraftTitle(menu.title)
                  setRenaming(false)
                }
              },
              style: {
                width: '100%', boxSizing: 'border-box', padding: '7px 9px', border: '1px solid var(--color-primary)',
                borderRadius: '6px', background: 'var(--island-bg-color)', color: 'var(--text-primary-color)', font: 'inherit', fontWeight: 600,
              },
            })
          : React.createElement('button', {
              type: 'button',
              title: menu.labels.rename,
              'data-testid': 'board-editor-title',
              onClick: () => setRenaming(true),
              style: {
                overflow: 'hidden', padding: 0, border: 0, background: 'transparent', color: 'inherit',
                font: 'inherit', fontWeight: 650, textAlign: 'left', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text',
              },
            }, menu.title),
        React.createElement('span', {
          'data-testid': 'board-editor-menu-save-status',
          style: { color: 'var(--text-secondary-color)', fontSize: '12px' },
        }, menu.saveStatusLabel),
      ) },
    ),
    React.createElement(MainMenu.Item, { onSelect: menu.onBack, children: menu.labels.back }),
    React.createElement(MainMenu.Item, { onSelect: menu.onOpenMaterials, disabled: menu.busy, children: menu.labels.materials }),
    React.createElement(MainMenu.Separator),
    React.createElement(MainMenu.Item, {
      onSelect: (event) => {
        event.preventDefault()
        cancelRename.current = false
        setRenaming(true)
      },
      disabled: menu.busy,
      children: menu.labels.rename,
    }),
    React.createElement(MainMenu.Item, { onSelect: menu.onToggleFavorite, disabled: menu.busy, children: menu.favorite ? menu.labels.unfavorite : menu.labels.favorite }),
    React.createElement(MainMenu.Separator),
    React.createElement(MainMenu.Item, { onSelect: menu.onExportPng, disabled: menu.busy, children: menu.labels.exportPng }),
    React.createElement(MainMenu.Item, { onSelect: menu.onExportSvg, disabled: menu.busy, children: menu.labels.exportSvg }),
    React.createElement(MainMenu.Item, { onSelect: menu.onCopy, disabled: menu.busy, children: menu.labels.copy }),
    React.createElement(MainMenu.Separator),
    React.createElement(MainMenu.Item, {
      onSelect: menu.onDelete,
      disabled: menu.busy,
      style: { color: 'var(--color-danger)' },
      children: menu.labels.delete,
    }),
    React.createElement(MainMenu.Separator),
    React.createElement(MainMenu.DefaultItems.Preferences),
    React.createElement(MainMenu.Separator),
    React.createElement(MainMenu.DefaultItems.ToggleTheme, { allowSystemTheme: false }),
    React.createElement(MainMenu.DefaultItems.ChangeCanvasBackground),
  )
}

function dataUrlToBlob(dataUrl: string, mimeType: string): Blob {
  const separator = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || separator < 0) {
    throw new Error('Excalidraw returned an unsupported image data URL')
  }
  const metadata = dataUrl.slice(5, separator)
  const encoded = dataUrl.slice(separator + 1)
  if (metadata.split(';').includes('base64')) {
    if (typeof atob !== 'function') throw new Error('Browser base64 support is unavailable')
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: mimeType })
  }
  return new Blob([decodeURIComponent(encoded)], { type: mimeType })
}

function runtimeAssets(files: BinaryFiles): BoardRuntimeAsset[] {
  return Object.entries(files).map(([fileKey, file]) => {
    const engineFileId = typeof file.id === 'string' && file.id.length > 0 ? file.id : fileKey
    return {
      engineFileId,
      mimeType: file.mimeType,
      blob: dataUrlToBlob(file.dataURL, file.mimeType),
    }
  })
}

function boardMaterialDataUrl(svg: string): DataURL {
  if (typeof btoa !== 'function') throw new Error('Browser base64 support is unavailable')
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}` as DataURL
}

export function numericSvgAttribute(attributes: string, name: string): number | null {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))
  if (!match) return null
  const raw = match[2]?.trim() ?? ''
  const lengthMatch = raw.match(/^([+]?(?:\d+(?:\.\d+)?|\.\d+))(?:\s*px)?$/i)
  if (!lengthMatch) return null
  const value = Number(lengthMatch[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

export function svgIntrinsicDimensions(svg: string): { width: number; height: number } {
  const root = svg.match(/<svg\b([^>]*)>/i)
  const attributes = root?.[1] ?? ''
  const width = numericSvgAttribute(attributes, 'width')
  const height = numericSvgAttribute(attributes, 'height')
  const viewBoxMatch = attributes.match(/(?:^|\s)viewBox\s*=\s*(["'])(.*?)\1/i)
  const viewBox = viewBoxMatch?.[2]?.trim().split(/[\s,]+/).map(Number) ?? []
  const viewBoxWidth = viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2]! > 0 ? viewBox[2]! : null
  const viewBoxHeight = viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3]! > 0 ? viewBox[3]! : null

  if (width && height) return { width, height }
  if (width && viewBoxWidth && viewBoxHeight) return { width, height: width * viewBoxHeight / viewBoxWidth }
  if (height && viewBoxWidth && viewBoxHeight) return { width: height * viewBoxWidth / viewBoxHeight, height }
  if (viewBoxWidth && viewBoxHeight) return { width: viewBoxWidth, height: viewBoxHeight }
  return { width: 320, height: 240 }
}

function nextMaterialFileId(): FileId {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `nuvyn-material-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return id as FileId
}

function insertBoardMaterialIntoScene(api: ExcalidrawImperativeAPI, material: BoardMaterial): void {
  const intrinsic = svgIntrinsicDimensions(material.svg)
  const appState = api.getAppState()
  const zoom = appState.zoom.value || 1
  const viewportWidth = appState.width > 0 ? appState.width : 800
  const viewportHeight = appState.height > 0 ? appState.height : 600
  const maxVisibleEdge = Math.max(160, Math.min(640, Math.min(viewportWidth, viewportHeight) * 0.5 / zoom))
  const scale = Math.min(1, maxVisibleEdge / Math.max(intrinsic.width, intrinsic.height))
  const width = intrinsic.width * scale
  const height = intrinsic.height * scale
  const center = viewportCoordsToSceneCoords({
    clientX: appState.offsetLeft + viewportWidth / 2,
    clientY: appState.offsetTop + viewportHeight / 2,
  }, appState)
  const fileId = nextMaterialFileId()
  const file: BinaryFileData = {
    id: fileId,
    mimeType: 'image/svg+xml',
    dataURL: boardMaterialDataUrl(material.svg),
    created: Date.now(),
    lastRetrieved: Date.now(),
    version: 1,
  }
  const [element] = convertToExcalidrawElements([{
    type: 'image',
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
    fileId,
    status: 'saved',
  }], { regenerateIds: true })
  if (!element) throw new Error('Excalidraw did not create an image element')

  api.addFiles([file])
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), element],
    appState: { selectedElementIds: { [element.id]: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}

function ExcalidrawIslandContent({
  theme,
  langCode,
  initialScene,
  libraryReturnUrl,
  onChange,
  onAssetsChanged,
  onAssetError,
  onLibrarySaveError,
  onReady,
  onError,
  editorMenu,
  onApiReady,
}: ExcalidrawIslandRenderOptions): React.ReactNode {
  const [excalidrawAPI, setExcalidrawAPI] = React.useState<ExcalidrawImperativeAPI | null>(null)
  const handleExcalidrawAPI = React.useCallback((api: ExcalidrawImperativeAPI | null): void => {
    setExcalidrawAPI((currentAPI) => currentAPI === api ? currentAPI : api)
    if (api) onApiReady?.(api)
  }, [onApiReady])
  const handleExcalidrawInitialize = React.useCallback((api: ExcalidrawImperativeAPI): void => {
    setExcalidrawAPI((currentAPI) => currentAPI === api ? currentAPI : api)
    onApiReady?.(api)
    onReady?.()
  }, [onApiReady, onReady])
  const handleLibraryChange = React.useCallback((libraryItems: LibraryItems): void => {
    // The official adapter also receives Library updates through
    // useHandleLibrary. This callback is the full-snapshot safety net for
    // metadata-only changes (for example rename/status updates) and shares
    // the adapter's serialized write queue, so it does not duplicate writes.
    void persistBoardLibraryItems(libraryItems, onLibrarySaveError).catch(() => {})
  }, [onLibrarySaveError])

  // Excalidraw owns the Library protocol: this hook handles both an
  // addLibrary hash that exists during the first mount and later hashchange
  // callbacks from libraries.excalidraw.com. The adapter keeps that same
  // official LibraryItems shape in Nuvyn' user-level store.
  useHandleLibrary({
    excalidrawAPI,
    adapter: boardLibraryPersistenceAdapter,
  })

  const handleChange = React.useCallback((elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    try {
      // This callback runs before the Vue bridge receives the scene. The
      // Asset Session can therefore make the pending Blob durable before a
      // checkpoint is ever scheduled for this onChange payload.
      onAssetsChanged?.(runtimeAssets(files))
    } catch (error) {
      onAssetError?.(error)
      return
    }
    onChange?.({
      elements: [...elements],
      appState: appState as unknown as Readonly<Record<string, unknown>>,
      files: files as unknown as Readonly<Record<string, unknown>>,
    })
  }, [onAssetError, onAssetsChanged, onChange])

  const initialData: ExcalidrawInitialDataState = {
    elements: initialScene.elements as readonly OrderedExcalidrawElement[],
    appState: initialScene.appState as Partial<AppState>,
    files: initialScene.files as BinaryFiles,
  }

  return React.createElement(
    BoardReactErrorBoundary,
    { onError },
    React.createElement(Excalidraw, {
      theme,
      langCode,
      libraryReturnUrl,
      initialData,
      onExcalidrawAPI: handleExcalidrawAPI,
      onInitialize: handleExcalidrawInitialize,
      onLibraryChange: handleLibraryChange,
      onChange: handleChange,
      isCollaborating: false,
      aiEnabled: false,
      UIOptions: {
        tools: { image: true },
        canvasActions: { export: false, saveToActiveFile: false },
      },
    }, editorMenu ? React.createElement(BoardEditorMainMenu, { menu: editorMenu }) : null),
  )
}

function renderIsland(root: Root, options: ExcalidrawIslandRenderOptions): void {
  root.render(React.createElement(ExcalidrawIslandContent, options))
}

export async function mountExcalidrawIsland(
  options: ExcalidrawIslandMountOptions,
): Promise<ExcalidrawIslandHandle> {
  const root = createRoot(options.container)
  let mounted = true
  let currentTheme = options.theme
  let currentLangCode = options.langCode
  let currentEditorMenu = options.editorMenu
  let currentAPI: ExcalidrawImperativeAPI | null = null
  let resolveAPI: ((api: ExcalidrawImperativeAPI) => void) | null = null
  const apiReady = new Promise<ExcalidrawImperativeAPI>((resolve) => {
    resolveAPI = resolve
  })
  const libraryReturnUrl = options.libraryReturnUrl ?? currentBoardLibraryReturnUrl()
  const libraryInstallHashGuard = createBoardLibraryInstallHashGuard()

  const render = (): void => {
    renderIsland(root, {
      theme: currentTheme,
      langCode: currentLangCode,
      libraryReturnUrl,
      editorMenu: currentEditorMenu,
      initialScene: options.initialScene,
      onChange: options.onChange,
      onAssetsChanged: options.onAssetsChanged,
      onAssetError: options.onAssetError,
      onLibrarySaveError: options.onLibrarySaveError,
      onReady: options.onReady,
      onError: options.onError,
      onApiReady: (api) => {
        currentAPI = api
        resolveAPI?.(api)
        resolveAPI = null
      },
    })
  }

  render()

  return {
    update(nextOptions): void {
      if (!mounted) return
      currentTheme = nextOptions.theme
      currentLangCode = nextOptions.langCode
      currentEditorMenu = nextOptions.editorMenu
      render()
    },
    async insertSvgMaterial(material: BoardMaterial): Promise<void> {
      if (!mounted) throw new Error('Excalidraw is no longer mounted')
      const api = currentAPI ?? await apiReady
      if (!mounted || api.isDestroyed) throw new Error('Excalidraw is no longer available')
      insertBoardMaterialIntoScene(api, material)
    },
    unmount(): void {
      if (!mounted) return
      mounted = false
      currentAPI = null
      libraryInstallHashGuard.dispose()
      root.unmount()
    },
  }
}
