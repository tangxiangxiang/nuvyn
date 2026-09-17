import type { BinaryFiles, AppState } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement, NonDeleted } from '@excalidraw/excalidraw/element/types'

export interface ExcalidrawExportRuntime {
  readonly elements: readonly unknown[]
  readonly appState: Readonly<Record<string, unknown>>
  readonly files: Readonly<Record<string, unknown>>
}

export const EXCALIDRAW_THUMBNAIL_MAX_EDGE = 640

interface ExportOptions {
  readonly maxWidthOrHeight?: number
}

interface ExcalidrawExportModule {
  exportToBlob: (options: {
    elements: readonly NonDeleted<ExcalidrawElement>[]
    appState?: Partial<Omit<AppState, 'offsetTop' | 'offsetLeft'>>
    files: BinaryFiles | null
    maxWidthOrHeight?: number
    mimeType?: string
    exportPadding?: number
  }) => Promise<Blob>
  exportToSvg: (options: {
    elements: readonly NonDeleted<ExcalidrawElement>[]
    appState?: Partial<Omit<AppState, 'offsetTop' | 'offsetLeft'>>
    files: BinaryFiles | null
    exportPadding?: number
  }) => Promise<SVGSVGElement>
}

async function loadExcalidrawExportModule(): Promise<ExcalidrawExportModule> {
  // Keep the heavyweight Excalidraw runtime behind the Board editor's lazy
  // boundary. Board Home and the shared application shell must not import it
  // merely to render metadata or search results.
  return import('@excalidraw/excalidraw') as unknown as Promise<ExcalidrawExportModule>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exportElements(runtime: ExcalidrawExportRuntime): readonly NonDeleted<ExcalidrawElement>[] {
  return runtime.elements.filter((element) => (
    isRecord(element) && element.isDeleted !== true
  )) as readonly NonDeleted<ExcalidrawElement>[]
}

function exportAppState(runtime: ExcalidrawExportRuntime): Partial<Omit<AppState, 'offsetTop' | 'offsetLeft'>> {
  const source = runtime.appState
  const appState: Record<string, unknown> = {
    // A thumbnail/export should show the scene background, not the transparent
    // editor viewport. The color still comes from the persisted scene state.
    exportBackground: true,
  }
  if (isRecord(source.zoom)) appState.zoom = source.zoom
  else if (typeof source.zoom === 'number' && Number.isFinite(source.zoom)) appState.zoom = { value: source.zoom }
  for (const key of ['scrollX', 'scrollY', 'gridSize', 'viewBackgroundColor'] as const) {
    const value = source[key]
    if (value !== undefined) appState[key] = value
  }
  return appState as Partial<Omit<AppState, 'offsetTop' | 'offsetLeft'>>
}

function exportOptions(runtime: ExcalidrawExportRuntime, options: ExportOptions = {}) {
  return {
    elements: exportElements(runtime),
    appState: exportAppState(runtime),
    files: runtime.files as BinaryFiles,
    maxWidthOrHeight: options.maxWidthOrHeight,
    exportPadding: 16,
  }
}

export async function exportExcalidrawPng(
  runtime: ExcalidrawExportRuntime,
  options: ExportOptions = {},
): Promise<Blob> {
  const { exportToBlob } = await loadExcalidrawExportModule()
  const blob = await exportToBlob({
    ...exportOptions(runtime, options),
    mimeType: 'image/png',
  })
  return blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' })
}

export async function exportExcalidrawSvg(
  runtime: ExcalidrawExportRuntime,
): Promise<Blob> {
  const { exportToSvg } = await loadExcalidrawExportModule()
  const svg = await exportToSvg(exportOptions(runtime))
  return new Blob([svg.outerHTML], { type: 'image/svg+xml;charset=utf-8' })
}
