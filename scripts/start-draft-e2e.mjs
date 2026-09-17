import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2] ?? '4175'
const tempRoot = path.resolve(os.tmpdir())
const vault = process.env.NUVYN_DRAFT_E2E_VAULT ?? path.join(tempRoot, `nuvyn-e2e-vault-${port}`)
const dbPath = process.env.NUVYN_E2E_DB_PATH ?? path.join(tempRoot, `nuvyn-e2e-db-${port}`, 'data', 'nuvyn.db')

function assertTestOwnedTempPath(value, label) {
  const resolved = path.resolve(value)
  if (!resolved.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`${label} must be inside the OS temporary directory for E2E isolation`)
  }
  return resolved
}

const isolatedVault = assertTestOwnedTempPath(vault, 'NUVYN_DRAFT_E2E_VAULT')
const isolatedDb = assertTestOwnedTempPath(dbPath, 'NUVYN_E2E_DB_PATH')
await fs.rm(isolatedVault, { recursive: true, force: true })
// Remove only the isolated database files. Never recursively remove a
// repository data directory: authenticated setup must not touch a developer
// database, and cleanup must remain narrowly test-owned.
for (const suffix of ['', '-wal', '-shm']) {
  await fs.rm(`${isolatedDb}${suffix}`, { force: true })
}
await fs.mkdir(path.dirname(isolatedDb), { recursive: true })
for (const folder of ['inbox', 'archive', 'literature']) {
  await fs.mkdir(path.join(isolatedVault, folder), { recursive: true })
}

const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port], {
  env: {
    ...process.env,
    VAULT_DIR: isolatedVault,
    NUVYN_E2E_DB_PATH: isolatedDb,
    NUVYN_PUBLIC_ORIGIN: process.env.NUVYN_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
    NUVYN_SETUP_TOKEN: process.env.NUVYN_SETUP_TOKEN ?? 'nuvyn-e2e-setup-token-0123456789abcdef',
  },
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
