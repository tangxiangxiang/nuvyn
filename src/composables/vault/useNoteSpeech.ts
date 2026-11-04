import { computed, onBeforeUnmount, ref } from 'vue'
import { NoteSpeechTextError, splitNoteSpeechText } from '../../lib/noteSpeechText'
import { synthesizeNoteSpeech } from '../../lib/ai-api'

export type NoteSpeechStatus = 'idle' | 'preparing' | 'playing' | 'paused' | 'buffering' | 'error'
export type NoteSpeechRate = 0.75 | 1 | 1.25 | 1.5

type PendingRequest = {
  task: number
  index: number
  controller: AbortController
  promise: Promise<Blob>
}

export type NoteSpeechOptions = {
  synthesize?: (text: string, signal: AbortSignal) => Promise<Blob>
  createAudio?: () => HTMLAudioElement
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

const CACHE_SEGMENTS = 3
const PLAYBACK_RATES: NoteSpeechRate[] = [0.75, 1, 1.25, 1.5]

function errorCode(error: unknown): string {
  if (error instanceof NoteSpeechTextError) return `tts-${error.code}`
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'tts-provider-unavailable'
}

export function useNoteSpeech(options: NoteSpeechOptions = {}) {
  const status = ref<NoteSpeechStatus>('idle')
  const currentIndex = ref(0)
  const segments = ref<string[]>([])
  const playbackRate = ref<NoteSpeechRate>(1)
  const error = ref<string | null>(null)
  const totalSegments = computed(() => segments.value.length)
  const isActive = computed(() => status.value !== 'idle')
  const canGoPrevious = computed(() => isActive.value && currentIndex.value > 0)
  const canGoNext = computed(() => isActive.value && currentIndex.value < segments.value.length - 1)

  const synthesize = options.synthesize ?? synthesizeNoteSpeech
  const createAudio = options.createAudio ?? (() => new Audio())
  const createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob))
  const revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url))
  const cache = new Map<number, Blob>()
  const prefetchFailures = new Map<number, string>()
  let audio: HTMLAudioElement | null = null
  let currentObjectUrl: string | null = null
  let pending: PendingRequest | null = null
  let taskId = 0
  let playbackAttempt = 0
  let disposed = false

  function isCurrent(task: number): boolean {
    return !disposed && task === taskId
  }

  function isPaused(): boolean {
    return status.value === 'paused'
  }

  function getAudio(): HTMLAudioElement {
    if (!audio) audio = createAudio()
    return audio
  }

  function releaseAudioSource(): void {
    if (!audio) return
    audio.onended = null
    audio.onerror = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    if (currentObjectUrl) revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }

  function clearTaskState(): void {
    playbackAttempt += 1
    releaseAudioSource()
    cache.clear()
    prefetchFailures.clear()
    segments.value = []
    currentIndex.value = 0
    error.value = null
    status.value = 'idle'
  }

  function stop(): void {
    taskId += 1
    pending?.controller.abort()
    clearTaskState()
  }

  async function requestSegment(task: number, index: number): Promise<Blob> {
    const cached = cache.get(index)
    if (cached) return cached
    const failed = prefetchFailures.get(index)
    if (failed) throw Object.assign(new Error('Speech generation failed'), { code: failed })

    if (pending) {
      if (pending.task === task && pending.index === index && !pending.controller.signal.aborted) return pending.promise
      pending.controller.abort()
      try { await pending.promise } catch { /* The next requested segment owns the visible result. */ }
      if (!isCurrent(task)) throw new DOMException('Speech task was cancelled', 'AbortError')
      const afterWait = cache.get(index)
      if (afterWait) return afterWait
    }

    const controller = new AbortController()
    const entry: PendingRequest = {
      task,
      index,
      controller,
      promise: Promise.resolve().then(() => synthesize(segments.value[index]!, controller.signal)),
    }
    pending = entry
    try {
      const blob = await entry.promise
      if (isCurrent(task) && !controller.signal.aborted) {
        cache.set(index, blob)
        while (cache.size > CACHE_SEGMENTS) {
          const removable = [...cache.keys()].find((key) => key !== currentIndex.value && key !== currentIndex.value + 1)
          if (removable === undefined) break
          cache.delete(removable)
        }
      }
      return blob
    } finally {
      if (pending === entry) pending = null
    }
  }

  async function playSegment(task: number, index: number, loadingStatus: 'preparing' | 'buffering' = 'preparing'): Promise<void> {
    if (!isCurrent(task) || index < 0 || index >= segments.value.length) return
    const attempt = ++playbackAttempt
    releaseAudioSource()
    currentIndex.value = index
    error.value = null
    status.value = loadingStatus
    let blob: Blob
    try {
      blob = await requestSegment(task, index)
    } catch (reason) {
      if (!isCurrent(task) || (reason instanceof DOMException && reason.name === 'AbortError')) return
      error.value = errorCode(reason)
      status.value = 'error'
      return
    }
    if (!isCurrent(task) || attempt !== playbackAttempt || isPaused()) return

    const player = getAudio()
    const source = createObjectURL(blob)
    currentObjectUrl = source
    player.playbackRate = playbackRate.value
    player.src = source
    player.onended = () => {
      if (!isCurrent(task) || attempt !== playbackAttempt || currentIndex.value !== index) return
      releaseAudioSource()
      if (index + 1 >= segments.value.length) {
        stop()
        return
      }
      status.value = 'buffering'
      void playSegment(task, index + 1, 'buffering')
    }
    player.onerror = () => {
      if (!isCurrent(task) || attempt !== playbackAttempt || currentIndex.value !== index) return
      releaseAudioSource()
      error.value = 'tts-playback-failed'
      status.value = 'error'
    }
    try {
      await player.play()
      if (!isCurrent(task) || attempt !== playbackAttempt || isPaused()) return
      status.value = 'playing'
      void prefetchNext(task, index + 1)
    } catch {
      if (!isCurrent(task) || attempt !== playbackAttempt) return
      // Keep the fetched Blob for a user-initiated retry. Browser autoplay
      // policies commonly reject play() after network preparation finishes.
      player.pause()
      error.value = 'tts-playback-blocked'
      status.value = 'paused'
    }
  }

  async function prefetchNext(task: number, index: number): Promise<void> {
    if (!isCurrent(task) || status.value !== 'playing' || index >= segments.value.length || cache.has(index)) return
    try {
      await requestSegment(task, index)
    } catch (reason) {
      if (!isCurrent(task) || (reason instanceof DOMException && reason.name === 'AbortError')) return
      prefetchFailures.set(index, errorCode(reason))
    }
  }

  function start(text: string): void {
    stop()
    const task = ++taskId
    try {
      segments.value = splitNoteSpeechText(text)
      status.value = 'preparing'
      void playSegment(task, 0)
    } catch (reason) {
      if (reason instanceof NoteSpeechTextError) {
        error.value = `tts-${reason.code}`
        status.value = 'error'
        return
      }
      throw reason
    }
  }

  function pause(): void {
    if (status.value !== 'playing' && status.value !== 'buffering') return
    playbackAttempt += 1
    audio?.pause()
    if (pending && pending.index !== currentIndex.value) pending.controller.abort()
    status.value = 'paused'
  }

  function resume(): void {
    if (status.value !== 'paused') return
    const player = getAudio()
    if (player.src && !error.value) {
      const attempt = ++playbackAttempt
      void player.play().then(() => {
        if (attempt === playbackAttempt && status.value === 'paused') {
          status.value = 'playing'
          void prefetchNext(taskId, currentIndex.value + 1)
        }
      }).catch(() => { error.value = 'tts-playback-blocked' })
      return
    }
    prefetchFailures.delete(currentIndex.value)
    void playSegment(taskId, currentIndex.value)
  }

  function retry(): void {
    if (status.value !== 'error' && !error.value) return
    prefetchFailures.delete(currentIndex.value)
    error.value = null
    void playSegment(taskId, currentIndex.value)
  }

  function previous(): void {
    if (canGoPrevious.value) void playSegment(taskId, currentIndex.value - 1)
  }

  function next(): void {
    if (canGoNext.value) void playSegment(taskId, currentIndex.value + 1)
  }

  function setPlaybackRate(value: number): void {
    if (!PLAYBACK_RATES.some((rate) => rate === value)) return
    playbackRate.value = value as NoteSpeechRate
    if (audio) audio.playbackRate = playbackRate.value
  }

  onBeforeUnmount(() => {
    disposed = true
    stop()
    audio = null
  })

  return {
    status,
    currentIndex,
    totalSegments,
    playbackRate,
    error,
    isActive,
    canGoPrevious,
    canGoNext,
    start,
    pause,
    resume,
    retry,
    previous,
    next,
    stop,
    setPlaybackRate,
  }
}
