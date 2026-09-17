import { describe, expect, it } from 'vitest'
import { reconcileBoardCheckpoint } from '../checkpointReconciliation'
import type { BoardCheckpoint } from '../recoveryTypes'
import type { BoardSceneRecord } from '../../../../shared/boardProtocol'

const scene = { engineData: { elements: [], fileMap: {} }, persistentAppState: {}, assetRefs: [] }

function record(revision = 3): BoardSceneRecord {
  return { boardId: 'board-a', engine: 'excalidraw', sceneVersion: 1, revision, scene }
}

function checkpoint(overrides: Partial<BoardCheckpoint> = {}): BoardCheckpoint {
  return { boardId: 'board-a', sceneVersion: 1, baseRevision: 3, localRevision: 5, scene, savedAt: 10, ...overrides }
}

describe('Board checkpoint reconciliation', () => {
  it('uses the server scene when no checkpoint exists', () => {
    expect(reconcileBoardCheckpoint({ serverRecord: record(), checkpoint: null })).toEqual({ kind: 'server', scene })
  })

  it('recovers a checkpoint based on the same server revision', () => {
    expect(reconcileBoardCheckpoint({ serverRecord: record(3), checkpoint: checkpoint() })).toMatchObject({ kind: 'recover-local' })
  })

  it('enters recovery conflict when the server is ahead', () => {
    expect(reconcileBoardCheckpoint({ serverRecord: record(4), checkpoint: checkpoint() })).toMatchObject({ kind: 'conflict' })
  })

  it('fails closed when the checkpoint base is ahead or the scene is invalid', () => {
    expect(reconcileBoardCheckpoint({ serverRecord: record(3), checkpoint: checkpoint({ baseRevision: 4 }) })).toEqual({ kind: 'invalid', reason: 'checkpoint-ahead' })
    expect(reconcileBoardCheckpoint({ serverRecord: record(), checkpoint: checkpoint(), validateScene: () => { throw new Error('bad') } })).toEqual({ kind: 'invalid', reason: 'scene-invalid' })
  })

  it('rejects future scene versions and malformed revisions', () => {
    expect(reconcileBoardCheckpoint({ serverRecord: record(), checkpoint: checkpoint({ sceneVersion: 2 }) })).toEqual({ kind: 'invalid', reason: 'scene-version-invalid' })
    expect(reconcileBoardCheckpoint({ serverRecord: record(), checkpoint: checkpoint({ localRevision: -1 }) })).toEqual({ kind: 'invalid', reason: 'revision-invalid' })
  })
})
