import { computed, readonly, ref, type Ref } from 'vue'
import {
  getAuthStatus,
  login as loginApi,
  logout as logoutApi,
  setupOwner as setupOwnerApi,
  type AuthApiError,
  type AuthStatusResponse,
  type AuthUser,
  type LoginRequest,
  type SetupRequest,
} from '../lib/auth-api'
import {
  advanceAuthSessionGeneration,
  captureAuthSessionGeneration,
  subscribeAuthSessionRequired,
  type AuthSessionRequiredEvent,
} from '../lib/auth-session'
import { resetVaultIdentity } from '../lib/vault-identity'

export type AuthState = 'unknown' | 'setup-required' | 'unauthenticated' | 'authenticated'

type SessionExpiredListener = () => void

export type AuthTransitionKind = 'logout' | 'expired'

export type WorkspaceAuthTransitionResult =
  | { status: 'ready'; resume?: () => void }
  | { status: 'cancelled' }

export interface WorkspaceAuthTransitionAdapter {
  prepareActiveLogout: (isCurrent: () => boolean) => Promise<WorkspaceAuthTransitionResult>
  prepareSessionExpiry: (isCurrent: () => boolean) => Promise<WorkspaceAuthTransitionResult>
  /** Abort any owner prompt that is waiting inside active logout. */
  cancelActiveLogout?: () => void
}

export type LogoutResult =
  | { status: 'logged-out'; revokeConfirmed: true }
  | { status: 'logged-out'; revokeConfirmed: false; warning: true }
  | { status: 'cancelled' }
  | { status: 'expired' }

const state = ref<AuthState>('unknown')
const user = ref<AuthUser | null>(null)
const hydrating = ref(false)
const submitting = ref(false)
const hydrationError = ref<unknown>(null)
const sessionExpired = ref(false)
const transitionKind = ref<AuthTransitionKind | null>(null)

let generation = captureAuthSessionGeneration()
let hydrationPromise: Promise<AuthState> | null = null
const expiryListeners = new Set<SessionExpiredListener>()
let workspaceTransition: WorkspaceAuthTransitionAdapter | null = null
let activeLogoutPromise: Promise<LogoutResult> | null = null
let expiryPromise: Promise<void> | null = null

function applyStatus(status: AuthStatusResponse): void {
  if (status.authenticated) {
    state.value = 'authenticated'
    user.value = status.user ?? null
  } else if (status.setupRequired) {
    state.value = 'setup-required'
    user.value = null
  } else {
    state.value = 'unauthenticated'
    user.value = null
  }
}

function beginTransition(): number {
  generation = advanceAuthSessionGeneration()
  // A successful setup/login/explicit refresh supersedes any in-flight
  // workspace transition. The generation guard below prevents stale
  // completions from changing the new auth state, while clearing the
  // presentation flag keeps the shell usable for the new transition.
  transitionKind.value = null
  resetVaultIdentity()
  hydrationPromise = null
  hydrating.value = false
  // A newer auth transition owns the presentation state. If an older
  // login/setup request resolves later, its generation guard must not leave
  // the form permanently disabled.
  submitting.value = false
  hydrationError.value = null
  return generation
}

function finishUnauthenticated(expired: boolean): void {
  resetVaultIdentity()
  state.value = 'unauthenticated'
  user.value = null
  sessionExpired.value = expired
}

async function ensureHydrated(): Promise<AuthState> {
  if (state.value !== 'unknown') return state.value
  if (hydrationPromise) return hydrationPromise

  const requestGeneration = generation
  hydrating.value = true
  hydrationError.value = null
  const pending = getAuthStatus()
    .then((status) => {
      if (requestGeneration === generation) applyStatus(status)
      return state.value
    })
    .catch((error: unknown) => {
      if (requestGeneration === generation) {
        state.value = 'unknown'
        user.value = null
        hydrationError.value = error
      }
      return state.value
    })
    .finally(() => {
      if (requestGeneration === generation) {
        hydrating.value = false
        hydrationPromise = null
      }
    })
  hydrationPromise = pending
  return pending
}

async function refreshStatus(): Promise<AuthState> {
  beginTransition()
  state.value = 'unknown'
  user.value = null
  return ensureHydrated()
}

