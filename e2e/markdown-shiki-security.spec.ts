import { expect, test } from '@playwright/test'

test('Shiki classes and trusted generated CSS stay outside sanitized article HTML', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  await expect(page.locator('.article.reading')).toBeVisible()

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const sourceSentinel = 'NUVYN_H4_BROWSER_SOURCE_SENTINEL_83c1'
    const html = await render([
      '```js',
      `const value = "${sourceSentinel}"`,
      '</style> body { display:none } --evil: red .nuvyn-shiki-hijack {}',
      '```',
      '',
      '<span style="color:rgb(1,2,3)" onclick="window.__nuvynH4Pwned=1">unsafe</span>',
      '<img src="/x" onerror="window.__nuvynH4Pwned=1">',
      '<a href="javascript:alert(1)">unsafe link</a>',
    ].join('\n'))
    const article = document.createElement('article')
    article.innerHTML = html
    document.body.append(article)

    const owner = document.head.querySelector('style#nuvyn-shiki-generated-styles')
    const tokenClass = Array.from(article.querySelectorAll<HTMLElement>('[class]'))
      .flatMap((element) => Array.from(element.classList))
      .find((className) => className.startsWith('nuvyn-shiki-'))
    const result = {
      html,
      articleText: article.textContent ?? '',
      hasShiki: Boolean(article.querySelector('pre.shiki')),
      hasLine: Boolean(article.querySelector('span.line')),
      tokenClass: tokenClass ?? null,
      styleAttributeCount: article.querySelectorAll('[style]').length,
      hasOnclick: Boolean(article.querySelector('[onclick]')),
      hasOnerror: Boolean(article.querySelector('[onerror]')),
      hasJavascriptHref: Boolean(article.querySelector('a[href^="javascript:"]')),
      hasScript: Boolean(article.querySelector('script')),
      hasArticleStyle: Boolean(article.querySelector('style')),
      hasManagedStyleInArticle: Boolean(article.querySelector('#nuvyn-shiki-generated-styles')),
      ownerCount: document.head.querySelectorAll('style#nuvyn-shiki-generated-styles').length,
      ownerParentIsHead: owner?.parentElement === document.head,
      ownerCss: owner?.textContent ?? '',
      pwned: (window as Window & { __nuvynH4Pwned?: unknown }).__nuvynH4Pwned,
    }
    article.remove()
    return result
  })

  expect(result.hasShiki).toBe(true)
  expect(result.hasLine).toBe(true)
  expect(result.tokenClass).toMatch(/^nuvyn-shiki-/)
  expect(result.styleAttributeCount).toBe(0)
  expect(result.hasOnclick).toBe(false)
  expect(result.hasOnerror).toBe(false)
  expect(result.hasScript).toBe(false)
  expect(result.hasArticleStyle).toBe(false)
  expect(result.hasManagedStyleInArticle).toBe(false)
  expect(result.html).not.toContain('nuvyn-shiki-generated-styles')
  expect(result.hasJavascriptHref).toBe(false)
  expect(result.articleText).toContain('NUVYN_H4_BROWSER_SOURCE_SENTINEL_83c1')
  expect(result.ownerCount).toBe(1)
  expect(result.ownerParentIsHead).toBe(true)
  expect(result.ownerCss).toContain('.nuvyn-shiki-')
  expect(result.ownerCss).toContain('--shiki-light:')
  expect(result.ownerCss).toContain('--shiki-dark:')
  expect(result.ownerCss).not.toContain('NUVYN_H4_BROWSER_SOURCE_SENTINEL_83c1')
  expect(result.ownerCss).not.toContain('body { display:none }')
  expect(result.pwned).toBeUndefined()
})
