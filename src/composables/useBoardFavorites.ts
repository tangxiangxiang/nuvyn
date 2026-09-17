import { useStorage } from '@vueuse/core'
import { NUVYN_BROWSER_STORAGE_KEYS } from '../technicalNamespace'

const STORAGE_KEY = NUVYN_BROWSER_STORAGE_KEYS.boardFavorites
const favoriteBoardIds = useStorage<string[]>(STORAGE_KEY, [])

function isFavorite(boardId: string): boolean {
  return favoriteBoardIds.value.includes(boardId)
}

function setFavorite(boardId: string, favorite: boolean): void {
  const next = new Set(favoriteBoardIds.value)
  if (favorite) next.add(boardId)
  else next.delete(boardId)
  favoriteBoardIds.value = [...next]
}

export function useBoardFavorites() {
  return { favoriteBoardIds, isFavorite, setFavorite }
}
