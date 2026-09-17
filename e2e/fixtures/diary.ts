import { test as authTest, expect, type APIRequestContext } from './auth'
import { sanitizeDiagnosticText } from '../../shared/sanitize-diagnostic'
import type { BrowserContext, Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import nodePath from 'node:path'
import { freezeCalendarClock } from '../helpers/calendar-clock'

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>
type PlaywrightApi = typeof import('playwright-core')

type DiaryBootstrapPhase =
  | 'NAVIGATION_START'
  | 'NAVIGATION_SETTLED'
  | 'START'
  | 'SCOPE_VISIBLE'
  | 'ACCESS_DIALOG_CHECK'
  | 'ACCESS_SUBMIT_START'
  | 'ACCESS_SUBMIT_FINISH'
  | 'SCOPE_ACTIVATION_START'
  | 'SCOPE_ACTIVATION_FINISH'
  | 'ACCESS_READY'
  | 'WORKSPACE_CHECK'
  | 'FINISH'
  | 'STALE'
  | 'ERROR'
  | 'TEARDOWN'

interface DiaryBootstrapDiagnosticContext {
  generation: number
  targetRoute: string
  currentGeneration: () => number
  record: (phase: DiaryBootstrapPhase, detail?: string) => Promise<void>
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:4174'
const DIARY_PASSWORD = 'e2e-diary-access-password-strong-123'
export const DIARY_ACCESS_CAPABILITY_HEADER = 'X-Nuvyn-Diary-Capability'

/**
 * E2E tests need deterministic isolation, including physical-only fixtures
 * that the public managed-Diary delete owner must reject when authoritative
 * metadata is absent. Cleanup is restricted to the explicitly test-owned
 * temporary vault/database that the Playwright configs provision. This helper
 * is never part of the application runtime.
 */
export async function resetManagedDiaryFixture(): Promise<void> {
  const tempRoot = nodePath.resolve(os.tmpdir())
  const vaultValue = process.env.NUVYN_DRAFT_E2E_VAULT?.trim()
  if (!vaultValue) return
  const vault = nodePath.resolve(vaultValue)
  if (!vault.startsWith(`${tempRoot}${nodePath.sep}`)) return

  const diaryRoot = nodePath.join(vault, 'diary')
  try {
    const entries = await fs.readdir(diaryRoot, { withFileTypes: true })
    await Promise.all(entries
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/u.test(entry.name))
      .map((entry) => fs.rm(nodePath.join(diaryRoot, entry.name), { force: true })))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const dbValue = process.env.NUVYN_E2E_DB_PATH?.trim()
  if (!dbValue) return
  const dbPath = nodePath.resolve(dbValue)
  if (!dbPath.startsWith(`${tempRoot}${nodePath.sep}`)) return
  try {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(dbPath)
    try {
      db.pragma('busy_timeout = 5000')
      db.pragma('foreign_keys = ON')
      db.exec('BEGIN IMMEDIATE')
      db.exec(`
        DELETE FROM tag_undo_association_deltas
        WHERE document_id IN (SELECT id FROM documents WHERE path LIKE 'diary/%');
        DELETE FROM history_metadata_revisions WHERE path_at_revision LIKE 'diary/%';
        DELETE FROM history_metadata_document_tombstones
        WHERE original_path LIKE 'diary/%';
        DELETE FROM metadata_migrations
        WHERE path LIKE 'diary/%' OR original_path LIKE 'diary/%';
        DELETE FROM documents WHERE path LIKE 'diary/%';
        DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM document_tags);
      `)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    } finally {
      db.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function resolvedBaseURL(baseURL: string | undefined): string {
  return baseURL ?? process.env.NUVYN_PUBLIC_ORIGIN ?? DEFAULT_BASE_URL
}

function originHeaders(baseURL: string): Record<string, string> {
  return { Origin: baseURL }
}

async function readAccessState(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<{
  state: 'UNINITIALIZED' | 'LOCKED' | 'UNLOCKED'
}> {
  expect(response.status(), await response.text()).toBe(200)
  return await response.json() as {
    state: 'UNINITIALIZED' | 'LOCKED' | 'UNLOCKED'
  }
}

async function ensureDiaryConfiguration(
  playwright: PlaywrightApi,
  baseURL: string,
): Promise<void> {
  // Configuration is a worker concern, but its setup capability must not be
  // stranded on the worker auth session that later tests depend on. Use a
  // disposable authenticated session and revoke it explicitly below.
  const auth = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: originHeaders(baseURL),
  })
  try {
    const authSetup = await auth.post('/api/auth/setup', {
      data: {
        bootstrapToken: process.env.NUVYN_SETUP_TOKEN
          ?? 'nuvyn-e2e-setup-token-0123456789abcdef',
        username: 'e2e-owner',
        password: 'e2e-owner-password-strong-123',
      },
    })
    if (authSetup.status() === 409) {
      const login = await auth.post('/api/auth/login', {
        data: {
          username: 'e2e-owner',
          password: 'e2e-owner-password-strong-123',
        },
      })
      expect(login.status(), await login.text()).toBe(200)
    } else {
      expect(authSetup.status(), await authSetup.text()).toBe(201)
    }

    const status = await auth.get('/api/diary/access/status')
    const access = await readAccessState(status)
    if (access.state !== 'UNINITIALIZED') return

    const setup = await auth.post('/api/diary/access/setup', {
      data: { password: DIARY_PASSWORD },
    })
    expect([201, 409], await setup.text()).toContain(setup.status())
  } finally {
    // setup returns a process-local capability, so disposing the request
    // context alone is not a supported revocation boundary.
    await auth.post('/api/auth/logout').catch(() => undefined)
    await auth.dispose()
  }
}

async function loginForDiaryApi(
  playwright: PlaywrightApi,
  baseURL: string,
): Promise<{ auth: APIRequestContext; api: APIRequestContext }> {
  const auth = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: originHeaders(baseURL),
  })
  try {
    const login = await auth.post('/api/auth/login', {
      data: {
        username: 'e2e-owner',
        password: 'e2e-owner-password-strong-123',
      },
    })
    expect(login.status(), await login.text()).toBe(200)

    const accessStatus = await auth.get('/api/diary/access/status')
    const access = await readAccessState(accessStatus)
    const accessPath = access.state === 'UNINITIALIZED'
      ? '/api/diary/access/setup'
      : '/api/diary/access/unlock'
    const unlock = await auth.post(accessPath, {
      data: { password: DIARY_PASSWORD },
    })
    expect([200, 201], await unlock.text()).toContain(unlock.status())
    const unlocked = await unlock.json() as { capability?: unknown }
    expect(unlocked.capability).toEqual(expect.any(String))

    const api = await playwright.request.newContext({
      baseURL,
      storageState: await auth.storageState(),
      extraHTTPHeaders: {
        ...originHeaders(baseURL),
        [DIARY_ACCESS_CAPABILITY_HEADER]: unlocked.capability as string,
      },
    })
    return { auth, api }
  } catch (error) {
    await auth.post('/api/auth/logout').catch(() => undefined)
    await auth.dispose()
    throw error
  }
}

async function currentDiaryScope(page: Page): Promise<boolean> {
  const diaryChip = page.locator('.scope-chip').filter({ hasText: 'diary' })
  if (await diaryChip.count() === 0) return false
  return (await diaryChip.getAttribute('aria-pressed')) === 'true'
}

async function submitDiaryAccess(page: Page): Promise<void> {
  const password = page.locator('#diary-access-password')
  await password.fill(DIARY_PASSWORD)
  const confirm = page.locator('#diary-access-confirm')
  if (await confirm.isVisible().catch(() => false)) await confirm.fill(DIARY_PASSWORD)
  // Draft Recovery may be mounted above the access dialog during a
  // reload. Submit through the focused form control so the supported
  // keyboard flow is not blocked by the other modal's pointer layer.
  await page.locator('.diary-access-dialog button[type="submit"]').press('Enter')
  await expect(page.locator('.diary-access-dialog')).toHaveCount(0, { timeout: 15_000 })
}

async function activateScopeChip(page: Page, chip: ReturnType<Page['locator']>): Promise<void> {
  // A stale recovery prompt can cover the chip while App is still resolving
  // the fresh process-local access session. Keyboard activation exercises the
  // same button handler without pretending that the overlay is dismissible.
  if (await page.locator('.draft-recovery-backdrop').isVisible().catch(() => false)) {
    await chip.focus()
    await chip.press('Enter')
    return
  }
  await chip.focus()
  await chip.press('Enter')
}

function waitForDiaryAccessStatus(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/diary/access/status',
    { timeout: 15_000 },
  )
}

function managedDiaryPathFromVaultRoute(pathname: string): string | null {
  const prefix = '/vault/diary/'
  if (!pathname.startsWith(prefix)) return null
  const encodedPath = pathname.slice('/vault/'.length)
  try {
    const path = decodeURIComponent(encodedPath)
    return /^diary\/\d{4}-\d{2}-\d{2}$/.test(path) ? path : null
  } catch {
    return null
  }
}

async function waitForDiaryWorkspaceRoute(
  page: Page,
  diagnostics: DiaryBootstrapDiagnosticContext,
): Promise<void> {
  const pathname = new URL(page.url()).pathname
  const path = managedDiaryPathFromVaultRoute(pathname)
  if (!path) return
  const tab = page.locator(`[role="tab"][data-tab-id="${path}"]`)
  await expect(tab).toHaveCount(1)
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await diagnostics.record('WORKSPACE_CHECK', 'managed-route-ready')
}

async function bootstrapDiaryPage(
  page: Page,
  keepDiaryScope: boolean,
  diagnostics: DiaryBootstrapDiagnosticContext,
): Promise<void> {
  await diagnostics.record('START')
  const pathname = new URL(page.url()).pathname
  if (!pathname.startsWith('/vault')) {
    await diagnostics.record('FINISH', 'non-vault')
    return
  }

  const diaryChip = page.locator('.scope-chip').filter({ hasText: 'diary' })
  const noteChip = page.locator('.scope-chip').filter({ hasText: 'note' })
  await expect(diaryChip).toBeVisible({ timeout: 15_000 })
  await diagnostics.record('SCOPE_VISIBLE')

  const password = page.locator('#diary-access-password')
  const initialAccessDialogVisible = await password.isVisible().catch(() => false)
  await diagnostics.record('ACCESS_DIALOG_CHECK', initialAccessDialogVisible ? 'visible' : 'hidden')

  // A reload can restore the generic recovery surface at the same time as
  // the persisted Diary scope asks App.vue to request access. Resolve an
  // already-open access dialog first; clicking a scope chip while the
  // recovery backdrop is present would only retry a blocked click and hide
  // the real unlock path behind a timeout.
  if (initialAccessDialogVisible) {
    await diagnostics.record('ACCESS_SUBMIT_START', 'initial-dialog')
    await submitDiaryAccess(page)
    await diagnostics.record('ACCESS_SUBMIT_FINISH', 'initial-dialog')
  }

  // On a fresh process the persisted Diary scope can briefly render as active
  // before App.vue reconciles the missing process-local capability and opens
  // the access dialog. Do not let that transient aria state satisfy the
  // bootstrap; wait for either the dialog or the normalization to note.
  if (keepDiaryScope
    && await diaryChip.getAttribute('aria-pressed') === 'true'
    && !initialAccessDialogVisible
    && !await password.isVisible().catch(() => false)) {
    await expect.poll(async () => (
      await password.isVisible().catch(() => false)
        || await diaryChip.getAttribute('aria-pressed') !== 'true'
    ), { timeout: 15_000 }).toBe(true)
  }

  // A full page navigation starts a new browser JS process, so a persisted
  // Diary scope must not be mistaken for a live capability. Force the real
  // scope transition to invoke App.vue's normal access dialog.
  if (await diaryChip.getAttribute('aria-pressed') === 'true' && !keepDiaryScope) {
    await diagnostics.record('SCOPE_ACTIVATION_START', 'note')
    await activateScopeChip(page, noteChip)
    await expect(noteChip).toHaveAttribute('aria-pressed', 'true')
    await diagnostics.record('SCOPE_ACTIVATION_FINISH', 'note')
  }
  if (await diaryChip.getAttribute('aria-pressed') !== 'true') {
    await diagnostics.record('SCOPE_ACTIVATION_START', 'diary')
    await activateScopeChip(page, diaryChip)
    await diagnostics.record('SCOPE_ACTIVATION_FINISH', 'diary')
  }

  await expect.poll(async () => (
    await diaryChip.getAttribute('aria-pressed') === 'true'
      || await password.isVisible().catch(() => false)
  ), { timeout: 15_000 }).toBe(true)
  if (await password.isVisible().catch(() => false)) {
    await diagnostics.record('ACCESS_SUBMIT_START', 'post-scope-dialog')
    await submitDiaryAccess(page)
    await diagnostics.record('ACCESS_SUBMIT_FINISH', 'post-scope-dialog')
  }

  await expect(diaryChip).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await diagnostics.record('ACCESS_READY')
  if (!keepDiaryScope) {
    await diagnostics.record('SCOPE_ACTIVATION_START', 'restore-note')
    await activateScopeChip(page, noteChip)
    await expect(noteChip).toHaveAttribute('aria-pressed', 'true')
    await diagnostics.record('SCOPE_ACTIVATION_FINISH', 'restore-note')
  }
  await waitForDiaryWorkspaceRoute(page, diagnostics)
  await diagnostics.record('WORKSPACE_CHECK')
  if (diagnostics.generation !== diagnostics.currentGeneration()) {
    // Attribution only: the first diagnostic pass records stale ownership but
    // deliberately preserves existing fixture semantics.
    await diagnostics.record('STALE')
  }
  await diagnostics.record('FINISH')
}

async function logoutBrowserContext(
  playwright: PlaywrightApi,
  baseURL: string,
  context: BrowserContext,
): Promise<void> {
  let state: StorageState
  try {
    state = await context.storageState()
  } catch {
    return
  }
  const api = await playwright.request.newContext({
    baseURL,
    storageState: state,
    extraHTTPHeaders: originHeaders(baseURL),
  })
  try {
    await api.post('/api/auth/logout')
  } finally {
    await api.dispose()
  }
}

export const test = authTest.extend<{}, {
  diaryConfigReady: void
  diaryFixtureReset: void
}>({
  diaryFixtureReset: [async ({}, use) => {
    await resetManagedDiaryFixture()
    await use()
  }, { auto: true }],

  diaryConfigReady: [async ({ playwright }, use) => {
    const origin = resolvedBaseURL(undefined)
    await ensureDiaryConfiguration(playwright, origin)
    await use()
  }, { scope: 'worker' }],

  // Diary browser tests receive a fresh authenticated session per test. A
  // test that logs out or locks cannot revoke the worker session reused by a
  // later test, while storageState still contains only the auth cookie.
  storageState: async ({ playwright, baseURL, diaryConfigReady }, use) => {
    void diaryConfigReady
    const origin = resolvedBaseURL(baseURL)
    const auth = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: originHeaders(origin),
    })
    try {
      const login = await auth.post('/api/auth/login', {
        data: {
          username: 'e2e-owner',
          password: 'e2e-owner-password-strong-123',
        },
      })
      expect(login.status(), await login.text()).toBe(200)
      await use(await auth.storageState())
    } finally {
      await auth.dispose()
    }
  },

  // API setup/cleanup uses a different fresh session from the browser page.
  // The capability is held only in this fixture's in-memory request header;
  // it is never put into storageState, browser storage, URLs, or logs.
  request: async ({ playwright, baseURL, diaryConfigReady }, use) => {
    void diaryConfigReady
    const origin = resolvedBaseURL(baseURL)
    const { auth, api } = await loginForDiaryApi(playwright, origin)
    try {
      await use(api)
    } finally {
      await api.dispose()
      await auth.post('/api/auth/logout').catch(() => undefined)
      await auth.dispose()
    }
  },

  // The Diary capability belongs to the page's current JS process. Re-run
  // the supported UI setup/unlock flow after full navigations that replace
  // that process, while preserving the scope the test was already using.
  page: async ({ page, playwright, baseURL, diaryConfigReady }, use, testInfo) => {
    void diaryConfigReady
    // Install the browser clock before any test navigation. DiaryCalendar
    // derives its current civil date from browser-side `new Date()`.
    await freezeCalendarClock(page)
    const origin = resolvedBaseURL(baseURL)
    const originalGoto = page.goto.bind(page)
    const originalReload = page.reload.bind(page)
    const originalGoBack = page.goBack.bind(page)
    const originalGoForward = page.goForward.bind(page)
    let diaryNavigationGeneration = 0
    const bootstrapDiagnostics: string[] = []
    let firstBrowserErrorRecorded = false

    function safePathname(value: string): string {
      try {
        return new URL(value, origin).pathname
      } catch {
        return '[invalid-url]'
      }
    }

    function redactDiagnosticText(value: string): string {
      return sanitizeDiagnosticText(value, DIARY_PASSWORD)
    }

    function appendDiagnostic(entry: Record<string, unknown>): void {
      bootstrapDiagnostics.push(JSON.stringify(entry))
    }

    async function recordBootstrapPhase(
      generation: number,
      targetRoute: string,
      phase: DiaryBootstrapPhase,
      detail?: string,
    ): Promise<void> {
      const currentGeneration = diaryNavigationGeneration
      const base = {
        event: 'diary-bootstrap',
        generation,
        currentGeneration,
        phase,
        targetRoute,
        currentRoute: page.isClosed() ? '[page-closed]' : safePathname(page.url()),
        stale: generation !== currentGeneration,
        detail: detail ?? '',
      }
      if (page.isClosed()) {
        appendDiagnostic(base)
        return
      }
      try {
        const snapshot = await page.evaluate(() => ({
          readyState: document.readyState,
          scope: Array.from(document.querySelectorAll<HTMLElement>('.scope-chip'))
            .find((chip) => chip.textContent?.trim() === 'diary')
            ?.getAttribute('aria-pressed') ?? null,
          accessDialogVisible: Boolean(document.querySelector('#diary-access-password')),
          tabPaths: Array.from(document.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]'))
            .map((tab) => tab.dataset.tabId ?? ''),
          selectedTabPath: document.querySelector<HTMLElement>('[role="tab"][data-tab-id][aria-selected="true"]')
            ?.dataset.tabId ?? null,
          calendarVisible: (() => {
            const calendar = document.querySelector<HTMLElement>('[data-testid="diary-calendar"]')
            if (!calendar) return null
            return getComputedStyle(calendar).display !== 'none'
          })(),
        }))
        appendDiagnostic({ ...base, ...snapshot })
      } catch (error) {
        appendDiagnostic({
          ...base,
          snapshotError: error instanceof Error ? error.message : String(error),
        })
      }
    }

    function beginNavigation(kind: string, targetRoute: string): DiaryBootstrapDiagnosticContext {
      const generation = ++diaryNavigationGeneration
      const record = (phase: DiaryBootstrapPhase, detail?: string) => (
        recordBootstrapPhase(generation, targetRoute, phase, detail)
      )
      void record('NAVIGATION_START', kind)
      return {
        generation,
        targetRoute,
        currentGeneration: () => diaryNavigationGeneration,
        record,
      }
    }

    page.on('response', (response) => {
      const pathname = safePathname(response.url())
      if (pathname !== '/api/diary/access/status') return
      appendDiagnostic({
        event: 'diary-access-status-response',
        generation: diaryNavigationGeneration,
        currentRoute: page.isClosed() ? '[page-closed]' : safePathname(page.url()),
        status: response.status(),
      })
    })
    page.on('pageerror', (error) => {
      if (firstBrowserErrorRecorded) return
      firstBrowserErrorRecorded = true
      appendDiagnostic({
        event: 'first-pageerror',
        generation: diaryNavigationGeneration,
        currentRoute: page.isClosed() ? '[page-closed]' : safePathname(page.url()),
        message: redactDiagnosticText(error.stack ?? error.message),
      })
    })
    page.on('console', (message) => {
      if (firstBrowserErrorRecorded || !['error', 'warning'].includes(message.type())) return
      firstBrowserErrorRecorded = true
      appendDiagnostic({
        event: 'first-console-error',
        generation: diaryNavigationGeneration,
        currentRoute: page.isClosed() ? '[page-closed]' : safePathname(page.url()),
        type: message.type(),
        message: redactDiagnosticText(message.text()),
        location: {
          path: safePathname(message.location().url),
          lineNumber: message.location().lineNumber,
          columnNumber: message.location().columnNumber,
        },
      })
    })

    page.goto = async (url, options) => {
      const keepDiaryScope = await currentDiaryScope(page)
      let targetPath: string
      try {
        targetPath = new URL(url, page.url()).pathname
      } catch {
        targetPath = new URL(url, origin).pathname
      }
      const diagnostics = beginNavigation('goto', targetPath)
      const accessStatus = managedDiaryPathFromVaultRoute(targetPath)
        ? waitForDiaryAccessStatus(page)
        : null
      const response = await originalGoto(url, options)
      await diagnostics.record('NAVIGATION_SETTLED', 'goto')
      if (accessStatus) await accessStatus
      await bootstrapDiaryPage(
        page,
        keepDiaryScope || targetPath.startsWith('/vault/diary/'),
        diagnostics,
      )
      return response
    }
    page.reload = async (options) => {
      const keepDiaryScope = await currentDiaryScope(page)
      const targetPath = safePathname(page.url())
      const diagnostics = beginNavigation('reload', targetPath)
      const accessStatus = managedDiaryPathFromVaultRoute(targetPath)
        ? waitForDiaryAccessStatus(page)
        : null
      const response = await originalReload(options)
      await diagnostics.record('NAVIGATION_SETTLED', 'reload')
      if (accessStatus) await accessStatus
      await bootstrapDiaryPage(page, keepDiaryScope, diagnostics)
      return response
    }
    page.goBack = async (options) => {
      const keepDiaryScope = await currentDiaryScope(page)
      const diagnostics = beginNavigation('goBack', '[browser-back]')
      const response = await originalGoBack(options)
      await diagnostics.record('NAVIGATION_SETTLED', 'goBack')
      await bootstrapDiaryPage(page, keepDiaryScope, diagnostics)
      return response
    }
    page.goForward = async (options) => {
      const keepDiaryScope = await currentDiaryScope(page)
      const diagnostics = beginNavigation('goForward', '[browser-forward]')
      const response = await originalGoForward(options)
      await diagnostics.record('NAVIGATION_SETTLED', 'goForward')
      await bootstrapDiaryPage(page, keepDiaryScope, diagnostics)
      return response
    }

    try {
      await use(page)
    } finally {
      const teardownGeneration = ++diaryNavigationGeneration
      await recordBootstrapPhase(teardownGeneration, safePathname(page.url()), 'TEARDOWN')
      await logoutBrowserContext(playwright, origin, page.context())
      await testInfo.attach('diary-bootstrap-diagnostics', {
        body: bootstrapDiagnostics.join('\n'),
        contentType: 'application/x-ndjson',
      })
      if (
        process.env.NUVYN_DIARY_BOOTSTRAP_DIAGNOSTICS === '1'
        || testInfo.status !== testInfo.expectedStatus
      ) {
        console.error(
          `DIARY_BOOTSTRAP_DIAG_BEGIN\n${bootstrapDiagnostics.join('\n')}\nDIARY_BOOTSTRAP_DIAG_END`,
        )
      }
    }
  },
})

export { expect }
export type { APIRequestContext }
