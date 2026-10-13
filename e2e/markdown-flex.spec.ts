import { expect, test } from '@playwright/test'

test('Flex Markdown renders supported properties and lays out automatic block items', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const declarations = [
      ['direction', 'row-reverse'],
      ['wrap', 'wrap-reverse'],
      ['justify', 'space-between'],
      ['items', 'center'],
      ['content', 'space-evenly'],
      ['gap', '24'],
      ['justify', 'safe-center'],
      ['items', 'first-baseline'],
      ['content', 'last-baseline'],
    ]
    const source = [
      ...declarations.map(([name, value]) => `::: flex ${name}=${value}\nProperty ${name}\n:::`),
      [
        ':::: flex direction=row wrap=wrap gap=16 mobile=preserve',
        'First paragraph item.',
        '',
        'Second paragraph item.',
        '',
        'Third paragraph item.',
        '::::',
      ].join('\n'),
      [
        '::: flex direction=row justify=space-between gap=0 mobile=preserve',
        'Distribute A',
        '',
        'Distribute B',
        ':::',
      ].join('\n'),
      [
        '::: flex direction=row items=center mobile=preserve',
        'Short item',
        '',
        'Tall item',
        ':::',
      ].join('\n'),
      [
        ':::: flex direction=row gap=16 mobile=preserve',
        '::: flex direction=column grow=2 basis=0',
        'Two shares',
        ':::',
        '::: flex direction=column grow=1 basis=0',
        'One share',
        ':::',
        '::::',
      ].join('\n'),
      [
        '::: flex direction=row-reverse mobile=preserve',
        'Reverse first',
        '',
        'Reverse second',
        ':::',
      ].join('\n'),
    ].join('\n\n')
    const article = document.createElement('article')
    article.className = 'article reading'
    article.style.width = '640px'
    article.innerHTML = await render(source)
    document.body.append(article)

    const flexes = Array.from(article.querySelectorAll<HTMLElement>('.nuvyn-flex'))
    const propertyFlexes = flexes.slice(0, declarations.length)
    const propertyClasses = propertyFlexes.map((element) => Array.from(element.classList))
    const flexWith = (text: string) => flexes.find((element) => element.textContent?.includes(text))
    const directParagraphs = (element: HTMLElement | undefined) => Array.from(
      element?.querySelectorAll<HTMLElement>(':scope > p') ?? [],
    )

    const wrapped = flexWith('First paragraph item.')
    if (wrapped) wrapped.style.width = '320px'
    const wrappedItems = directParagraphs(wrapped)
    wrappedItems.forEach((element) => { element.style.width = '150px' })

    const distributed = directParagraphs(flexWith('Distribute A'))
    distributed.forEach((element) => { element.style.width = '40px' })

    const centered = directParagraphs(flexWith('Short item'))
    centered[0]?.style.setProperty('height', '20px')
    centered[1]?.style.setProperty('height', '60px')

    const growth = flexes.find((element) => element.querySelector(':scope > .nuvyn-flex-scope > .nuvyn-flex'))
    const growthScopes = Array.from(growth?.querySelectorAll<HTMLElement>(':scope > .nuvyn-flex-scope') ?? [])

    const reversed = directParagraphs(flexWith('Reverse first'))
    const getRects = (elements: HTMLElement[]) => elements.map((element) => {
      const { x, y, width, height, right, bottom } = element.getBoundingClientRect()
      return { x, y, width, height, right, bottom }
    })
    const result = {
      renderedPropertyValues: propertyFlexes.map((element) => {
        const style = getComputedStyle(element)
        return {
          direction: style.flexDirection,
          wrap: style.flexWrap,
          justify: style.justifyContent,
          items: style.alignItems,
          content: style.alignContent,
          gap: style.gap,
        }
      }),
      propertyClasses,
      directChildTags: Array.from(wrapped?.children ?? []).map((element) => element.tagName),
      wrappedRects: getRects(wrappedItems),
      distributedRects: getRects(distributed),
      centeredRects: getRects(centered),
      growthWidths: growthScopes.map((element) => element.getBoundingClientRect().width),
      growthProps: growthScopes.map((element) => ({
        grow: getComputedStyle(element).flexGrow,
        basis: getComputedStyle(element).flexBasis,
      })),
      reversedRects: getRects(reversed),
    }
    article.remove()
    return result
  })

  expect(result.renderedPropertyValues.slice(0, 7)).toEqual([
    expect.objectContaining({ direction: 'row-reverse' }),
    expect.objectContaining({ wrap: 'wrap-reverse' }),
    expect.objectContaining({ justify: 'space-between' }),
    expect.objectContaining({ items: 'center' }),
    expect.objectContaining({ content: 'space-evenly' }),
    expect.objectContaining({ gap: '24px' }),
    expect.objectContaining({ justify: 'safe center' }),
  ])
  expect(result.propertyClasses[0]).toContain('nuvyn-flex-direction-row-reverse')
  expect(result.propertyClasses[1]).toContain('nuvyn-flex-wrap-wrap-reverse')
  expect(result.propertyClasses[2]).toContain('nuvyn-flex-justify-space-between')
  expect(result.propertyClasses[3]).toContain('nuvyn-flex-items-center')
  expect(result.propertyClasses[4]).toContain('nuvyn-flex-content-space-evenly')
  expect(result.propertyClasses[5]).toContain('nuvyn-flex-gap-24')
  expect(result.propertyClasses[6]).toContain('nuvyn-flex-justify-safe-center')
  expect(result.propertyClasses[7]).toContain('nuvyn-flex-items-first-baseline')
  expect(result.propertyClasses[8]).toContain('nuvyn-flex-content-last-baseline')
  expect(result.directChildTags).toEqual(['P', 'P', 'P'])
  expect(result.wrappedRects[1]!.y).toBeCloseTo(result.wrappedRects[0]!.y, 0)
  expect(result.wrappedRects[2]!.y).toBeGreaterThan(result.wrappedRects[0]!.y)
  expect(result.distributedRects[1]!.x - result.distributedRects[0]!.right).toBeGreaterThan(400)
  const centerA = result.centeredRects[0]!.y + result.centeredRects[0]!.height / 2
  const centerB = result.centeredRects[1]!.y + result.centeredRects[1]!.height / 2
  expect(Math.abs(centerA - centerB)).toBeLessThanOrEqual(1)
  expect(result.growthProps).toEqual([{ grow: '2', basis: '0px' }, { grow: '1', basis: '0px' }])
  expect(result.growthWidths[0]! / result.growthWidths[1]!).toBeCloseTo(2, 1)
  expect(result.reversedRects[0]!.x).toBeGreaterThan(result.reversedRects[1]!.x)
})

