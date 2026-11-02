import { expect, test, type APIRequestContext, type Page } from './fixtures/auth'
import { test as diaryTest } from './fixtures/diary'

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const MOBILE_VIEWPORT = { width: 375, height: 812 }
const DESKTOP_VIEWPORT = { width: 1280, height: 800 }

async function createNote(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.post('/api/posts', {
    data: { path, title: 'Mobile navigation contract', content: '# Mobile navigation contract\n' },
  })
  expect([200, 201], await response.text()).toContain(response.status())
}

async function deleteNote(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.delete(`/api/posts/${path}`)
  expect([200, 404], await response.text()).toContain(response.status())
}

async function expectMobileNavigation(page: Page): Promise<void> {
  const navigation = page.locator('.workspace-navigation')
  await expect(navigation.locator('.scope-chip')).toHaveCount(3)
  for (const scope of ['note', 'diary', 'ledger']) {
    await expect(navigation.locator('.scope-chip').filter({ hasText: scope })).toBeVisible()
  }
  await expect(navigation.locator('.workspace-board-link')).toBeVisible()
  await expect(navigation.locator('.scope-chip-label').first()).toBeHidden()
  await expect(navigation.locator('.workspace-board-link-label')).toBeHidden()
  await expect(page.locator('.navbar .brand-wordmark')).toBeHidden()
  await expect(page.locator('.navbar .account-menu-root')).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1)
}

async function brandWorkspaceGap(page: Page): Promise<number> {
  const brand = page.locator('.navbar .brand')
  const firstWorkspace = page.locator('.workspace-navigation .nav-workspace-link').first()
  await expect(brand).toBeVisible()
  await expect(firstWorkspace).toBeVisible()
  const brandBounds = await brand.boundingBox()
  const workspaceBounds = await firstWorkspace.boundingBox()
  expect(brandBounds).not.toBeNull()
  expect(workspaceBounds).not.toBeNull()
  return workspaceBounds!.x - (brandBounds!.x + brandBounds!.width)
}

async function navbarGeometry(page: Page) {
  return page.locator('.navbar').evaluate((root) => {
    const inner = root.querySelector<HTMLElement>('.navbar-inner')
    const brand = root.querySelector<HTMLElement>('.brand')
    const firstChip = root.querySelector<HTMLElement>('.scope-chip')
    const chips = root.querySelector<HTMLElement>('.scope-chips')
    if (!inner || !brand || !firstChip || !chips) throw new Error('Workspace navigation is incomplete')
    const innerStyle = getComputedStyle(inner)
    const chipStyle = getComputedStyle(firstChip)
    return {
      headerHeight: root.getBoundingClientRect().height,
      rowHeight: inner.getBoundingClientRect().height,
      paddingLeft: innerStyle.paddingLeft,
      paddingRight: innerStyle.paddingRight,
      rowGap: innerStyle.gap,
      brandLeft: brand.getBoundingClientRect().left,
      firstChipLeft: firstChip.getBoundingClientRect().left,
      chipHeight: firstChip.getBoundingClientRect().height,
      chipPaddingLeft: chipStyle.paddingLeft,
      chipPaddingRight: chipStyle.paddingRight,
      chipGap: getComputedStyle(chips).gap,
    }
  })
}

