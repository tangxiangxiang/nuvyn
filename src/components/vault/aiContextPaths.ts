/**
 * Per-capture display projections for the AI panel (Edit-10.2, trimmed
 * in Edit-10.3).
 *
 * The legacy path-only transport helper is gone: since Edit-10.3 the
 * panel ships the full send-time snapshot (AiLiveContextSnapshot) as
 * the request's liveContext field and the server validates it
 * strictly — no path projection travels the wire anymore.
 *
 * What remains is display-only. Any ready context kind has a title and
 * identity path worth showing; none / unavailable show no context. These
 * helpers are never used for transport.
 */
import type { AiLiveContextCapture } from '../../composables/vault/aiLiveContext'

export interface AiDisplayContext {
  title: string
  path: string
}

export function displayContextForCapture(capture: AiLiveContextCapture): AiDisplayContext | null {
  if (capture.status !== 'ready') return null
  return {
    title: capture.context.title,
    path: capture.context.identity.path,
  }
}

export function displayPathForCapture(capture: AiLiveContextCapture): string | null {
  return displayContextForCapture(capture)?.path ?? null
}
