import { expect, test } from './fixtures/auth'
import {
  cleanupCreatedPaths,
  createDoc,
  gotoVaultReady,
  interceptAiChat,
  interceptAiChatGated,
  jsonResponse,
  sse,
  sendAi,
} from './helpers/edit-program'
import type { AnyRecord } from './helpers/edit-program'
import { ensureVaultLeftDrawerOpen, selectWorkspace } from './helpers/workspace-navigation'
import { unlockDiary } from './helpers/diary-life'

test.describe('AI history keyboard interaction', () => {
  test.beforeEach(async ({ page }) => {
    let session = { id: 21, title: 'Saved conversation', createdAt: 1, updatedAt: 1 }
    await page.route('**/api/ai/**', async (route) => {
      const request = route.request()
      switch (new URL(request.url()).pathname) {
        case '/api/ai/active': return route.fulfill(jsonResponse({ activeId: session.id, activeSession: session, configured: true }))
        case '/api/ai/sessions': return route.fulfill(jsonResponse([session]))
        case '/api/ai/sessions/21/messages': return route.fulfill(jsonResponse([]))
        case '/api/ai/sessions/21':
          expect(request.method()).toBe('PATCH')
          session = { ...session, title: request.postDataJSON().title }
          return route.fulfill(jsonResponse(session))
        default: return route.fallback()
      }
    })
    await gotoVaultReady(page)
    await page.getByTestId('global-ai-trigger').click()
    await page.getByTestId('global-ai-history').click()
    await expect(page.locator('.ai-sp-name')).toHaveText('Saved conversation')
  })

  test('Escape cancels rename, then closes history, then closes the panel', async ({ page }) => {
    const history = page.locator('.ai-sp-dialog')
    const panel = page.getByTestId('global-ai-panel')
    await history.getByRole('button', { name: /重命名|Rename/ }).click()
    const input = history.getByRole('textbox')
    await expect(input).toBeFocused()
    await input.fill('Discard this name')
    await page.keyboard.press('Escape')
    await expect(history).toBeVisible()
    await expect(history.locator('.ai-sp-name')).toHaveText('Saved conversation')
    await expect(history.locator('.ai-sp-close')).toBeFocused()

    await page.keyboard.press('Shift+Tab')
    await expect(history.locator('.ai-sp-new')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(history.locator('.ai-sp-close')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(history).toBeHidden()
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('global-ai-history')).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(page.getByTestId('global-ai-trigger')).toBeFocused()
  })

  test('Escape closes delete confirmation before history and Enter renames once', async ({ page }) => {
    const history = page.locator('.ai-sp-dialog')
    const writes: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/ai/sessions/21') writes.push(request.method())
    })
    await history.getByRole('button', { name: /删除|Delete/ }).click()
    const confirmation = page.getByRole('dialog', { name: /Saved conversation/ })
    const cancel = confirmation.getByRole('button', { name: /取消|Cancel/ })
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(confirmation.locator('button:focus')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(confirmation).toBeHidden()
    await expect(history).toBeVisible()
    await expect(history.getByRole('button', { name: /删除|Delete/ })).toBeFocused()
    await expect(history.locator('.ai-sp-name')).toHaveText('Saved conversation')
    expect(writes).toEqual([])
    await page.keyboard.press('Escape')
    await expect(history).toBeHidden()
    await expect(page.getByTestId('global-ai-panel')).toBeVisible()
    await page.getByTestId('global-ai-history').click()

    await history.getByRole('button', { name: /重命名|Rename/ }).click()
    const input = history.getByRole('textbox')
    await input.fill('Updated conversation')
    await input.press('Enter')
    await expect(history.locator('.ai-sp-name')).toHaveText('Updated conversation')
    expect(writes).toEqual(['PATCH'])
    await expect(history.locator('.ai-sp-close')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(history).toBeHidden()
    await expect(page.getByTestId('global-ai-panel')).toBeVisible()
  })
})

test('global AI drag position persists, stays in view, and resets on title double-click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoVaultReady(page)
  const trigger = page.getByTestId('global-ai-trigger')
  await trigger.click()
  const panel = page.getByTestId('global-ai-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveCSS('transform', 'none')
  await expect(panel.locator('.ai-quick-prompt')).toHaveCount(3)

  const initial = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  })
  const dragRegion = panel.locator('.ai-floating-drag-region')
  const box = await dragRegion.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 - 110, box!.y + box!.height / 2 + 42, { steps: 5 })
  await page.mouse.up()

  const moved = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  })
  expect(moved.left).toBeLessThan(initial.left)
  expect(moved.top).toBeGreaterThan(initial.top)
  expect(moved.left).toBeGreaterThanOrEqual(8)
  expect(moved.top).toBeGreaterThanOrEqual(await page.locator('.navbar').evaluate((element) => element.getBoundingClientRect().bottom + 8))

  await panel.getByTestId('global-ai-close').click()
  await expect(panel).toBeHidden()
  await trigger.click()
  await expect(panel).toBeVisible()
  await expect(panel).toHaveCSS('transform', 'none')
  await expect.poll(() => panel.evaluate((element) => element.getBoundingClientRect().left)).toBeCloseTo(moved.left, 0)

  await page.reload()
  await gotoVaultReady(page)
  await page.getByTestId('global-ai-trigger').click()
  await expect(panel).toHaveCSS('transform', 'none')
  const restored = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  })
  expect(restored.left).toBeCloseTo(moved.left, 0)
  expect(restored.top).toBeCloseTo(moved.top, 0)

  await panel.locator('.ai-floating-drag-region').dblclick()
  const reset = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top }
  })
  expect(reset.left).toBeGreaterThan(moved.left)
  expect(reset.top).toBeLessThan(moved.top)
})

