import type { Page } from '@playwright/test'

type BrandJourneyProbe = {
  words: string[]
  rounds: string[]
  phases: string[]
  maxWords: number
  blackFrame: { points: number; words: number; coreOpacity: string } | null
}

type BrandJourneyWindow = Window & {
  __brandJourneyProbe?: BrandJourneyProbe
  __brandJourneyObserver?: MutationObserver
}

// Observe before the 3s gesture so Playwright's polling cannot miss the
// short black field or the first point's appearance.
export async function observeBrandJourney(page: Page) {
  await page.evaluate(() => {
    const state = window as BrandJourneyWindow
    state.__brandJourneyObserver?.disconnect()
    const probe: BrandJourneyProbe = { words: [], rounds: [], phases: [], maxWords: 0, blackFrame: null }
    const observer = new MutationObserver(() => {
      const journey = document.querySelector('.brand-journey')
      if (!journey) return
      const phase = journey.getAttribute('data-phase')
      if (phase && probe.phases.at(-1) !== phase) probe.phases.push(phase)
      const words = journey.querySelectorAll('.brand-network-virtue')
      probe.maxWords = Math.max(probe.maxWords, words.length)
      const word = words[0]?.getAttribute('data-word')
      if (word && probe.words.at(-1) !== word) probe.words.push(word)
      const round = journey.querySelector('.brand-journey-round')?.getAttribute('data-virtue')
      if (round && probe.rounds.at(-1) !== round) probe.rounds.push(round)
      if (phase === 'black' && !probe.blackFrame) {
        probe.blackFrame = {
          points: journey.querySelectorAll('.brand-journey-point').length,
          words: words.length,
          coreOpacity: getComputedStyle(journey.querySelector('.brand-journey-core')!).opacity,
        }
      }
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    state.__brandJourneyProbe = probe
    state.__brandJourneyObserver = observer
  })
}

export async function readBrandJourneyProbe(page: Page, stop = false) {
  return page.evaluate((disconnect) => {
    const state = window as BrandJourneyWindow
    if (disconnect) state.__brandJourneyObserver?.disconnect()
    return state.__brandJourneyProbe!
  }, stop)
}