test('switching to Note does not enlarge the shared tablet header', async ({ page }) => {
  for (const width of [768, 1024, 1199]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/board')
    await expect(page.locator('.navbar-inner')).toHaveCSS('height', '36px')
    const boardHeader = await page.locator('.navbar').boundingBox()
    expect(boardHeader).not.toBeNull()

    for (const next of ['note', 'ledger', 'note', 'board'] as const) {
      if (next === 'board') {
        await page.locator('.workspace-board-link').click()
        await expect(page).toHaveURL(/\/board(?:[/?#]|$)/)
      } else {
        await page.locator('.scope-chip').filter({ hasText: next }).click()
        await expect(page).toHaveURL(next === 'note' ? /\/vault(?:[/?#]|$)/ : /\/ledger(?:[/?#]|$)/)
      }
      await expect(page.locator('.navbar-inner')).toHaveCSS('height', '36px')
      const header = await page.locator('.navbar').boundingBox()
      expect(header).not.toBeNull()
      expect(header!.height, `header on ${next} at ${width}px`).toBeCloseTo(boardHeader!.height, 1)
      if (next === 'note') {
        await expect(page.locator('.navbar')).toHaveClass(/note-tablet-nav/)
        await expect(page.locator('.vault')).toHaveClass(/note-tablet-mode/)
        await expect(page.locator('.scope-chip').filter({ hasText: 'note' })).toHaveCSS('height', '28px')
        const headerHeight = await page.locator('.vault').evaluate((element) => (
          getComputedStyle(element).getPropertyValue('--navbar-h').trim()
        ))
        expect(headerHeight).toBe('36px')
      }
    }
  }
})

test('tablet and desktop align the first workspace equally beside the Nuvyn brand', async ({ page }) => {
  for (const width of [768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    for (const route of ['/vault', '/ledger', '/board']) {
      await page.goto(route)
      const gap = await brandWorkspaceGap(page)
      expect(gap, `brand-to-workspace gap on ${route} at ${width}px`).toBeGreaterThanOrEqual(9)
      expect(gap, `brand-to-workspace gap on ${route} at ${width}px`).toBeLessThanOrEqual(11)
    }
  }
})

test('mobile nav shows all four workspaces at the 600px boundary and common phone widths', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')

  const navigation = page.locator('.workspace-navigation')
  await expect(navigation.locator('.scope-chip')).toHaveCount(3)
  await expect(navigation.locator('.workspace-board-link')).toBeVisible()

  for (const width of [320, 375, 390, 430, 600]) {
    await page.setViewportSize({ width, height: MOBILE_VIEWPORT.height })
    await expectMobileNavigation(page)
  }
})

test('workspace navigation remains available on resize without reloading', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')
  const navigation = page.locator('.workspace-navigation')

  await expect(navigation.locator('.scope-chip')).toHaveCount(3)
  await expect(navigation.locator('.workspace-board-link')).toBeVisible()

  await page.setViewportSize(MOBILE_VIEWPORT)
  await expectMobileNavigation(page)
  await expect(navigation.locator('.scope-chip').filter({ hasText: 'diary' })).toHaveAttribute('aria-pressed', 'false')
  await expect(navigation.locator('.scope-chip').filter({ hasText: 'ledger' })).toHaveAttribute('aria-pressed', 'false')

  await page.setViewportSize(DESKTOP_VIEWPORT)
  await expect(navigation.locator('.scope-chip')).toHaveCount(3)
  await expect(navigation.locator('.workspace-board-link')).toBeVisible()
  await expect(navigation.locator('.scope-chip[aria-pressed="true"]')).toHaveCount(1)
})

test('mobile direct Note route selects Note without activating Diary or Ledger', async ({ page, request }) => {
  const path = `inbox/mobile-nav-${RUN_ID}`
  try {
    await createNote(request, path)
    await page.setViewportSize(MOBILE_VIEWPORT)
    await page.goto(`/vault/${path}`)

    await expect(page).toHaveURL(new RegExp(`/vault/${path}$`))
    await expect(page.locator('.vault')).toBeVisible()
    await expect(page.locator(`[role="tab"][data-tab-id="${path}"]`)).toBeVisible()
    await expectMobileNavigation(page)
    await expect(page.locator('.scope-chip[aria-pressed="true"]')).toHaveCount(1)
    await expect(page.locator('.scope-chip').filter({ hasText: 'note' })).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await deleteNote(request, path)
  }
})

test('mobile direct Board route highlights its navigation entry', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/board')

  await expect(page).toHaveURL(/\/board(?:[/?#]|$)/)
  await expect(page.getByTestId('board-home')).toBeVisible()
  await expectMobileNavigation(page)
  await expect(page.locator('.scope-chip[aria-pressed="true"]')).toHaveCount(0)
  await expect(page.locator('.workspace-board-link')).toHaveAttribute('aria-current', 'page')
})

test('mobile navigation switches between Note, Board and Ledger', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/ledger')
  await expectMobileNavigation(page)

  await page.locator('.scope-chip').filter({ hasText: 'note' }).click()
  await expect(page).toHaveURL(/\/vault(?:[/?#]|$)/)
  await expect(page.locator('.scope-chip').filter({ hasText: 'note' })).toHaveAttribute('aria-pressed', 'true')

  await page.locator('.workspace-board-link').click()
  await expect(page).toHaveURL(/\/board(?:[/?#]|$)/)
  await expect(page.getByTestId('board-home')).toBeVisible()
  await expect(page.locator('.workspace-board-link')).toHaveAttribute('aria-current', 'page')

  await page.locator('.scope-chip').filter({ hasText: 'ledger' }).click()
  await expect(page).toHaveURL(/\/ledger(?:[/?#]|$)/)
  await expect(page.getByTestId('ledger-page')).toBeVisible()
})

diaryTest('Diary Calendar matches Note navbar geometry across tablet breakpoints', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')
  const tabletWidths = [601, 768, 899, 900, 901, 1024, 1199]
  const noteGeometry = new Map<number, Awaited<ReturnType<typeof navbarGeometry>>>()
  for (const width of tabletWidths) {
    await page.setViewportSize({ width, height: 1024 })
    noteGeometry.set(width, await navbarGeometry(page))
  }

  await page.setViewportSize({ width: 768, height: 1024 })
  const diary = page.locator('.scope-chip').filter({ hasText: 'diary' })
  await diary.click()
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible()
  await expect(page.locator('.navbar .brand-wordmark')).toBeVisible()
  for (const name of ['note', 'diary', 'ledger']) {
    await expect(page.locator('.navbar .scope-chip-label').filter({ hasText: name })).toBeVisible()
  }
  await expect(page.locator('.navbar .workspace-board-link-label')).toBeVisible()

  for (const width of tabletWidths) {
    await page.setViewportSize({ width, height: 1024 })
    const actual = await navbarGeometry(page)
    expect(actual, `Diary navbar at ${width}px must match Note`).toEqual(noteGeometry.get(width))
    expect(actual.headerHeight).toBe(37) // 36px row + 1px border
    expect(actual.chipHeight).toBe(28)
    expect(actual.paddingLeft).toBe('10px')
    expect(actual.chipPaddingLeft).toBe('8px')
  }
})

diaryTest('Diary and Ledger entries remain usable from the mobile navigation', async ({ page }) => {
  // Let the Diary fixture complete its supported unlock/bootstrap flow on
  // desktop, where Note is still present, then exercise the mobile nav.
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')
  await page.setViewportSize(MOBILE_VIEWPORT)
  await expectMobileNavigation(page)

  const diary = page.locator('.scope-chip').filter({ hasText: 'diary' })
  await diary.click()
  await expect(diary).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await expect(page.getByTestId('diary-calendar-surface')).toBeVisible()

  await page.locator('.scope-chip').filter({ hasText: 'ledger' }).click()
  await expect(page).toHaveURL(/\/ledger(?:[/?#]|$)/)
  await expect(page.getByTestId('ledger-page')).toBeVisible()
})