test('an in-flight Note response survives a workspace switch and later requests get no Ledger context', async ({ page, request }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  const slug = `inbox/e2e-global-ai-${Date.now()}`
  const created: string[] = []
  const chatBodies: AnyRecord[] = []
  let releaseStream!: () => void
  const streamGate = new Promise<void>((resolve) => { releaseStream = resolve })
  try {
    await createDoc(request, slug, '# Global AI context test\n\nA Note snapshot.', created)
    await interceptAiChatGated(page, chatBodies, streamGate, () => [
      sse('user', { id: 1 }),
      sse('token', { text: 'stream finished after switching workspaces' }),
      sse('done', { userId: 1, assistantId: 2 }),
    ].join(''))
    await page.route('**/api/ai/ledger-session', route => route.fulfill(jsonResponse({
      session: { id: 2, title: 'AI Finance', createdAt: 1, updatedAt: 1 }, messages: [],
    })))
    await gotoVaultReady(page)
    await ensureVaultLeftDrawerOpen(page)
    const row = page.locator(`[data-tree-key="file:${slug}"]`)
    if (!(await row.isVisible().catch(() => false))) {
      await page.locator(`[data-tree-key="folder:${slug.split('/')[0]}"]`).click()
    }
    await expect(row).toBeVisible()
    await row.locator(':scope > .row-line').dblclick()
    await expect(page.locator('.editor-pane .monaco-editor .view-lines').first()).toBeVisible()
    await page.getByTestId('global-ai-trigger').click()
    const panel = page.getByTestId('global-ai-panel')
    await expect(panel).toBeVisible()
    await expect(panel.locator('.ai-quick-prompt')).toHaveCount(3)

    await sendAi(page, 'capture the current Note')
    await expect.poll(() => chatBodies.length).toBe(1)
    expect(chatBodies[0]?.liveContext?.identity?.path).toBe(slug)

    const historyButton = panel.getByTestId('global-ai-history')
    await historyButton.click()
    const historyDialog = page.locator('.ai-sp-dialog')
    await expect(historyDialog.locator('.ai-sp-close')).toBeFocused()
    await expect(historyDialog.locator('.ai-sp-new')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(historyDialog).toBeHidden()
    await expect(historyButton).toBeFocused()

    await selectWorkspace(page, 'ledger')
    await expect(page).toHaveURL(/\/ledger(?:\/|$)/)
    await expect(panel).toBeVisible()
    releaseStream()
    await expect(panel.getByText('stream finished after switching workspaces')).toHaveCount(0)

    await sendAi(page, 'ordinary Ledger workspace question')
    await expect.poll(() => chatBodies.length).toBe(2)
    expect(chatBodies[1]).toMatchObject({ sessionId: 2, ledgerAnalysis: true })
    expect(chatBodies[1]).not.toHaveProperty('liveContext')
    expect(JSON.stringify(chatBodies[1])).not.toContain(slug)
    await selectWorkspace(page, 'note')
    await expect(panel.getByText('stream finished after switching workspaces')).toBeVisible()

    await selectWorkspace(page, 'board')
    await expect(page).toHaveURL(/\/board(?:\/|$)/)
    await expect.poll(async () => (
      await page.getByTestId('global-ai-trigger').count()
      + await page.getByTestId('immersive-global-ai-trigger').count()
    )).toBeGreaterThan(0)
    await expect(panel).toBeVisible()
  } finally {
    releaseStream()
    await cleanupCreatedPaths(request, created)
  }
})

test('a workspace modal takes priority over the floating AI panel and consumes the first Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await gotoVaultReady(page)
  const trigger = page.getByTestId('global-ai-trigger')
  await trigger.click()
  const panel = page.getByTestId('global-ai-panel')
  await expect(panel).toBeVisible()

  await page.locator('.mobile-workspace-selector').click()
  const workspaceDialog = page.locator('#workspace-switcher-dialog')
  await expect(workspaceDialog).toBeVisible()
  await expect(panel).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(workspaceDialog).toBeHidden()
  await expect(panel).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('quick prompts follow the active workspace and Diary view without replacing the draft or sending', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'zh-CN' })
  })
  await gotoVaultReady(page)
  const trigger = page.getByTestId('global-ai-trigger')
  await trigger.click()
  const panel = page.getByTestId('global-ai-panel')
  const prompts = panel.locator('.ai-quick-prompt')
  const composer = panel.locator('textarea')
  let chatRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/ai/chat') chatRequests += 1
  })

  await expect(prompts).toHaveCount(3)
  const selectedPromptText = await prompts.first().getAttribute('title')
  expect(selectedPromptText).toBeTruthy()
  await prompts.first().click()
  await expect(composer).toHaveValue(selectedPromptText!)
  expect(chatRequests).toBe(0)
  await composer.fill('草稿在切换工作区后仍要保留')

  await selectWorkspace(page, 'ledger')
  await expect(panel).toBeVisible()
  await expect(prompts).toHaveText(['分析本月收支', '分析消费结构', '查看财务趋势'])
  await expect(panel.locator('.ai-empty-hint')).toHaveText('可以分析最新账本的收支、还款和账户余额。')
  await expect(composer).toHaveValue('')
  await composer.fill('财务草稿')
  expect(chatRequests).toBe(0)

  await selectWorkspace(page, 'board')
  await expect(panel).toBeVisible()
  await expect(prompts).toHaveText(['头脑风暴', '整理思路', '设计信息结构'])
  await expect(panel.locator('.ai-empty-hint')).toHaveText('可以帮助你头脑风暴和整理思路。')
  await expect(composer).toHaveValue('草稿在切换工作区后仍要保留')

  await selectWorkspace(page, 'diary')
  await unlockDiary(page)
  await expect(panel).toBeVisible()
  await expect(prompts).toHaveText(['梳理心情', '自我反思', '培养记录习惯'])
  await expect(panel.locator('.ai-empty-hint')).toHaveText('可以帮你梳理心情和思考，不会读取你的日记。')

  await page.getByTestId('diary-view-mode-events').click()
  await expect(prompts).toHaveText(['规划重要日程', '准备生日纪念日', '制定活动计划'])
  await expect(panel.locator('.ai-empty-hint')).toHaveText('可以帮你规划重要日期和活动安排。')
  await page.getByTestId('diary-view-mode-tasks').click()
  await expect(prompts).toHaveText(['拆解复杂任务', '梳理任务优先级', '制定执行计划'])
  await expect(panel.locator('.ai-empty-hint')).toHaveText('可以帮你拆解任务、梳理优先级。')
  await expect(composer).toHaveValue('草稿在切换工作区后仍要保留')
  await selectWorkspace(page, 'ledger')
  await expect(composer).toHaveValue('财务草稿')
  expect(chatRequests).toBe(0)
})

