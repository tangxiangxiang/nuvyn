import { expect, test } from './fixtures/auth'
import { uniqueBoardTitle } from './helpers/board'

test('Board Home keeps a compact phone toolbar, complete previews, and folder rows', async ({ page, request }) => {
  const title = uniqueBoardTitle('Mobile layout')
  const folderName = uniqueBoardTitle('Mobile folder')
  let boardId = ''
  let folderId = ''

  try {
    const boardResponse = await request.post('/api/board', { data: { title, folderId: null } })
    expect(boardResponse.status()).toBe(201)
    boardId = (await boardResponse.json() as { metadata: { id: string } }).metadata.id

    const folderResponse = await request.post('/api/board-folders', { data: { name: folderName } })
    expect(folderResponse.status()).toBe(201)
    folderId = (await folderResponse.json() as { id: string }).id

    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/board')
    await expect(page.locator('.board-card').filter({ hasText: title })).toBeVisible()
    await expect(page.locator('.board-folder-card').filter({ hasText: folderName })).toBeVisible()

    for (const width of [320, 375, 430, 600]) {
      await page.setViewportSize({ width, height: 812 })
      const toolbar = page.getByTestId('board-toolbar')
      const mobileLayout = await toolbar.evaluate((element) => {
        const sort = element.querySelector<HTMLElement>('.board-sort-select')!
        const box = (selector: string) => {
          const rect = element.querySelector(selector)!.getBoundingClientRect()
          return { top: rect.top, left: rect.left, right: rect.right, width: rect.width }
        }
        return {
          display: getComputedStyle(element).display,
          title: box('h2'),
          sortDisplay: getComputedStyle(sort).display,
          search: box('.board-all-search'),
          filter: box('.board-filter'),
        }
      })
      expect(mobileLayout.display).toBe('grid')
      expect(mobileLayout.sortDisplay).toBe('none')
      expect(mobileLayout.title.top).toBeLessThan(mobileLayout.search.top)
      expect(Math.abs(mobileLayout.search.top - mobileLayout.filter.top)).toBeLessThanOrEqual(4)
      expect(mobileLayout.search.width).toBeGreaterThan(90)
      await expect(page.locator('.board-home-subtitle')).toBeHidden()
      const card = page.locator('.board-card').filter({ hasText: title })
      const preview = await card.locator('.board-card-thumbnail').evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const image = document.createElement('img')
        image.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 500"%3E%3C/svg%3E'
        element.appendChild(image)
        const objectFit = getComputedStyle(image).objectFit
        const objectPosition = getComputedStyle(image).objectPosition
        image.remove()
        return { height: rect.height, objectFit, objectPosition }
      })
      expect(preview.height).toBeGreaterThanOrEqual(180)
      expect(preview.height).toBeLessThanOrEqual(210)
      expect(preview.objectFit).toBe('contain')
      expect(preview.objectPosition).toBe('50% 50%')
      const folderHeight = await page.locator('.board-folder-card').filter({ hasText: folderName })
        .evaluate((element) => element.getBoundingClientRect().height)
      expect(folderHeight).toBeGreaterThanOrEqual(60)
      expect(folderHeight).toBeLessThanOrEqual(64)
      const pagination = page.locator('.board-pagination')
      await expect(pagination).toBeVisible()
      await expect(pagination).toHaveCSS('flex-direction', 'row')
      await expect(pagination.locator('.n-base-selection')).toHaveCount(0)
      const pageLayout = await pagination.evaluate((element) => {
        const total = element.querySelector<HTMLElement>('.board-pagination-meta')!.getBoundingClientRect()
        const controls = element.querySelector<HTMLElement>('.n-pagination')!.getBoundingClientRect()
        return {
          totalTop: total.top,
          controlsTop: controls.top,
          totalRight: total.right,
          controlsLeft: controls.left,
          controlsRight: controls.right,
        }
      })
      expect(Math.abs(pageLayout.totalTop - pageLayout.controlsTop)).toBeLessThanOrEqual(16)
      expect(pageLayout.totalRight).toBeLessThanOrEqual(pageLayout.controlsLeft)
      expect(pageLayout.controlsRight).toBeLessThanOrEqual(width + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    }

    await page.setViewportSize({ width: 768, height: 1024 })
    await expect(page.locator('.board-home-subtitle')).toBeVisible()
    await expect(page.getByTestId('board-toolbar')).toHaveCSS('display', 'flex')
    await expect(page.locator('.board-sort-select')).toBeVisible()
    await expect(page.locator('.board-pagination .n-base-selection')).toHaveCount(1)
    const tabletAspectRatio = await page.locator('.board-card').filter({ hasText: title })
      .locator('.board-card-thumbnail').evaluate((element) => getComputedStyle(element).aspectRatio)
    const ratioParts = tabletAspectRatio.split('/').map((value) => Number.parseFloat(value.trim()))
    expect(ratioParts[0]! / ratioParts[1]!).toBeCloseTo(1.6, 4)
  } finally {
    if (boardId) await request.delete(`/api/board/${encodeURIComponent(boardId)}`).catch(() => {})
    if (folderId) await request.delete(`/api/board-folders/${encodeURIComponent(folderId)}`).catch(() => {})
  }
})
