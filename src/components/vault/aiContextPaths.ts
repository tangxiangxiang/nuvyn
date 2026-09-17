/**
 * Per-capture path projections for the AI panel (Edit-10.2, trimmed
 * in Edit-10.3).
 *
 * The legacy path-only transport helper is gone: since Edit-10.3 the
 * panel ships the full send-time snapshot (AiLiveContextSnapshot) as
 * the request's liveContext field and the server validates it
 * strictly — no path projection travels the wire anymore.
 *
 * What remains is display-only: `displayPathForCapture` decides what
 * the composer/chat header chip shows. Any ready context kind has an
 * identity path worth showing; none / unavailable show nothing. This
 * helper is never used for transport.
 */
import type { AiLiveContextCapture } from '../../composables/vault/aiLiveContext'

export function displayPathForCapture(capture: AiLiveContextCapture): string | null {
  if (capture.status !== 'ready') return null
  return capture.context.identity.path
}
