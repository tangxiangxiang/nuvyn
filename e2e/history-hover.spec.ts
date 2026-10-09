import { test, expect } from './fixtures/auth'
import { interceptHistory } from './helpers/edit-program'

for (const locale of ['en-US', 'zh-CN']) {
  test.describe(locale, () => {
    test.use({ locale })

    test('changes composer stays compact and explains disabled submission', async ({ page }) => {
      const longPath = 'inbox/a-very-long-document-title-for-sidebar-layout-testing.md'
      await interceptHistory(page, { files: [longPath], raw: '# Preview', sha: 'preview-test', subject: 'Preview changes' })
      await page.route('**/api/history/status', route => route.fulfill({
        json: { available: true, dirty: [
          { path: longPath, index: ' ', worktree: 'M' },
          { path: 'inbox/new.md', index: '?', worktree: '?' },
        ] },
      }))
      await page.goto('/vault')
      await page.locator(`button.ab-btn[aria-label="${locale === 'zh-CN' ? '历史' : 'History'}"]`).click()
      await expect(page.locator('.history-selected-count')).toHaveCount(0)
      await expect(page.locator('.history-create-version')).toBeDisabled()
      await expect(page.locator('.history-create-action')).toHaveAttribute('title', locale === 'zh-CN' ? '填写提交说明后即可创建版本' : 'Enter a version message to create this version')
      const input = page.locator('#history-version-message')
      const ai = page.locator('.history-generate-message')
      const inputBox = await input.boundingBox()
      const aiBox = await ai.boundingBox()
      expect(aiBox!.y).toBeGreaterThanOrEqual(inputBox!.y + inputBox!.height)
      const submitBox = await page.locator('.history-create-version').boundingBox()
      expect(aiBox!.height).toBeCloseTo(submitBox!.height, 0)
      expect(aiBox!.y).toBeCloseTo(submitBox!.y, 0)
      expect(submitBox!.x - (aiBox!.x + aiBox!.width)).toBeCloseTo(0, 0)
      expect(aiBox!.width).toBeCloseTo(submitBox!.width, 0)
      const actionBox = await page.locator('.history-composer-actions').boundingBox()
      expect(aiBox!.x).toBeCloseTo(actionBox!.x, 0)
      expect(submitBox!.x + submitBox!.width).toBeCloseTo(actionBox!.x + actionBox!.width, 0)
      if (locale === 'zh-CN') await page.locator('.history-version-composer').screenshot({ path: '/tmp/nuvyn-history-composer-buttons-preview.png' })
      await input.fill('Preview changes')
      await expect(page.locator('.history-create-version')).toBeEnabled()
      await expect(page.locator('.history-commit-hint')).toHaveCount(0)
      await page.locator('.history-changes-actions button').click()
      await expect(page.locator('.history-create-action')).toHaveAttribute('title', locale === 'zh-CN' ? '请选择要提交的文件' : 'Select files to include in this version')
      await expect(ai).toBeDisabled()
      await page.locator('.history-changes-actions button').click()
      const title = page.locator('.history-change-copy strong').first()
      expect(await title.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      await expect(page.locator('.history-change-open').first()).toHaveAttribute('title', `a-very-long-document-title-for-sidebar-layout-testing\n${longPath}`)
      const statusEdges = await page.locator('.history-change-status').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().right))
      expect(statusEdges[0]).toBeCloseTo(statusEdges[1]!, 0)
      if (locale === 'zh-CN') await page.locator('.history-panel').screenshot({ path: '/tmp/nuvyn-history-composer-preview.png' })
      const splitter = page.locator('.splitter:not(.splitter-toc)')
      const splitterBox = await splitter.boundingBox()
      await splitter.dispatchEvent('pointerdown', { clientX: splitterBox!.x + splitterBox!.width / 2 })
      await page.mouse.move(0, splitterBox!.y + 80)
      await page.mouse.up()
      expect(await page.locator('.history-composer-actions').evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return [...element.querySelectorAll('button')].every(child => {
          const box = child.getBoundingClientRect()
          return box.left >= bounds.left && box.right <= bounds.right + 1
        })
      })).toBe(true)
      await expect(page.locator('.history-create-version')).toBeEnabled()
    })

    test('history rows use sidebar hover colors without accent text', async ({ page }) => {
      await interceptHistory(page, { files: ['inbox/hover-note.md'], raw: '# Hover note', sha: 'hover-test', subject: 'Hover test' })
      await page.goto('/vault')
      await page.locator(`button.ab-btn[aria-label="${locale === 'zh-CN' ? '历史' : 'History'}"]`).click()
      const day = page.locator('.history-timeline-group-header').first()
      await expect(day.locator('.history-timeline-group-title')).toHaveText(locale === 'zh-CN' ? '2026-07-21 周二' : '2026-07-21 Tue')
      await day.click()
      const commit = page.locator('.history-commit-row').first()
      await commit.click()
      await expect(commit).toHaveAttribute('title', 'Hover test\nhover-t')
      await expect(page.locator('.history-commit-tooltip')).toHaveCount(0)
      const file = page.locator('.history-file-row').first()
      await expect(day.locator('.history-timeline-count')).toHaveText(locale === 'zh-CN' ? '1 次提交' : '1 commit')
      await expect(commit.locator('.history-row-file-count')).toHaveText(locale === 'zh-CN' ? '1 个文件' : '1 file')
      await expect.poll(() => commit.locator('.history-row-title').evaluate(element => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--vs-text-1)'
        element.append(probe)
        const matches = getComputedStyle(element).color === getComputedStyle(probe).color
        probe.remove()
        return matches
      })).toBe(true)
      const dateEdge = await day.locator('.history-timeline-count').boundingBox()
      const commitEdge = await commit.locator('.history-row-file-count').boundingBox()
      expect(dateEdge).not.toBeNull()
      expect(commitEdge).not.toBeNull()
      expect(dateEdge!.x + dateEdge!.width).toBeCloseTo(commitEdge!.x + commitEdge!.width, 0)
      const textRight = (element: Element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        return range.getBoundingClientRect().right
      }
      expect(await day.locator('.history-timeline-count').evaluate(textRight))
        .toBeCloseTo(await commit.locator('.history-row-file-count').evaluate(textRight), 0)
      for (const row of [day, commit, file]) {
        await row.hover()
        await expect.poll(() => row.evaluate(element => {
          const probe = document.createElement('span')
          probe.style.backgroundColor = 'var(--vs-hover-bg)'
          probe.style.color = 'var(--vs-text-1)'
          element.append(probe)
          const reference = getComputedStyle(probe)
          const actual = getComputedStyle(element)
          const result = actual.backgroundColor === reference.backgroundColor && actual.color === reference.color
          probe.remove()
          return result
        })).toBe(true)
      }
    })
  })
}
