import { expect, test, type APIRequestContext, type Page } from './fixtures/auth'
import { unlockDiary } from './helpers/diary-life'

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const MOBILE_VIEWPORT = { width: 375, height: 812 }
const DESKTOP_VIEWPORT = { width: 1280, height: 800 }
const WORKSPACE_NAMES = { note: '笔记', diary: '日程', ledger: '账本', board: '白板' } as const
const WORKSPACE_MENU_LABEL = /^(切换模块|Switch workspace)$/

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
  const selector = page.getByTestId('mobile-workspace-selector')
  const pathname = new URL(page.url()).pathname
  const current = pathname.startsWith('/diary')
    ? WORKSPACE_NAMES.diary
    : pathname.startsWith('/ledger')
      ? WORKSPACE_NAMES.ledger
      : pathname.startsWith('/board')
        ? WORKSPACE_NAMES.board
        : WORKSPACE_NAMES.note
  await expect(selector).toBeVisible()
  await expect(selector).toHaveText(current)
  await expect(page.locator('.workspace-navigation .scope-chip, .workspace-navigation .workspace-board-link')).toHaveCount(0)
  await expect(page.locator('.navbar .brand-wordmark')).toBeHidden()
  await expect(page.locator('.navbar .account-menu-root')).toBeInViewport()
  await expect(page.locator('.navbar-inner')).toHaveCSS('height', '36px')
  const headerGeometry = await page.locator('.navbar').evaluate((root) => {
    const brand = root.querySelector<HTMLElement>('.brand')!.getBoundingClientRect()
    const navigation = root.querySelector<HTMLElement>('.workspace-navigation')!.getBoundingClientRect()
    const actions = root.querySelector<HTMLElement>('.nav-actions')!.getBoundingClientRect()
    return {
      brandRight: brand.right,
      navigationLeft: navigation.left,
      navigationRight: navigation.right,
      actionsLeft: actions.left,
    }
  })
  expect(headerGeometry.navigationLeft).toBeGreaterThanOrEqual(headerGeometry.brandRight)
  expect(headerGeometry.actionsLeft).toBeGreaterThanOrEqual(headerGeometry.navigationRight)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1)

  await selector.click()
  const menu = page.getByRole('menu', { name: WORKSPACE_MENU_LABEL })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveCount(4)
  await expect(menu.getByRole('menuitem', { name: current })).toHaveAttribute('aria-current', 'page')
  for (const name of Object.values(WORKSPACE_NAMES)) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible()
  }
  await page.keyboard.press('Escape')
}

async function expectTabletWorkspaceNavigation(page: Page): Promise<void> {
  const selector = page.getByTestId('mobile-workspace-selector')
  const pathname = new URL(page.url()).pathname
  const current = pathname.startsWith('/diary')
    ? WORKSPACE_NAMES.diary
    : pathname.startsWith('/ledger')
      ? WORKSPACE_NAMES.ledger
      : pathname.startsWith('/board')
        ? WORKSPACE_NAMES.board
        : WORKSPACE_NAMES.note
  await expect(selector).toBeVisible()
  await expect(selector).toHaveText(current)
  await expect(page.locator('.navbar .brand-wordmark')).toBeVisible()
  await expect(page.locator('.workspace-navigation .scope-chip, .workspace-navigation .workspace-board-link')).toHaveCount(0)
  await expect(page.locator('.navbar-inner')).toHaveCSS('height', '36px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1)

  await selector.click()
  const menu = page.getByRole('menu', { name: WORKSPACE_MENU_LABEL })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveCount(4)
  await expect(menu.getByRole('menuitem', { name: current })).toHaveAttribute('aria-current', 'page')
  for (const name of Object.values(WORKSPACE_NAMES)) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible()
  }
  await page.keyboard.press('Escape')
}

async function selectMobileWorkspace(page: Page, workspace: string): Promise<void> {
  await page.getByTestId('mobile-workspace-selector').click()
  await page.getByRole('menu', { name: WORKSPACE_MENU_LABEL }).getByRole('menuitem', { name: workspace }).click()
}

