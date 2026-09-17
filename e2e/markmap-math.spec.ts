import { expect, test } from '@playwright/test'

test('Markmap upgrades browser-loaded KaTeX through retransform', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const markmap = page.locator('.article.reading .markmap-widget-host')
  await expect(markmap).toBeVisible()

  /* This is intentionally scoped to the Markmap host. The specimen also
     contains ordinary Nuvyn math, so a page-wide `.katex` assertion would
     not prove that browser KaTeX autoload triggered Transformer.retransform
     and the existing Markmap instance consumed the new root. */
  const katex = markmap.locator('.katex').first()
  await expect(katex).toBeVisible()
  await expect(katex.locator('[style]').first()).toHaveAttribute('style', /.+/)
})
