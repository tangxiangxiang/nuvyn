import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/auth'
import { createDoc, gotoVaultReady, openDoc } from './helpers/edit-program'

const defaults = {
  flex: '::: flex direction=row gap=16\n\nFirst item\n\nSecond item\n\n:::\n',
  'code-group': '::: code-group\n\n```java [Java]\nSystem.out.println("Hello");\n```\n\n```python [Python]\nprint("Hello")\n```\n\n:::\n',
  details: '::: details Read more\n\nDetails content\n\n:::\n',
  snippet: '<<< ./example.ts\n',
  include: '<!--@include: ./part.md-->\n',
} as const

const host = (page: Page) => page.locator('.monaco-host')
// Monaco can retain a model's native CRLF convention; compare logical lines.
const value = (page: Page) => host(page).evaluate((el) => ((el as any).__vueParentComponent.setupState.editor.getValue() as string).replace(/\r\n/g, '\n'))
const selected = (page: Page) => host(page).evaluate((el) => {
  const editor = (el as any).__vueParentComponent.setupState.editor
  return editor.getModel().getValueInRange(editor.getSelection()) as string
})

async function insertCommand(page: Page, label: string, query = label, accept?: 'Tab' | 'Enter') {
  if (/^[a-z-]+$/.test(query)) await page.keyboard.type(`/${query}`)
  else await page.keyboard.insertText(`/${query}`)
  // Explicit invocation also covers full pasted queries, not just the '/' trigger.
  await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.getAction('editor.action.triggerSuggest').run())
  const suggestion = page.locator('.suggest-widget.visible .monaco-list-row').filter({
    has: page.locator('.label-name', { hasText: new RegExp(`^${label}$`) }),
  })
  await expect(suggestion).toBeVisible()
  if (accept) await page.keyboard.press(accept)
  else await suggestion.click()
}

for (const [label, accept, firstField] of [['code-group', 'Enter', 'System.out.println("Hello");'], ['task', 'Tab', 'Task']] as const) {
  test(`native ${accept} accepts /${label} without invoking Markdown indent or enter actions`, async ({ page, request }) => {
    const slug = `inbox/slash-keyboard-${label}-${randomUUID().slice(0, 8)}`
    await createDoc(request, slug, '', [])
    try {
      await gotoVaultReady(page)
      await openDoc(page, slug)
      await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.focus())
      await insertCommand(page, label, label, accept)
      expect(await selected(page)).toBe(firstField)
      expect(await value(page)).toBe(label === 'task' ? '- [ ] Task' : defaults['code-group'])
    } finally { await request.delete(`/api/posts/${slug}`) }
  })
}

