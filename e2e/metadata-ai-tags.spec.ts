import { expect, test } from './fixtures/auth'
import { cleanupCreatedPaths, createDoc, openDoc, waitForVaultReady } from './helpers/edit-program'

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
