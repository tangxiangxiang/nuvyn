import { expect, test } from './fixtures/auth'
import { deleteBoardIfExists, drawRectangle, getBoard, openEditorMenuItem, waitForBoardSaved, waitForEditorReady } from './helpers/board'
import { cleanupCreatedPaths, createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'

test.setTimeout(90_000)

test('copies a Board reference into a Note, follows saved edits, and handles deleted Boards', async ({ page, request, context }) => {
  const created: string[] = []
  const slug = `inbox/e2e-board-embed-${Date.now()}`
  let boardId = ''
  try {
    const response = await request.post('/api/board', { data: { title: 'Diagram for a Note' } })
    expect(response.status()).toBe(201)
    boardId = (await response.json()).metadata.id
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(`/board/${boardId}`)
    await waitForEditorReady(page)
    await drawRectangle(page)
    await waitForBoardSaved(page)
    await openEditorMenuItem(page, /Copy Note reference|复制笔记引用/)
    const reference = await page.evaluate(() => navigator.clipboard.readText())
    expect(reference).toBe(`![Diagram for a Note](board:${boardId})`)
    const saved = await getBoard(request, boardId)

    await createDoc(request, slug, `# Board in a Note\n\n${reference}`, created)
    await gotoVaultReady(page)
    await openDoc(page, slug)
    await page.getByTestId('view-toggle').click()
    const embed = page.locator('.reading-pane .board-embed')
    await expect(embed).toHaveAttribute('data-board-state', 'ready', { timeout: 30_000 })
    await expect(embed.locator('img')).toBeVisible()
    const originalWidth = await embed.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)
    expect(originalWidth).toBeGreaterThan(200)
    const initialLayout = await embed.locator('img').evaluate(image => {
      const style = getComputedStyle(image)
      const box = image.getBoundingClientRect()
      const parent = image.parentElement!.getBoundingClientRect()
      return { width: box.width, naturalWidth: (image as HTMLImageElement).naturalWidth, border: style.borderTopWidth, centerOffset: box.x + box.width / 2 - parent.x - parent.width / 2 }
    })
    expect(initialLayout.width).toBeLessThanOrEqual(initialLayout.naturalWidth)
    expect(initialLayout.border).toBe('0px')
    expect(Math.abs(initialLayout.centerOffset)).toBeLessThan(1)
    await expect(embed.locator('img')).toHaveAttribute('alt', 'Diagram for a Note')
    await expect(embed.locator('.board-embed-caption')).toHaveCount(0)
    const afterRead = await request.get(`/api/board/${boardId}/metadata`)
    expect((await afterRead.json()).lastOpenedAt).toBe(saved.metadata.lastOpenedAt)

    const scene = structuredClone(saved.sceneRecord.scene)
    const elements = (scene.engineData as { elements: Array<{ width: number; height: number }> }).elements
    elements[0]!.width += 100
    elements[0]!.height = 1000
    const save = await request.put(`/api/board/${boardId}/scene`, {
      data: { expectedRevision: saved.sceneRecord.revision, engine: 'excalidraw', sceneVersion: 1, scene },
    })
    expect(save.status()).toBe(200)
    const nextRevision = (await save.json()).revision
    expect((await request.patch(`/api/board/${boardId}`, { data: { title: 'Renamed diagram' } })).status()).toBe(200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(embed).toHaveAttribute('data-board-revision', String(nextRevision))
    await expect(embed).toHaveAttribute('data-board-state', 'ready')
    await expect(embed.locator('img')).toHaveAttribute('alt', 'Renamed diagram')
    const naturalWidth = await embed.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)
    expect(naturalWidth).toBeGreaterThan(originalWidth)
    const imageBox = await embed.locator('img').boundingBox()
    expect(imageBox!.height).toBeLessThanOrEqual(Math.min(480, page.viewportSize()!.height * 0.6) + 1)
    const aspectRatio = await embed.locator('img').evaluate(image => {
      const img = image as HTMLImageElement
      const box = img.getBoundingClientRect()
      return { rendered: box.width / box.height, natural: img.naturalWidth / img.naturalHeight }
    })
    expect(aspectRatio.rendered).toBeCloseTo(aspectRatio.natural, 2)

    await embed.locator('.board-embed-preview').click()
    await expect(page).toHaveURL(new RegExp(`/board/${boardId}$`))
    await waitForEditorReady(page)
    await page.goBack()
    await expect(embed).toHaveAttribute('data-board-state', 'ready', { timeout: 30_000 })
    await deleteBoardIfExists(request, boardId)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(embed).toHaveAttribute('data-board-state', 'error')
    await expect(embed.locator('img')).toHaveCount(0)
    await expect(embed.locator('.board-embed-status')).toContainText(/does not exist|不存在/)
    await expect(embed.locator('.board-embed-retry')).toBeVisible()
  } finally {
    if (boardId) await deleteBoardIfExists(request, boardId)
    await cleanupCreatedPaths(request, created)
  }
})
