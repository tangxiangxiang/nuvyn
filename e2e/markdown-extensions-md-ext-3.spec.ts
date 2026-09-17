import { expect, test } from '@playwright/test'

const annotatedSource = [
  '```ts {1,3}:line-numbers=10 [example.ts]',
  'const first = 1 // [!code highlight]',
  'const second = 2 // [!code focus:2]',
  'const added = 3 // [!code ++]',
  'const warning = 4 // [!code warning]',
  'const deferred = 5 // [!code highlight:2]',
  '```',
  '',
  '```mermaid {1}',
  'graph TD',
  'A --> B',
  '```',
].join('\n')

test('MD-EXT-3 separates fence metadata from approved Shiki source notation', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async (markdown: string) => {
    const { render } = await import('/src/lib/markdown.ts')
    const article = document.createElement('article')
    article.className = 'article reading md-ext-3-browser-fixture'
    article.innerHTML = await render(markdown)
    document.body.append(article)

    const lines = Array.from(article.querySelectorAll<HTMLElement>('pre.shiki .line'))
    const lineContaining = (text: string) => lines.find((line) => line.textContent?.includes(text))
    const first = lineContaining('const first')
    const focused = lineContaining('const second')
    const added = lineContaining('const added')
    const warning = lineContaining('const warning')
    const deferred = lineContaining('const deferred')
    const beforeSwitch = article.innerHTML
    const firstNode = first

    const { useTheme } = await import('/src/composables/useTheme.ts')
    useTheme().set('dark')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const result = {
      firstHighlighted: first?.classList.contains('highlighted') ?? false,
      focused: focused?.classList.contains('focused') ?? false,
      added: added?.classList.contains('diff') && added?.classList.contains('add'),
      warning: warning?.classList.contains('warning') ?? false,
      deferredKeptAsSource: deferred?.textContent?.includes('[!code highlight:2]') ?? false,
      deferredNotActivated: deferred?.classList.contains('highlighted') === false,
      lineNumberDom: article.querySelector('.nuvyn-line-number, .nuvyn-line-content') !== null,
      metadataMermaidNotSpecial: article.querySelector('.mermaid-mount') === null,
      deferredGateMarkerLeaked: article.innerHTML.includes('nuvyn-deferred-notation'),
      annotationBackground: first ? getComputedStyle(first).backgroundColor : '',
      annotationBorder: first ? getComputedStyle(first).boxShadow : '',
      themeSwitchKeptDom: article.innerHTML === beforeSwitch && first === firstNode,
    }
    article.remove()
    useTheme().set('light')
    return result
  }, annotatedSource)

  expect(result).toEqual({
    firstHighlighted: true,
    focused: true,
    added: true,
    warning: true,
    deferredKeptAsSource: true,
    deferredNotActivated: true,
    lineNumberDom: true,
    metadataMermaidNotSpecial: true,
    deferredGateMarkerLeaked: false,
    annotationBackground: expect.not.stringMatching(/^(|rgba\(0, 0, 0, 0\))$/),
    annotationBorder: expect.not.stringMatching(/^(|none)$/),
    themeSwitchKeptDom: true,
  })
})

