import { expect, test } from './fixtures/auth'
import { deleteBoardIfExists, uniqueBoardTitle } from './helpers/board'

test('Board global search has no recommendations before a query or after clearing it', async ({ page, request }) => {
  const title = uniqueBoardTitle('Search empty state target')
  const created = await request.post('/api/board', { data: { title, folderId: null } })
  expect(created.status()).toBe(201)
  const { metadata: { id } } = await created.json()

  try {
    await page.goto('/board')
    await page.locator('.nav-search').click()
    await expect(page.locator('.palette-empty')).toContainText(/输入关键词开始搜索|Start typing to search/)
    await expect(page.getByRole('option')).toHaveCount(0)

    const input = page.locator('.palette-input input')
    await input.fill(title)
    const result = page.getByRole('option')
    await expect(result).toHaveCount(1)
    await expect(result).toContainText(title)

    await input.fill('')
    await expect(page.locator('.palette-empty')).toContainText(/输入关键词开始搜索|Start typing to search/)
    await expect(page.getByRole('option')).toHaveCount(0)
  } finally {
    await deleteBoardIfExists(request, id)
  }
})
