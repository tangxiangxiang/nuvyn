export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export function isSlugSegment(value: string): boolean {
  return SLUG_RE.test(value)
}

export function toLocalSlug(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}