test('MD-EXT-3 keeps annotated line surfaces visible across reader themes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/__markdown-test?mode=reading')

  const source = [
    '```ts {1,3-5}',
    'const meta = 1',
    'const plain = 2',
    'const metaThree = 3',
    'const metaFour = 4',
    'const metaFive = 5',
    'const metaTail = 6',
    '```',
    '',
    '```ts',
    'const source = 1 // [!code highlight]',
    'const focused = 2 // [!code focus]',
    'const added = 3 // [!code ++]',
    'const removed = 4 // [!code --]',
    'const warning = 5 // [!code warning]',
    'const error = 6 // [!code error]',
    'const info = 7 // [!code info]',
    '```',
    '',
    '```ts {2,4}:line-numbers=30',
    'const numberedOne = 1',
    'const numberedTwo = 2',
    'const numberedThree = 3',
    'const numberedFour = 4',
    '```',
  ].join('\n')

  const light = await page.evaluate(async (markdown: string) => {
    const { render } = await import('/src/lib/markdown.ts')
    const { useTheme } = await import('/src/composables/useTheme.ts')
    useTheme().set('light')
    const article = document.createElement('article')
    article.className = 'article reading md-ext-3-line-surface-fixture'
    article.style.width = '760px'
    article.innerHTML = await render(markdown)
    document.body.append(article)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const isTransparent = (value: string) => {
      const normalized = value.trim().toLowerCase().replace(/\s+/gu, '')
      return normalized === 'transparent'
        || normalized === 'rgba(0,0,0,0)'
        || normalized === 'rgb(0,0,0,0)'
        || normalized === 'rgb(0,0,0/0)'
    }
    const nonNumbered = Array.from(article.querySelectorAll<HTMLElement>(
      'pre.shiki:not(.nuvyn-line-numbers):not(.nuvyn-shiki-plain)',
    ))
    const numbered = article.querySelector<HTMLElement>('pre.shiki.nuvyn-line-numbers')
    const meta = nonNumbered[0]
    const notation = nonNumbered[1]
    if (!meta || !notation || !numbered) throw new Error('line-surface fixture is incomplete')

    const readLine = (line: HTMLElement | null, pre: HTMLElement) => {
      if (!line) throw new Error('expected annotated line is missing')
      const token = Array.from(line.querySelectorAll<HTMLElement>('span'))
        .find((element) => Array.from(element.classList).some((name) => name.startsWith('nuvyn-shiki-')))
      if (!token) throw new Error('expected Shiki token is missing')
      const lineStyle = getComputedStyle(line)
      const tokenStyle = getComputedStyle(token)
      return {
        lineBackground: lineStyle.backgroundColor,
        lineBorder: lineStyle.boxShadow,
        tokenBackground: tokenStyle.backgroundColor,
        tokenTransparent: isTransparent(tokenStyle.backgroundColor),
        tokenDoesNotMatchRoot: tokenStyle.backgroundColor !== getComputedStyle(pre).backgroundColor,
      }
    }

    const metaLine = meta.querySelector<HTMLElement>('.line.highlighted')
    const plainLine = meta.querySelector<HTMLElement>('.line:not(.highlighted)')
    const notationLine = notation.querySelector<HTMLElement>('.line.highlighted')
    const focusedLine = notation.querySelector<HTMLElement>('.line.focused')
    const addedLine = notation.querySelector<HTMLElement>('.line.diff.add')
    const removedLine = notation.querySelector<HTMLElement>('.line.diff.remove')
    const warningLine = notation.querySelector<HTMLElement>('.line.warning')
    const errorLine = notation.querySelector<HTMLElement>('.line.error')
    const infoLine = notation.querySelector<HTMLElement>('.line.info')
    const numberedLine = numbered.querySelector<HTMLElement>('.line.highlighted')
    const numberedNumber = numberedLine?.querySelector<HTMLElement>('.nuvyn-line-number')
    const numberedContent = numberedLine?.querySelector<HTMLElement>('.nuvyn-line-content')
    const code = meta.querySelector<HTMLElement>('code')
    if (!numberedNumber || !numberedContent || !code) throw new Error('line-surface structure is incomplete')

    const rootBackground = getComputedStyle(meta).backgroundColor
    return {
      rootBackground,
      fullWidth: metaLine
        ? metaLine.getBoundingClientRect().width >= code.getBoundingClientRect().width - 2
        : false,
      meta: readLine(metaLine, meta),
      plain: readLine(plainLine, meta),
      notation: readLine(notationLine, notation),
      focused: readLine(focusedLine, notation),
      added: readLine(addedLine, notation),
      removed: readLine(removedLine, notation),
      warning: readLine(warningLine, notation),
      error: readLine(errorLine, notation),
      info: readLine(infoLine, notation),
      numbered: readLine(numberedLine, numbered),
      numberedNumberTransparent: isTransparent(getComputedStyle(numberedNumber).backgroundColor),
      numberedContentTransparent: isTransparent(getComputedStyle(numberedContent).backgroundColor),
    }
  }, source)

  await page.emulateMedia({ colorScheme: 'light' })
  const dark = await page.evaluate(async () => {
    const { useTheme } = await import('/src/composables/useTheme.ts')
    useTheme().set('dark')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const article = document.querySelector<HTMLElement>('.md-ext-3-line-surface-fixture')
    if (!article) throw new Error('line-surface fixture is missing after theme switch')
    const meta = article.querySelector<HTMLElement>(
      'pre.shiki:not(.nuvyn-line-numbers):not(.nuvyn-shiki-plain)',
    )
    const line = meta?.querySelector<HTMLElement>('.line.highlighted')
    const token = line
      ? Array.from(line.querySelectorAll<HTMLElement>('span'))
        .find((element) => Array.from(element.classList).some((name) => name.startsWith('nuvyn-shiki-')))
      : null
    if (!meta || !line || !token) throw new Error('dark line-surface fixture is incomplete')
    return {
      rootBackground: getComputedStyle(meta).backgroundColor,
      lineBackground: getComputedStyle(line).backgroundColor,
      lineBorder: getComputedStyle(line).boxShadow,
      tokenBackground: getComputedStyle(token).backgroundColor,
    }
  })

  await page.evaluate(() => {
    document.querySelector('.md-ext-3-line-surface-fixture')?.remove()
  })

  const isVisibleSurface = (
    surface: { lineBackground: string; lineBorder: string },
    root: string,
    requireBorder = true,
  ) => {
    const normalized = surface.lineBackground.trim().toLowerCase().replace(/\s+/gu, '')
    expect(normalized).not.toBe('transparent')
    expect(normalized).not.toBe('rgba(0,0,0,0)')
    expect(normalized).not.toBe('rgb(0,0,0,0)')
    expect(surface.lineBackground).not.toBe(root)
    if (requireBorder) expect(surface.lineBorder).not.toBe('none')
  }

  isVisibleSurface(light.meta, light.rootBackground)
  isVisibleSurface(light.notation, light.rootBackground)
  isVisibleSurface(light.numbered, light.rootBackground)
  for (const surface of [light.focused, light.info]) {
    isVisibleSurface(surface, light.rootBackground)
    expect(surface.tokenTransparent).toBe(true)
    expect(surface.tokenDoesNotMatchRoot).toBe(true)
  }
  for (const surface of [light.warning, light.error]) {
    isVisibleSurface(surface, light.rootBackground, false)
    expect(surface.tokenTransparent).toBe(true)
    expect(surface.tokenDoesNotMatchRoot).toBe(true)
  }
  expect(light.warning.lineBackground).toBe('rgba(234, 179, 8, 0.14)')
  expect(light.warning.lineBorder).toBe('none')
  expect(light.error.lineBackground).toBe('rgba(244, 63, 94, 0.14)')
  expect(light.error.lineBorder).toBe('none')
  for (const surface of [light.added, light.removed]) {
    isVisibleSurface(surface, light.rootBackground, false)
    expect(surface.tokenTransparent).toBe(true)
    expect(surface.tokenDoesNotMatchRoot).toBe(true)
  }
  expect(light.meta.tokenTransparent).toBe(true)
  expect(light.meta.tokenDoesNotMatchRoot).toBe(true)
  expect(['transparent', 'rgba(0,0,0,0)', 'rgb(0,0,0,0)'])
    .toContain(light.plain.lineBackground.trim().toLowerCase().replace(/\s+/gu, ''))
  expect(light.plain.lineBorder).toBe('none')
  expect(light.fullWidth).toBe(true)
  expect(light.numberedNumberTransparent).toBe(true)
  expect(light.numberedContentTransparent).toBe(true)

  const darkLineBackground = dark.lineBackground.trim().toLowerCase().replace(/\s+/gu, '')
  expect(darkLineBackground).not.toBe('transparent')
  expect(darkLineBackground).not.toBe('rgba(0,0,0,0)')
  expect(darkLineBackground).not.toBe('rgb(0,0,0,0)')
  expect(dark.lineBackground).not.toBe(dark.rootBackground)
  expect(dark.lineBorder).not.toBe('none')
  const darkTokenBackground = dark.tokenBackground.trim().toLowerCase().replace(/\s+/gu, '')
  expect(['transparent', 'rgba(0,0,0,0)', 'rgb(0,0,0,0)']).toContain(darkTokenBackground)
})

