import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import type { Page, APIRequestContext } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { createDoc } from './helpers/edit-program'

test.use({ hasTouch: true })

const left = (page: Page) => page.getByTestId('left-panel-toggle')
const right = (page: Page) => page.locator('.right-rail-toggle')
const tab = (page: Page, path: string) => page.locator(`[role="tab"][data-tab-id="${path}"]`)
const openDocuments = (page: Page) => page.getByTestId('open-workspace-documents')
const openDocument = (page: Page, path: string) => page.locator(`[data-workspace-document-id="${path}"]`)

async function ensureLeftDrawerOpen(page: Page) {
  if (await left(page).getAttribute('aria-pressed') !== 'true') await left(page).tap()
  await expect(page.locator('.file-tree')).toBeVisible()
}

async function expandOpenDocuments(page: Page) {
  const toggle = openDocuments(page).locator('.open-workspace-documents-toggle')
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.tap()
  await expect(openDocuments(page).locator('.open-workspace-document').first()).toBeVisible()
}

async function seed(request: APIRequestContext) {
  const id = randomUUID().slice(0, 8)
  const paths = [`inbox/tablet-a-${id}`, `inbox/tablet-b-${id}`]
  const created: string[] = []
  const raw = [
    '# Tablet reading', '', `[[${paths[1]}#destination|Next note]]`, '',
    `| ${Array.from({ length: 24 }, (_, i) => `Column ${i}`).join(' | ')} |`,
    `| ${Array(24).fill('---').join(' | ')} |`,
    `| ${Array(24).fill('Wide cell content').join(' | ')} |`, '',
    '```text', 'wide '.repeat(150), '```', '',
    '![Image](/logo-48.png)', '',
    '::: details Touch details', '', 'Details content', '', ':::', '',
    '::: code-group', '```ts [One]', 'const one = 1', '```',
    '```js [Two]', 'const two = 2', '```', ':::', '',
    '## Middle', '', 'Paragraph\n\n'.repeat(40), '## Destination', '', 'Target content',
  ].join('\n')
  await createDoc(request, paths[0]!, raw, created)
  await createDoc(request, paths[1]!, '# Second note\n\n## Destination\n\nLinked target', created)
  return { paths, async cleanup() { for (const path of created) await request.delete(`/api/posts/${path}`) } }
}

