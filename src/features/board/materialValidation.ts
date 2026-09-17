import { matchesSvgText } from '../../../shared/svgValidation'

export const BOARD_MATERIAL_MAX_SVG_BYTES = 2 * 1024 * 1024

export function defaultBoardMaterialName(filename: string): string {
  const name = filename.trim().replace(/\.svg$/i, '').trim()
  return name || '未命名素材'
}

export function isBoardMaterialSvg(value: string): boolean {
  if (!value || new TextEncoder().encode(value).byteLength > BOARD_MATERIAL_MAX_SVG_BYTES) return false
  return matchesSvgText(value)
}

export function boardMaterialPreviewUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