async function setup(input: SetupRequest): Promise<AuthUser> {
  const transitionGeneration = beginTransition()
  submitting.value = true
  try {
    const result = await setupOwnerApi(input)
    if (transitionGeneration === generation) {
      state.value = 'authenticated'
      user.value = result.user
      sessionExpired.value = false
    }
    return result.user
  } finally {
    if (transitionGeneration === generation) submitting.value = false
  }
}

async function login(input: LoginRequest): Promise<AuthUser> {
  const transitionGeneration = beginTransition()
  submitting.value = true
  try {
    const result = await loginApi(input)
    if (transitionGeneration === generation) {
      state.value = 'authenticated'
      user.value = result.user
      sessionExpired.value = false
    }
    return result.user
  } finally {
    if (transitionGeneration === generation) submitting.value = false
  }
}

async function logout(): Promise<LogoutResult> {
  if (activeLogoutPromise) return activeLogoutPromise
  if (state.value !== 'authenticated') {
    return { status: 'logged-out', revokeConfirmed: true }
  }

  const logoutGeneration = generation
  transitionKind.value = 'logout'
  // Defer the coordinator body one microtask so the shared promise is
  // installed before a workspace adapter can synchronously surface an
  // expiry response of its own. That makes active logout/expiry ownership
  // unambiguous even in adversarial test or network timing.
  const pending = Promise.resolve().then(async (): Promise<LogoutResult> => {
    if (generation !== logoutGeneration || state.value !== 'authenticated'
      || transitionKind.value !== 'logout') {
      return { status: 'expired' }
    }
    const isCurrent = () => generation === logoutGeneration
      && state.value === 'authenticated'
      && transitionKind.value === 'logout'
    let prepared: WorkspaceAuthTransitionResult
    try {
      prepared = workspaceTransition
        ? await workspaceTransition.prepareActiveLogout(isCurrent)
        : { status: 'ready' as const }
    } catch (error) {
      if (generation === logoutGeneration && transitionKind.value === 'logout') {
        transitionKind.value = null
      }
      throw error
    }
    if (prepared.status === 'cancelled') {
      const current = generation === logoutGeneration && transitionKind.value === 'logout'
      if (current) transitionKind.value = null
      return current ? { status: 'cancelled' } : { status: 'expired' }
    }
    if (!isCurrent()) return { status: 'expired' }

    try {
      await logoutApi()
    } catch (error) {
      // An exact session-expiry event may have taken ownership while the
      // logout request was in flight. Its workspace transition must remain
      // the only owner of identity reset and Draft Store flushing.
      if (generation !== logoutGeneration) return { status: 'expired' }
      // The server clears cookies best-effort even when storage revoke is
      // unavailable. Reconcile once so the UI never claims a confirmed
      // revoke when the browser is already unauthenticated, while keeping a
      // live authenticated session recoverable when the status still says so.
      try {
        const status = await getAuthStatus()
        if (!status.authenticated) {
          generation = advanceAuthSessionGeneration()
          finishUnauthenticated(false)
          transitionKind.value = null
          return { status: 'logged-out', revokeConfirmed: false, warning: true }
        }
      } catch {
        // Keep the original safe error below; no raw storage detail is shown.
      }
      // The session is still usable (or its status could not be reconciled),
      // so an active workspace must resume autosave after the failed revoke.
      if (prepared.status === 'ready') prepared.resume?.()
      transitionKind.value = null
      throw error
    }

    if (generation !== logoutGeneration) return { status: 'expired' }
    generation = advanceAuthSessionGeneration()
    finishUnauthenticated(false)
    transitionKind.value = null
    return { status: 'logged-out', revokeConfirmed: true }
  })
  activeLogoutPromise = pending
  void pending.then(
    () => { if (activeLogoutPromise === pending) activeLogoutPromise = null },
    () => { if (activeLogoutPromise === pending) activeLogoutPromise = null },
  )
  return pending
}

