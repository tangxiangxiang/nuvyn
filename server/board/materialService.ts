import type { Database as DatabaseT } from 'better-sqlite3'
import type { BoardMaterial } from '../../shared/boardMaterialProtocol.js'
import { BoardMaterialError } from './materialErrors.js'
import { createBoardMaterialRepository, type BoardMaterialRepository } from './materialRepository.js'
import {
  assertBoardMaterialId,
  assertBoardMaterialTimestamp,
  createBoardMaterialId,
  normalizeBoardMaterialName,
  normalizeBoardMaterialSvg,
} from './materialValidation.js'

export interface BoardMaterialServiceDependencies {
  readonly now?: () => number
  readonly createId?: () => string
  readonly repository?: BoardMaterialRepository
}

export class BoardMaterialService {
  private readonly repository: BoardMaterialRepository
  private readonly now: () => number
  private readonly createId: () => string

  constructor(db: DatabaseT, dependencies: BoardMaterialServiceDependencies = {}) {
    this.repository = dependencies.repository ?? createBoardMaterialRepository(db)
    this.now = dependencies.now ?? Date.now
    this.createId = dependencies.createId ?? createBoardMaterialId
  }

  list(archived = false): BoardMaterial[] {
    return this.repository.list(archived)
  }

  create(input: { readonly name?: unknown; readonly svg?: unknown }): BoardMaterial {
    const name = normalizeBoardMaterialName(input.name)
    const svg = normalizeBoardMaterialSvg(input.svg)
    const id = assertBoardMaterialId(this.createId())
    return this.repository.create(id, name, svg, this.nextTimestamp())
  }

  rename(id: string, name: unknown): BoardMaterial {
    return this.repository.rename(
      assertBoardMaterialId(id),
      normalizeBoardMaterialName(name),
      this.nextTimestamp(),
    )
  }

  archive(id: string): BoardMaterial {
    return this.repository.setArchived(assertBoardMaterialId(id), true, this.nextTimestamp())
  }

  restore(id: string): BoardMaterial {
    return this.repository.setArchived(assertBoardMaterialId(id), false, this.nextTimestamp())
  }

  delete(id: string): { readonly deleted: true } {
    if (!this.repository.deleteArchived(assertBoardMaterialId(id))) {
      throw new BoardMaterialError('BOARD_MATERIAL_NOT_FOUND', 404, 'Board material was not found')
    }
    return { deleted: true }
  }

  private nextTimestamp(): number {
    return assertBoardMaterialTimestamp(this.now())
  }
}

export function createBoardMaterialService(
  db: DatabaseT,
  dependencies: BoardMaterialServiceDependencies = {},
): BoardMaterialService {
  return new BoardMaterialService(db, dependencies)
}
