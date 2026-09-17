/**
 * Shared, deliberately narrow observation seam for the Nuvyn session.
 *
 * This module does not own navigation and it never replaces global fetch.
 * Protected API wrappers call `observeAuthSessionResponse` after receiving a
 * response.  The observer reads a clone so each feature-specific parser keeps
 * ownership of the original response body.
 */
import { getDiaryCapability } from './diary-capability'
import { NUVYN_DIARY_ACCESS_CAPABILITY_HEADER } from '../../shared/technicalNamespace'

export const AUTH_SESSION_REQUIRED_CODE = 'auth-session-required' as const
export const DIARY_ACCESS_LOCKED_CODE = 'diary-locked' as const

export type AuthSessionRequiredEvent = {
  /** Request epoch captured when the protected request started. */
  readonly generation: number
}

type Listener = (event: AuthSessionRequiredEvent) => void
type DiaryAccessLockedListener = () => void

let generation = 0
const listeners = new Set<Listener>()
const diaryAccessLockedListeners = new Set<DiaryAccessLockedListener>()

/** Capture the current request epoch before starting a protected fetch. */
export function captureAuthSessionGeneration(): number {
  return generation
}

/** Advance the epoch when a successful auth transition supersedes old work. */
export function advanceAuthSessionGeneration(): number {
  generation += 1
  return generation
}

export function subscribeAuthSessionRequired(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Subscribe to the server-side Diary lock boundary. This is deliberately a
 * separate channel from authentication expiry: the owner session can still
 * be valid when a restarted server process has lost its in-memory Diary DEK.
 */
export function subscribeDiaryAccessLocked(listener: DiaryAccessLockedListener): () => void {
  diaryAccessLockedListeners.add(listener)
  return () => diaryAccessLockedListeners.delete(listener)
}

async function responseCode(response: Response): Promise<unknown> {
  try {
    const body = await response.clone().json() as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
    return (body as { code?: unknown }).code
  } catch {
    return undefined
  }
}

/**
 * Return true only for the Nuvyn-owned session-expiry contract.
 * HTTP status alone is intentionally insufficient: provider authentication
 * failures also use 401 in the AI API.
 */
export async function isAuthSessionRequiredResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  return await responseCode(response) === AUTH_SESSION_REQUIRED_CODE
}

export async function isDiaryAccessLockedResponse(response: Response): Promise<boolean> {
  if (response.status !== 423) return false
  return await responseCode(response) === DIARY_ACCESS_LOCKED_CODE
}

/**
 * Observe a response and notify subscribers when it is a Nuvyn session
 * expiry.  The original response remains readable by the caller.
 */
export async function observeAuthSessionResponse(
  response: Response,
  requestGeneration = captureAuthSessionGeneration(),
): Promise<boolean> {
  if (!await isAuthSessionRequiredResponse(response)) return false
  const event = { generation: requestGeneration } satisfies AuthSessionRequiredEvent
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // An observation subscriber must never break the feature-specific
      // parser that still owns the original response.
    }
  }
  return true
}

/**
 * Observe a locked Diary body response without consuming the caller-owned
 * response. A process restart intentionally loses the server's in-memory DEK;
 * this event makes the browser drop its matching capability and plaintext
 * workspace immediately instead of leaving a stale unlocked presentation.
 */
export async function observeDiaryAccessLockedResponse(response: Response): Promise<boolean> {
  if (!await isDiaryAccessLockedResponse(response)) return false
  for (const listener of [...diaryAccessLockedListeners]) {
    try {
      listener()
    } catch {
      // The feature-specific parser still owns the original response.
    }
  }
  return true
}

async function fetchWithSessionObservation(
  input: string | URL | Request,
  init: RequestInit | undefined,
  capability: string | null,
): Promise<Response> {
  const requestGeneration = captureAuthSessionGeneration()
  let requestInput = input
  let requestInit = init
  if (capability) {
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers) {
      new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    }
    headers.set(NUVYN_DIARY_ACCESS_CAPABILITY_HEADER, capability)
    if (input instanceof Request && init === undefined) {
      requestInput = new Request(input, { headers })
    } else {
      requestInit = { ...init, headers }
    }
  }
  const response = requestInit === undefined ? await fetch(requestInput) : await fetch(requestInput, requestInit)
  await observeAuthSessionResponse(response, requestGeneration)
  await observeDiaryAccessLockedResponse(response)
  return response
}

/**
 * Fetch helper for ordinary protected application wrappers. It observes the
 * authentication session but never reads or forwards the Diary capability.
 * Diary authority must be requested through the explicit seam below. Keep
 * this as a Promise-returning function rather than an async wrapper: the
 * workspace lifecycle relies on the same settlement timing as the original
 * authFetch implementation.
 */
export function authFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetchWithSessionObservation(input, init, null)
}

/**
 * Explicit request seam for an operation that has already established that it
 * is inside the managed-Diary capability boundary. A missing capability is
 * intentionally sent as no header; the server then fails closed with 423.
 * This seam is operation-owned, so it may carry the capability to a generic
 * Vault endpoint when the caller has already established Diary context.
 */
export function diaryAuthFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetchWithSessionObservation(input, init, getDiaryCapability())
}

/** Test-only reset; no production code relies on this. */
export function resetAuthSessionForTesting(): void {
  generation = 0
  // Keep production subscribers (notably useAuth's singleton coordinator)
  // installed when a test resets the request epoch.
}
