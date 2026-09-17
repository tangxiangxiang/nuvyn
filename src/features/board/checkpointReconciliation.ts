import type { BoardScene, BoardSceneRecord } from '../../../shared/boardProtocol'
import type { BoardCheckpoint } from './recoveryTypes'

export interface ReconcileBoardCheckpointInput {
  serverRecord: BoardSceneRecord
  checkpoint: BoardCheckpoint | null
  validateScene?: (scene: BoardScene) => void
}

export type BoardCheckpointReconciliation =
  | { kind: 'server'; scene: BoardScene }
  | { kind: 'recover-local'; scene: BoardScene; checkpoint: BoardCheckpoint }
  | { kind: 'conflict'; scene: BoardScene; checkpoint: BoardCheckpoint }
  | { kind: 'invalid'; reason: BoardCheckpointInvalidReason }

export type BoardCheckpointInvalidReason =
  | 'board-id-mismatch'
  | 'scene-version-invalid'
  | 'revision-invalid'
  | 'saved-at-invalid'
  | 'scene-invalid'
  | 'checkpoint-ahead'

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function reconcileBoardCheckpoint(
  input: ReconcileBoardCheckpointInput,
): BoardCheckpointReconciliation {
  const { serverRecord, checkpoint, validateScene } = input
  if (!checkpoint) return { kind: 'server', scene: serverRecord.scene }

  if (checkpoint.boardId !== serverRecord.boardId) return { kind: 'invalid', reason: 'board-id-mismatch' }
  if (checkpoint.sceneVersion !== serverRecord.sceneVersion) return { kind: 'invalid', reason: 'scene-version-invalid' }
  if (!isNonNegativeInteger(checkpoint.baseRevision)
    || !isNonNegativeInteger(checkpoint.localRevision)) {
    return { kind: 'invalid', reason: 'revision-invalid' }
  }
  if (typeof checkpoint.savedAt !== 'number' || !Number.isFinite(checkpoint.savedAt) || checkpoint.savedAt < 0) {
    return { kind: 'invalid', reason: 'saved-at-invalid' }
  }
  try {
    validateScene?.(checkpoint.scene)
  } catch {
    return { kind: 'invalid', reason: 'scene-invalid' }
  }

  if (checkpoint.baseRevision > serverRecord.revision) {
    return { kind: 'invalid', reason: 'checkpoint-ahead' }
  }
  if (checkpoint.baseRevision < serverRecord.revision) {
    return { kind: 'conflict', scene: checkpoint.scene, checkpoint }
  }
  return { kind: 'recover-local', scene: checkpoint.scene, checkpoint }
}
