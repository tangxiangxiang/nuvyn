// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const reactMocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
  render: vi.fn(),
  unmount: vi.fn(),
  useState: vi.fn((initial: unknown) => [initial, vi.fn()]),
}))

const libraryMocks = vi.hoisted(() => ({
  useHandleLibrary: vi.fn(),
}))

const excalidrawMocks = vi.hoisted(() => ({
  convertToExcalidrawElements: vi.fn(() => [{ id: 'material-image-1' }]),
  viewportCoordsToSceneCoords: vi.fn(() => ({ x: 100, y: 100 })),
}))

vi.mock('react-dom/client', () => ({
  createRoot: reactMocks.createRoot,
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return {
    ...actual,
    useCallback: (callback: (...args: never[]) => unknown) => callback,
    useState: reactMocks.useState,
  }
})

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: 'div',
  CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY' },
  convertToExcalidrawElements: excalidrawMocks.convertToExcalidrawElements,
  viewportCoordsToSceneCoords: excalidrawMocks.viewportCoordsToSceneCoords,
  MainMenu: Object.assign('main-menu', {
    Item: 'menu-item',
    ItemCustom: 'menu-item-custom',
    Separator: 'menu-separator',
    DefaultItems: {
      Preferences: 'preferences',
      ToggleTheme: 'toggle-theme',
      ChangeCanvasBackground: 'change-background',
    },
  }),
  useHandleLibrary: libraryMocks.useHandleLibrary,
}))

import { mountExcalidrawIsland, numericSvgAttribute, svgIntrinsicDimensions } from '../reactIsland'

const initialScene = { elements: [], appState: {}, files: {} }
const makeSvg = (attributes: string, content = ''): string => ['<', 'svg', ` ${attributes}>`, content, '</', 'svg>'].join('')

afterEach(() => {
  reactMocks.createRoot.mockReset()
  reactMocks.render.mockReset()
  reactMocks.unmount.mockReset()
  reactMocks.useState.mockClear()
  libraryMocks.useHandleLibrary.mockClear()
  excalidrawMocks.convertToExcalidrawElements.mockClear()
  excalidrawMocks.viewportCoordsToSceneCoords.mockClear()
})