function runExpiryTransition(expiryGeneration: number): void {
  if (expiryPromise) return
  const waitForLogout = activeLogoutPromise ?? Promise.resolve()
  const finish = async (): Promise<void> => {
    if (generation !== expiryGeneration) return
    const isCurrent = () => generation === expiryGeneration
    if (workspaceTransition) await workspaceTransition.prepareSessionExpiry(isCurrent)
    if (generation !== expiryGeneration) return
    // Identity reset is deliberately delayed until the workspace has
    // explicitly flushed browser recovery storage.
    resetVaultIdentity()
    transitionKind.value = null
    for (const listener of [...expiryListeners]) listener()
  }
  // Start the workspace adapter in the same turn when no active logout is
  // being drained. This keeps the expiry boundary observable immediately
  // while still allowing a concurrent logout to finish its in-flight save
  // before the expiry adapter takes ownership.
  const pending = (activeLogoutPromise
    ? waitForLogout.catch(() => undefined).then(finish)
    : finish())
    .catch(() => {
      // A broken adapter must not leave the owner trapped in the workspace;
      // the server session is already invalid, so fail closed after the
      // best-effort transition.
      if (generation === expiryGeneration) {
        resetVaultIdentity()
        transitionKind.value = null
        for (const listener of [...expiryListeners]) listener()
      }
    })
    .finally(() => {
      if (expiryPromise === pending) expiryPromise = null
    })
  expiryPromise = pending
}

function onSessionRequired(event: AuthSessionRequiredEvent): void {
  // A response that began before a successful setup/login must not invalidate
  // the newly authenticated state when its body is observed later.
  if (event.generation !== generation || state.value !== 'authenticated') return
  generation = advanceAuthSessionGeneration()
  hydrationPromise = null
  state.value = 'unauthenticated'
  user.value = null
  sessionExpired.value = true
  transitionKind.value = 'expired'
  workspaceTransition?.cancelActiveLogout?.()
  runExpiryTransition(generation)
}

subscribeAuthSessionRequired(onSessionRequired)

export interface AuthCoordinator {
  readonly state: Readonly<Ref<AuthState>>
  readonly user: Readonly<Ref<AuthUser | null>>
  readonly hydrating: Readonly<Ref<boolean>>
  readonly submitting: Readonly<Ref<boolean>>
  readonly hydrationError: Readonly<Ref<unknown>>
  readonly sessionExpired: Readonly<Ref<boolean>>
  readonly transitionKind: Readonly<Ref<AuthTransitionKind | null>>
  ensureHydrated: () => Promise<AuthState>
  refreshStatus: () => Promise<AuthState>
  setup: (input: SetupRequest) => Promise<AuthUser>
  login: (input: LoginRequest) => Promise<AuthUser>
  logout: () => Promise<LogoutResult>
  registerWorkspaceTransition: (adapter: WorkspaceAuthTransitionAdapter) => () => void
  onSessionExpired: (listener: SessionExpiredListener) => () => void
  resetAuthForTesting: () => void
}

function onSessionExpired(listener: SessionExpiredListener): () => void {
  expiryListeners.add(listener)
  return () => expiryListeners.delete(listener)
}

function registerWorkspaceTransition(adapter: WorkspaceAuthTransitionAdapter): () => void {
  workspaceTransition = adapter
  return () => {
    if (workspaceTransition === adapter) workspaceTransition = null
  }
}

export function resetAuthForTesting(): void {
  generation = advanceAuthSessionGeneration()
  resetVaultIdentity()
  hydrationPromise = null
  state.value = 'unknown'
  user.value = null
  hydrating.value = false
  submitting.value = false
  hydrationError.value = null
  sessionExpired.value = false
  transitionKind.value = null
  activeLogoutPromise = null
  expiryPromise = null
  workspaceTransition = null
}

const coordinator: AuthCoordinator = {
  state: readonly(state),
  user: readonly(user),
  hydrating: readonly(hydrating),
  submitting: readonly(submitting),
  hydrationError: readonly(hydrationError),
  sessionExpired: readonly(sessionExpired),
  transitionKind: readonly(transitionKind),
  ensureHydrated,
  refreshStatus,
  setup,
  login,
  logout,
  registerWorkspaceTransition,
  onSessionExpired,
  resetAuthForTesting,
}

export function useAuth(): AuthCoordinator {
  return coordinator
}

export function isAuthApiError(error: unknown): error is AuthApiError {
  return Boolean(error && typeof error === 'object' && error instanceof Error && 'status' in error && 'body' in error)
}

export const authState = computed(() => state.value)
