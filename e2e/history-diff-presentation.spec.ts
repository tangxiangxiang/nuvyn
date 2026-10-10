import { test, expect } from './fixtures/auth'
import { interceptHistory } from './helpers/edit-program'

for (const locale of ['en-US', 'zh-CN']) {
  test.describe(locale, () => {
    test.use({ locale })

    test('keeps the withdraw menu compact and left aligned', async ({ page }) => {
      await interceptHistory(page, { files: ['inbox/menu-preview.md'], raw: '# Preview', sha: 'menu-revision' })
      await page.goto('/vault')
      await page.locator(`button.ab-btn[aria-label="${locale === 'zh-CN' ? '历史' : 'History'}"]`).click()
      await page.locator('.history-timeline-group-header').first().click()
      await page.locator('.history-commit-row').first().click({ button: 'right' })
      const menu = page.locator('.history-context-menu')
      const item = menu.getByRole('menuitem')
      await expect(item).toHaveClass(/danger/)
      await expect(item).toHaveClass(/n-button--small-type/)
      expect(await item.evaluate(element => getComputedStyle(element).height)).toBe('28px')
      expect(await item.locator('.n-button__content').evaluate(element => getComputedStyle(element).justifyContent)).toBe('flex-start')
      expect(await menu.evaluate(element => {
        const label = element.querySelector('.n-button__content')!
        const range = document.createRange()
        range.selectNodeContents(label)
        return element.getBoundingClientRect().width - range.getBoundingClientRect().width
      })).toBeLessThan(40)
      await item.hover()
      await expect.poll(() => item.evaluate(element => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--vs-danger, #c94f4f)'
        probe.style.backgroundColor = 'color-mix(in srgb, var(--vs-danger, #c94f4f) 8%, transparent)'
        element.append(probe)
        const actual = getComputedStyle(element)
        const reference = getComputedStyle(probe)
        const matches = actual.color === reference.color && actual.backgroundColor === reference.backgroundColor
        probe.remove()
        return matches
      })).toBe(true)
      if (locale === 'zh-CN') await menu.screenshot({ path: '/tmp/nuvyn-withdraw-menu-preview.png' })
      await item.press('Escape')
      await expect(menu).toHaveCount(0)
    })

    test('file context actions reuse comparison and restore confirmation', async ({ page, request }) => {
      const path = `inbox/e2e-history-context-${Date.now()}`
      const created = await request.post('/api/posts', { data: { path, title: 'Context actions' } })
      expect(created.ok()).toBe(true)
      try {
        await interceptHistory(page, { files: [`${path}.md`], raw: '# Historical content', sha: 'context-revision', subject: 'Context actions' })
        await page.goto('/vault')
        await page.locator(`button.ab-btn[aria-label="${locale === 'zh-CN' ? '历史' : 'History'}"]`).click()
        await page.locator('.history-timeline-group-header').first().click()
        await page.locator('.history-commit-row').first().click()
        const file = page.locator('.history-file-row').first()
        await file.click({ button: 'right' })
        const menu = page.locator('.history-context-menu')
        await menu.getByRole('menuitem', { name: locale === 'zh-CN' ? '与当前工作区比较' : 'Compare with Working Tree' }).click()
        await expect(page.locator('.history-comparison-direction')).toContainText(locale === 'zh-CN' ? '工作区' : 'Working tree')
        await file.focus()
        await file.press('Shift+F10')
        await menu.getByRole('menuitem', { name: locale === 'zh-CN' ? '恢复到这个版本…' : 'Restore to this version…' }).click()
        const confirmation = page.locator('.n-dialog[role="dialog"]')
        await expect(confirmation).toBeVisible()
        await confirmation.getByRole('button', { name: locale === 'zh-CN' ? '取消' : 'Cancel', exact: true }).click()
        await expect(confirmation).not.toBeVisible()
      } finally {
        await request.delete(`/api/posts/${path}`)
      }
    })

    test('shows zero change counts without extra information rows', async ({ page }) => {
      await interceptHistory(page, {
        files: ['inbox/diff-preview.md'], raw: '# Identical content', sha: 'same-revision', parents: ['parent-revision'], subject: 'Same content comparison',
      })
      await page.goto('/vault')
      await page.locator(`button.ab-btn[aria-label="${locale === 'zh-CN' ? '历史' : 'History'}"]`).click()
      await page.locator('.history-timeline-group-header').first().click()
      await page.locator('.history-commit-row').first().click()
      await page.locator('.history-file-row').first().click()
      const pane = page.locator('.history-comparison-pane')
      await expect(pane.locator('.history-diff-stats .is-added')).toHaveText('+0')
      await expect(pane.locator('.history-diff-stats .is-removed')).toHaveText('−0')
      await expect(pane.locator('.history-diff-identical, .history-diff-summary, .history-unchanged-notice')).toHaveCount(0)
      const headerBox = await pane.locator('.history-diff-header').boundingBox()
      const contentBox = await pane.locator('.history-unchanged-content').boundingBox()
      expect(contentBox!.y).toBeCloseTo(headerBox!.y + headerBox!.height, 0)
      if (locale === 'zh-CN') await pane.screenshot({ path: '/tmp/nuvyn-diff-identical-preview.png' })
      const trigger = pane.locator('.history-pane-menu-trigger')
      await expect(trigger.locator('.history-pane-menu-icon svg')).toHaveCount(1)
      await trigger.click()
      const menu = pane.locator('.history-pane-menu')
      await expect(menu).toBeVisible()
      const item = menu.getByRole('menuitem').first()
      await item.hover()
      await expect.poll(() => item.evaluate(element => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--vs-text-1)'
        probe.style.backgroundColor = 'var(--vs-hover-bg)'
        element.append(probe)
        const actual = getComputedStyle(element)
        const reference = getComputedStyle(probe)
        const matches = actual.color === reference.color && actual.backgroundColor === reference.backgroundColor
        probe.remove()
        return matches
      })).toBe(true)
      expect(await item.locator('.n-button__content').evaluate(element => getComputedStyle(element).justifyContent)).toBe('flex-start')
      if (locale === 'zh-CN') await menu.screenshot({ path: '/tmp/nuvyn-diff-menu-preview.png' })
      await item.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(trigger).toBeFocused()
    })

    test('keeps the diff header compact and change backgrounds subtle', async ({ page }) => {
      const summary = 'Refine the document and preserve the full revision summary. '.repeat(12)
      await interceptHistory(page, {
        files: ['inbox/diff-preview.md'], raw: '# New content', sha: 'preview-revision', parents: ['parent-revision'], subject: summary,
      })
      await page.route('**/api/history/file?**', route => {
        const url = new URL(route.request().url())
        const ref = url.searchParams.get('ref')
        return route.fulfill({ json: {
          path: 'inbox/diff-preview.md', ref,
          content: ref === 'parent-revision' ? '# Previous content' : '# New content',
        } })
      })
      await page.goto('/vault')
      await page.locator(`button.ab-btn[aria-label="${locale === 'zh-CN' ? '历史' : 'History'}"]`).click()
      await page.locator('.history-timeline-group-header').first().click()
      await page.locator('.history-commit-row').first().click()
      await page.locator('.history-file-row').first().click()
      const pane = page.locator('.history-comparison-pane')
      await expect(pane).toBeVisible()
      await expect(pane.locator('.history-diff-summary')).toHaveCount(0)
      const revision = pane.locator('.history-revision-chip').last()
      await expect(revision).toHaveAttribute('title', /2026-07-21 \d{2}:\d{2}/)
      expect(await revision.getAttribute('title')).toContain(summary)
      for (const operation of ['add', 'remove']) {
        const row = pane.locator(`.unified-diff-line.is-${operation}`)
        await expect(row).toHaveCount(1)
        expect(await row.evaluate((element, operation) => {
          const probe = document.createElement('span')
          probe.style.backgroundColor = `color-mix(in srgb, var(--diff-${operation}-color) 7%, var(--vs-bg-1))`
          element.append(probe)
          const matches = getComputedStyle(element).backgroundColor === getComputedStyle(probe).backgroundColor
          probe.remove()
          return matches
        }, operation)).toBe(true)
      }
      if (locale === 'zh-CN') await pane.screenshot({ path: '/tmp/nuvyn-diff-preview.png' })
      await page.getByTestId('left-panel-toggle').click()
      const rightToggle = page.locator('.right-rail-toggle')
      if (await rightToggle.getAttribute('aria-pressed') === 'true') await rightToggle.click()
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(revision).toBeVisible()
      await expect(pane.locator('.history-diff-summary')).toHaveCount(0)
    })
  })
}