async function read(page: Page, path: string) {
  await page.goto(`/vault/${path}`)
  const width = page.viewportSize()!.width
  if (width > 600 && width < 1200) {
    await expect(page.locator('.editor-tabs-shell')).toHaveCount(0)
    await expect(page.locator('.editor-area')).toHaveClass(/is-no-tab-strip/)
  } else {
    await expect(tab(page, path)).toHaveAttribute('aria-selected', 'true')
  }
  // Mobile direct routes remain accessible through their existing controls;
  // they intentionally retain the pre-tablet sidebar policy.
  if (page.viewportSize()!.width <= 600) {
    if (await left(page).getAttribute('aria-pressed') === 'true') await left(page).click()
    if (await right(page).getAttribute('aria-pressed') === 'true') await right(page).click()
  }
  if (!await page.locator('.reading-pane').isVisible()) await page.getByTestId('view-toggle').click()
  await expect(page.locator('.reading-pane h1')).toBeVisible()
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

for (const [width, height] of [[390, 844], [600, 900], [601, 900], [768, 1024], [820, 1180], [1024, 768], [1180, 820], [1199, 900], [1200, 900], [1440, 900]]) {
  test(`Note viewport boundary ${width}x${height}`, async ({ page, request }) => {
    await page.setViewportSize({ width: width!, height: height! })
    const f = await seed(request)
    try {
      await read(page, f.paths[0]!)
      const note = page.locator('.scope-chip').filter({ hasText: 'note' })
      await expect(note).toHaveCount(width! <= 600 ? 0 : 1)
      await expect(page.locator('.workspace-board-link')).toHaveCount(width! <= 600 ? 0 : 1)
      if (width! > 600 && width! < 1200) {
        await expect(page.locator('.vault')).toHaveClass(/note-tablet-mode/)
        await expect(page.locator('.editor-tabs-shell')).toHaveCount(0)
        const editorArea = await page.locator('.editor-area').boundingBox()
        const content = await page.locator('.reading-content').boundingBox()
        expect(content?.y).toBe(editorArea?.y)
        await expect(left(page)).toHaveAttribute('aria-pressed', 'false')
        await expect(right(page)).toHaveAttribute('aria-pressed', 'false')
        const before = await page.locator('.editor-area').boundingBox()
        await left(page).tap()
        await expect(page.locator('.file-tree')).toBeVisible()
        await expect(openDocuments(page)).toBeVisible()
        await expect(openDocuments(page).locator('.open-workspace-documents-toggle')).toHaveAttribute('aria-expanded', 'false')
        expect((await page.locator('.editor-area').boundingBox())?.width).toBe(before?.width)
        await right(page).tap()
        await expect(left(page)).toHaveAttribute('aria-pressed', 'false')
        await expect(page.locator('.right-rail')).toBeVisible()
        expect((await page.locator('.editor-area').boundingBox())?.width).toBe(before?.width)
        await page.getByTestId('note-tablet-backdrop').click({ position: { x: 10, y: 100 } })
        await expect(right(page)).toHaveAttribute('aria-pressed', 'false')
        await expect(right(page)).toBeFocused()
        await noPageOverflow(page)
        expect(await page.locator('.vault').evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true)
      } else {
        await expect(page.locator('.vault')).not.toHaveClass(/note-tablet-mode/)
      }
    } finally { await f.cleanup() }
  })
}

for (const viewport of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
  test(`tablet navigation, TOC, touch content and desktop isolation at ${viewport.width}`, async ({ page, request }, testInfo) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    const f = await seed(request)
    try {
      await read(page, f.paths[0]!)
      const stored = await page.evaluate(() => localStorage.getItem('nuvyn.vault.layout'))
      const desktopColumns = await page.locator('.vault').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
      await page.setViewportSize(viewport)
      await expect(page.locator('.vault')).toHaveClass(/note-tablet-mode/)
      await page.screenshot({ path: testInfo.outputPath('reading.png') })
      await left(page).tap()
      await page.screenshot({ path: testInfo.outputPath('left-navigation.png') })
      await page.locator('.activity-bar button').nth(1).tap()
      await expect(page.locator('.tag-panel')).toBeVisible()
      await page.locator('.activity-bar button').nth(2).tap()
      await expect(page.locator('.history-panel')).toBeVisible()
      await page.locator('.activity-bar button').first().tap()
      await page.keyboard.press('Escape')
      await expect(left(page)).toBeFocused()
      await right(page).tap()
      await page.screenshot({ path: testInfo.outputPath('right-outline.png') })
      await page.locator('.toc-panel-link').filter({ hasText: 'Destination' }).tap()
      await expect(right(page)).toHaveAttribute('aria-pressed', 'false')
      await expect(page.locator('.reading-pane #destination')).toBeInViewport()
      await right(page).tap()
      await expect(page.locator('.toc-panel-link[aria-current="location"]')).toContainText('Destination')
      await page.keyboard.press('Escape')
      await expect(right(page)).toHaveAttribute('aria-pressed', 'false')
      await page.locator('.reading-pane').evaluate((el) => { el.scrollTop = 0 })
      await page.locator('summary').filter({ hasText: 'Touch details' }).tap()
      await expect(page.locator('details')).toHaveAttribute('open', '')
      await page.getByRole('tab', { name: 'Two', exact: true }).tap()
      await expect(page.locator('.nuvyn-code-group-panel.is-active')).toContainText('const two')
      await noPageOverflow(page)
      expect(await page.locator('.table-scroll').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
      await page.locator('.reading-pane').evaluate((el) => { el.scrollTop = 0 })
      await page.getByRole('link', { name: 'Next note', exact: true }).tap()
      await expect(page.locator('.reading-pane #destination')).toBeInViewport()
      await ensureLeftDrawerOpen(page)
      await expandOpenDocuments(page)
      await expect(openDocument(page, f.paths[1]!)).toHaveAttribute('data-tab-mode', 'preview')
      await openDocument(page, f.paths[1]!).locator('.open-workspace-document-select').tap()
      await expect(left(page)).toHaveAttribute('aria-pressed', 'false')
      await expect(page.locator('.reading-pane h1')).toHaveText('Second note')
      await ensureLeftDrawerOpen(page)
      await expandOpenDocuments(page)
      await openDocument(page, f.paths[1]!).getByRole('button', { name: /固定|Pin/ }).tap()
      await expect(openDocument(page, f.paths[1]!)).toHaveAttribute('data-tab-mode', 'pinned')
      await left(page).tap()
      await left(page).tap()
      await page.locator('.file-tree .search-input').fill(f.paths[0]!.split('/').at(-1)!)
      const row = page.locator(`[data-tree-key="file:${f.paths[0]}"]`)
      if (!await row.isVisible()) await page.locator('[data-tree-key="folder:inbox"] > .row-line').tap()
      await row.locator('.row-line').tap()
      await expect(page.locator('.reading-pane h1')).toHaveText('Tablet reading')
      await expect(left(page)).toHaveAttribute('aria-pressed', 'false')
      await page.getByTestId('view-toggle').tap()
      await expect(page.locator('.monaco-host')).toBeVisible()
      const editor = await page.locator('.monaco-host').boundingBox()
      expect(editor!.width).toBeGreaterThan(400)
      expect(editor!.height).toBeGreaterThan(200)
      await page.locator('.monaco-host').evaluate((el) => {
        const editor = (el as any).__vueParentComponent.setupState.editor
        ;(window as any).__tabletModel = editor.getModel()
      })
      await left(page).tap()
      await expect(page.locator('.file-tree .search-input')).toHaveValue(f.paths[0]!.split('/').at(-1)!)
      await right(page).tap()
      await page.keyboard.press('Escape')
      expect(await page.locator('.monaco-host').evaluate((el) => (el as any).__vueParentComponent.setupState.editor.getModel() === (window as any).__tabletModel)).toBe(true)
      await page.setViewportSize({ width: 1440, height: 900 })
      await expect(page.locator('.vault')).not.toHaveClass(/note-tablet-mode/)
      expect(await page.locator('.vault').evaluate((el) => getComputedStyle(el).gridTemplateColumns)).toBe(desktopColumns)
      expect(await page.evaluate(() => localStorage.getItem('nuvyn.vault.layout'))).toBe(stored)
    } finally { await f.cleanup() }
  })
}

test('tablet manages nine retained notes from Open documents and search stays above the drawer', async ({ page, request }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const paths: string[] = []
  const id = randomUUID().slice(0, 8)
  try {
    for (let i = 0; i < 9; i++) await createDoc(request, `inbox/tablet-tabs-${id}-${i}`, `# Tablet ${i}`, paths)
    await read(page, paths[0]!)
    for (const path of paths.slice(1)) {
      const row = page.locator(`[data-tree-key="file:${path}"]`)
      if (!await row.isVisible()) await page.locator('[data-tree-key="folder:inbox"] > .row-line').tap()
      await row.locator('.row-line').tap()
      await expect(tab(page, path)).toHaveAttribute('data-tab-mode', 'preview')
      await tab(page, path).focus()
      await page.keyboard.press('Shift+F10')
      await page.getByRole('menuitem', { name: /固定标签|Pin Tab/ }).click()
      await expect(tab(page, path)).toHaveAttribute('data-tab-mode', 'pinned')
    }
    await expect(page.locator('.editor-tabs-shell [data-tab-id]')).toHaveCount(9)
    await page.setViewportSize({ width: 768, height: 1024 })
    await expect(page.locator('.vault')).toHaveClass(/note-tablet-mode/)
    await expect(page.locator('.editor-tabs-shell')).toHaveCount(0)
    await ensureLeftDrawerOpen(page)
    await expandOpenDocuments(page)
    await expect(openDocuments(page).locator('.open-workspace-document')).toHaveCount(9)
    await expect(openDocuments(page).locator('.open-workspace-documents-count')).toHaveText('9')
    await openDocument(page, paths[0]!).locator('.open-workspace-document-select').tap()
    await expect(left(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.reading-pane h1')).toHaveText('Tablet 0')
    await ensureLeftDrawerOpen(page)
    await expandOpenDocuments(page)
    await openDocument(page, paths[1]!).getByRole('button', { name: /关闭|Close/ }).tap()
    await expect(openDocuments(page).locator('.open-workspace-document')).toHaveCount(8)
    await openDocument(page, paths[0]!).getByRole('button', { name: /关闭|Close/ }).tap()
    await expect(page.locator('.reading-pane h1')).not.toHaveText('Tablet 0')
    await expect(openDocuments(page).locator('.open-workspace-document')).toHaveCount(7)
    await page.locator('.nav-search').tap()
    await expect(page.locator('.palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.palette')).toHaveCount(0)
    await expect(left(page)).toHaveAttribute('aria-pressed', 'true')
    await left(page).tap()
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('.editor-tabs-shell')).toHaveCount(1)
    await expect(page.locator('.editor-tabs-shell [data-tab-id]')).toHaveCount(7)
    await noPageOverflow(page)
  } finally { for (const path of paths) await request.delete(`/api/posts/${path}`) }
})

test('tablet rich reader retains diagrams, authored Flex, includes, snippets, Board and folding', async ({ page, request }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 768, height: 1024 })
  const vault = nodePath.resolve(process.env.NUVYN_DRAFT_E2E_VAULT!)
  expect(vault.startsWith(`${nodePath.resolve(os.tmpdir())}${nodePath.sep}`)).toBe(true)
  const id = randomUUID().slice(0, 8)
  const codePath = nodePath.join(vault, 'inbox', `tablet-code-${id}.ts`)
  const paths: string[] = []
  let boardId = ''
  try {
    await fs.writeFile(codePath, 'export const tabletSnippet = 42\n')
    const included = `inbox/tablet-include-${id}`
    await createDoc(request, included, '### Included heading\n\nIncluded body\n\n#### Fourth level\n\n- [x] Finished task', paths)
    const createdBoard = await request.post('/api/board', { data: { title: 'Tablet Board' } })
    expect(createdBoard.status()).toBe(201)
    boardId = (await createdBoard.json()).metadata.id
    const board = await (await request.get(`/api/board/${boardId}`)).json()
    const savedBoard = await request.put(`/api/board/${boardId}/scene`, {
      data: {
        expectedRevision: board.sceneRecord.revision, engine: 'excalidraw', sceneVersion: 1,
        scene: {
          engineData: { elements: [{
            id: 'tablet-box', type: 'rectangle', x: 0, y: 0, width: 400, height: 200,
            angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid',
            strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
            frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1,
            isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
          }], fileMap: {} },
          persistentAppState: {}, assetRefs: [],
        },
      },
    })
    expect(savedBoard.status()).toBe(200)
    const main = `inbox/tablet-rich-${id}`
    await createDoc(request, main, [
      '# Rich tablet', '', '## Widgets', '',
      '::: flex direction=row mobile=preserve', '',
      '![First](/logo-48.png)', '', '![Second](/logo-48.png)', '', ':::', '',
      '```mermaid', 'graph LR', 'A[Reader] --> B[Navigation]', '```', '',
      '```markmap', '# Reader map', '## Navigation', '```', '',
      `<!--@include: ./tablet-include-${id}.md-->`, '',
      `<<< ./tablet-code-${id}.ts [Tablet snippet]`, '',
      `![Tablet Board](board:${boardId})`,
    ].join('\n'), paths)
    await read(page, main)
    await expect(page.locator('.mermaid-widget')).toHaveAttribute('data-mermaid-state', 'ready', { timeout: 30_000 })
    await expect(page.locator('.markmap-widget-host .markmap-node').first()).toBeAttached({ timeout: 30_000 })
    await expect(page.locator('.article')).toContainText('Included body')
    await expect(page.locator('.article')).toContainText('export const tabletSnippet = 42')
    const flex = page.locator('.nuvyn-flex-mobile-preserve').first()
    await expect(flex).toHaveCSS('flex-direction', 'row')
    await expect(flex.locator('img')).toHaveCount(2)
    await expect(page.locator('.board-embed')).toHaveAttribute('data-board-state', 'ready', { timeout: 30_000 })
    await expect(page.locator('.article input[type="checkbox"]')).toBeDisabled()
    const diagram = page.locator('.mermaid-widget')
    await diagram.evaluate((el) => { (window as any).__tabletDiagram = el })
    await page.locator('#widgets > .nuvyn-fold-toggle').tap()
    await expect(diagram).toBeHidden()
    await page.locator('#widgets > .nuvyn-fold-toggle').tap()
    await expect(diagram).toBeVisible()
    expect(await diagram.evaluate((el) => el === (window as any).__tabletDiagram)).toBe(true)
    await right(page).tap()
    await page.locator('.toc-panel-link').filter({ hasText: 'Fourth level' }).tap()
    await expect(page.locator('#fourth-level')).toBeInViewport()
    await noPageOverflow(page)
    await page.setViewportSize({ width: 1024, height: 768 })
    await noPageOverflow(page)
  } finally {
    for (const path of paths) await request.delete(`/api/posts/${path}`)
    if (boardId) await request.delete(`/api/board/${boardId}`)
    await fs.rm(codePath, { force: true })
  }
})