test('Flex uses Note content width for mobile stacking and contains preserved layouts', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/__markdown-test?mode=reading')
  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const article = document.createElement('article')
    article.className = 'article reading'
    article.style.width = '320px'
    article.innerHTML = await render([
      '::: flex direction=row mobile=stack',
      'Stack A',
      '',
      'Stack B',
      ':::',
      '',
      ':::: flex direction=row mobile=preserve wrap=nowrap',
      '::: flex direction=column basis=75% shrink=0',
      'Preserved A',
      ':::',
      '::: flex direction=column basis=75% shrink=0',
      'Preserved B',
      ':::',
      '::::',
    ].join('\n'))
    document.body.append(article)
    const flexes = Array.from(article.querySelectorAll<HTMLElement>('.nuvyn-flex'))
    const stacked = flexes[0]!
    const preserved = flexes[1]!
    const preservedScope = preserved.parentElement!
    const children = Array.from(preserved.children) as HTMLElement[]
    const result = {
      stackedDirection: getComputedStyle(stacked).flexDirection,
      stackedChildrenY: Array.from(stacked.children).map((element) => element.getBoundingClientRect().y),
      preservedDirection: getComputedStyle(preserved).flexDirection,
      scopeOverflowX: getComputedStyle(preservedScope).overflowX,
      childRects: children.map((element) => ({
        x: element.getBoundingClientRect().x,
        right: element.getBoundingClientRect().right,
      })),
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }
    article.remove()
    return result
  })

  expect(result.stackedDirection).toBe('column')
  expect(result.stackedChildrenY[1]).toBeGreaterThan(result.stackedChildrenY[0]!)
  expect(result.preservedDirection).toBe('row')
  expect(result.scopeOverflowX).toBe('auto')
  expect(result.childRects[1]!.x).toBeGreaterThan(result.childRects[0]!.x)
  expect(result.documentScrollWidth).toBeLessThanOrEqual(result.viewportWidth)
})

test('Flex PDF clone retains parser layout and uses independent printable styles', async ({ page }) => {
  await page.goto('/__markdown-test?mode=reading')
  const result = await page.evaluate(async () => {
    const { render } = await import('/src/lib/markdown.ts')
    const { buildPdfDownloadDocument, preparePdfArticleHtml } = await import('/src/lib/pdfExport.ts')
    const article = document.createElement('article')
    article.className = 'article reading'
    article.style.width = '640px'
    article.innerHTML = await render([
      ':::: flex direction=row-reverse justify=space-between gap=24',
      '::: flex direction=column grow=2 basis=0',
      'Main',
      ':::',
      '::: flex direction=column grow=1 basis=0',
      'Aside',
      ':::',
      '::::',
    ].join('\n'))
    document.body.append(article)
    const root = document.createElement('div')
    root.innerHTML = buildPdfDownloadDocument(preparePdfArticleHtml(article))
    document.body.append(root)
    const flex = root.querySelector<HTMLElement>('.pdf-document .nuvyn-flex')
    const nestedFlexes = Array.from(root.querySelectorAll<HTMLElement>('.pdf-document .nuvyn-flex'))
    const parentScopes = nestedFlexes.slice(1).map((element) => element.parentElement as HTMLElement)
    const result = {
      direction: flex ? getComputedStyle(flex).flexDirection : '',
      gap: flex ? getComputedStyle(flex).gap : '',
      nestedCount: nestedFlexes.length,
      childCount: flex?.querySelectorAll(':scope > .nuvyn-flex-scope').length ?? 0,
      grows: parentScopes.map((element) => getComputedStyle(element).flexGrow),
      sourceChildCount: article.querySelectorAll('.nuvyn-flex > .nuvyn-flex-scope').length,
      hasNoLegacyImageRow: !root.querySelector('.nuvyn-image-row'),
    }
    article.remove()
    root.remove()
    return result
  })

  expect(result).toEqual({
    direction: 'row-reverse',
    gap: '24px',
    nestedCount: 3,
    childCount: 2,
    grows: ['2', '1'],
    sourceChildCount: 2,
    hasNoLegacyImageRow: true,
  })
})
