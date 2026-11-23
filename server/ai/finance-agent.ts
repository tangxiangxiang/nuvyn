import { ledgerReadTool, type createLedgerAnalysis } from './ledger-analysis.js'
import type { NormalizedToolCall } from './llm.js'

const MAX_ROUNDS = 8
const MAX_CALLS = 24
const MAX_BATCH = 8
const MAX_RESULT_BYTES = 12_000
const MAX_CONTEXT_BYTES = 48_000
// Leave space for a small error response to every tool call in the current batch.
const budgetError = 'Ledger tool budget exhausted. Explain the missing coverage.'
const encodeError = (error: string, observation: number) => JSON.stringify({ error, observation })
const errorBytes = Buffer.byteLength(encodeError(budgetError, MAX_CALLS))

type Query = ReturnType<ReturnType<typeof createLedgerAnalysis>['normalize']>
type Result = ReturnType<ReturnType<typeof createLedgerAnalysis>['readQuery']>

export function createFinanceAgent(analysis: ReturnType<typeof createLedgerAnalysis>) {
  const observations = new Map<string, number>()
  const pages = new Map<string, { total: number; sizes: Map<number, number>; coveredPrefix: number }>()
  let omittedCategories = false
  let successfulReads = 0
  let rounds = 0
  let calls = 0
  let remaining = MAX_CONTEXT_BYTES
  let exhausted = false

  function canQuery() {
    return !exhausted && rounds < MAX_ROUNDS && calls < MAX_CALLS && remaining > MAX_BATCH * errorBytes
  }

  function beginBatch(size: number) {
    if (!canQuery() || size < 1 || size > MAX_BATCH || calls + size > MAX_CALLS) {
      exhausted = true
      return false
    }
    rounds++
    calls += size
    return true
  }

  function pageCoverage(query: Query, result: Result) {
    if (!('nextOffset' in result) || typeof result.nextOffset === 'undefined') return
    const key = JSON.stringify({ ...query, offset: 0 })
    const page = pages.get(key) ?? { total: result.count, sizes: new Map<number, number>() }
    const size = 'accounts' in result ? result.accounts.length : result.transactions.length
    // Stage the observation until its result fits the context budget.
    const sizes = new Map(page.sizes).set(query.offset, size)
    let coveredPrefix = 0
    for (const [offset, length] of [...sizes].sort(([a], [b]) => a - b)) {
      if (offset > coveredPrefix) break
      coveredPrefix = Math.max(coveredPrefix, offset + length)
    }
    return {
      key,
      page: { total: page.total, sizes, coveredPrefix },
      coverage: {
        offset: query.offset,
        returned: size,
        total: result.count,
        firstUnreadOffset: coveredPrefix < result.count ? coveredPrefix : null,
        exhaustive: coveredPrefix >= result.count,
      },
    }
  }

  async function execute(call: NormalizedToolCall, batchSize: number, ordinal: number, beforeRead: () => Promise<void>) {
    const observation = calls - batchSize + ordinal + 1
    let commit: (() => void) | undefined
    let content: string
    if (exhausted) {
      content = encodeError(budgetError, observation)
    } else if (call.name !== ledgerReadTool.name) {
      content = encodeError('Only read_ledger is available.', observation)
    } else {
      let query: Query | undefined
      try { query = analysis.normalize(call.input) } catch { /* invalid input */ }
      if (!query) {
        content = encodeError('Invalid Ledger query. Check the requested kind, dates and page.', observation)
      } else {
        const key = JSON.stringify(query)
        const previous = observations.get(key)
        if (previous !== undefined) {
          content = JSON.stringify({ duplicateOfObservation: previous, instruction: 'Use the earlier observation or query a different scope.' })
        } else {
          // Keep access and cancellation errors out of the tool error handler.
          await beforeRead()
          observations.set(key, observation)
          try {
            const result = analysis.readQuery(query)
            const page = pageCoverage(query, result)
            content = JSON.stringify({ ...result, observation, ...(page ? { coverage: page.coverage } : {}) })
            commit = () => {
              if (!('error' in result)) successfulReads++
              if (page) pages.set(page.key, page.page)
              if ('omittedExpenseCategoryCount' in result && (result.omittedExpenseCategoryCount ?? 0) > 0) omittedCategories = true
            }
          } catch {
            content = encodeError('Ledger query failed. Try a narrower range or report the data as unavailable.', observation)
          }
        }
      }
    }
    if (Buffer.byteLength(content) > MAX_RESULT_BYTES) {
      content = encodeError('Ledger result is too large. Try a shorter period or a more focused kind of query.', observation)
      commit = undefined
    }
    if (Buffer.byteLength(content) + (batchSize - ordinal - 1) * errorBytes > remaining) {
      exhausted = true
      content = encodeError(budgetError, observation)
      commit = undefined
    }
    remaining -= Buffer.byteLength(content)
    commit?.()
    return content
  }

  function limitations() {
    const partialPages = [...pages.values()].some(({ total, coveredPrefix }) => coveredPrefix < total)
    return { partialPages, omittedCategories, noEvidence: rounds > 0 && successfulReads === 0, exhausted: !canQuery() }
  }

  return { canQuery, beginBatch, execute, limitations }
}

export function financeCoverageNotice(limits: ReturnType<ReturnType<typeof createFinanceAgent>['limitations']>, chinese: boolean) {
  const notes = chinese ? [
    limits.partialPages && '部分账户或交易明细未逐页查完',
    limits.omittedCategories && '分类汇总仅列出部分分类',
    limits.exhausted && '本轮查询已达到执行预算',
  ] : [
    limits.partialPages && 'some account or transaction lists were only partially reviewed',
    limits.omittedCategories && 'the category breakdown includes only the leading categories',
    limits.exhausted && 'the query budget for this turn was reached',
  ]
  const present = notes.filter(Boolean)
  if (!present.length) return ''
  return chinese ? '\n\n账本核对范围：' + present.join('；') + '。'
    : '\n\nLedger coverage: ' + present.join('; ') + '.'
}