test('AI Finance isolates its transcript and executes local commands without sending chat', async ({ page }) => {
  const ordinary = { id: 30, title: 'Note chat', createdAt: 1, updatedAt: 1 }
  const finance = { id: 31, title: 'AI Finance', createdAt: 1, updatedAt: 1 }
  const chatRequests: AnyRecord[] = []
  const commands: string[] = []
  const financeMessages: AnyRecord[] = []
  await page.route('**/api/ai/**', async (route) => {
    const request = route.request()
    switch (new URL(request.url()).pathname) {
      case '/api/ai/active':
        return route.fulfill(jsonResponse({ activeId: ordinary.id, activeSession: ordinary, configured: true }))
      case '/api/ai/settings':
        return route.fulfill(jsonResponse({ provider: 'openai', model: 'fixture' }))
      case '/api/ai/sessions':
        return route.fulfill(jsonResponse([ordinary]))
      case '/api/ai/sessions/30/messages':
        return route.fulfill(jsonResponse([
          { id: 1, sessionId: ordinary.id, role: 'assistant', content: 'Previous Note conversation', createdAt: 1 },
        ]))
      case '/api/ai/ledger-session':
        return route.fulfill(jsonResponse({ session: finance, messages: financeMessages }))
      case '/api/ai/ledger-session/command': {
        const { command } = request.postDataJSON()
        commands.push(command)
        if (command === 'clear') financeMessages.length = 0
        return route.fulfill(jsonResponse({ outcome: command === 'clear' ? 'cleared' : 'nothing-to-compact' }))
      }
      case '/api/ai/chat': {
        const body = request.postDataJSON()
        chatRequests.push(body)
        const number = chatRequests.length
        const userId = number * 2
        const assistantId = userId + 1
        const reply = body.ledgerAnalysis ? `Ledger analysis ${number}` : 'Board conversation'
        if (body.ledgerAnalysis) {
          financeMessages.push(
            { id: userId, sessionId: finance.id, role: 'user', content: body.content, createdAt: userId },
            { id: assistantId, sessionId: finance.id, role: 'assistant', content: reply, createdAt: assistantId },
          )
        }
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          ...(number === 1 ? { headers: { 'x-finance-progress-fixture': '1' } } : {}),
          body: sse('user', { id: userId })
            + (number === 1 ? sse('finance_progress', { phase: 'reading' }) : '')
            + sse('token', { text: reply }) + sse('done', { userId, assistantId }),
        })
      }
      default: return route.fallback()
    }
  })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'zh-CN' })
    // Hold the final SSE frames so the test can interact with a running
    // request without depending on an arbitrary provider delay.
    const fetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const response = await fetch(...args)
      if (response.headers.get('x-finance-progress-fixture') !== '1') return response
      const body = await response.text()
      const final = body.indexOf('event: token')
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(body.slice(0, final)))
          window.addEventListener('finance-fixture-answer', () => {
            controller.enqueue(encoder.encode(body.slice(final)))
            controller.close()
          }, { once: true })
        },
      }), { headers: response.headers })
    }
  })
  await gotoVaultReady(page)
  await page.getByTestId('global-ai-trigger').click()
  const panel = page.getByTestId('global-ai-panel')
  await expect(panel.getByText('Previous Note conversation')).toBeVisible()
  await selectWorkspace(page, 'ledger')
  await expect(panel.locator('.ai-floating-title')).toHaveText('AI财务')
  await expect(panel.getByTestId('global-ai-new-session')).toHaveCount(0)
  await expect(panel.getByTestId('global-ai-history')).toHaveCount(0)
  await expect(panel.getByText('Previous Note conversation')).toHaveCount(0)
  await sendAi(page, '分析本月的收入和支出')
  const progress = panel.getByTestId('finance-agent-progress')
  await expect(progress).toHaveText('正在查询账本…')
  await expect(panel.getByText('Ledger analysis 1')).toHaveCount(0)
  await selectWorkspace(page, 'board')
  await expect(progress).toHaveCount(0)
  await selectWorkspace(page, 'ledger')
  await expect(progress).toHaveText('正在查询账本…')
  await page.evaluate(() => window.dispatchEvent(new Event('finance-fixture-answer')))
  await expect(panel.getByText('Ledger analysis 1')).toBeVisible()
  await expect(progress).toHaveCount(0)
  await sendAi(page, '那上个月呢？')
  await expect(panel.getByText('Ledger analysis 2')).toBeVisible()
  await expect(panel.getByTestId('ai-ledger-approval')).toHaveCount(0)

  await selectWorkspace(page, 'board')
  await expect(panel.getByText('Ledger analysis 2')).toHaveCount(0)
  await expect(panel.getByText('Previous Note conversation')).toBeVisible()
  await sendAi(page, '帮我整理思路')
  await expect(panel.getByText('Board conversation')).toBeVisible()
  expect(chatRequests.map(({ sessionId, ledgerAnalysis, liveContext }) => [sessionId, ledgerAnalysis, liveContext])).toEqual([
    [finance.id, true, undefined], [finance.id, true, undefined], [ordinary.id, undefined, undefined],
  ])

  await selectWorkspace(page, 'ledger')
  await expect(panel.getByText('Ledger analysis 2')).toBeVisible()
  await panel.getByTestId('global-ai-close').click()
  await page.getByTestId('global-ai-trigger').click()
  await expect(panel.getByText('Ledger analysis 2')).toBeVisible()

  await sendAi(page, '  /compact  ')
  await expect(panel.getByText('当前无需压缩')).toBeVisible()
  await sendAi(page, '/unknown')
  await expect(panel.getByText('未知命令。可用命令为 /compact 和 /clear。')).toBeVisible()
  const input = panel.locator('textarea')
  await input.fill('/')
  await panel.getByRole('option', { name: '/clear · 清空对话', exact: true }).click()
  await expect(panel.getByText('对话已清空')).toBeVisible()
  await expect(panel.getByText('Ledger analysis 2')).toHaveCount(0)
  await expect(input).toHaveValue('')
  expect(commands).toEqual(['compact', 'clear'])
  expect(chatRequests).toHaveLength(3)

  await page.reload()
  await page.getByTestId('global-ai-trigger').click()
  await expect(panel.locator('.ai-floating-title')).toHaveText('AI财务')
  await expect(panel.locator('.ai-empty-hint')).toBeVisible()
  await expect(panel.getByText('Ledger analysis 2')).toHaveCount(0)
  await selectWorkspace(page, 'note')
  await expect(panel.getByText('Previous Note conversation')).toBeVisible()
})

