export type BoardSearchMatch = 'title' | 'body'

export interface BoardSearchItem {
  boardId: string
  title: string
  match: BoardSearchMatch
  revision: number
  updatedAt: number
  snippet?: string
  elementId?: string
}

export interface BoardSearchResponse {
  items: BoardSearchItem[]
}