test('MD-EXT-3 keeps the focused row visibly selected in the reader', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const vault = document.createElement('div')
    vault.className = 'vault'
    const article = document.createElement('article')
    article.className = 'article reading md-ext-3-focused-surface-fixture'
    article.innerHTML = await render([
      '```js',
      'const before = 1',
      'const focused = 2 // [!code focus]',
      'const after = 3',
      '```',
    ].join('\n'))
    vault.append(article)
    document.body.append(vault)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const pre = article.querySelector<HTMLElement>('pre.shiki')
    const focused = pre?.querySelector<HTMLElement>('.line.focused')
    const unfocused = pre?.querySelector<HTMLElement>('.line:not(.focused)')
    if (!pre || !focused || !unfocused) throw new Error('focused reader fixture is incomplete')

    const preStyle = getComputedStyle(pre)
    const focusedStyle = getComputedStyle(focused)
    const unfocusedStyle = getComputedStyle(unfocused)
    const result = {
      hasFocused: pre.classList.contains('has-focused'),
      focusedBackground: focusedStyle.backgroundColor,
      focusedBorder: focusedStyle.boxShadow,
      focusedOpacity: focusedStyle.opacity,
      unfocusedOpacity: unfocusedStyle.opacity,
      unfocusedFilter: unfocusedStyle.filter,
      rootBackground: preStyle.backgroundColor,
    }
    vault.remove()
    return result
  })

  expect(result.hasFocused).toBe(true)
  expect(result.focusedBackground).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/u)
  expect(result.focusedBorder).toBe('none')
  expect(result.focusedOpacity).toBe('1')
  expect(result.unfocusedOpacity).toBe('0.4')
  expect(result.unfocusedFilter).not.toBe('none')
})

