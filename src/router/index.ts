import { createRouter, createWebHistory, type RouteLocationNormalized, type RouteLocationRaw } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { safeInternalRedirect } from '../lib/auth-redirect'
import { ensureVaultIdentity } from '../lib/vault-identity'
import type { ChromeStyle, WorkspaceKind } from '../lib/workspace'

declare module 'vue-router' {
  interface RouteMeta {
    authPage?: boolean
    publicDevPreview?: boolean
    workspace?: boolean
    workspaceKind?: WorkspaceKind
    chromeStyle?: ChromeStyle
    immersive?: boolean
    requiresVaultIdentity?: boolean
    fullWidth?: boolean
    sidebar?: boolean
  }
}

const devRoutes = import.meta.env.DEV
  ? [
      {
        path: '/__markdown-test',
        component: () => import('../views/MarkdownTestView.vue'),
        meta: { fullWidth: true, publicDevPreview: true },
      },
    ]
  : []

const compatibilitySpikeRoutes = [
  {
    // Keep the compatibility module in production's async graph so the
    // production build can prove the React/Excalidraw lazy boundary. The
    // guard keeps this temporary spike development-only at runtime.
    path: '/__spike/board-excalidraw',
    name: 'board-excalidraw-spike',
    component: () => import('../views/BoardExcalidrawSpikeView.vue'),
    beforeEnter: () => import.meta.env.DEV,
    meta: { fullWidth: true, publicDevPreview: true },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes: [
    ...devRoutes,
    ...compatibilitySpikeRoutes,
    { path: '/', redirect: '/vault', meta: { workspace: true } },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { authPage: true },
    },
    {
      path: '/setup',
      name: 'setup',
      component: () => import('../views/SetupView.vue'),
      meta: { authPage: true },
    },
    {
      path: '/vault',
      name: 'vault',
      component: () => import('../views/VaultView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'vault',
        chromeStyle: 'workspace',
        sidebar: true,
      },
    },
    {
      path: '/vault/:pathMatch(.*)*',
      name: 'vault-doc',
      component: () => import('../views/VaultView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'vault',
        chromeStyle: 'workspace',
        sidebar: true,
      },
    },
    {
      path: '/board',
      name: 'board',
      component: () => import('../views/BoardHomeView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'board',
        chromeStyle: 'workspace',
        requiresVaultIdentity: false,
        sidebar: false,
      },
    },
    {
      path: '/board/folder/:folderId',
      name: 'board-folder',
      component: () => import('../views/BoardHomeView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'board',
        chromeStyle: 'workspace',
        requiresVaultIdentity: false,
        sidebar: false,
      },
    },
    {
      path: '/board/:boardId',
      name: 'board-editor',
      component: () => import('../views/BoardEditorView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'board',
        chromeStyle: 'immersive',
        immersive: true,
        requiresVaultIdentity: false,
        sidebar: false,
      },
    },
    {
      path: '/ledger',
      name: 'ledger',
      component: () => import('../views/LedgerView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'ledger',
        chromeStyle: 'workspace',
        sidebar: false,
      },
    },
    {
      path: '/ledger/transactions',
      name: 'ledger-transactions',
      component: () => import('../views/LedgerTransactionsView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'ledger',
        chromeStyle: 'workspace',
        sidebar: false,
      },
    },
    {
      path: '/ledger/accounts',
      name: 'ledger-accounts',
      component: () => import('../views/LedgerAccountsView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'ledger',
        chromeStyle: 'workspace',
        sidebar: false,
      },
    },
    {
      path: '/ledger/accounts/:id',
      name: 'ledger-account',
      component: () => import('../views/LedgerAccountDetailView.vue'),
      meta: {
        fullWidth: true,
        workspace: true,
        workspaceKind: 'ledger',
        chromeStyle: 'workspace',
        sidebar: false,
      },
    },
    {
      path: '/bills/transactions',
      redirect: (to) => ({ name: 'ledger-transactions', query: to.query, hash: to.hash }),
      meta: { fullWidth: true, workspace: true, sidebar: false },
    },
    {
      path: '/bills',
      redirect: (to) => ({ name: 'ledger', query: to.query, hash: to.hash }),
      meta: { fullWidth: true, workspace: true, sidebar: false },
    },
    { path: '/:pathMatch(.*)*', redirect: '/vault', meta: { workspace: true } },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})

const auth = useAuth()

function intendedRedirect(route: RouteLocationNormalized): string {
  return safeInternalRedirect(route.fullPath, '/vault')
}

function authRouteTarget(route: RouteLocationNormalized, name: 'login' | 'setup'): true | RouteLocationRaw {
  const redirect = safeInternalRedirect(route.query.redirect, '')
  const query: Record<string, string> = {}
  if (redirect) query.redirect = redirect
  // Keep the informational expiry notice while normalizing away every other
  // auth-page query value. The notice is never treated as an error or a
  // redirect target and is consumed by the LoginView after the next login.
  if (name === 'login' && route.query.reason === 'expired') query.reason = 'expired'

  const currentKeys = Object.keys(route.query)
  const targetKeys = Object.keys(query)
  const alreadyNormalized = route.name === name
    && currentKeys.length === targetKeys.length
    && targetKeys.every((key) => route.query[key] === query[key])
  if (alreadyNormalized) return true

  return Object.keys(query).length > 0
    ? { name, query }
    : { name }
}

router.beforeEach(async (to) => {
  if (to.meta.publicDevPreview) return true

  const state = await auth.ensureHydrated()
  // A failed status request remains recoverable through the App shell. Do not
  // mount either VaultView or an auth form based on untrusted/absent data.
  if (state === 'unknown') return false

  if (to.meta.authPage) {
    if (state === 'setup-required') {
      return authRouteTarget(to, 'setup')
    }
    if (state === 'unauthenticated') {
      return authRouteTarget(to, 'login')
    }
    if (state === 'authenticated') {
      return safeInternalRedirect(to.query.redirect, '/vault')
    }
    return false
  }

  if (to.meta.workspace) {
    if (state === 'setup-required') {
      return { name: 'setup', query: { redirect: intendedRedirect(to) } }
    }
    if (state === 'unauthenticated') {
      return { name: 'login', query: { redirect: intendedRedirect(to) } }
    }
    if (state === 'authenticated') {
      if (to.meta.requiresVaultIdentity === false) return true
      try {
        await ensureVaultIdentity()
        return true
      } catch {
        // Keep the intended workspace route in the URL while the App shell
        // exposes the recoverable identity retry surface. A 401 is observed
        // by authFetch and transitions auth to unauthenticated; in that case
        // the shared session-expiry observer owns the redirect.
        return auth.state.value !== 'unauthenticated'
      }
    }
  }
  return true
})

// The coordinator owns the state transition; the router owns the navigation
// side effect. This keeps the auth module free of a router import/cycle.
auth.onSessionExpired(() => {
  const current = router.currentRoute.value
  if (current.meta.authPage || current.meta.publicDevPreview) return
  const redirect = safeInternalRedirect(current.fullPath, '/vault')
  void router.replace({ name: 'login', query: { reason: 'expired', redirect } })
})

export default router
