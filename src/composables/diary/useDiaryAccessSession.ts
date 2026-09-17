import { computed, readonly, ref, watch, type Ref } from 'vue'
import {
  getDiaryAccessStatus,
  lockDiaryAccess,
  setupDiaryAccess,
  unlockDiaryAccess,
  type DiaryAccessState,
} from '../../lib/diary-access-api'
import { clearDiaryCapability, setDiaryCapability } from '../../lib/diary-capability'
import { subscribeDiaryAccessLocked } from '../../lib/auth-session'
import { useAuth } from '../useAuth'

export interface DiaryAccessSession {
  readonly state: Readonly<Ref<DiaryAccessState>>
  readonly epoch: Readonly<Ref<number | null>>
  readonly isUnlocked: Readonly<Ref<boolean>>
  /** True once this browser process has received an authoritative access
   *  status or transition result. It distinguishes fresh bootstrap from a
   *  real lock/expiry/logout after the session was already reconciled. */
  readonly statusResolved: Readonly<Ref<boolean>>
  readonly ensureStatus: () => Promise<DiaryAccessState>
  readonly setup: (password: string) => Promise<void>
  readonly unlock: (password: string) => Promise<void>
  readonly lock: () => Promise<void>
  readonly clear: () => void
}

export type DiaryTeardownReason =
  | 'lock'
  | 'logout'
  | 'auth-invalidated'
  | 'capability-expired'
  | 'capability-replaced'
  | 'reset'

export type DiaryTeardownEvent = {
  generation: number
  reason: DiaryTeardownReason
}

const state = ref<DiaryAccessState>('UNINITIALIZED')
const epoch = ref<number | null>(null)
const statusResolved = ref(false)
const isUnlocked = computed(() => state.value === 'UNLOCKED')
let generation = 0
let statusRequest: { generation: number; promise: Promise<DiaryAccessState> } | null = null
let authWatchWired = false
let expiryUnsubscribe: (() => void) | null = null
let serverLockUnsubscribe: (() => void) | null = null
const teardownListeners = new Set<(event: DiaryTeardownEvent) => void>()

function notifyTeardown(reason: DiaryTeardownReason): void {
  // `generation` is the existing session owner's monotonic invalidation
  // token. Advance it before clearing any holder so every listener can fence
  // late work synchronously; listeners must not own the session or DEK.
  generation += 1
  const event = { generation, reason }
  for (const listener of [...teardownListeners]) {
    try { listener(event) } catch { /* one cleanup must not block others */ }
  }
}

function clear(reason: DiaryTeardownReason = 'auth-invalidated'): void {
  notifyTeardown(reason)
  statusRequest = null
  clearDiaryCapability()
  epoch.value = null
  if (state.value === 'UNLOCKED') state.value = 'LOCKED'
}

async function ensureStatus(): Promise<DiaryAccessState> {
  if (statusRequest?.generation === generation) return statusRequest.promise
  const requestGeneration = generation
  const pending = getDiaryAccessStatus()
    .then((status) => {
      if (requestGeneration !== generation) return state.value
      // Status reconciliation is also an authoritative lock boundary. A
      // session can be locked elsewhere without emitting the local auth
      // event, so advance the same generation before replacing UNLOCKED
      // state; derived holders must not survive this poll response.
      if (state.value === 'UNLOCKED' && status.state !== 'UNLOCKED') {
        notifyTeardown('auth-invalidated')
      }
      state.value = status.state
      epoch.value = status.epoch ?? null
      statusResolved.value = true
      if (status.state !== 'UNLOCKED') clearDiaryCapability()
      return status.state
    })
    .finally(() => {
      if (requestGeneration === generation) statusResolved.value = true
      if (statusRequest?.promise === pending) statusRequest = null
    })
  statusRequest = { generation: requestGeneration, promise: pending }
  return pending
}

async function setup(password: string): Promise<void> {
  const requestGeneration = state.value === 'UNLOCKED'
    ? (notifyTeardown('capability-replaced'), generation)
    : ++generation
  statusRequest = null
  const result = await setupDiaryAccess(password)
  if (requestGeneration !== generation) return
  setDiaryCapability(result.capability)
  state.value = result.state
  epoch.value = result.epoch
  statusResolved.value = true
}

async function unlock(password: string): Promise<void> {
  const requestGeneration = state.value === 'UNLOCKED'
    ? (notifyTeardown('capability-replaced'), generation)
    : ++generation
  statusRequest = null
  const result = await unlockDiaryAccess(password)
  if (requestGeneration !== generation) return
  setDiaryCapability(result.capability)
  state.value = result.state
  epoch.value = result.epoch
  statusResolved.value = true
}

async function lock(): Promise<void> {
  notifyTeardown('lock')
  const requestGeneration = generation
  statusRequest = null
  clearDiaryCapability()
  epoch.value = null
  state.value = 'LOCKED'
  statusResolved.value = true
  await lockDiaryAccess()
  if (requestGeneration !== generation) return
  state.value = 'LOCKED'
}

const coordinator: DiaryAccessSession = {
  state: readonly(state),
  epoch: readonly(epoch),
  isUnlocked: readonly(isUnlocked),
  statusResolved: readonly(statusResolved),
  ensureStatus,
  setup,
  unlock,
  lock,
  clear,
}

export function useDiaryAccessSession(): DiaryAccessSession {
  if (!authWatchWired) {
    const auth = useAuth()
    watch(auth.state, (next) => {
      if (next !== 'authenticated') clear('logout')
    }, { immediate: true })
    expiryUnsubscribe = auth.onSessionExpired(() => clear('capability-expired'))
    serverLockUnsubscribe = subscribeDiaryAccessLocked(() => clear('auth-invalidated'))
    authWatchWired = true
  }
  void expiryUnsubscribe
  void serverLockUnsubscribe
  return coordinator
}

/** Subscribe to the authoritative session owner's synchronous teardown.
 * Derived caches/models may clear themselves here; they must not mutate the
 * session state or access the server DEK. */
export function subscribeDiaryTeardown(
  listener: (event: DiaryTeardownEvent) => void,
): () => void {
  teardownListeners.add(listener)
  return () => teardownListeners.delete(listener)
}

/** Capture the existing session generation for stale-result fencing. */
export function captureDiarySessionGeneration(): number { return generation }

export function isDiarySessionGenerationCurrent(value: number): boolean {
  return value === generation
}

export function resetDiaryAccessSessionForTesting(): void {
  notifyTeardown('reset')
  clearDiaryCapability()
  state.value = 'UNINITIALIZED'
  epoch.value = null
  statusResolved.value = false
  statusRequest = null
}
