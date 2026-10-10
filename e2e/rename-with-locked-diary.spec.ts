import { expect, test } from './fixtures/auth'
import { cleanupCreatedPaths, createDoc, openDoc, waitForVaultReady } from './helpers/edit-program'

test('ordinary rename updates references while Diary remains locked', async ({ page, request, baseURL }) => {
  const id = Date.now()
  const source = `inbox/e2e-rename-${id}`
  const backlink = `inbox/e2e-backlink-${id}`
  const newName = `e2e-renamed-${id}`
  const destination = `inbox/${newName}`
  const diaryPath = 'diary/1999-02-16'
  const created: string[] = []
  let diaryCreated = false
  let headers: Record<string, string> = {}
  try {
    const status = await (await request.get('/api/diary/access/status')).json()
    const access = await request.post(`/api/diary/access/${status.state === 'UNINITIALIZED' ? 'setup' : 'unlock'}`, {
      headers: { Origin: baseURL! }, data: { password: 'e2e-diary-access-password-strong-123' },
    })
    expect([200, 201]).toContain(access.status())
    const { capability } = await access.json()
    headers = { 'X-Nuvyn-Diary-Capability': capability, Origin: baseURL! }
    const diary = await request.post('/api/diary/dates', {
      headers, data: { date: '1999-02-16', timeZone: 'Asia/Shanghai' },
    })
    expect(diary.status(), await diary.text()).toBe(201)
    diaryCreated = true
    expect((await request.get(`/api/posts/${diaryPath}`)).status()).toBe(423)
    await createDoc(request, source, '# Source\n', created)
    await createDoc(request, backlink, `# Backlink\n\n[[${source}]]\n`, created)
    await page.goto('/vault')
    await waitForVaultReady(page)
    await openDoc(page, source)
    await page.locator(`[data-tree-key="file:${source}"]`).click({ button: 'right' })
    await page.locator('.tree-context-menu button', { hasText: 'Rename' }).click()
    const prompt = page.locator('.n-dialog[role="dialog"]')
    await prompt.getByRole('textbox').fill(newName)
    await prompt.getByRole('button', { name: 'Confirm', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: /link to this note/i })
    await expect(confirmation).toContainText('Links inside encrypted diaries are not updated')
    created.push(destination)
    await confirmation.getByRole('button').last().click()
    await expect(page.locator(`[data-tab-id="${destination}"]`)).toBeVisible()
    const updated = await (await request.get(`/api/posts/${backlink}`)).json()
    expect(updated.raw).toContain(`[[${destination}]]`)
    expect((await request.get(`/api/posts/${diaryPath}`)).status()).toBe(423)
  } finally {
    await cleanupCreatedPaths(request, created)
    if (diaryCreated) await request.delete(`/api/posts/${diaryPath}`, { headers })
  }
})
