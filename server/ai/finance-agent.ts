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

type Failure = { kind: 'invalid' | 'retryable' | 'oversized' | 'budget'; query?: Query }
type DeliveredResult = Exclude<Result, { error: string }>
export type FinanceObservation = { query: Query; result: DeliveredResult }
const MAX_READ_ATTEMPTS = 2

export function createFinanceAgent(analysis: ReturnType<typeof createLedgerAnalysis>) {
  const delivered = new Map<number, FinanceObservation>()
  const observations = new Map<string, number>()
  const attempts = new Map<string, number>()
  const failures = new Map<string, Failure>()
  const pages = new Map<string, { total: number; sizes: Map<number, number>; coveredPrefix: number }>()
  let omittedCategories = false
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
    let delivery: { key: string; query: Query; result: DeliveredResult; page: ReturnType<typeof pageCoverage> } | undefined
    let content: string
    let reused = false
    if (exhausted) {
      content = encodeError(budgetError, observation)
    } else if (call.name !== ledgerReadTool.name) {
      failures.set('unsupported-tool', { kind: 'invalid' })
      content = encodeError('Only read_ledger is available.', observation)
    } else {
      let query: Query | undefined
      try { query = analysis.normalize(call.input) } catch { /* invalid input */ }
      if (!query) {
        failures.set('invalid-input', { kind: 'invalid' })
        content = encodeError('Invalid Ledger query. Check the requested kind, dates and page.', observation)
      } else {
        const key = JSON.stringify(query)
        const previous = observations.get(key)
        if (previous !== undefined) {
          reused = true
          content = JSON.stringify({ duplicateOfObservation: previous, instruction: 'Use the earlier observation or query a different scope.' })
        } else if (failures.get(key)?.kind === 'oversized') {
          content = encodeError('Ledger result is too large. Try a shorter period or a more focused kind of query.', observation)
        } else if (failures.get(key)?.kind === 'invalid') {
          content = encodeError('Ledger query parameters must change before retrying.', observation)
        } else if ((attempts.get(key) ?? 0) >= MAX_READ_ATTEMPTS) {
          content = encodeError('Ledger query retry limit reached. Report this scope as unavailable.', observation)
        } else {
          await beforeRead()
          attempts.set(key, (attempts.get(key) ?? 0) + 1)
          try {
            const result = analysis.readQuery(query)
            if ('error' in result && typeof result.error === 'string') {
              failures.set(key, { kind: 'invalid', query })
              content = encodeError(result.error, observation)
            } else {
              const page = pageCoverage(query, result)
              content = JSON.stringify({ ...result, observation, ...(page ? { coverage: page.coverage } : {}) })
              delivery = { key, query, result: result as DeliveredResult, page }
            }
          } catch {
            failures.set(key, { kind: 'retryable', query })
            content = encodeError('Ledger query failed. Retry once or report the data as unavailable.', observation)
          }
        }
      }
    }
    if (Buffer.byteLength(content) > MAX_RESULT_BYTES) {
      content = encodeError('Ledger result is too large. Try a shorter period or a more focused kind of query.', observation)
      if (delivery) failures.set(delivery.key, { kind: 'oversized', query: delivery.query })
      delivery = undefined
    }
    if (Buffer.byteLength(content) + (batchSize - ordinal - 1) * errorBytes > remaining) {
      exhausted = true
      reused = false
      content = encodeError(budgetError, observation)
      if (delivery) failures.set(delivery.key, { kind: 'budget', query: delivery.query })
      delivery = undefined
    }
    remaining -= Buffer.byteLength(content)
    if (delivery) {
      const { key, query, result, page } = delivery
      observations.set(key, observation)
      delivered.set(observation, { query, result })
      failures.delete(key)
      if (page) pages.set(page.key, page.page)
      if ('omittedExpenseCategoryCount' in result && (result.omittedExpenseCategoryCount ?? 0) > 0) omittedCategories = true
    }
    return { content, status: delivery ? 'success' : reused ? 'reused' : 'failed' } as const
  }

  function limitations() {
    const partialPages = [...pages.values()].some(({ total, coveredPrefix }) => coveredPrefix < total)
    const failedScopes = [...failures.values()].flatMap(({ query }) => query ? [query] : [])
    return {
      partialPages, omittedCategories, noEvidence: delivered.size === 0,
      queried: rounds > 0, failedQueries: failures.size > 0, failedScopes,
      partialMonths: [...delivered.values()].some(({ result }) => 'partialMonths' in result && Boolean(result.partialMonths?.length)),
      exhausted: !canQuery(),
    }
  }

  return { canQuery, beginBatch, execute, limitations, observation: (id: number) => delivered.get(id) }
}

export function financeCoverageNotice(limits: ReturnType<ReturnType<typeof createFinanceAgent>['limitations']>, chinese: boolean) {
  const scopeLabels = {
    accounts: ['账户余额', 'account balances'], details: ['交易明细', 'transaction details'],
    cashflow: ['收支', 'cashflow'], spending: ['支出', 'spending'],
    trend: ['趋势', 'trend'], repayment: ['还款', 'repayment'],
  } as const
  const failedScopes = [...new Set(limits.failedScopes.map((query) => {
    const kind = scopeLabels[query.kind][chinese ? 0 : 1]
    return 'from' in query ? `${kind} (${query.from} → ${query.to})` : kind
  }))].slice(0, 3)
  const scopes = failedScopes.length ? ' (' + failedScopes.join(', ') + ')' : ''
  const notes = chinese ? [
    limits.partialPages && '部分账户或交易明细未逐页查完',
    limits.omittedCategories && '分类汇总仅列出部分分类',
    limits.partialMonths && '部分趋势月份只覆盖了月内部分日期',
    limits.failedQueries && '有查询未能完成' + scopes,
    limits.exhausted && '本轮查询已达到执行预算',
  ] : [
    limits.partialPages && 'some account or transaction lists were only partially reviewed',
    limits.omittedCategories && 'the category breakdown includes only the leading categories',
    limits.partialMonths && 'some trend months cover only part of the calendar month',
    limits.failedQueries && 'some queries could not be completed' + scopes,
    limits.exhausted && 'the query budget for this turn was reached',
  ]
  const present = notes.filter(Boolean)
  if (!present.length) return ''
  return chinese ? '\n\n账本核对范围：' + present.join('；') + '。'
    : '\n\nLedger coverage: ' + present.join('; ') + '.'
}
