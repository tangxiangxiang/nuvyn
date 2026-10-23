import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'

const host = (page: Page) => page.locator('.monaco-host')
const flex = '::: flex gap=7\n\nContent\n\n:::'
async function useMountedMonacoApi(page: Page) {
  await page.evaluate(async () => {
    // Import the same Vite-resolved API as the app. A raw node_modules URL
    // creates a second Monaco marker service, falsely reporting no markers.
    const module = await (await fetch('/src/components/vault/monacoModels.ts')).text()
    const url = /import \* as monaco from ["']([^"']+)["']/u.exec(module)?.[1]
    if (!url) throw new Error('Mounted Monaco API import not found')
    Object.assign(window, { __syntaxApi: (await import(url)).editor })
  })
}
async function markers(page: Page) {
  return host(page).evaluate((el) => {
    const { editor } = (el as any).__vueParentComponent.setupState
    return (window as any).__syntaxApi.getModelMarkers({ owner: 'nuvyn-syntax', resource: editor.getModel().uri }).map((item: any) => ({
      message: item.message, severity: item.severity,
      line: item.startLineNumber, start: item.startColumn, end: item.endColumn,
    }))
  })
}

async function selectText(page: Page, text: string) {
  await host(page).evaluate((el, text) => {
    const editor = (el as any).__vueParentComponent.setupState.editor
    const match = editor.getModel().findMatches(text, false, false, true, null, false)[0]
    if (!match) throw new Error(`Missing source text: ${text}`)
    editor.setSelection(match.range)
    editor.revealRangeInCenter(match.range)
    editor.focus()
  }, text)
}

test('native syntax hints follow edits, Undo, Note switches and Reader without changing saves', async ({ page, request }) => {
  const id = randomUUID().slice(0, 8)
  const a = `inbox/syntax-a-${id}`
  const b = `inbox/syntax-b-${id}`
  const prefix = '# Syntax\n\n'
  const bSource = '# Group\n\n::: code-group\n\n```java [Java]\nSystem.out.println("Hello");\n```\n\n:::\n\n```md\n::: flex gap=7\n:::\n<<< ./example.ts{3-}\n```'
  await createDoc(request, a, prefix, [])
  await createDoc(request, b, bSource, [])
  try {
    await gotoVaultReady(page)
    await useMountedMonacoApi(page)
    await openDoc(page, a)
    await host(page).evaluate((el) => {
      const { editor } = (el as any).__vueParentComponent.setupState
      Object.assign(window, { __syntaxModel: editor.getModel() })
      editor.setPosition({ lineNumber: 3, column: 1 })
      editor.focus()
    })
    await page.keyboard.insertText(flex)
    await expect.poll(() => markers(page)).toEqual([{
      message: 'Flex 的 gap=7 不受支持。允许值：0、4、8、12、16、24、32。',
      severity: 1, line: 3, start: 10, end: 15,
    }])
    // Separate the parameter correction from the preceding whole-block paste.
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.pushUndoStop())
    await selectText(page, 'gap=7')
    await page.keyboard.insertText('gap=16')
    await expect.poll(() => markers(page)).toEqual([])
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.trigger('syntax-test', 'undo', null))
    await expect.poll(async () => (await markers(page)).length).toBe(1)
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.trigger('syntax-test', 'redo', null))
    await expect.poll(() => markers(page)).toEqual([])
    await expect(page.locator(`[data-tab-id="${a}"]`)).toHaveAttribute('data-save-status', 'saved')
    expect((await (await request.get(`/api/posts/${a}`)).json()).raw).toBe(prefix + flex.replace('gap=7', 'gap=16'))
    await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.trigger('syntax-test', 'undo', null))
    await expect.poll(async () => (await markers(page)).length).toBe(1)
    await openDoc(page, b)
    await expect.poll(() => markers(page)).toEqual([])
    expect(await page.evaluate(() => (window as any).__syntaxApi.getModelMarkers({ owner: 'nuvyn-syntax', resource: (window as any).__syntaxModel.uri }))).toEqual([])

    await selectText(page, '[Java]')
    await page.keyboard.press('Backspace')
    await expect.poll(() => markers(page)).toEqual([{
      message: 'Code Group 中的代码块需要非空的 [Label]。', severity: 1, line: 5, start: 1, end: 8,
    }])
    await page.keyboard.insertText('[Java]')
    await expect.poll(() => markers(page)).toEqual([])
    await page.getByTestId('view-toggle').click()
    await expect(page.locator('.reading-pane .nuvyn-code-group').getByRole('tab')).toHaveText(['Java'])
    await expect(page.locator('.reading-pane .article')).toContainText('::: flex gap=7')
    await page.getByTestId('view-toggle').click()
    await expect.poll(() => markers(page)).toEqual([])
  } finally {
    await request.delete(`/api/posts/${a}`)
    await request.delete(`/api/posts/${b}`)
  }
})

test('resource format hints are readonly and never perform resource lookups while editing', async ({ page, request }) => {
  const slug = `inbox/syntax-resources-${randomUUID().slice(0, 8)}`
  const source = '# Resources\n\n<<< ./example.ts{3-}\n\n<!--@include: ./part.md{typescript}-->'
  await createDoc(request, slug, source, [])
  const lookups: string[] = []
  const writes: string[] = []
  page.on('request', (event) => {
    if (new URL(event.url()).pathname === '/api/markdown-resources') lookups.push(event.url())
    if (event.method() === 'PUT' && new URL(event.url()).pathname === `/api/posts/${slug}`) writes.push(event.url())
  })
  try {
    await gotoVaultReady(page)
    await useMountedMonacoApi(page)
    await openDoc(page, slug)
    await expect.poll(async () => (await markers(page)).map((item: any) => item.line)).toEqual([3, 5])
    await expect(page.locator(`[data-tab-id="${slug}"]`)).toHaveAttribute('data-save-status', 'idle')
    expect((await (await request.get(`/api/posts/${slug}`)).json()).raw).toBe(source)
    expect(writes).toEqual([])
    await selectText(page, '{3-}')
    await page.keyboard.insertText('{3,}')
    await selectText(page, '{typescript}')
    await page.keyboard.press('Backspace')
    await expect.poll(() => markers(page)).toEqual([])
    expect(lookups).toEqual([])
  } finally { await request.delete(`/api/posts/${slug}`) }
})
