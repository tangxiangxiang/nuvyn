import {
  spawn,
  type ChildProcess,
} from 'node:child_process'

export type ChildExitEvidence = {
  code: number | null
  signal: NodeJS.Signals | null
}

const childClosePromises =
  new WeakMap<ChildProcess, Promise<ChildExitEvidence>>()

export function waitForChildClose(
  child: ChildProcess,
): Promise<ChildExitEvidence> {
  const existing = childClosePromises.get(child)
  if (existing) return existing

  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    })
  }

  const closePromise = new Promise<ChildExitEvidence>((resolve, reject) => {
    const onError = (error: Error): void => {
      child.off('close', onClose)
      reject(error)
    }
    const onClose = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      child.off('error', onError)
      resolve({ code, signal })
    }

    child.once('error', onError)
    child.once('close', onClose)
  })
  childClosePromises.set(child, closePromise)
  return closePromise
}

async function taskkillTree(pid: number): Promise<string | null> {
  const killer = spawn(
    'taskkill',
    [
      '/PID',
      String(pid),
      '/T',
      '/F',
    ],
    {
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  const result = await waitForChildClose(killer)
  if (result.code !== 0 && result.code !== 128) {
    return `taskkill exited with code ${result.code} and signal ${result.signal}`
  }
  return null
}

async function killPosixProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return

  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') throw error
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: {
    timeoutMs: number
  },
): Promise<ChildExitEvidence> {
  const closePromise = waitForChildClose(child)
  if (child.exitCode !== null || child.signalCode !== null) {
    return closePromise
  }

  let terminationDiagnostic: string | null = null
  if (process.platform === 'win32') {
    if (child.pid) terminationDiagnostic = await taskkillTree(child.pid)
  } else {
    await killPosixProcessGroup(child)
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const diagnostic = terminationDiagnostic
        ? ` (${terminationDiagnostic})`
        : ''
      reject(new Error(
        `process tree did not close within ${options.timeoutMs}ms${diagnostic}`,
      ))
    }, options.timeoutMs)
  })

  try {
    return await Promise.race([
      closePromise,
      timeoutPromise,
    ])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
