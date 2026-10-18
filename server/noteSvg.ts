import { sanitizeStaticNoteSvg } from '../shared/noteSvg.js'
export { NoteSvgValidationError, __testing__ } from '../shared/noteSvg.js'

/** Preserve the server's existing Buffer API over the shared static policy. */
export function sanitizeNoteSvg(input: Uint8Array): Buffer {
  return Buffer.from(sanitizeStaticNoteSvg(input))
}