test('workspace names stay Chinese across mobile, tablet and desktop', async ({ page }) => {
  const navigation = page.locator('.workspace-navigation')
  for (const width of [320, 390, 430, 600, 601, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/board')
    if (width <= 600) {
      await expectMobileNavigation(page)
    } else if (width <= 1199) {
      await expectTabletWorkspaceNavigation(page)
    } else {
      await expect(navigation.locator('.scope-chip-label')).toHaveText([
        WORKSPACE_NAMES.note,
        WORKSPACE_NAMES.diary,
        WORKSPACE_NAMES.ledger,
      ])
      await expect(navigation.locator('.workspace-board-link')).toHaveAttribute('aria-label', WORKSPACE_NAMES.board)
      await expect(navigation.locator('.workspace-board-link-label')).toHaveText(WORKSPACE_NAMES.board)
      await expect(navigation.locator('.scope-chip-icon, .workspace-board-link-icon')).toHaveCount(0)
      for (const [index, name] of [WORKSPACE_NAMES.note, WORKSPACE_NAMES.diary, WORKSPACE_NAMES.ledger].entries()) {
        await expect(navigation.locator('.scope-chip').nth(index)).toHaveAttribute('aria-label', new RegExp(name))
        await expect(navigation.locator('.scope-chip-label').nth(index)).toBeVisible()
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  }
})

async function brandWorkspaceGap(page: Page): Promise<number> {
  const brand = page.locator('.navbar .brand')
  const firstWorkspace = page.locator(
    '.workspace-navigation .mobile-workspace-selector, .workspace-navigation .nav-workspace-link',
  ).first()
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
    const workspaceNavigation = root.querySelector<HTMLElement>('.workspace-navigation')
    const workspaceControl = root.querySelector<HTMLElement>('.mobile-workspace-selector')
      ?? root.querySelector<HTMLElement>('.scope-chip')
    if (!inner || !brand || !workspaceNavigation || !workspaceControl) {
      throw new Error('Workspace navigation is incomplete')
    }
    const innerStyle = getComputedStyle(inner)
    const workspaceControlStyle = getComputedStyle(workspaceControl)
    return {
      headerHeight: root.getBoundingClientRect().height,
      rowHeight: inner.getBoundingClientRect().height,
      paddingLeft: innerStyle.paddingLeft,
      paddingRight: innerStyle.paddingRight,
      rowGap: innerStyle.gap,
      brandLeft: brand.getBoundingClientRect().left,
      controlLeft: workspaceControl.getBoundingClientRect().left,
      controlHeight: workspaceControl.getBoundingClientRect().height,
      controlPaddingLeft: workspaceControlStyle.paddingLeft,
      controlPaddingRight: workspaceControlStyle.paddingRight,
      navigationGap: getComputedStyle(workspaceNavigation).gap,
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
      await selectMobileWorkspace(page, WORKSPACE_NAMES[next])
      await expect(page).toHaveURL(next === 'board'
        ? /\/board(?:[/?#]|$)/
        : next === 'note'
          ? /\/vault(?:[/?#]|$)/
          : /\/ledger(?:[/?#]|$)/)
      await expect(page.locator('.navbar-inner')).toHaveCSS('height', '36px')
      const header = await page.locator('.navbar').boundingBox()
      expect(header).not.toBeNull()
      expect(header!.height, `header on ${next} at ${width}px`).toBeCloseTo(boardHeader!.height, 1)
      if (next === 'note') {
        await expect(page.locator('.navbar')).toHaveClass(/note-tablet-nav/)
        await expect(page.locator('.vault')).toHaveClass(/note-tablet-mode/)
        await expect(page.getByTestId('mobile-workspace-selector')).toHaveText(WORKSPACE_NAMES.note)
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
      const brand = page.locator('.navbar .brand-content')
      const { logoInset, gap: brandGap, centerOffset } = await brand.evaluate((element) => {
        const logo = element.querySelector('.brand-logo')!.getBoundingClientRect()
        const wordmark = element.querySelector('.brand-wordmark')!.getBoundingClientRect()
        return {
          logoInset: logo.left - element.closest('.navbar-inner')!.getBoundingClientRect().left,
          gap: wordmark.left - logo.right,
          centerOffset: (wordmark.top + wordmark.height / 2) - (logo.top + logo.height / 2),
        }
      })
      const desktopVault = route === '/vault' && width >= 1200
      expect(logoInset).toBeCloseTo(desktopVault ? 8.5 : 10, 1)
      expect(brandGap).toBeCloseTo(desktopVault ? 7.5 : 6, 1)
      expect(centerOffset).toBeCloseTo(0, 1)
      const gap = await brandWorkspaceGap(page)
      expect(gap, `brand-to-workspace gap on ${route} at ${width}px`).toBeGreaterThanOrEqual(9)
      expect(gap, `brand-to-workspace gap on ${route} at ${width}px`).toBeLessThanOrEqual(11)
    }
  }
})

test('the Note toolbar folder icon lines up with the brand logo', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')
  const logo = page.locator('.navbar .brand-logo')
  const folder = page.locator('.activity-bar .ab-btn').first().locator('.ab-btn-icon')
  const logoBounds = await logo.boundingBox()
  const folderBounds = await folder.boundingBox()
  expect(logoBounds).not.toBeNull()
  expect(folderBounds).not.toBeNull()
  expect(logoBounds!.x + logoBounds!.width / 2).toBeCloseTo(folderBounds!.x + folderBounds!.width / 2, 1)
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
  await page.getByTestId('mobile-workspace-selector').click()
  const mobileMenu = page.getByRole('menu', { name: WORKSPACE_MENU_LABEL })
  await expect(mobileMenu.getByRole('menuitem', { name: WORKSPACE_NAMES.note })).toHaveAttribute('aria-current', 'page')
  await expect(mobileMenu.getByRole('menuitem', { name: WORKSPACE_NAMES.diary })).not.toHaveAttribute('aria-current', 'page')
  await expect(mobileMenu.getByRole('menuitem', { name: WORKSPACE_NAMES.ledger })).not.toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Escape')

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
    await expect(page.locator('.vault')).toHaveClass(/note-tablet-mode/)
    await expect(page.locator('.editor-tabs-shell')).toHaveCount(0)
    await expectMobileNavigation(page)
    await expect(page.getByTestId('mobile-workspace-selector')).toHaveText(WORKSPACE_NAMES.note)
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
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText(WORKSPACE_NAMES.board)

  await page.setViewportSize({ width: 320, height: MOBILE_VIEWPORT.height })
  await expectMobileNavigation(page)
})

test('mobile navigation switches between Note, Board and Ledger', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT)
  await page.goto('/ledger')
  await expectMobileNavigation(page)

  await selectMobileWorkspace(page, WORKSPACE_NAMES.note)
  await expect(page).toHaveURL(/\/vault(?:[/?#]|$)/)
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText(WORKSPACE_NAMES.note)
  await expectMobileNavigation(page)

  await selectMobileWorkspace(page, WORKSPACE_NAMES.board)
  await expect(page).toHaveURL(/\/board(?:[/?#]|$)/)
  await expect(page.getByTestId('board-home')).toBeVisible()
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText(WORKSPACE_NAMES.board)
  await expectMobileNavigation(page)

  await selectMobileWorkspace(page, WORKSPACE_NAMES.ledger)
  await expect(page).toHaveURL(/\/ledger(?:[/?#]|$)/)
  await expect(page.getByTestId('ledger-page')).toBeVisible()
  await expectMobileNavigation(page)
})

test('Diary Calendar matches Note navbar geometry across tablet breakpoints', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')
  const tabletWidths = [601, 768, 899, 900, 901, 1024, 1199]
  const noteGeometry = new Map<number, Awaited<ReturnType<typeof navbarGeometry>>>()
  for (const width of tabletWidths) {
    await page.setViewportSize({ width, height: 1024 })
    noteGeometry.set(width, await navbarGeometry(page))
  }

  await page.setViewportSize({ width: 768, height: 1024 })
  await selectMobileWorkspace(page, WORKSPACE_NAMES.diary)
  await unlockDiary(page)
  await expect(page.getByTestId('diary-life')).toBeVisible()
  await expect(page.locator('.navbar .brand-wordmark')).toBeVisible()
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText(WORKSPACE_NAMES.diary)
  await expect(page.locator('.navbar .scope-chip, .navbar .workspace-board-link')).toHaveCount(0)

  for (const width of tabletWidths) {
    await page.setViewportSize({ width, height: 1024 })
    const actual = await navbarGeometry(page)
    expect(actual, `Diary navbar at ${width}px must match Note`).toEqual(noteGeometry.get(width))
    expect(actual.headerHeight).toBe(37) // 36px row + 1px border
    expect(actual.controlHeight).toBe(28)
    expect(actual.paddingLeft).toBe('10px')
    expect(actual.controlPaddingLeft).toBe('6px')
  }
})

test('Diary and Ledger entries remain usable from the mobile navigation', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT)
  await page.goto('/vault')
  await page.setViewportSize(MOBILE_VIEWPORT)
  await expectMobileNavigation(page)

  await selectMobileWorkspace(page, WORKSPACE_NAMES.diary)
  await unlockDiary(page)
  await expect(page.getByTestId('mobile-workspace-selector')).toHaveText(WORKSPACE_NAMES.diary, { timeout: 15_000 })
  await expect(page.getByTestId('diary-life')).toBeVisible()

  await selectMobileWorkspace(page, WORKSPACE_NAMES.ledger)
  await expect(page).toHaveURL(/\/ledger(?:[/?#]|$)/)
  await expect(page.getByTestId('ledger-page')).toBeVisible()
})
