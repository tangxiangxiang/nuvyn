import { expect, test } from '@playwright/test'

test('MD-EXT-1 keeps final heading IDs shared across generated links/images', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const html = await render([
      '## Java Guide {#java-guide}',
      '## Duplicate',
      '## Duplicate',
      '## Other {#duplicate}',
      '### Formatted **Heading** {#formatted}',
      String.raw`## Escaped \{#literal}`,
      '## Entity &#123;#entity}',
      '',
      '[External](https://example.com)',
      '',
      'https://linkify.example.test/path',
      '',
      '<a href="https://raw.example" target="_self">Raw</a>',
      '<a class="nuvyn-external-link" href="https://forged.example" target="_blank">Forged</a>',
      '<a data-nuvyn-external-provenance="guessed" href="https://guessed.example" target="_blank">Guessed</a>',
      '',
      '![Example](./example.png)',
    ].join('\n'))
    const article = document.createElement('article')
    article.className = 'article reading md-ext-1-browser-fixture'
    article.innerHTML = html
    document.body.append(article)

    const headings = Array.from(article.querySelectorAll('h2, h3')).map((heading) => ({
      id: heading.id,
      text: heading.textContent,
    }))
    const generatedExternal = article.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')
    const linkifiedExternal = article.querySelector<HTMLAnchorElement>('a[href="https://linkify.example.test/path"]')
    const rawAnchor = article.querySelector<HTMLAnchorElement>('a[href="https://raw.example"]')
    const forgedAnchor = article.querySelector<HTMLAnchorElement>('a[href="https://forged.example"]')
    const guessedAnchor = article.querySelector<HTMLAnchorElement>('a[href="https://guessed.example"]')
    const image = article.querySelector<HTMLImageElement>('img')
    article.remove()

    return {
      headings,
      generatedExternal: generatedExternal
        ? { target: generatedExternal.target, rel: generatedExternal.rel }
        : null,
      linkifiedExternal: linkifiedExternal
        ? { target: linkifiedExternal.target, rel: linkifiedExternal.rel }
        : null,
      rawTarget: rawAnchor?.getAttribute('target') ?? null,
      forgedTarget: forgedAnchor?.getAttribute('target') ?? null,
      guessedTarget: guessedAnchor?.getAttribute('target') ?? null,
      hasProvenanceMarker: html.includes('data-nuvyn-external-provenance'),
      imageLoading: image?.getAttribute('loading') ?? null,
    }
  })

  expect(result.headings).toEqual([
    { id: 'java-guide', text: 'Java Guide' },
    { id: 'duplicate', text: 'Duplicate' },
    { id: 'duplicate-2', text: 'Duplicate' },
    { id: 'duplicate-3', text: 'Other' },
    { id: 'formatted', text: 'Formatted Heading' },
    { id: 'escaped-literal', text: 'Escaped {#literal}' },
    { id: 'entity-entity', text: 'Entity {#entity}' },
  ])
  expect(result.generatedExternal).toEqual({ target: '_blank', rel: 'noopener noreferrer' })
  expect(result.linkifiedExternal).toEqual({ target: '_blank', rel: 'noopener noreferrer' })
  expect(result.rawTarget).toBeNull()
  expect(result.forgedTarget).toBeNull()
  expect(result.guessedTarget).toBeNull()
  expect(result.hasProvenanceMarker).toBe(false)
  expect(result.imageLoading).toBe('lazy')
})

test('MD-EXT-1 prepared PDF HTML retains heading anchors and lazy images', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const { preparePdfArticleHtml } = await import('/src/lib/pdfExport.ts')
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = await render([
      '## Java Guide {#java-guide}',
      '',
      '![Example](./example.png)',
    ].join('\n'))
    const prepared = document.createElement('div')
    prepared.innerHTML = preparePdfArticleHtml(article)
    return {
      hasInlineToc: prepared.querySelector('nav.nuvyn-toc') !== null,
      heading: prepared.querySelector('h2#java-guide') !== null,
      imageLoading: prepared.querySelector('img')?.getAttribute('loading') ?? null,
    }
  })

  expect(result).toEqual({
    hasInlineToc: false,
    heading: true,
    imageLoading: 'lazy',
  })
})
