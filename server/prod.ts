// Production entry point. The dev server (server/vite-plugin.ts)
// mounts the Hono app on Vite's middleware; in production we run a
// real Node HTTP server via @hono/node-server, serve the Vite build
// output as static assets, and fall back to index.html for SPA routes
// (the router has a catch-all splat for /vault/:pathMatch(.*)*).
//
// Run with `tsx server/prod.ts` (or compile to JS first).
import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import app from './index.ts'
import { CONTENT_DIR } from './paths.ts'
import { ensureInitialFolders } from './seed.ts'
import { getDb } from './db.ts'
import { migrateVaultMetadata } from './metadataMigration.ts'
import { initializeTagIdentityAndHealth } from './tagIdentityMigration.ts'
import { initializeTagUndoFoundationHealth } from './tagUndoHealth.ts'
import { recoverInterruptedOperations } from './crashRecovery.ts'
import { reconcileHistoryMetadata } from './history/metadataRevisions.ts'
import {
  acquireVaultWriterOwnership,
  installVaultWriterShutdownHandlers,
} from './vaultWriterOwnership.ts'
import { resolveAuthOrigin, resolveServerHost } from './prodConfig.ts'
import { loadAuthConfig } from './auth/config.ts'
import { initializeAuthRuntime } from './auth/runtime.ts'
import { getDiaryMigrationService } from './diaryMigration/service.ts'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = resolveServerHost()
const AUTH_ORIGIN = resolveAuthOrigin(process.env, PORT, HOST)
const DIST_DIR = path.resolve(process.cwd(), 'dist')

// Cached index.html so the SPA fallback is cheap on every navigation.
let indexHtmlCache: string | null = null
async function getIndexHtml(): Promise<string> {
  if (indexHtmlCache) return indexHtmlCache
  indexHtmlCache = await readFile(path.join(DIST_DIR, 'index.html'), 'utf8')
  return indexHtmlCache
}

// /assets/* and other static files come straight off disk. Everything
// else that isn't /api/* falls through to index.html so vue-router's
// HTML5 history mode (createWebHistory) keeps working after a refresh.
app.use(
  '/*',
  serveStatic({
    root: path.relative(process.cwd(), DIST_DIR) || '.',
  }),
)
app.get('*', async (c) => {
  // Already handled by serveStatic above if a real file matched; this
  // catches SPA paths like /vault/inbox/foo that have no on-disk file.
  if (c.req.path.startsWith('/api/')) return c.notFound()
  const html = await getIndexHtml()
  return c.html(html)
})

// Lifetime ownership is acquired before any startup mutation or listener.
const writerOwnership = await acquireVaultWriterOwnership(CONTENT_DIR)
try {
  // Seed the four vault root folders (inbox / literature / archive / diary)
  // before the HTTP server starts accepting requests. Idempotent — existing
  // folders and files are left alone; only missing roots are created.
  // See server/seed.ts for the rationale.
  await ensureInitialFolders(CONTENT_DIR)
  console.log(`[nuvyn] content dir: ${CONTENT_DIR}`)

  // Authentication is intentionally initialized as a narrow dependency seam
  // in Phase 2. The global application boundary remains disabled until the
  // later atomic cutover; auth routes can still use this runtime safely.
  initializeAuthRuntime({
    db: getDb(),
    config: loadAuthConfig({ ...process.env, NUVYN_PUBLIC_ORIGIN: AUTH_ORIGIN }),
    env: process.env,
  })

  // Reconcile operations interrupted by a previous crash (kill -9, power
  // loss, container stop) BEFORE the server accepts a single request.
  const recovery = await recoverInterruptedOperations(CONTENT_DIR, getDb())
  if (recovery.actions.length > 0) {
    console.log(`[nuvyn] crash recovery: resolved ${recovery.actions.length} interrupted operation(s)`)
    for (const action of recovery.actions) {
      console.log(`[nuvyn] crash recovery: ${action.action} ${action.file}${action.detail ? ` (${action.detail})` : ''}`)
    }
  }
  const diaryMigrationRecovery = await getDiaryMigrationService(getDb(), CONTENT_DIR).recover()
  if (diaryMigrationRecovery.actions.length > 0) {
    console.log(`[nuvyn] Diary migration recovery: ${JSON.stringify(diaryMigrationRecovery)}`)
  }
  // Reconcile the generic History metadata journal after filesystem crash
  // recovery and before the server accepts requests. An unresolved
  // cross-store state fails startup closed instead of being guessed by a
  // later History request.
  await reconcileHistoryMetadata(getDb(), CONTENT_DIR)
  // Only scan live vault metadata after crash recovery has restored every
  // formal path. Otherwise an interrupted takeover can be misclassified
  // as an orphan during this very startup.
  const metadataReport = await migrateVaultMetadata(getDb(), CONTENT_DIR)
  console.log(`[nuvyn] metadata migration: ${JSON.stringify(metadataReport)}`)
  const tagIdentityHealth = await initializeTagIdentityAndHealth(getDb(), CONTENT_DIR, metadataReport)
  console.log(`[nuvyn] tag identity health: ${JSON.stringify(tagIdentityHealth)}`)
  const tagUndoFoundationHealth = initializeTagUndoFoundationHealth(getDb())
  console.log(`[nuvyn] tag Undo foundation health: ${JSON.stringify(tagUndoFoundationHealth)}`)

  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[nuvyn] listening on http://${info.address}:${info.port}`)
  })
  const removeSignalHandlers = installVaultWriterShutdownHandlers(
    writerOwnership,
    () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  )
  server.once('close', () => {
    removeSignalHandlers()
    void writerOwnership.release()
  })
} catch (error) {
  await writerOwnership.release()
  throw error
}
