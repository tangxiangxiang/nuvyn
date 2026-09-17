import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const image = process.env.DOCKER_IMAGE ?? 'nuvyn-ci-smoke'
const namespace = `nuvyn-vault-lifecycle-${process.pid}-${Date.now()}`
const setupToken = 'docker-lifecycle-test-token-0123456789abcdef'
const containers = new Set()
const hostUser = typeof process.getuid === 'function' && typeof process.getgid === 'function'
  ? `${process.getuid()}:${process.getgid()}`
  : null
const dockerUserArgs = hostUser ? ['--user', hostUser] : []
const composeUserConfig = hostUser ? `    user: "${hostUser}"\n` : ''

if (!image || /\s/.test(image)) {
  throw new Error('Docker Vault writer lifecycle test requires a valid local image reference')
}

async function docker(args, label) {
  try {
    return await execFileAsync('docker', args, { maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : ''
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const detail = [stdout, stderr].filter(Boolean).join('\n')
    throw new Error(`${label} failed${detail ? `:\n${detail}` : ''}`, { cause: error })
  }
}

async function inspect(container, format) {
  const { stdout } = await docker(['inspect', '--format', format, container], `inspect ${container}`)
  return stdout.trim()
}

async function containerState(container) {
  return inspect(container, '{{.State.Status}}')
}

async function waitForHealthy(container) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await containerState(container)
    if (state === 'exited' || state === 'dead') {
      const exitCode = await inspect(container, '{{.State.ExitCode}}')
      throw new Error(`${container} exited before becoming healthy (exit ${exitCode})`)
    }
    const health = await inspect(
      container,
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
    )
    if (health === 'healthy') return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${container} did not become healthy`)
}

async function waitForExited(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await containerState(container)
    if (state === 'exited' || state === 'dead') return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${container} did not exit`)
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function readOwner(ownerPath) {
  return JSON.parse(await readFile(ownerPath, 'utf8'))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function prepareStore(root, name) {
  const vault = path.join(root, `${name}-vault`)
  const data = path.join(root, `${name}-data`)
  await mkdir(vault, { recursive: true })
  await mkdir(data, { recursive: true })
  await chmod(vault, 0o777)
  await chmod(data, 0o777)
  return {
    vault,
    data,
    ownerPath: path.join(vault, '.nuvyn', 'vault-writer.json'),
  }
}

async function startContainer(name, store) {
  const { stdout } = await docker([
    'run', '-d', '--name', name,
    '--read-only',
    '--tmpfs', '/tmp:rw,mode=1777',
    ...dockerUserArgs,
    '-e', 'NODE_ENV=production',
    '-e', 'HOST=0.0.0.0',
    '-e', 'PORT=3000',
    '-e', 'NUVYN_PUBLIC_ORIGIN=http://127.0.0.1:3000',
    '-e', `NUVYN_SETUP_TOKEN=${setupToken}`,
    '--mount', `type=bind,src=${store.vault},dst=/app/src/content`,
    '--mount', `type=bind,src=${store.data},dst=/app/data`,
    image,
  ], `start ${name}`)
  assert(stdout.trim().length > 0, `${name} did not return a container id`)
  containers.add(name)
  return stdout.trim()
}

async function removeContainer(name) {
  if (!containers.has(name)) return
  try {
    await docker(['rm', '-f', name], `remove ${name}`)
    containers.delete(name)
  } catch {
    // Leave it tracked so the outer finally block gets one more cleanup try.
  }
}

async function stopGracefully(name) {
  await docker(['stop', '--timeout', '10', name], `stop ${name}`)
  const exitCode = Number(await inspect(name, '{{.State.ExitCode}}'))
  assert(exitCode === 0, `${name} graceful stop exited with ${exitCode}`)
}

async function assertOwnerMatchesContainer(name, ownerPath) {
  const hostname = await inspect(name, '{{.Config.Hostname}}')
  const owner = await readOwner(ownerPath)
  assert(owner.host === hostname, `${name} owner host does not match its Docker hostname`)
  assert(Number.isSafeInteger(owner.pid) && owner.pid > 0, `${name} owner pid is invalid`)
  assert(typeof owner.nonce === 'string' && owner.nonce.length > 0, `${name} owner nonce is invalid`)
  assert(!Number.isNaN(Date.parse(owner.startedAt)), `${name} owner startedAt is invalid`)
  return { hostname, owner }
}

async function assertDirectNodeTopology(name) {
  const { stdout } = await docker(
    ['top', name, '-eo', 'pid,ppid,comm,args'],
    `inspect process tree for ${name}`,
  )
  assert(stdout.includes('/usr/bin/tini -- node --import tsx server/prod.ts'), 'tini is not supervising Nuvyn Node directly')
  assert(!/\bnpm\b/.test(stdout), 'production process tree unexpectedly contains npm')
  assert(!/\bsh -c\b/.test(stdout), 'production process tree unexpectedly contains a shell launcher')
  return stdout.trim()
}

async function testGracefulStopAndNewHostname(root, evidence) {
  const store = await prepareStore(root, 'graceful')
  const oldName = `${namespace}-graceful-old`
  const newName = `${namespace}-graceful-new`

  await startContainer(oldName, store)
  await waitForHealthy(oldName)
  const old = await assertOwnerMatchesContainer(oldName, store.ownerPath)
  evidence.processTree = await assertDirectNodeTopology(oldName)
  evidence.oldHostname = old.hostname
  evidence.oldOwnerPid = old.owner.pid
  evidence.oldStartedAt = old.owner.startedAt

  await stopGracefully(oldName)
  assert(!(await exists(store.ownerPath)), 'graceful stop left vault-writer.json behind')
  evidence.gracefulOwnerRemoved = true

  await startContainer(newName, store)
  await waitForHealthy(newName)
  const replacement = await assertOwnerMatchesContainer(newName, store.ownerPath)
  assert(replacement.hostname !== old.hostname, 'replacement unexpectedly reused the old Docker hostname')
  assert(replacement.owner.nonce !== old.owner.nonce, 'replacement unexpectedly reused the old owner nonce')
  evidence.newHostname = replacement.hostname
  evidence.newOwnerPid = replacement.owner.pid

  await stopGracefully(newName)
  assert(!(await exists(store.ownerPath)), 'replacement graceful stop left vault-writer.json behind')
  await removeContainer(oldName)
  await removeContainer(newName)
}

async function testComposeForceRecreate(root, evidence) {
  const store = await prepareStore(root, 'compose')
  const composeFile = path.join(root, 'compose.lifecycle.yml')
  const project = `${namespace}-compose`
  const composeArgs = ['compose', '--project-name', project, '--file', composeFile]
  let composeStarted = false

  await writeFile(composeFile, `services:\n  nuvyn:\n    image: ${JSON.stringify(image)}\n    pull_policy: never\n    read_only: true\n${composeUserConfig}    tmpfs:\n      - /tmp:rw,mode=1777\n    environment:\n      NODE_ENV: production\n      HOST: 0.0.0.0\n      PORT: \"3000\"\n      NUVYN_PUBLIC_ORIGIN: http://127.0.0.1:3000\n      NUVYN_SETUP_TOKEN: ${setupToken}\n    volumes:\n      - type: bind\n        source: ${JSON.stringify(store.vault)}\n        target: /app/src/content\n      - type: bind\n        source: ${JSON.stringify(store.data)}\n        target: /app/data\n`, 'utf8')

  try {
    await docker([...composeArgs, 'up', '-d'], 'initial Compose startup')
    composeStarted = true
    const firstId = (await docker([...composeArgs, 'ps', '-q', 'nuvyn'], 'find initial Compose container')).stdout.trim()
    assert(firstId.length > 0, 'Compose did not create the initial container')
    await waitForHealthy(firstId)
    const first = await assertOwnerMatchesContainer(firstId, store.ownerPath)

    await docker([...composeArgs, 'up', '-d', '--force-recreate', 'nuvyn'], 'Compose force-recreate')
    const secondId = (await docker([...composeArgs, 'ps', '-q', 'nuvyn'], 'find replacement Compose container')).stdout.trim()
    assert(secondId.length > 0 && secondId !== firstId, 'Compose did not replace the container')
    await waitForHealthy(secondId)
    const second = await assertOwnerMatchesContainer(secondId, store.ownerPath)
    assert(second.hostname !== first.hostname, 'Compose replacement reused the old Docker hostname')
    assert(second.owner.nonce !== first.owner.nonce, 'Compose replacement reused the old owner nonce')

    evidence.composeOldHostname = first.hostname
    evidence.composeNewHostname = second.hostname
    evidence.composeReplacementHealthy = true

    await docker([...composeArgs, 'down', '--timeout', '10', '--remove-orphans'], 'Compose shutdown')
    composeStarted = false
    assert(!(await exists(store.ownerPath)), 'Compose shutdown left vault-writer.json behind')
  } finally {
    if (composeStarted) {
      try {
        await docker([...composeArgs, 'down', '--timeout', '10', '--remove-orphans'], 'Compose cleanup')
      } catch {
        // Cleanup remains best effort so the primary assertion is preserved.
      }
    }
  }
}

async function testSigkillFailsClosed(root, evidence) {
  const store = await prepareStore(root, 'sigkill')
  const oldName = `${namespace}-sigkill-old`
  const newName = `${namespace}-sigkill-new`

  await startContainer(oldName, store)
  await waitForHealthy(oldName)
  const old = await assertOwnerMatchesContainer(oldName, store.ownerPath)

  await docker(['kill', '--signal=KILL', oldName], `SIGKILL ${oldName}`)
  await waitForExited(oldName)
  assert(await exists(store.ownerPath), 'SIGKILL unexpectedly removed vault-writer.json')
  const stale = await readOwner(store.ownerPath)
  assert(stale.nonce === old.owner.nonce, 'SIGKILL changed the stale owner nonce')
  await removeContainer(oldName)

  await startContainer(newName, store)
  await waitForExited(newName)
  const newHostname = await inspect(newName, '{{.Config.Hostname}}')
  const exitCode = Number(await inspect(newName, '{{.State.ExitCode}}'))
  assert(newHostname !== old.hostname, 'SIGKILL replacement reused the old Docker hostname')
  assert(exitCode !== 0, 'cross-host stale owner did not fail startup closed')
  const { stdout, stderr } = await docker(['logs', newName], `read fail-closed logs for ${newName}`)
  const logs = `${stdout}\n${stderr}`
  assert(/Vault writer is owned by host/.test(logs), 'cross-host ownership failure was not observable')
  const preserved = await readOwner(store.ownerPath)
  assert(preserved.nonce === stale.nonce && preserved.host === stale.host, 'failed replacement changed the stale owner')

  evidence.sigkillHostname = old.hostname
  evidence.sigkillReplacementHostname = newHostname
  evidence.sigkillExitCode = exitCode
  evidence.sigkillOwnerPreserved = true
  await removeContainer(newName)
}

async function run() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nuvyn-vault-writer-lifecycle-'))
  const evidence = {}
  try {
    await testGracefulStopAndNewHostname(root, evidence)
    console.log('[nuvyn] PASS graceful stop releases owner')
    console.log('[nuvyn] PASS replacement acquires with a new Docker hostname')

    await testComposeForceRecreate(root, evidence)
    console.log('[nuvyn] PASS Compose force-recreate releases and reacquires owner')

    await testSigkillFailsClosed(root, evidence)
    console.log('[nuvyn] PASS SIGKILL preserves stale owner and cross-host startup fails closed')

    console.log(`[nuvyn] process tree evidence:\n${evidence.processTree}`)
    console.log(`[nuvyn] lifecycle evidence: ${JSON.stringify(evidence)}`)
  } finally {
    for (const name of [...containers]) await removeContainer(name)
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Docker Vault writer lifecycle test failed')
  process.exitCode = 1
})
