import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const TSX_CLI = fileURLToPath(import.meta.resolve('tsx/cli'))
const GRANDCHILD_FIXTURE = path.join(
  import.meta.dirname,
  'process-tree-lock-grandchild.ts',
)

const grandchild = spawn(
  process.execPath,
  [
    TSX_CLI,
    GRANDCHILD_FIXTURE,
  ],
  {
    env: process.env,
    stdio: [
      'ignore',
      'inherit',
      'inherit',
    ],
    windowsHide: true,
  },
)

grandchild.once('error', (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exit(1)
})

setInterval(
  () => {},
  1_000,
)
