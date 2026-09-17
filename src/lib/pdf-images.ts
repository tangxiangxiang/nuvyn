export const PDF_IMAGE_SETTLE_TIMEOUT = 5000

export type PdfImageOutcome = 'loaded' | 'error' | 'timeout'

export interface PdfImageSettlementResult {
  total: number
  loaded: number
  failed: number
  timedOut: number
  outcomes: PdfImageOutcome[]
}

interface PdfImageWaitOptions {
  timeoutMs?: number
}

function immediateOutcome(image: HTMLImageElement): PdfImageOutcome | null {
  if (!image.complete) return null
  return image.naturalWidth > 0 ? 'loaded' : 'error'
}

function promoteLazyImageForPdf(image: HTMLImageElement): void {
  if (image.getAttribute('loading') !== 'lazy') return

  // The PDF surface is a dedicated export surface rather than the reader.
  // Promote Markdown-generated lazy images before waiting so browser lazy-load
  // heuristics cannot keep an otherwise valid image unsettled indefinitely.
  image.setAttribute('loading', 'eager')
}

function summarize(outcomes: PdfImageOutcome[]): PdfImageSettlementResult {
  return {
    total: outcomes.length,
    loaded: outcomes.filter((outcome) => outcome === 'loaded').length,
    failed: outcomes.filter((outcome) => outcome === 'error').length,
    timedOut: outcomes.filter((outcome) => outcome === 'timeout').length,
    outcomes,
  }
}

/**
 * Wait for the HTML images in a PDF article to reach a bounded terminal
 * outcome. Image failures are local degradation: they settle the waiter but
 * never reject the document export.
 */
export function waitForPdfImages(
  article: HTMLElement,
  options: PdfImageWaitOptions = {},
): Promise<PdfImageSettlementResult> {
  const images = Array.from(article.querySelectorAll<HTMLImageElement>('img'))
  if (images.length === 0) return Promise.resolve(summarize([]))

  const timeoutMs = Math.max(0, options.timeoutMs ?? PDF_IMAGE_SETTLE_TIMEOUT)

  return new Promise((resolve) => {
    const outcomes: Array<PdfImageOutcome | undefined> = Array.from({ length: images.length })
    const cleanups: Array<(() => void) | undefined> = Array.from({ length: images.length })
    let remaining = images.length
    let finished = false
    let timeoutId: number | undefined

    const finish = () => {
      if (finished) return
      finished = true
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      resolve(summarize(outcomes as PdfImageOutcome[]))
    }

    const settle = (index: number, outcome: PdfImageOutcome) => {
      if (outcomes[index] !== undefined) return
      outcomes[index] = outcome
      cleanups[index]?.()
      remaining -= 1
      if (remaining === 0) finish()
    }

    images.forEach((image, index) => {
      promoteLazyImageForPdf(image)
      const initialOutcome = immediateOutcome(image)
      if (initialOutcome) {
        settle(index, initialOutcome)
        return
      }

      const onLoad = () => settle(index, 'loaded')
      const onError = () => settle(index, 'error')
      const cleanup = () => {
        image.removeEventListener('load', onLoad)
        image.removeEventListener('error', onError)
      }
      cleanups[index] = cleanup

      image.addEventListener('load', onLoad)
      image.addEventListener('error', onError)

      // The image can finish between the initial check and listener
      // registration. Re-check after both listeners are installed so a
      // cached or very fast resource cannot be stranded until timeout.
      const postRegistrationOutcome = immediateOutcome(image)
      if (postRegistrationOutcome) settle(index, postRegistrationOutcome)
    })

    if (remaining > 0) {
      timeoutId = window.setTimeout(() => {
        images.forEach((_, index) => {
          if (outcomes[index] === undefined) settle(index, 'timeout')
        })
      }, timeoutMs)
    }
  })
}
