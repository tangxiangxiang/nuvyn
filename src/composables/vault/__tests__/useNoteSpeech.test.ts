// @vitest-environment jsdom
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNoteSpeech } from '../useNoteSpeech'
import type { NoteSpeechOptions } from '../useNoteSpeech'

class FakeAudio {
  src = ''
  playbackRate = 1
  paused = true
  currentTime = 0
  onended: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  play = vi.fn(async () => { this.paused = false })
  pause = vi.fn(() => { this.paused = true })
  load = vi.fn()
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = '' })
  finish(): void { this.paused = true; this.onended?.(new Event('ended')) }
}

type Speech = ReturnType<typeof useNoteSpeech>
let speech: Speech
let wrapper: VueWrapper | undefined

function mountSpeech(options: NoteSpeechOptions = {}) {
  const component = defineComponent({
    setup() {
      speech = useNoteSpeech(options)
      return () => h('div')
    },
  })
  wrapper = mount(component)
  return wrapper
}

const plainText = '第一段。'.repeat(10)

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})

describe('useNoteSpeech', () => {

  it('keeps one voice for every segment, retry and prefetch until a new task starts', async () => {
    const audio = new FakeAudio()
    const synthesize = vi.fn(async (_text: string, _signal: AbortSignal, _voice?: string) => new Blob(['mp3']))
    mountSpeech({ synthesize, createAudio: () => audio as unknown as HTMLAudioElement })
    speech.start('完整句子。'.repeat(400), 'audiobook_male_1')
    await flushPromises()
    const count = speech.totalSegments.value
    for (let i = 1; i < count; i++) { audio.finish(); await flushPromises() }
    expect(synthesize.mock.calls.length).toBeGreaterThan(1)
    expect(synthesize.mock.calls.every((call) => call[2] === 'audiobook_male_1')).toBe(true)
    speech.start(plainText, 'audiobook_female_1')
    await flushPromises()
    expect(synthesize.mock.calls.at(-1)?.[2]).toBe('audiobook_female_1')
  })
  it('prepares, plays, pauses, resumes, changes valid rates, and releases audio on stop', async () => {
    const audio = new FakeAudio()
    const synthesize = vi.fn(async () => new Blob(['mp3'], { type: 'audio/mpeg' }))
    const createObjectURL = vi.fn(() => 'blob:segment-1')
    const revokeObjectURL = vi.fn()
    mountSpeech({ synthesize, createAudio: () => audio as unknown as HTMLAudioElement, createObjectURL, revokeObjectURL })

    speech.start(plainText)
    await flushPromises()
    expect(speech.status.value).toBe('playing')
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(audio.src).toBe('blob:segment-1')

    speech.pause()
    expect(speech.status.value).toBe('paused')
    expect(audio.paused).toBe(true)
    speech.setPlaybackRate(1.25)
    speech.setPlaybackRate(2)
    expect(speech.playbackRate.value).toBe(1.25)
    await speech.resume()
    await flushPromises()
    expect(speech.status.value).toBe('playing')
    expect(audio.playbackRate).toBe(1.25)

    speech.stop()
    expect(speech.status.value).toBe('idle')
    expect(audio.src).toBe('')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:segment-1')
  })

  it('continues to the next segment and completes after pause/resume', async () => {
    const audio = new FakeAudio()
    const synthesize = vi.fn(async (text: string) => new Blob([text], { type: 'audio/mpeg' }))
    mountSpeech({ synthesize, createAudio: () => audio as unknown as HTMLAudioElement })

    speech.start('完整句子。'.repeat(250))
    await flushPromises()
    expect(speech.totalSegments.value).toBeGreaterThan(1)
    speech.pause()
    expect(speech.status.value).toBe('paused')
    speech.resume()
    await flushPromises()
    expect(speech.status.value).toBe('playing')

    const segments = speech.totalSegments.value
    for (let index = 1; index < segments; index += 1) {
      audio.finish()
      await flushPromises()
      expect(speech.currentIndex.value).toBe(index)
      expect(speech.status.value).toBe('playing')
    }
    audio.finish()
    await flushPromises()
    expect(speech.status.value).toBe('idle')
  })

  it('replaces a running task and ignores a late response from the previous task', async () => {
    const audio = new FakeAudio()
    const deferred: Array<{ resolve: (blob: Blob) => void; reject: (error: unknown) => void; signal: AbortSignal }> = []
    const synthesize = vi.fn((_text: string, signal: AbortSignal) => new Promise<Blob>((resolve, reject) => {
      deferred.push({ resolve, reject, signal })
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}`)
    mountSpeech({ synthesize, createAudio: () => audio as unknown as HTMLAudioElement, createObjectURL })

    speech.start('old task')
    await flushPromises()
    speech.start('new task')
    await flushPromises()
    expect(deferred).toHaveLength(2)
    expect(deferred[0]?.signal.aborted).toBe(true)

    deferred[0]?.resolve(new Blob(['old']))
    deferred[1]?.resolve(new Blob(['new audio']))
    await flushPromises()
    expect(speech.status.value).toBe('playing')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(audio.src).toBe('blob:9')
  })

  it('keeps at most one request active and aborts an in-flight prefetch when paused', async () => {
    const audio = new FakeAudio()
    const pending: Array<{ resolve: (blob: Blob) => void; signal: AbortSignal; settled: boolean }> = []
    const synthesize = vi.fn((_text: string, signal: AbortSignal) => new Promise<Blob>((resolve, reject) => {
      const entry = { resolve, signal, settled: false }
      pending.push(entry)
      signal.addEventListener('abort', () => {
        entry.settled = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    }))
    mountSpeech({ synthesize, createAudio: () => audio as unknown as HTMLAudioElement })

    speech.start('段落。'.repeat(320))
    await flushPromises()
    expect(pending).toHaveLength(1)
    if (pending[0]) pending[0].settled = true
    pending[0]?.resolve(new Blob(['first']))
    await flushPromises()
    expect(speech.status.value).toBe('playing')
    expect(pending).toHaveLength(2)

    speech.pause()
    expect(pending[1]?.signal.aborted).toBe(true)
    await flushPromises()
    expect(speech.status.value).toBe('paused')
    await speech.resume()
    await flushPromises()
    expect(pending).toHaveLength(3)
    expect(pending.filter((entry) => !entry.settled)).toHaveLength(1)
  })

  it('continues segments in order, supports previous/next, and only starts once per end event', async () => {
    const audio = new FakeAudio()
    const synthesize = vi.fn(async (text: string) => new Blob([text], { type: 'audio/mpeg' }))
    mountSpeech({ synthesize, createAudio: () => audio as unknown as HTMLAudioElement })

    speech.start('句子。'.repeat(300))
    await flushPromises()
    expect(speech.totalSegments.value).toBeGreaterThan(1)
    expect(speech.currentIndex.value).toBe(0)
    audio.finish()
    audio.finish()
    await flushPromises()
    expect(speech.currentIndex.value).toBe(1)

    speech.previous()
    await flushPromises()
    expect(speech.currentIndex.value).toBe(0)
    speech.next()
    await flushPromises()
    expect(speech.currentIndex.value).toBe(1)
    expect(synthesize.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('exposes provider errors and retries only after explicit user action', async () => {
    const audio = new FakeAudio()
    const synthesize = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('provider'), { code: 'tts-provider-error' }))
      .mockResolvedValueOnce(new Blob(['retry'], { type: 'audio/mpeg' }))
    mountSpeech({ synthesize, createAudio: () => audio as unknown as HTMLAudioElement })

    speech.start(plainText)
    await flushPromises()
    expect(speech.status.value).toBe('error')
    expect(synthesize).toHaveBeenCalledTimes(1)
    speech.retry()
    await flushPromises()
    expect(synthesize).toHaveBeenCalledTimes(2)
    expect(speech.status.value).toBe('playing')
  })

  it('keeps autoplay rejection resumable and revokes the Blob URL on unmount', async () => {
    const audio = new FakeAudio()
    audio.play
      .mockRejectedValueOnce(new Error('autoplay blocked'))
      .mockResolvedValueOnce(undefined)
    const revokeObjectURL = vi.fn()
    mountSpeech({
      synthesize: async () => new Blob(['mp3'], { type: 'audio/mpeg' }),
      createAudio: () => audio as unknown as HTMLAudioElement,
      createObjectURL: () => 'blob:autoplay',
      revokeObjectURL,
    })

    speech.start(plainText)
    await flushPromises()
    expect(speech.status.value).toBe('paused')
    expect(speech.error.value).toBe('tts-playback-blocked')
    await speech.resume()
    await flushPromises()
    expect(speech.status.value).toBe('playing')
    wrapper?.unmount()
    wrapper = undefined
    expect(speech.status.value).toBe('idle')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:autoplay')
  })
})