for (const label of Object.keys(defaults) as Array<keyof typeof defaults>) {
  test(`/${label} inserts a real Monaco snippet, navigates Tab stops and renders existing syntax`, async ({ page, request }) => {
    const id = randomUUID().slice(0, 8)
    const slug = `inbox/slash-${label}-${id}`
    const prefix = label === 'flex' ? '' : '# Before\n\n'
    await createDoc(request, slug, prefix, [])
    const codeName = `slash-resource-${id}.ts`
    const partSlug = `inbox/slash-part-${id}`
    const codePath = path.join(process.env.NUVYN_DRAFT_E2E_VAULT ?? path.join(os.tmpdir(), 'nuvyn-e2e-vault-4174'), 'inbox', codeName)
    if (label === 'snippet') await fs.writeFile(codePath, 'export const slashTemplate = 42\n', 'utf8')
    if (label === 'include') await createDoc(request, partSlug, '## Included template\n\nIncluded body\n', [])
    try {
      await gotoVaultReady(page)
      await openDoc(page, slug)
      await host(page).evaluate((el) => {
        const editor = (el as any).__vueParentComponent.setupState.editor
        const model = editor.getModel()
        const lineNumber = model.getLineCount()
        editor.setPosition({ lineNumber, column: model.getLineMaxColumn(lineNumber) })
        editor.focus()
      })
      await insertCommand(page, label)
      expect(await value(page)).toBe(prefix + defaults[label])
      // Undo must remove the whole completion, restoring the typed query.
      await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.trigger('slash-test', 'undo', null))
      expect(await value(page)).toBe(`${prefix}/${label}`)
      await host(page).evaluate((el) => {
        const editor = (el as any).__vueParentComponent.setupState.editor
        editor.setPosition({ lineNumber: editor.getModel().getLineCount(), column: editor.getModel().getLineMaxColumn(editor.getModel().getLineCount()) })
        editor.focus()
      })
      // Reaccept the existing query without typing another slash.
      await host(page).evaluate((el) => (el as any).__vueParentComponent.setupState.editor.getAction('editor.action.triggerSuggest').run())
      await page.locator('.suggest-widget.visible .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${label}$`) }) }).click()

      const fields = label === 'flex' ? ['First item', 'Second item']
        : label === 'code-group' ? ['System.out.println("Hello");', 'print("Hello")']
          : label === 'details' ? ['Read more', 'Details content']
            : [label === 'snippet' ? './example.ts' : './part.md']
      expect(await selected(page)).toBe(fields[0])
      if (fields.length === 2) {
        await page.keyboard.press('Tab')
        expect(await selected(page)).toBe(fields[1])
        await page.keyboard.press('Shift+Tab')
        expect(await selected(page)).toBe(fields[0])
        await page.keyboard.press('Tab')
      } else {
        await page.keyboard.insertText(label === 'snippet' ? `./${codeName}` : `./${partSlug.split('/').pop()}.md`)
      }
      await page.keyboard.press('Tab')
      expect(await selected(page)).toBe('')
      const raw = await value(page)
      expect(raw).not.toMatch(/\$\{|\$0|\/(?:flex|code-group|details|snippet|include)(?=:::|<<<|<!--)/)
      const cursor = await host(page).evaluate((el) => {
        const editor = (el as any).__vueParentComponent.setupState.editor
        const position = editor.getPosition()
        return { lineNumber: position.lineNumber, column: position.column, lastLine: editor.getModel().getLineCount() }
      })
      expect(cursor).toEqual({ lineNumber: raw.split('\n').length, column: 1, lastLine: raw.split('\n').length })
      await page.getByTestId('view-toggle').click()
      const article = page.locator('.reading-pane .article')
      if (label === 'flex') {
        const flex = article.locator('.nuvyn-flex')
        await expect(flex).toHaveClass(/nuvyn-flex-direction-row/)
        await expect(flex).toHaveClass(/nuvyn-flex-mobile-stack/)
        await expect(flex.locator(':scope > p')).toHaveText(['First item', 'Second item'])
      } else if (label === 'code-group') {
        const group = article.locator('.nuvyn-code-group')
        await expect(group.getByRole('tab')).toHaveText(['Java', 'Python'])
        await expect(group.getByRole('tabpanel').first()).toContainText('System.out.println("Hello");')
        await group.getByRole('tab', { name: 'Python', exact: true }).click()
        await expect(group.getByRole('tabpanel', { name: 'Python', exact: true })).toContainText('print("Hello")')
      } else if (label === 'details') {
        const details = article.locator('details')
        await expect(details).not.toHaveAttribute('open')
        await expect(details.locator('p')).not.toBeVisible()
        await details.locator('summary').click()
        await expect(details.locator('p')).toHaveText('Details content')
        await expect(details.locator('p')).toBeVisible()
      } else if (label === 'snippet') {
        await expect(article.locator('pre code')).toContainText('export const slashTemplate = 42')
      } else {
        await expect(article.locator('h2#included-template')).toHaveText('Included template')
        await expect(article).toContainText('Included body')
      }
    } finally {
      await request.delete(`/api/posts/${slug}`)
      if (label === 'snippet') await fs.rm(codePath, { force: true })
      if (label === 'include') await request.delete(`/api/posts/${partSlug}`)
    }
  })
}

for (const tabSize of [2, 4]) {
  test(`slash completion preserves an indented blank line and surrounding text with tab size ${tabSize}`, async ({ page, request }) => {
    const slug = `inbox/slash-indent-${tabSize}-${randomUUID().slice(0, 8)}`
    const source = '# Before\n\n  \n\nAfter'
    await createDoc(request, slug, source, [])
    try {
      await gotoVaultReady(page)
      await openDoc(page, slug)
      await host(page).evaluate((el, tabSize) => {
        const editor = (el as any).__vueParentComponent.setupState.editor
        editor.getModel().updateOptions({ tabSize, insertSpaces: true })
        editor.setPosition({ lineNumber: 3, column: 3 })
        editor.focus()
      }, tabSize)
      await insertCommand(page, 'flex', tabSize === 2 ? '布局' : 'flex')
      expect(await selected(page)).toBe('First item')
      await page.keyboard.insertText('Changed first')
      await page.keyboard.press('Tab')
      expect(await selected(page)).toBe('Second item')
      await page.keyboard.insertText('Changed second')
      await page.keyboard.press('Tab')
      expect(await value(page)).toBe('# Before\n\n  ::: flex direction=row gap=16\n  \n  Changed first\n  \n  Changed second\n  \n  :::\n  \n\nAfter')
      await page.getByTestId('view-toggle').click()
      await expect(page.locator('.reading-pane .nuvyn-flex > p')).toHaveText(['Changed first', 'Changed second'])
    } finally { await request.delete(`/api/posts/${slug}`) }
  })
}