test('MD-EXT-3 reveals softened rows when the focused block is hovered', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const vault = document.createElement('div')
    vault.className = 'vault'
    const article = document.createElement('article')
    article.className = 'article reading md-ext-3-focused-hover-fixture'
    article.innerHTML = await render([
      '```js',
      'const before = 1',
      'const focused = 2 // [!code focus]',
      'const after = 3',
      '```',
    ].join('\n'))
    vault.append(article)
    document.body.append(vault)
  })

  const pre = page.locator('.md-ext-3-focused-hover-fixture pre.shiki')
  const unfocused = pre.locator('.line:not(.focused)').first()
  await expect(pre).toBeVisible()
  await expect(unfocused).toHaveCSS('opacity', '0.4')
  await expect(unfocused).toHaveCSS('filter', /blur\(/u)

  await pre.hover()
  await expect(unfocused).toHaveCSS('opacity', '1')
  await expect(unfocused).toHaveCSS('filter', 'none')

  await page.evaluate(() => {
    document.querySelector('.md-ext-3-focused-hover-fixture')?.closest('.vault')?.remove()
  })
})

test('MD-EXT-3 renders diff rows with full semantic colors and markers', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const { useTheme } = await import('/src/composables/useTheme.ts')
    useTheme().set('light')
    const vault = document.createElement('div')
    vault.className = 'vault'
    const article = document.createElement('article')
    article.className = 'article reading md-ext-3-diff-surface-fixture'
    article.innerHTML = await render([
      '```ts',
      'const removed = 1 // [!code --]',
      'const added = 2 // [!code ++]',
      '```',
    ].join('\n'))
    vault.append(article)
    document.body.append(vault)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const removed = article.querySelector<HTMLElement>('.line.diff.remove')
    const added = article.querySelector<HTMLElement>('.line.diff.add')
    if (!removed || !added) throw new Error('diff reader fixture is incomplete')

    const read = (line: HTMLElement) => {
      const style = getComputedStyle(line)
      const marker = getComputedStyle(line, '::before')
      return {
        background: style.backgroundColor,
        border: style.boxShadow,
        marker: marker.content,
        markerColor: marker.color,
      }
    }
    const result = { removed: read(removed), added: read(added) }
    vault.remove()
    return result
  })

  expect(result.removed.background).not.toBe(result.added.background)
  expect(result.removed.background).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/u)
  expect(result.added.background).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/u)
  expect(result.removed.border).toBe('none')
  expect(result.added.border).toBe('none')
  expect(result.removed.marker).toBe('"-"')
  expect(result.added.marker).toBe('"+"')
  expect(result.removed.markerColor).toBe('rgb(185, 28, 28)')
  expect(result.added.markerColor).toBe('rgb(24, 121, 78)')
})

test('MD-EXT-3 keeps error and warning colors in the reader surface', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const { useTheme } = await import('/src/composables/useTheme.ts')
    useTheme().set('light')
    const vault = document.createElement('div')
    vault.className = 'vault'
    const article = document.createElement('article')
    article.className = 'article reading md-ext-3-error-warning-fixture'
    article.innerHTML = await render([
      '```js',
      "const error = 'Error' // [!code error]",
      "const warning = 'Warning' // [!code warning]",
      '```',
    ].join('\n'))
    vault.append(article)
    document.body.append(vault)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const read = (selector: string) => {
      const line = article.querySelector<HTMLElement>(selector)
      if (!line) throw new Error(`${selector} is missing`)
      const style = getComputedStyle(line)
      return {
        className: line.className,
        background: style.backgroundColor,
        border: style.boxShadow,
      }
    }
    const result = {
      error: read('.line.error'),
      warning: read('.line.warning'),
    }
    vault.remove()
    return result
  })

  expect(result.error.className).toContain('error')
  expect(result.warning.className).toContain('warning')
  expect(result.error.background).toBe('rgba(244, 63, 94, 0.14)')
  expect(result.warning.background).toBe('rgba(234, 179, 8, 0.14)')
  expect(result.error.border).toBe('none')
  expect(result.warning.border).toBe('none')
})

