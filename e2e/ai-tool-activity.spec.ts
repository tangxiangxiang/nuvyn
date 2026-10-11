import { expect, test } from './fixtures/auth'
import { cleanupCreatedPaths, createDoc, gotoVaultReady, interceptAiChat, openAiRail, openDoc, sendAi, sse } from './helpers/edit-program'

test('successful reads collapse together while errors and mutations stay visible', async ({ page, request }) => {
  const source = `inbox/e2e-ai-activity-${Date.now()}`
  const created: string[] = []
  try {
    await createDoc(request, source, '# Activity test', created)
    await interceptAiChat(page, [])
    const calls = [
      { id: 'read', name: 'read_file', path: source, content: 'Read result', error: false },
      { id: 'list', name: 'list_files', path: 'inbox', content: 'Listed result', error: false },
      { id: 'empty', name: 'read_file', path: `${source}-empty`, content: '', error: false },
      { id: 'failed', name: 'read_file', path: 'inbox/missing', content: 'Read access failed', error: true },
      { id: 'write', name: 'patch_file', path: source, content: 'Patch operation result', error: false },
    ]
    await page.route('**/api/ai/chat', route => route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [sse('user', { id: 1 }), ...calls.flatMap(call => [
        sse('tool_use', { id: call.id, name: call.name, input: { path: call.path } }),
        sse('tool_result', { tool_use_id: call.id, content: call.content, is_error: call.error }),
      ]), sse('token', { text: 'Activity complete' }), sse('done', { userId: 1, assistantId: 2 })].join(''),
    }))
    await gotoVaultReady(page)
    await openDoc(page, source)
    await openAiRail(page)
    await sendAi(page, 'Review this note')
    const activity = page.locator('.ai-tool-activity')
    await expect(activity.locator('summary')).toHaveText('Documents viewed: 2 · Directory lookups completed: 1')
    await expect(activity.locator('.ai-tool-pill-pending')).toHaveCount(0)
    await expect(activity.locator('details .ai-tool-pill-ok')).toHaveCount(3)
    await expect(activity.locator('details .ai-tool-card').first()).not.toBeVisible()
    await expect(activity.getByText('Read access failed', { exact: true })).toBeVisible()
    await expect(activity.getByText('Patch operation result', { exact: true })).toBeVisible()
    await activity.locator('summary').click()
    await expect(activity.locator('details .ai-tool-card').first()).toBeVisible()
    await activity.locator('details .ai-tool-toggle').first().click()
    await expect(activity.getByText('Read result', { exact: true })).toBeVisible()
    await activity.locator('summary').click()
    await expect(activity.getByText('Read result', { exact: true })).not.toBeVisible()
  } finally {
    await cleanupCreatedPaths(request, created)
  }
})
