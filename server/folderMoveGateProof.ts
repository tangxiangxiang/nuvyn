import { promises as fs } from 'node:fs'
import path from 'node:path'

import { syncParentDirectoryBestEffort } from './atomicTextWrite.js'
import { writeCreateOnlyDurableFile } from './durableCreateOnlyFile.js'
import type { FolderMoveGateProof } from './folderMoveTransaction.js'

export function folderMoveGateMarkerAbs(
  destinationAbs: string,
  proof: FolderMoveGateProof,
): string {
  return path.join(destinationAbs, proof.markerName)
}

export async function writeFolderMoveGateProof(
  destinationAbs: string,
  proof: FolderMoveGateProof,
): Promise<void> {
  const markerAbs = folderMoveGateMarkerAbs(destinationAbs, proof)
  await writeCreateOnlyDurableFile(markerAbs, proof.secret, { mode: 0o600 })
}

export async function verifyFolderMoveGateProof(
  destinationAbs: string,
  proof: FolderMoveGateProof,
): Promise<boolean> {
  const markerAbs = folderMoveGateMarkerAbs(destinationAbs, proof)
  try {
    const stat = await fs.lstat(markerAbs)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    return await fs.readFile(markerAbs, 'utf8') === proof.secret
  } catch {
    return false
  }
}

export async function removeFolderMoveGateProof(
  destinationAbs: string,
  proof: FolderMoveGateProof,
): Promise<void> {
  const markerAbs = folderMoveGateMarkerAbs(destinationAbs, proof)
  if (!await verifyFolderMoveGateProof(destinationAbs, proof)) {
    throw new Error(`folder move gate proof is missing or mismatched: ${markerAbs}`)
  }
  await fs.rm(markerAbs, { force: true })
  await syncParentDirectoryBestEffort(markerAbs)
}