describe('mountExcalidrawIsland', () => {
  it('mounts, updates theme without recreating the root, and unmounts idempotently', async () => {
    reactMocks.createRoot.mockReturnValue({ render: reactMocks.render, unmount: reactMocks.unmount })
    const container = document.createElement('div')
    const onError = vi.fn()
    const island = await mountExcalidrawIsland({ container, initialScene, theme: 'light', langCode: 'en', onError })

    expect(reactMocks.createRoot).toHaveBeenCalledWith(container)
    expect(reactMocks.render).toHaveBeenCalledOnce()
    island.update({ theme: 'dark', langCode: 'en' })
    expect(reactMocks.createRoot).toHaveBeenCalledOnce()
    expect(reactMocks.render).toHaveBeenCalledTimes(2)

    island.unmount()
    island.unmount()
    expect(reactMocks.unmount).toHaveBeenCalledOnce()
  })

  it('leaves image file drops available to Excalidraw', async () => {
    reactMocks.createRoot.mockReturnValue({ render: reactMocks.render, unmount: reactMocks.unmount })
    const container = document.createElement('div')
    const onError = vi.fn()
    const onAssetsChanged = vi.fn()
    const island = await mountExcalidrawIsland({ container, initialScene, theme: 'light', langCode: 'en', onError, onAssetsChanged })
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } })

    container.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    expect(onAssetsChanged).not.toHaveBeenCalled()

    island.unmount()
    const laterEvent = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(laterEvent, 'dataTransfer', { value: { types: ['Files'] } })
    container.dispatchEvent(laterEvent)
    expect(onAssetsChanged).not.toHaveBeenCalled()
  })

  it('enables the Excalidraw image tool and does not override paste handling', async () => {
    reactMocks.createRoot.mockReturnValue({ render: reactMocks.render, unmount: reactMocks.unmount })
    const container = document.createElement('div')
    const onError = vi.fn()
    await mountExcalidrawIsland({ container, initialScene, theme: 'light', langCode: 'en', onError })

    const renderedContent = reactMocks.render.mock.calls[0][0] as {
      type: (props: unknown) => { props: { children: { props: { onPaste?: unknown; UIOptions?: { tools?: { image?: boolean } } } } } }
      props: unknown
    }
    const renderedBoundary = renderedContent.type(renderedContent.props)

    expect(renderedBoundary.props.children.props.onPaste).toBeUndefined()
    expect(renderedBoundary.props.children.props.UIOptions?.tools?.image).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })

  it('connects the Excalidraw API to the official Library handler and return URL', async () => {
    reactMocks.createRoot.mockReturnValue({ render: reactMocks.render, unmount: reactMocks.unmount })
    const container = document.createElement('div')
    const onReady = vi.fn()
    await mountExcalidrawIsland({
      container,
      initialScene,
      theme: 'light',
      langCode: 'en',
      libraryReturnUrl: 'https://nuvyn.example/board/board-1',
      onReady,
    })

    const renderedContent = reactMocks.render.mock.calls[0][0] as {
      type: (props: unknown) => { props: { children: { props: Record<string, unknown> } } }
      props: unknown
    }
    const renderedBoundary = renderedContent.type(renderedContent.props)
    const excalidrawProps = renderedBoundary.props.children.props
    const api = { id: 'excalidraw-api-1' }

    expect(libraryMocks.useHandleLibrary).toHaveBeenCalledWith({
      excalidrawAPI: null,
      adapter: expect.anything(),
    })
    expect(excalidrawProps.libraryReturnUrl).toBe('https://nuvyn.example/board/board-1')
    expect(excalidrawProps.onLibraryChange).toEqual(expect.any(Function))
    ;(excalidrawProps.onExcalidrawAPI as (value: unknown) => void)(api)
    expect(onReady).not.toHaveBeenCalled()
    ;(excalidrawProps.onInitialize as (value: unknown) => void)(api)
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('bridges runtime BinaryFiles as engine-neutral Blobs before onChange', async () => {
    reactMocks.createRoot.mockReturnValue({ render: reactMocks.render, unmount: reactMocks.unmount })
    const container = document.createElement('div')
    const onChange = vi.fn()
    const onAssetsChanged = vi.fn()
    await mountExcalidrawIsland({ container, initialScene, theme: 'light', langCode: 'en', onChange, onAssetsChanged })

    const renderedContent = reactMocks.render.mock.calls[0][0] as {
      type: (props: unknown) => { props: { children: { props: { onChange: (elements: unknown[], appState: unknown, files: unknown) => void } } } }
      props: unknown
    }
    const renderedBoundary = renderedContent.type(renderedContent.props)
    const file = {
      id: 'engine-file-1',
      dataURL: 'data:image/png;base64,aGk=',
      mimeType: 'image/png',
      created: 1,
    }
    const elements = [{ id: 'shape' }]
    const appState = { zoom: { value: 0.8 } }
    const files = { 'engine-file-1': file }
    renderedBoundary.props.children.props.onChange(elements, appState, files)

    expect(onAssetsChanged).toHaveBeenCalledWith([expect.objectContaining({
      engineFileId: 'engine-file-1',
      mimeType: 'image/png',
      blob: expect.any(Blob),
    })])
    expect(onChange).toHaveBeenCalledWith({ elements, appState, files })
  })

  it('inserts a saved SVG material through the official Excalidraw scene API', async () => {
    reactMocks.createRoot.mockReturnValue({ render: reactMocks.render, unmount: reactMocks.unmount })
    const container = document.createElement('div')
    const island = await mountExcalidrawIsland({ container, initialScene, theme: 'light', langCode: 'en' })
    const renderedContent = reactMocks.render.mock.calls[0][0] as {
      type: (props: unknown) => { props: { children: { props: Record<string, unknown> } } }
      props: unknown
    }
    const renderedBoundary = renderedContent.type(renderedContent.props)
    const excalidrawProps = renderedBoundary.props.children.props
    const api = {
      isDestroyed: false,
      getAppState: () => ({
        zoom: { value: 1 },
        width: 800,
        height: 600,
        offsetLeft: 0,
        offsetTop: 0,
      }),
      getSceneElementsIncludingDeleted: () => [{ id: 'existing-element' }],
      addFiles: vi.fn(),
      updateScene: vi.fn(),
    }
    ;(excalidrawProps.onExcalidrawAPI as (value: unknown) => void)(api)

    await island.insertSvgMaterial({
      id: 'material-1',
      name: 'Arrow',
      kind: 'svg',
      svg: '<svg viewBox="0 0 16 16"><path d="M0 8h16" /></svg>',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    })

    expect(excalidrawMocks.viewportCoordsToSceneCoords).toHaveBeenCalledOnce()
    expect(excalidrawMocks.convertToExcalidrawElements).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'image',
        fileId: expect.any(String),
        status: 'saved',
      }),
    ], { regenerateIds: true })
    expect(api.addFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        mimeType: 'image/svg+xml',
        dataURL: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      }),
    ])
    expect(api.updateScene).toHaveBeenCalledWith({
      elements: [{ id: 'existing-element' }, { id: 'material-image-1' }],
      appState: { selectedElementIds: { 'material-image-1': true } },
      captureUpdate: 'IMMEDIATELY',
    })
  })

  it('accepts only unitless and px SVG dimensions', () => {
    const attributes = [
      'width="24"',
      'width="24px"',
      'width="24PX"',
      'width="24.5"',
      'width=" 24 px "',
    ]
    expect(attributes.map((value) => numericSvgAttribute(value, 'width'))).toEqual([24, 24, 24, 24.5, 24])

    for (const value of ['100%', '2em', '2rem', '24pt', '1in', '10vw', 'auto', 'calc(100% - 1px)', '0', '-10', 'abc']) {
      expect(numericSvgAttribute(`width="${value}"`, 'width')).toBeNull()
    }
  })

  it.each([
    [makeSvg('width="400" height="200"'), { width: 400, height: 200 }],
    [makeSvg('width="400px" height="200px"'), { width: 400, height: 200 }],
    [makeSvg('viewBox="0 0 400 200"'), { width: 400, height: 200 }],
    [makeSvg('width="100%" height="100%" viewBox="0 0 400 200"'), { width: 400, height: 200 }],
    [makeSvg('width="2em" height="1em" viewBox="0 0 400 200"'), { width: 400, height: 200 }],
    [makeSvg('width="24pt" height="12pt" viewBox="0 0 400 200"'), { width: 400, height: 200 }],
    [makeSvg('width="300" height="100%" viewBox="0 0 400 200"'), { width: 300, height: 150 }],
    [makeSvg('width="100%" height="150" viewBox="0 0 400 200"'), { width: 300, height: 150 }],
    [makeSvg('width="100%" height="100%"'), { width: 320, height: 240 }],
    [makeSvg('width="0" height="-10" viewBox="0 0 400 200"'), { width: 400, height: 200 }],
  ])('resolves SVG intrinsic dimensions for %s', (svg, expected) => {
    expect(svgIntrinsicDimensions(svg)).toEqual(expected)
  })

  it('preserves the viewBox aspect ratio for relative-unit material insertion', async () => {
    reactMocks.createRoot.mockReturnValue({ render: reactMocks.render, unmount: reactMocks.unmount })
    const container = document.createElement('div')
    const island = await mountExcalidrawIsland({ container, initialScene, theme: 'light', langCode: 'en' })
    const renderedContent = reactMocks.render.mock.calls[0][0] as {
      type: (props: unknown) => { props: { children: { props: Record<string, unknown> } } }
      props: unknown
    }
    const renderedBoundary = renderedContent.type(renderedContent.props)
    const excalidrawProps = renderedBoundary.props.children.props
    const api = {
      isDestroyed: false,
      getAppState: () => ({
        zoom: { value: 1 },
        width: 800,
        height: 600,
        offsetLeft: 0,
        offsetTop: 0,
      }),
      getSceneElementsIncludingDeleted: () => [],
      addFiles: vi.fn(),
      updateScene: vi.fn(),
    }
    ;(excalidrawProps.onExcalidrawAPI as (value: unknown) => void)(api)

    await island.insertSvgMaterial({
      id: 'material-relative-units',
      name: 'Relative units',
      kind: 'svg',
      svg: makeSvg('width="100%" height="100%" viewBox="0 0 400 200"', '<rect width="400" height="200" />'),
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    })

    const latestCall = excalidrawMocks.convertToExcalidrawElements.mock.calls[0] as unknown as [Array<{ width: number; height: number }>]
    const [imageInput] = latestCall[0]
    expect(imageInput!.width / imageInput!.height).toBe(2)
  })
})