test.describe('tablet global AI panel', () => {
  test.use({ hasTouch: true, isMobile: false, viewport: { width: 1024, height: 768 } })

  test('keeps a floating layout and supports touch dragging within the viewport', async ({ page }) => {
    await gotoVaultReady(page)
    await page.getByTestId('global-ai-trigger').tap()
    const panel = page.getByTestId('global-ai-panel')
    await expect(panel).toBeVisible()

    const before = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top }
    })
    const box = await panel.locator('.ai-floating-drag-region').boundingBox()
    expect(box).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const x = box!.x + box!.width / 2
    const y = box!.y + box!.height / 2
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ id: 1, x, y, radiusX: 2, radiusY: 2, force: 1 }],
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ id: 1, x: x - 72, y: y + 36, radiusX: 2, radiusY: 2, force: 1 }],
    })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await client.detach()

    const after = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top }
    })
    expect(after.left).toBeLessThan(before.left)
    expect(after.top).toBeGreaterThan(before.top)
    expect(after.left).toBeGreaterThanOrEqual(8)
    expect(after.top).toBeGreaterThanOrEqual(await page.locator('.navbar').evaluate((element) => element.getBoundingClientRect().bottom + 8))
  })
})

test.describe('mobile global AI panel', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('opens as a full-screen touch panel and closes without a backdrop', async ({ page }) => {
    await gotoVaultReady(page)
    await page.getByTestId('global-ai-trigger').tap()
    const panel = page.getByTestId('global-ai-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveCSS('position', 'fixed')
    await expect(panel.locator('.ai-quick-prompt')).toHaveCount(3)
    await expect(panel.locator('.ai-floating-drag-region')).toHaveCSS('cursor', 'default')
    await panel.getByTestId('global-ai-close').tap()
    await expect(panel).toBeHidden()
    await expect(page.locator('.ai-floating-backdrop')).toHaveCount(0)
  })
})
