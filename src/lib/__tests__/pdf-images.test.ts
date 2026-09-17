// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PDF_IMAGE_SETTLE_TIMEOUT,
  waitForPdfImages,
} from '../pdf-images'

function articleWithImages(count: number): { article: HTMLElement; images: HTMLImageElement[] } {
  const article = document.createElement('article')
  const images = Array.from({ length: count }, () => {
    const image = document.createElement('img')
    article.appendChild(image)
    return image
  })
  return { article, images }
}

function setImageState(
  image: HTMLImageElement,
  complete: boolean,
  naturalWidth: number,
): void {
  Object.defineProperty(image, 'complete', { configurable: true, value: complete })
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: naturalWidth })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForPdfImages', () => {
  it('resolves immediately when the article has no images', async () => {
    const article = document.createElement('article')

    await expect(waitForPdfImages(article)).resolves.toEqual({
      total: 0,
      loaded: 0,
      failed: 0,
      timedOut: 0,
      outcomes: [],
    })
  })

  it('settles an already loaded image without waiting for an event', async () => {
    const { article, images: [image] } = articleWithImages(1)
    setImageState(image, true, 100)

    await expect(waitForPdfImages(article)).resolves.toMatchObject({
      total: 1,
      loaded: 1,
      failed: 0,
      timedOut: 0,
      outcomes: ['loaded'],
    })
  })

  it('promotes lazy images before waiting on the PDF surface', async () => {
    const { article, images: [image] } = articleWithImages(1)
    image.setAttribute('loading', 'lazy')
    setImageState(image, false, 0)
    const pending = waitForPdfImages(article, { timeoutMs: 100 })

    expect(image.getAttribute('loading')).toBe('eager')

    setImageState(image, true, 100)
    image.dispatchEvent(new Event('load'))

    await expect(pending).resolves.toMatchObject({
      loaded: 1,
      failed: 0,
      timedOut: 0,
      outcomes: ['loaded'],
    })
  })

  it('settles an already failed image as a local error', async () => {
    const { article, images: [image] } = articleWithImages(1)
    setImageState(image, true, 0)

    await expect(waitForPdfImages(article)).resolves.toMatchObject({
      total: 1,
      loaded: 0,
      failed: 1,
      timedOut: 0,
      outcomes: ['error'],
    })
  })

  it('waits for a loading image to dispatch load', async () => {
    const { article, images: [image] } = articleWithImages(1)
    setImageState(image, false, 0)
    const pending = waitForPdfImages(article, { timeoutMs: 100 })

    setImageState(image, true, 100)
    image.dispatchEvent(new Event('load'))

    await expect(pending).resolves.toMatchObject({
      loaded: 1,
      failed: 0,
      timedOut: 0,
      outcomes: ['loaded'],
    })
  })

  it('settles a loading image when it dispatches error', async () => {
    const { article, images: [image] } = articleWithImages(1)
    setImageState(image, false, 0)
    const pending = waitForPdfImages(article, { timeoutMs: 100 })

    image.dispatchEvent(new Event('error'))

    await expect(pending).resolves.toMatchObject({
      loaded: 0,
      failed: 1,
      timedOut: 0,
      outcomes: ['error'],
    })
  })

  it('handles the post-registration completion race', async () => {
    const { article, images: [image] } = articleWithImages(1)
    setImageState(image, false, 0)
    const nativeAddEventListener = image.addEventListener.bind(image)
    vi.spyOn(image, 'addEventListener').mockImplementation((type, listener, options) => {
      nativeAddEventListener(type, listener, options)
      if (type === 'error') setImageState(image, true, 100)
    })

    await expect(waitForPdfImages(article, { timeoutMs: 100 })).resolves.toMatchObject({
      loaded: 1,
      failed: 0,
      timedOut: 0,
      outcomes: ['loaded'],
    })
  })

  it('waits for every image in parallel', async () => {
    const { article, images: [loaded, loading, failed] } = articleWithImages(3)
    setImageState(loaded, true, 100)
    setImageState(loading, false, 0)
    setImageState(failed, true, 0)
    const pending = waitForPdfImages(article, { timeoutMs: 100 })
    let resolved = false
    void pending.then(() => { resolved = true })

    await Promise.resolve()
    expect(resolved).toBe(false)
    setImageState(loading, true, 100)
    loading.dispatchEvent(new Event('load'))

    await expect(pending).resolves.toMatchObject({
      total: 3,
      loaded: 2,
      failed: 1,
      timedOut: 0,
      outcomes: ['loaded', 'loaded', 'error'],
    })
  })

  it('uses one bounded timeout window for unresolved images', async () => {
    vi.useFakeTimers()
    const { article, images } = articleWithImages(3)
    images.forEach((image) => setImageState(image, false, 0))
    const pending = waitForPdfImages(article)
    let resolved = false
    void pending.then(() => { resolved = true })

    await vi.advanceTimersByTimeAsync(PDF_IMAGE_SETTLE_TIMEOUT - 1)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toMatchObject({
      total: 3,
      loaded: 0,
      failed: 0,
      timedOut: 3,
      outcomes: ['timeout', 'timeout', 'timeout'],
    })
  })

  it('removes listeners on timeout and ignores late events', async () => {
    vi.useFakeTimers()
    const { article, images: [image] } = articleWithImages(1)
    setImageState(image, false, 0)
    const removeEventListener = vi.spyOn(image, 'removeEventListener')
    const pending = waitForPdfImages(article, { timeoutMs: 20 })

    await vi.advanceTimersByTimeAsync(20)
    const result = await pending
    expect(result.outcomes).toEqual(['timeout'])
    expect(removeEventListener).toHaveBeenCalledTimes(2)

    setImageState(image, true, 100)
    image.dispatchEvent(new Event('load'))
    expect(result.outcomes).toEqual(['timeout'])
  })
})
