import { expect, test } from './fixtures/auth'
import { cleanupCreatedPaths, createDoc, openDoc, waitForVaultReady } from './helpers/edit-program'

test('overflow tags stay in one row and can be removed in a popover', async ({ page, request }) => {
  const slug = `inbox/e2e-tag-overflow-${Date.now()}`
  const created: string[] = []
  const tags = Array.from({ length: 15 }, (_, index) => `topic-${String(index).padStart(2, '0')}`)
  try {
    await createDoc(request, slug, '# Many tags', created)
    const before = await (await request.get(`/api/posts/${slug}`)).json()
    await request.patch(`/api/metadata/documents/${slug}`, {
      data: { tags, expectedUpdatedAt: before.metadata.updatedAt },
    })
    await page.goto('/vault')
    await waitForVaultReady(page)
    await openDoc(page, slug)
    await page.locator('.right-rail').getByRole('tab', { name: /^(Properties|属性)$/ }).click()
    const panel = page.locator('.metadata-slot')
    const list = panel.locator('.metadata-tag-list')
    const more = list.locator('.metadata-tag-more')
    await expect(more).toBeVisible()
    let visibleCount = await list.locator('.metadata-tag-name').count()
    await expect(more).toHaveText(`+${tags.length - visibleCount}`)
    expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const box = panel.locator('.metadata-tag-box')
    const originalHeight = await box.evaluate(el => el.getBoundingClientRect().height)
    await box.evaluate(el => { (el as HTMLElement).style.width = '140px' })
    await expect.poll(() => list.locator('.metadata-tag-name').count()).toBeLessThan(visibleCount)
    visibleCount = await list.locator('.metadata-tag-name').count()
    await expect(more).toHaveText(`+${tags.length - visibleCount}`)
    expect(await box.evaluate(el => el.getBoundingClientRect().height)).toBe(originalHeight)
    await more.click()
    const popup = page.locator('.metadata-tag-overflow')
    await expect(popup).toBeVisible()
    await expect(popup.locator('.metadata-tag-name')).toHaveCount(tags.length - visibleCount)
    const removed = await popup.locator('.metadata-tag-name').first().textContent()
    await popup.locator('.n-base-close').first().click()
    await expect(popup.locator('.metadata-tag-name').filter({ hasText: removed! })).toHaveCount(0)
    const unsaved = await (await request.get(`/api/posts/${slug}`)).json()
    expect(unsaved.metadata.tags).toHaveLength(15)
    await page.keyboard.press('Escape')
    await panel.locator('.document-metadata-action-group button').last().click()
    await expect.poll(async () => {
      const saved = await (await request.get(`/api/posts/${slug}`)).json()
      return saved.metadata.tags.length
    }).toBe(14)
  } finally {
    await cleanupCreatedPaths(request, created)
  }
})

test('AI tags merge into the properties draft and persist only on Save', async ({ page, request }) => {
  const slug = `inbox/e2e-ai-tags-${Date.now()}`
  const created: string[] = []
  try {
    await createDoc(request, slug, '# Vue component\n\nTypeScript composition API.', created)
    const before = await (await request.get(`/api/posts/${slug}`)).json()
    await request.patch(`/api/metadata/documents/${slug}`, {
      data: { tags: ['Vue'], expectedUpdatedAt: before.metadata.updatedAt },
    })
    let generatedContent = ''
    await page.route('**/api/ai/tags', async route => {
      generatedContent = route.request().postDataJSON().content
      await route.fulfill({ json: { tags: ['vue', 'TypeScript', 'Components'] } })
    })
    await page.route('**/api/ai/title', route => route.fulfill({ json: { title: 'Vue component patterns' } }))
    await page.goto('/vault')
    await waitForVaultReady(page)
    await openDoc(page, slug)
    await page.locator('.right-rail').getByRole('tab', { name: /^(Properties|属性)$/ }).click()
    const panel = page.locator('.metadata-slot')
    const titleHeight = await panel.locator('.document-metadata-input').first().evaluate(el => el.getBoundingClientRect().height)
    expect(titleHeight).toBeLessThanOrEqual(32)
    const saveHeight = await panel.locator('.document-metadata-action-group button').last().evaluate(el => el.getBoundingClientRect().height)
    expect(saveHeight).toBeLessThanOrEqual(30)
    await panel.locator('.metadata-generate-title').click()
    await expect(panel.getByRole('textbox', { name: /^(Title|标题)$/ })).toHaveValue('Vue component patterns')
    await expect(panel.locator('.metadata-tags-label .metadata-add-tag')).toBeVisible()
    await panel.locator('.metadata-generate-tags').click()
    await expect(panel.locator('.metadata-tag-name')).toHaveText(['Vue', 'TypeScript', 'Components'])
    expect(generatedContent).toContain('TypeScript composition API')
    const draft = await (await request.get(`/api/posts/${slug}`)).json()
    expect(draft.metadata.tags).toEqual(['Vue'])
    expect(draft.metadata.title).not.toBe('Vue component patterns')
    await panel.locator('.document-metadata-action-group button').last().click()
    await expect.poll(async () => {
      const saved = await (await request.get(`/api/posts/${slug}`)).json()
      return [...saved.metadata.tags].sort()
    }).toEqual(['Components', 'TypeScript', 'Vue'])
    const saved = await (await request.get(`/api/posts/${slug}`)).json()
    expect(saved.metadata.title).toBe('Vue component patterns')
  } finally {
    await cleanupCreatedPaths(request, created)
  }
})
