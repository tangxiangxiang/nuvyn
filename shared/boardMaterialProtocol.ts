export const BOARD_MATERIAL_KIND_SVG = 'svg' as const
export type BoardMaterialKind = typeof BOARD_MATERIAL_KIND_SVG

export const BOARD_MATERIAL_MIME_TYPE = 'image/svg+xml' as const

export interface BoardMaterial {
  id: string
  name: string
  kind: BoardMaterialKind
  svg: string
  archived: boolean
  createdAt: number
  updatedAt: number
}
