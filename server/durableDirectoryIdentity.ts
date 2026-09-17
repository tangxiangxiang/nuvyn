import { promises as fs } from 'node:fs'
import type { BigIntStats } from 'node:fs'

export type DurableDirectoryIdentity = {
  dev: string
  ino: string
  birthtimeNs: string
}

const DECIMAL_RE = /^\d+$/
const POSITIVE_DECIMAL_RE = /^[1-9]\d*$/

export function isDurableDirectoryIdentity(
  value: unknown,
): value is DurableDirectoryIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as Partial<DurableDirectoryIdentity>
  return typeof identity.dev === 'string'
    && DECIMAL_RE.test(identity.dev)
    && typeof identity.ino === 'string'
    && POSITIVE_DECIMAL_RE.test(identity.ino)
    && typeof identity.birthtimeNs === 'string'
    && POSITIVE_DECIMAL_RE.test(identity.birthtimeNs)
}

export function matchesDurableDirectoryIdentity(
  stat: BigIntStats,
  expected: DurableDirectoryIdentity,
): boolean {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.dev.toString() === expected.dev
    && stat.ino.toString() === expected.ino
    && stat.birthtimeNs.toString() === expected.birthtimeNs
}

export async function captureDurableDirectoryIdentity(
  directoryAbs: string,
): Promise<DurableDirectoryIdentity> {
  let stat: BigIntStats
  try {
    stat = await fs.lstat(directoryAbs, { bigint: true })
  } catch (error) {
    throw new Error(
      'folder move filesystem lacks stable directory birthtime identity',
      { cause: error },
    )
  }
  const identity = {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  }
  if (!matchesDurableDirectoryIdentity(stat, identity)
    || !isDurableDirectoryIdentity(identity)) {
    throw new Error(
      'folder move filesystem lacks stable directory birthtime identity',
    )
  }
  return identity
}