test('MD-EXT-3 preserves author sentinel-like source and deferred markers', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const article = document.createElement('article')
    article.className = 'article reading md-ext-3-source-fidelity-fixture'
    article.innerHTML = await render([
      '```ts',
      'const old = "[!code nuvyn-deferred-notation hello]"',
      'const collision = "[!code nuvyn-deferred-notation-0- hello]"',
      'const deferred = 1 // [!code highlight:2]',
      '```',
    ].join('\n'))
    document.body.append(article)

    const lines = Array.from(article.querySelectorAll<HTMLElement>('pre.shiki .line'))
    const text = lines.map((line) => line.textContent ?? '').join('\n')
    const deferred = lines.find((line) => line.textContent?.includes('const deferred'))
    const result = {
      oldSentinelPreserved: text.includes('[!code nuvyn-deferred-notation hello]'),
      collisionCandidatePreserved: text.includes('[!code nuvyn-deferred-notation-0- hello]'),
      deferredMarkerPreserved: text.includes('[!code highlight:2]'),
      deferredNotActivated: deferred?.classList.contains('highlighted') === false,
      invocationMarkerLeaked: article.innerHTML.includes('nuvyn-deferred-notation-1-'),
    }
    article.remove()
    return result
  })

  expect(result).toEqual({
    oldSentinelPreserved: true,
    collisionCandidatePreserved: true,
    deferredMarkerPreserved: true,
    deferredNotActivated: true,
    invocationMarkerLeaked: false,
  })
})

test('MD-EXT-3 keeps annotations and expands generated details only in the PDF surface', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')

  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const pdf = await import('/src/lib/pdfExport.ts')
    const article = document.createElement('article')
    article.className = 'article reading'
    article.innerHTML = await render([
      '::: details Hidden annotation',
      '',
      '```ts',
      'const value = 1 // [!code error]',
      '```',
      '',
      ':::',
    ].join('\n'))
    document.body.append(article)

    const liveDetails = article.querySelector<HTMLDetailsElement>('.markdown-container-details')
    if (!liveDetails) throw new Error('MD-EXT-3 PDF fixture is missing details')
    liveDetails.open = false

    const stylesheet = document.createElement('style')
    stylesheet.textContent = pdf.__testing__.buildPdfDownloadStyles()
    document.head.append(stylesheet)

    const host = document.createElement('main')
    host.className = 'pdf-document vault'
    const prepared = document.createElement('div')
    prepared.innerHTML = pdf.preparePdfArticleHtml(article)
    host.append(prepared)
    document.body.append(host)

    const cloneDetails = prepared.querySelector<HTMLDetailsElement>('.markdown-container-details')
    const errorLine = prepared.querySelector<HTMLElement>('pre.shiki .line.error')
    const token = errorLine?.querySelector<HTMLElement>('[class*="nuvyn-shiki-"]')
    if (!cloneDetails || !errorLine || !token) throw new Error('MD-EXT-3 PDF fixture is incomplete')

    const tokenStyle = getComputedStyle(token)
    const rootStyle = getComputedStyle(errorLine.closest('pre.shiki'))
    const normalize = (value: string) => {
      const probe = document.createElement('span')
      probe.style.color = value.trim()
      document.body.append(probe)
      const normalized = getComputedStyle(probe).color
      probe.remove()
      return normalized
    }
    const result = {
      liveDetailsOpen: liveDetails.open,
      cloneDetailsOpen: cloneDetails.open,
      errorClass: errorLine.classList.contains('error'),
      lineBackground: getComputedStyle(errorLine).backgroundColor,
      lineBorder: getComputedStyle(errorLine).boxShadow,
      tokenColor: tokenStyle.color,
      tokenBackground: tokenStyle.backgroundColor,
      rootBackground: rootStyle.backgroundColor,
      lightTokenColor: normalize(tokenStyle.getPropertyValue('--shiki-light')),
      darkTokenColor: normalize(tokenStyle.getPropertyValue('--shiki-dark')),
      noInlineStyle: prepared.querySelector('[style]') === null,
    }

    host.remove()
    article.remove()
    stylesheet.remove()
    return result
  })

  expect(result.liveDetailsOpen).toBe(false)
  expect(result.cloneDetailsOpen).toBe(true)
  expect(result.errorClass).toBe(true)
  expect(result.lineBackground).not.toBe('rgba(0, 0, 0, 0)')
  expect(result.lineBorder).not.toBe('none')
  expect(result.tokenBackground).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/u)
  expect(result.tokenBackground).not.toBe(result.rootBackground)
  expect(result.tokenColor).toBe(result.lightTokenColor)
  expect(result.tokenColor).not.toBe(result.darkTokenColor)
  expect(result.noInlineStyle).toBe(true)
})
