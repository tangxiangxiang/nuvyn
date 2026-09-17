// Load .env into process.env BEFORE the Hono app reads it. Vite's
// default .env handling only exposes VITE_* vars to the client
// build; server-side process.env stays empty without this.
import dotenv from 'dotenv'
dotenv.config({ override: true })
import type { Plugin } from 'vite'
import app from './index.ts'
import { CONTENT_DIR } from './paths.ts'
import { ensureInitialFolders } from './seed.ts'
import { getDb } from './db.ts'
import { loadAuthConfig } from './auth/config.ts'
import { initializeAuthRuntime } from './auth/runtime.ts'
import { getDiaryMigrationService } from './diaryMigration/service.ts'
import { readCanonicalEnv } from './env.ts'
import { migrateVaultMetadata } from './metadataMigration.ts'
import { initializeTagIdentityAndHealth } from './tagIdentityMigration.ts'
import { initializeTagUndoFoundationHealth } from './tagUndoHealth.ts'
import { recoverInterruptedOperations } from './crashRecovery.ts'
import { reconcileHistoryMetadata } from './history/metadataRevisions.ts'
import {
  acquireVaultWriterOwnership,
  installVaultWriterShutdownHandlers,
} from './vaultWriterOwnership.ts'

export function serverPlugin(): Plugin {
  return {
    name: 'nuvyn-server',
    async configureServer(server) {
      const writerOwnership = await acquireVaultWriterOwnership(CONTENT_DIR)
      try {
        // Keep dev startup on the same root initialization contract as
        // production. Seed is idempotent and runs before auth, recovery,
        // and metadata scans can observe the vault.
        await ensureInitialFolders(CONTENT_DIR)
        // Reconcile operations interrupted by a previous crash BEFORE any
        // /api request is served (see server/crashRecovery.ts). Never throws.
        const authOrigin = readCanonicalEnv(process.env, 'NUVYN_PUBLIC_ORIGIN') ?? 'http://localhost:5173'
        initializeAuthRuntime({
          db: getDb(),
          config: loadAuthConfig({ ...process.env, NUVYN_PUBLIC_ORIGIN: authOrigin }),
          env: process.env,
        })
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
        // Keep development startup aligned with production: unresolved
        // generic History metadata journals fail closed before any request
        // can observe an unproven cross-store state.
        await reconcileHistoryMetadata(getDb(), CONTENT_DIR)
        const report = await migrateVaultMetadata(getDb(), CONTENT_DIR)
        console.log(`[nuvyn] metadata migration: ${JSON.stringify(report)}`)
        const tagIdentityHealth = await initializeTagIdentityAndHealth(getDb(), CONTENT_DIR, report)
        console.log(`[nuvyn] tag identity health: ${JSON.stringify(tagIdentityHealth)}`)
        const tagUndoFoundationHealth = initializeTagUndoFoundationHealth(getDb())
        console.log(`[nuvyn] tag Undo foundation health: ${JSON.stringify(tagUndoFoundationHealth)}`)
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith('/api/')) return next()
          const url = `http://localhost${req.url}`
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) {
            if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv))
            else if (v != null) headers.set(k, String(v))
          }
          const method = req.method ?? 'GET'
          let body: Buffer | undefined
          if (method !== 'GET' && method !== 'HEAD' && req.readable) {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(chunk as Buffer)
            // Keep truly bodyless mutations bodyless. Constructing a Request
            // with Buffer.alloc(0) creates an empty ReadableStream, which the
            // auth boundary would otherwise classify as a JSON body and
            // reject a normal DELETE without Content-Type.
            if (chunks.length > 0) body = Buffer.concat(chunks)
          }
          const fetchReq = new Request(url, {
            method,
            headers,
            body: body as any,
          })
          const fetchRes = await app.fetch(fetchReq)
          res.statusCode = fetchRes.status
          fetchRes.headers.forEach((v, k) => res.setHeader(k, v))
          if (fetchRes.body) {
            const buf = Buffer.from(await fetchRes.arrayBuffer())
            res.end(buf)
          } else {
            res.end()
          }
        })
        const stopServing = typeof server.close === 'function'
          ? () => Promise.resolve(server.close()).then(() => {})
          : async () => {}
        const removeSignalHandlers = installVaultWriterShutdownHandlers(
          writerOwnership,
          stopServing,
        )
        server.httpServer?.once('close', () => {
          removeSignalHandlers()
          void writerOwnership.release()
        })
      } catch (error) {
        await writerOwnership.release()
        throw error
      }
    },
  }
}
