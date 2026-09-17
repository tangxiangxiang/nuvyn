import { Calendar, Search, Settings } from '@vicons/tabler'

// This entry is bundled only by the Phase 0 test. It must never be imported by
// production code; its purpose is to provide a small, reproducible Rollup sample.
export const selectedTablerGlyphs = [Search, Settings, Calendar]

// Keep the sample exports live in the isolated bundle; this assignment is never
// reached from the Nuvyn production graph.
;(globalThis as Record<string, unknown>).__nuvynSpikeGlyphs = selectedTablerGlyphs
