import { expect, test } from './fixtures/auth'
import { ensureLedgerDashboardFixtures } from './helpers/ledger-live'

type Viewport = {
  width: number
  height: number
}

type Box = {
  top: number
  bottom: number
  left: number
  right: number
  height: number
}

type AccountLayoutMetrics = {
  page: Box
  sections: Box
  cards: Array<Box & { content: Box | null }>
  lists: Array<Box & { clientHeight: number; scrollHeight: number; overflowY: string }>
  documentScrollHeight: number
}

async function readAccountLayoutMetrics(page: import('@playwright/test').Page): Promise<AccountLayoutMetrics> {
  return await page.evaluate(() => {
    function box(element: Element): Box {
      const rect = element.getBoundingClientRect()
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        height: rect.height,
      }
    }

    const pageElement = document.querySelector<HTMLElement>('[data-testid="ledger-accounts-page"]')
    const sections = document.querySelector<HTMLElement>('.ledger-account-sections')
    const cards = [...document.querySelectorAll<HTMLElement>('.ledger-account-section')]
    const lists = [...document.querySelectorAll<HTMLElement>('.ledger-account-list')]
    if (!pageElement || !sections || cards.length !== 2) throw new Error('Accounts layout nodes are missing')

    return {
      page: box(pageElement),
      sections: box(sections),
      cards: cards.map((card) => ({
        ...box(card),
        content: (() => {
          const content = card.querySelector<HTMLElement>('.ledger-account-list, .ledger-inline-empty, .ledger-archived-empty')
          return content ? box(content) : null
        })(),
      })),
      lists: lists.map((list) => ({
        ...box(list),
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        overflowY: getComputedStyle(list).overflowY,
      })),
      documentScrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    }
  })
}

function assertDesktopContainment(metrics: AccountLayoutMetrics, viewport: Viewport): void {
  const tolerance = 2
  expect(metrics.page.bottom, `${viewport.width}x${viewport.height} page containment`).toBeLessThanOrEqual(viewport.height + tolerance)
  expect(metrics.sections.bottom, `${viewport.width}x${viewport.height} sections containment`).toBeLessThanOrEqual(metrics.page.bottom + tolerance)
  expect(metrics.cards).toHaveLength(2)

  for (const card of metrics.cards) {
    expect(card.height, `${viewport.width}x${viewport.height} card height`).toBeGreaterThan(0)
    expect(card.bottom, `${viewport.width}x${viewport.height} card containment`).toBeLessThanOrEqual(metrics.page.bottom + tolerance)
    expect(card.content, `${viewport.width}x${viewport.height} card content`).not.toBeNull()
    if (card.content) {
      expect(card.content.height, `${viewport.width}x${viewport.height} card content height`).toBeGreaterThan(0)
      expect(card.content.bottom, `${viewport.width}x${viewport.height} card content containment`).toBeLessThanOrEqual(card.bottom + tolerance)
    }
  }

  expect(metrics.lists.length, `${viewport.width}x${viewport.height} account list count`).toBeGreaterThanOrEqual(1)
  for (const list of metrics.lists) {
    expect(list.clientHeight, `${viewport.width}x${viewport.height} list client height`).toBeGreaterThan(0)
    expect(list.overflowY, `${viewport.width}x${viewport.height} list scrolling`).toBe('auto')
  }
  expect(metrics.documentScrollHeight, `${viewport.width}x${viewport.height} document containment`).toBeLessThanOrEqual(viewport.height + tolerance)
}

test('Accounts cards and lists use the desktop workspace height without mobile regression', async ({ page, request }) => {
  await ensureLedgerDashboardFixtures(request)

  const desktopViewports: Viewport[] = [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]
  const desktopMetrics: AccountLayoutMetrics[] = []

  for (const viewport of desktopViewports) {
    await page.setViewportSize(viewport)
    await page.goto('/ledger/accounts')
    await expect(page.getByTestId('ledger-accounts-page')).toBeVisible()
    await expect(page.getByTestId('ledger-active-account-list').or(page.getByTestId('ledger-active-account-empty'))).toBeVisible()
    await expect(page.getByTestId('ledger-archived-account-list').or(page.getByTestId('ledger-archived-account-empty'))).toBeVisible()
    const metrics = await readAccountLayoutMetrics(page)
    assertDesktopContainment(metrics, viewport)
    desktopMetrics.push(metrics)
  }

  const activeListHeights = desktopMetrics.map((metrics) => {
    const list = metrics.lists[0]
    if (!list) throw new Error('Active account list is missing')
    return list.height
  })
  expect(activeListHeights[1]).toBeGreaterThan(activeListHeights[0]! + 20)
  expect(activeListHeights[2]).toBeGreaterThanOrEqual(activeListHeights[1]! - 2)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/ledger/accounts')
  await expect(page.getByTestId('ledger-accounts-page')).toBeVisible()
  await expect(page.getByTestId('ledger-active-account-list').or(page.getByTestId('ledger-active-account-empty'))).toBeVisible()
  await expect(page.getByTestId('ledger-archived-account-list').or(page.getByTestId('ledger-archived-account-empty'))).toBeVisible()
  const mobileMetrics = await readAccountLayoutMetrics(page)
  expect(mobileMetrics.cards[0]).toBeTruthy()
  expect(mobileMetrics.cards[1]).toBeTruthy()
  if (mobileMetrics.cards[0] && mobileMetrics.cards[1]) {
    expect(Math.abs(mobileMetrics.cards[0].left - mobileMetrics.cards[1].left)).toBeLessThanOrEqual(1)
    expect(mobileMetrics.cards[1].top).toBeGreaterThanOrEqual(mobileMetrics.cards[0].bottom - 1)
  }
  await expect(page.locator('.ledger-account-list .ledger-account-row').first()).toBeVisible()
})
