import type { Database as DatabaseT } from 'better-sqlite3'
import type { BoardMaterial } from '../../shared/boardMaterialProtocol.js'
import { BoardMaterialError } from './materialErrors.js'
import { assertBoardMaterialId } from './materialValidation.js'

interface BoardMaterialRow {
  id: string
  name: string
  kind: string
  content: string
  archived: number
  created_at: number
  updated_at: number
}

export interface BoardMaterialRepository {
  list(archived: boolean): BoardMaterial[]
  get(id: string): BoardMaterial | null
  create(id: string, name: string, svg: string, createdAt: number): BoardMaterial
  rename(id: string, name: string, updatedAt: number): BoardMaterial
  setArchived(id: string, archived: boolean, updatedAt: number): BoardMaterial
  deleteArchived(id: string): boolean
}

function runImmediate<T>(db: DatabaseT, callback: () => T): T {
  if (db.inTransaction) return callback()
  return db.transaction(callback).immediate()
}

function materialFromRow(row: BoardMaterialRow): BoardMaterial {
  if (row.kind !== 'svg' || row.archived !== 0 && row.archived !== 1) {
    throw new BoardMaterialError('BOARD_MATERIAL_STORAGE_ERROR', 500, 'Board material row is invalid')
  }
  return {
    id: row.id,
    name: row.name,
    kind: 'svg',
    svg: row.content,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteBoardMaterialRepository implements BoardMaterialRepository {
  private readonly db: DatabaseT

  constructor(db: DatabaseT) {
    this.db = db
  }

  list(archived: boolean): BoardMaterial[] {
    const rows = this.db.prepare(`
      SELECT id, name, kind, content, archived, created_at, updated_at
      FROM board_materials
      WHERE archived = ?
      ORDER BY updated_at DESC, id DESC
    `).all(archived ? 1 : 0) as BoardMaterialRow[]
    return rows.map(materialFromRow)
  }

  get(id: string): BoardMaterial | null {
    const materialId = assertBoardMaterialId(id)
    const row = this.db.prepare(`
      SELECT id, name, kind, content, archived, created_at, updated_at
      FROM board_materials
      WHERE id = ?
    `).get(materialId) as BoardMaterialRow | undefined
    return row ? materialFromRow(row) : null
  }

  create(id: string, name: string, svg: string, createdAt: number): BoardMaterial {
    const materialId = assertBoardMaterialId(id)
    runImmediate(this.db, () => {
      this.db.prepare(`
        INSERT INTO board_materials (id, name, kind, content, archived, created_at, updated_at)
        VALUES (@id, @name, 'svg', @content, 0, @createdAt, @updatedAt)
      `).run({ id: materialId, name, content: svg, createdAt, updatedAt: createdAt })
    })
    const material = this.get(materialId)
    if (!material) throw new BoardMaterialError('BOARD_MATERIAL_STORAGE_ERROR', 500, 'Material disappeared after creation')
    return material
  }

  rename(id: string, name: string, updatedAt: number): BoardMaterial {
    const materialId = assertBoardMaterialId(id)
    runImmediate(this.db, () => {
      const result = this.db.prepare(`
        UPDATE board_materials
        SET name = @name, updated_at = @updatedAt
        WHERE id = @id
      `).run({ id: materialId, name, updatedAt })
      if (result.changes !== 1) {
        throw new BoardMaterialError('BOARD_MATERIAL_NOT_FOUND', 404, 'Board material was not found')
      }
    })
    const material = this.get(materialId)
    if (!material) throw new BoardMaterialError('BOARD_MATERIAL_STORAGE_ERROR', 500, 'Material disappeared after rename')
    return material
  }

  setArchived(id: string, archived: boolean, updatedAt: number): BoardMaterial {
    const materialId = assertBoardMaterialId(id)
    runImmediate(this.db, () => {
      const result = this.db.prepare(`
        UPDATE board_materials
        SET archived = @archived, updated_at = @updatedAt
        WHERE id = @id
      `).run({ id: materialId, archived: archived ? 1 : 0, updatedAt })
      if (result.changes !== 1) {
        throw new BoardMaterialError('BOARD_MATERIAL_NOT_FOUND', 404, 'Board material was not found')
      }
    })
    const material = this.get(materialId)
    if (!material) throw new BoardMaterialError('BOARD_MATERIAL_STORAGE_ERROR', 500, 'Material disappeared after archive update')
    return material
  }

  deleteArchived(id: string): boolean {
    const materialId = assertBoardMaterialId(id)
    return runImmediate(this.db, () => {
      const row = this.db.prepare('SELECT archived FROM board_materials WHERE id = ?').get(materialId) as { archived: number } | undefined
      if (!row) return false
      if (row.archived !== 1) {
        throw new BoardMaterialError('BOARD_MATERIAL_NOT_ARCHIVED', 409, 'Only archived Board materials can be deleted permanently')
      }
      const result = this.db.prepare('DELETE FROM board_materials WHERE id = ? AND archived = 1').run(materialId)
      if (result.changes !== 1) {
        throw new BoardMaterialError('BOARD_MATERIAL_STORAGE_ERROR', 500, 'Board material delete lost its row')
      }
      return true
    })
  }
}

export function createBoardMaterialRepository(db: DatabaseT): BoardMaterialRepository {
  return new SqliteBoardMaterialRepository(db)
}
