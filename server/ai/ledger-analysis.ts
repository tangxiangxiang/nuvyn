import { randomUUID } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import { LEDGER_AI_ANALYSIS_KINDS, type LedgerAiAnalysisApproval, type LedgerAiAnalysisScope } from '../../shared/ledgerAiAnalysis.js'
import { parseLedgerLocalDate } from '../ledger/time.js'

export function parseLedgerAiAnalysisScope(input: unknown): LedgerAiAnalysisScope | null {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 3) return null
  const { kind, from, to } = input as Partial<LedgerAiAnalysisScope>
  if (!kind || !LEDGER_AI_ANALYSIS_KINDS.includes(kind)) return null
  try {
    const first = parseLedgerLocalDate(from)
    const last = parseLedgerLocalDate(to)
    const days = Temporal.PlainDate.from(first).until(last).days
    return days >= 0 && days < 366 ? { kind, from: first, to: last } : null
  } catch {
    return null
  }
}

interface ApprovalOwner {
  userId: number
  authSessionId: number
  chatSessionId: number
}

const pending = new Map<string, ApprovalOwner & { finish: (allowed: boolean) => void }>()

/** A challenge can resume only its original request and can be answered once. */
export async function requestLedgerAnalysisApproval(
  owner: ApprovalOwner,
  scope: LedgerAiAnalysisScope,
  signal: AbortSignal,
  announce: (approval: LedgerAiAnalysisApproval) => Promise<void>,
): Promise<boolean> {
  if (signal.aborted || pending.size >= 16
    || [...pending.values()].some((entry) => entry.authSessionId === owner.authSessionId)) return false
  const id = randomUUID()
  let finish!: (allowed: boolean) => void
  const answer = new Promise<boolean>((resolve) => { finish = resolve })
  const onAbort = () => finish(false)
  const timer = setTimeout(onAbort, 120_000)
  pending.set(id, { ...owner, finish })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await announce({ id, scope })
    return await answer && !signal.aborted
  } finally {
    pending.delete(id)
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export function decideLedgerAnalysisApproval(id: string, owner: ApprovalOwner, allowed: boolean): boolean {
  const entry = pending.get(id)
  if (!entry || entry.userId !== owner.userId || entry.authSessionId !== owner.authSessionId
    || entry.chatSessionId !== owner.chatSessionId) return false
  pending.delete(id)
  entry.finish(allowed)
  return true
}
