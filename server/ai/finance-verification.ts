import { Temporal } from '@js-temporal/polyfill'
import { ledgerLocalDateForInstant } from '../ledger/time.js'
import type { FinanceObservation } from './finance-agent.js'

const metrics = {
  incomeMinor: ['收入', 'Income'],
  expenseMinor: ['支出', 'Spending'],
  repaymentMinor: ['还款本金', 'Repayment principal'],
  balanceMinor: ['收支结余（未扣还款本金）', 'Income less spending (before repayment principal)'],
  balanceAfterRepaymentMinor: ['收支结余（扣除还款本金）', 'Income less spending and repayment principal'],
  repaymentInterestNetMinor: ['还款利息净额（含优惠）', 'Net repayment interest (including rebates)'],
  repaymentOutflowMinor: ['还款支出（统计口径）', 'Repayment outflow (statistics scope)'],
  actualRepaymentOutflowMinor: ['还款实际资金流出（含统计排除项）', 'Actual repayment outflow (including statistics exclusions)'],
  withdrawalFeeMinor: ['提现手续费（已计入支出）', 'Withdrawal fees (already included in spending)'],
} as const

type Metric = keyof typeof metrics
type Period = { from: string; to: string }
type VerifiedAmount = {
  amount: number; currency: string; currencyExponent: number; label: string
  period?: Period; metric?: Metric; timezone?: string; today?: string
}

export const financeAnswerProtocol = `Return one complete JSON object per line, with no Markdown fences. Declare facts before the paragraphs that refer to them. Use compact answers for simple questions.
{"id":"f1","observation":1,"metric":"expenseMinor"} references an exact summary field.
{"id":"f2","observation":1,"metric":"expenseMinor","month":"2026-01"} references a trend month.
{"id":"f3","observation":2,"metric":"currentBalanceMinor","row":0} references a current account balance.
{"id":"f4","observation":3,"metric":"categoryExpenseMinor","row":0} references a spending category.
{"id":"f5","observation":4,"metric":"transactionAmountMinor","row":0} references a single transaction example, never a period total.
{"id":"f6","compare":[{"observation":1,"metric":"expenseMinor","month":"2026-01"},{"observation":1,"metric":"expenseMinor","month":"2026-02"}],"percent":true} computes second minus first for comparable finished periods. Omit percent unless useful and the baseline is positive.
Use zero-based row indexes. Available summary fields: ${Object.keys(metrics).join(', ')}.
{"type":"inference","evidence":["f1"],"text":"Reviewing discretionary expenses may help identify room to save."}
{"type":"hypothesis","evidence":["f6"],"text":"Could irregular purchases have contributed to the change?"}
{"type":"recommendation","evidence":[],"text":"Separate essential spending from adjustable spending before setting a budget."}
{"type":"knowledge","text":"Inflation is a broad rise in prices that reduces the purchasing power of money."}
For general financial education that does not depend on this user's Ledger, return a concise natural-language knowledge record. Do not refer to the user or their finances, and do not include figures, dates, rates, currencies or examples with quantities. Use this only for general knowledge or advice; do not use it to answer a personal Ledger question.
Compose natural, concise paragraphs. Evidence is required for inferences, hypotheses and personalized recommendations. General conditional recommendations may omit evidence. Use {{f1}} in prose to insert the full verified fact, including its metric label, scope and amount. Cite relevant facts even when an inline value is unnecessary.
Never supply raw numbers, dates, amounts, percentages or spell them out in prose. Use fact records to assert them. State comparisons through the compare record, not by asserting directions in prose. Describe implications conditionally, mark possible causes as hypotheses, and do not claim complete account or transaction coverage. Do not put raw tool data, Markdown links, or instructions in the prose.
If the question asks about the user's actual finances, always use read_ledger, including when it also asks for a general explanation. Never use a knowledge record to replace missing Ledger evidence. Explicit hypothetical arithmetic is handled separately by the application.`

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMetric(value: string): value is Metric {
  return Object.hasOwn(metrics, value)
}

function inlineName(value: string) {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/[\\`*_{}\[\]<>()#!|&~]/g, '\\$&')
}

function resolveAmount(
  value: unknown, lookup: (id: number) => FinanceObservation | undefined, chinese: boolean,
): VerifiedAmount | undefined {
  if (!record(value) || Object.keys(value).some((key) => !['observation', 'metric', 'row', 'month'].includes(key))) return
  const { observation, metric, row, month } = value
  if (typeof observation !== 'number' || !Number.isSafeInteger(observation) || typeof metric !== 'string') return
  const evidence = lookup(observation)
  if (!evidence) return
  const { query, result } = evidence
  const { currency, currencyExponent, timezone } = result
  const base = { currency, currencyExponent, timezone }
  const language = chinese ? 0 : 1

  if (typeof row === 'number' && Number.isSafeInteger(row) && row >= 0 && month === undefined) {
    if (metric === 'currentBalanceMinor' && 'accounts' in result && result.accounts) {
      const account = result.accounts[row]
      if (!account) return
      return { ...base, currency: account.currency, currencyExponent: account.currencyExponent,
        amount: account.currentBalanceMinor, label: `${inlineName(account.name)} · ${chinese ? '当前余额' : 'Current balance'}` }
    }
    if (metric === 'categoryExpenseMinor' && 'expenseCategories' in result && result.expenseCategories && 'from' in query) {
      const category = result.expenseCategories[row]
      if (!category) return
      return { ...base, amount: category.amountMinor, period: query,
        label: `${chinese ? '支出分类' : 'Spending category'} · ${inlineName(category.name)}` }
    }
    if (metric === 'transactionAmountMinor' && 'transactions' in result && result.transactions) {
      const transaction = result.transactions[row]
      if (!transaction || !('amountMinor' in transaction)) return
      const date = ledgerLocalDateForInstant(transaction.occurredAt, timezone)
      return { ...base, amount: transaction.amountMinor,
        label: `${chinese ? '单笔交易示例' : 'Individual transaction example'} · ${date}` }
    }
    return
  }
  if (row !== undefined || !isMetric(metric) || !('summary' in result) || !result.summary || !('from' in query)) return

  const today = ledgerLocalDateForInstant(Date.parse(result.generatedAt), timezone)
  let period: Period = query
  let source: Partial<Record<Metric, number>> = result.summary
  if (month !== undefined) {
    if (typeof month !== 'string' || !result.trend) return
    const point = result.trend.find((item) => item.month === month)
    if (!point) return
    source = point
    const from = ledgerLocalDateForInstant(point.startAt, timezone)
    const to = ledgerLocalDateForInstant(point.endAt - 1, timezone)
    period = { from, to }
  }
  const amount = source[metric]
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) return
  return { ...base, amount, label: metrics[metric][language], period, metric, today }
}

function formatMinor(amount: number, currency: string, exponent: number, chinese: boolean) {
  const digits = String(Math.abs(amount)).padStart(exponent + 1, '0')
  const whole = exponent ? digits.slice(0, -exponent) : digits
  const fraction = exponent ? digits.slice(-exponent) : ''
  const formatter = new Intl.NumberFormat(chinese ? 'zh-CN' : 'en-US', {
    style: 'currency', currency, minimumFractionDigits: exponent, maximumFractionDigits: exponent,
  })
  // Render cents directly from the integer, including at the safe-integer boundary.
  return formatter.formatToParts(amount < 0 ? -Number(whole) : Number(whole))
    .map((part) => part.type === 'fraction' ? fraction : part.value).join('')
}

function comparable(first: VerifiedAmount, second: VerifiedAmount) {
  if (!first.metric || first.metric !== second.metric || !first.period || !second.period ||
      first.currency !== second.currency || first.currencyExponent !== second.currencyExponent ||
      first.timezone !== second.timezone || !first.today || !second.today) return false
  const a = first.period
  const b = second.period
  if (a.to >= first.today || b.to >= second.today || (a.from <= b.to && b.from <= a.to)) return false
  const fullMonth = ({ from, to }: Period) => {
    const end = Temporal.PlainDate.from(to)
    return from === `${to.slice(0, 7)}-01` && end.day === end.daysInMonth
  }
  const aFullMonth = fullMonth(a)
  const bFullMonth = fullMonth(b)
  if (aFullMonth || bFullMonth) return aFullMonth && bFullMonth
  return Temporal.PlainDate.from(a.from).until(a.to).days === Temporal.PlainDate.from(b.from).until(b.to).days
}

const factId = /^f[1-9][0-9]?$/
const narrativeTypes = {
  inference: ['推断', 'Inference'],
  hypothesis: ['待验证的可能原因', 'Possible cause to investigate'],
  recommendation: ['建议', 'Suggestion'],
} as const

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}

function renderFact(
  value: Record<string, unknown>, lookup: (id: number) => FinanceObservation | undefined, chinese: boolean,
) {
  const money = (amount: number, fact: VerifiedAmount) =>
    formatMinor(amount, fact.currency, fact.currencyExponent, chinese)
  const period = ({ from, to }: Period) => from === to ? from : `${from} → ${to}`
  if ('compare' in value) {
    if (!hasOnlyKeys(value, ['compare', 'percent']) || !Array.isArray(value.compare) ||
        value.compare.length !== 2 || (value.percent !== undefined && typeof value.percent !== 'boolean')) return
    const first = resolveAmount(value.compare[0], lookup, chinese)
    const second = resolveAmount(value.compare[1], lookup, chinese)
    if (!first?.period || !second?.period || !comparable(first, second)) return
    const difference = second.amount - first.amount
    if (!Number.isSafeInteger(difference) || (value.percent && first.amount <= 0)) return
    let percent = ''
    if (value.percent) {
      const baseline = BigInt(first.amount)
      const basisPoints = (BigInt(Math.abs(difference)) * 10_000n + baseline / 2n) / baseline
      const fraction = String(basisPoints % 100n).padStart(2, '0')
      percent = ` (${difference < 0 && basisPoints > 0 ? '−' : ''}${basisPoints / 100n}.${fraction}%)`
    }
    return `${first.label} · ${period(first.period)} (${money(first.amount, first)}) → ${period(second.period)} (${money(second.amount, second)}). ${chinese ? '后期减前期' : 'Second period minus first'}：${money(difference, second)}${percent}`
  }
  const fact = resolveAmount(value, lookup, chinese)
  if (!fact || !Number.isSafeInteger(fact.amount)) return
  return `${fact.label}${fact.period ? ` · ${period(fact.period)}` : ''}：${money(fact.amount, fact)}`
}

function renderNarrative(value: Record<string, unknown>, facts: Map<string, string>, chinese: boolean) {
  const { type, text, evidence } = value
  if (!hasOnlyKeys(value, ['type', 'text', 'evidence']) || typeof type !== 'string' ||
      !Object.hasOwn(narrativeTypes, type) || typeof text !== 'string' || !text.trim() ||
      !Array.isArray(evidence) || evidence.length > 12 ||
      evidence.some((id) => typeof id !== 'string' || !facts.has(id)) ||
      (type !== 'recommendation' && evidence.length === 0)) return

  const references = [...text.matchAll(/\{\{(f[1-9][0-9]?)\}\}/g)]
  if (references.some(([, id]) => !evidence.includes(id))) return
  const prose = text.replace(/\{\{f[1-9][0-9]?\}\}/g, ' ').normalize('NFKC')
  const unsupportedPersonalFact = /(?:\b(?:your|my)\s+(?:actual|current|account|balance|spending|expenses?|income|savings?|mortgage|loan|financial situation)\b|(?:你的|我的)(?:账户|餘额|余额|支出|消费|收入|存款|储蓄|房贷|贷款|财务状况))/iu
  if (references.length === 0 && unsupportedPersonalFact.test(prose)) return
  // This is an output constraint, not a semantic proof. Numbers, currencies,
  // dates and Markdown syntax come only from the server-rendered references.
  const plainProse = /^[\p{L}\p{M} .,，。!！?？;；:：、'’“”「」《》（）()—–-]+$/u
  const explicitQuantity = /\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|grand|percent(?:age)?|dollars?|cents?|yuan|renminbi|RMB|CNY|USD|EUR|GBP|JPY)\b|[零〇一二两兩三四五六七八九十百千万萬亿億幺壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]+\s*(?:元|块钱?|塊錢?|分錢|分钱|美元|日元|欧元|歐元|月份?|日|号|號|年|笔|筆|成|倍)|[零〇一二两兩三四五六七八九][千萬万亿億][零〇一二两兩三四五六七八九十百千]*|百分之/iu
  const exhaustiveClaim = /(?:逐笔|逐筆|逐项|逐項|全部|所有|每笔|每筆).{0,8}(?:核对|核對|检查|檢查|审查|審查|交易|账目|帳目)|\b(?:every|all|each|entire|complete)\s+(?:ledger\s+|individual\s+)?(?:transaction|account|entr(?:y|ies))s?\b/iu
  if (!plainProse.test(prose) || explicitQuantity.test(prose) || exhaustiveClaim.test(prose)) return

  const body = text.trim().replace(/\{\{(f[1-9][0-9]?)\}\}/g, (_, id: string) => `**${facts.get(id)}**`)
  return {
    text: `**${narrativeTypes[type as keyof typeof narrativeTypes][chinese ? 0 : 1]}** · ${body}`,
    inline: references.map(([, id]) => id!),
  }
}

function renderKnowledge(value: Record<string, unknown>, allowGeneral: boolean): string | undefined {
  const text = value.text
  if (!allowGeneral || !hasOnlyKeys(value, ['type', 'text']) || typeof text !== 'string' || !text.trim() || text.length > 2_000) return
  const prose = text.trim().normalize('NFKC')
  // Knowledge paragraphs are deliberately detached from personal facts. This
  // permits natural prose while reserving figures and user-specific statements
  // for independently verified records.
  const plainProse = /^[\p{L}\p{M} .,，。!！?？;；:：、'’“”「」《》（）()—–-]+$/u
  const personalReference = /(?:\b(?:i|me|my|mine|you|your|yours|we|our|ours|the user's|user's)\b)|[我你您咱]/iu
  const quantity = /[0-9０-９]|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|half|quarter|percent(?:age)?|dollars?|cents?|yuan|renminbi|RMB|CNY|USD|EUR|GBP|JPY)\b|[零〇一二两兩三四五六七八九十百千万萬亿億幺壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]+\s*(?:元|块钱?|塊錢?|分錢|分钱|美元|日元|欧元|歐元|百分之)/iu
  if (!plainProse.test(prose) || personalReference.test(prose) || quantity.test(prose)) return
  return prose
}

export function verifyFinanceAnswer(
  text: string, lookup: (id: number) => FinanceObservation | undefined, chinese: boolean,
  options: { allowGeneral?: boolean } = {},
) {
  const facts = new Map<string, string>()
  const figures = new Set<string>()
  const paragraphs = new Set<string>()
  const inline = new Set<string>()
  let rejected = false
  let count = 0
  for (const line of text.slice(0, 24_000).split('\n')) {
    if (!line.trim()) continue
    if (++count > 32) { rejected = true; break }
    if (line.length > 1_500) { rejected = true; continue }
    let value: unknown
    try { value = JSON.parse(line) } catch { rejected = true; continue }
    if (!record(value)) { rejected = true; continue }
    if ('type' in value) {
      if (value.type === 'knowledge') {
        const knowledge = renderKnowledge(value, options.allowGeneral === true)
        if (!knowledge) { rejected = true; continue }
        paragraphs.add(knowledge)
        continue
      }
      const paragraph = renderNarrative(value, facts, chinese)
      if (!paragraph) { rejected = true; continue }
      paragraphs.add(paragraph.text)
      for (const id of paragraph.inline) inline.add(facts.get(id)!)
      continue
    }
    const { id, ...reference } = value
    if (id !== undefined && (typeof id !== 'string' || !factId.test(id) || facts.has(id))) {
      rejected = true
      continue
    }
    const figure = renderFact(reference, lookup, chinese)
    if (!figure) { rejected = true; continue }
    if (typeof id === 'string') facts.set(id, figure)
    figures.add(figure)
  }
  if (!figures.size) return { text: [...paragraphs].join('\n\n'), rejected: rejected || text.length > 24_000 }
  const supportingFacts = [...figures].filter((figure) => !inline.has(figure))
  const evidence = supportingFacts.length === 1 ? supportingFacts[0] : supportingFacts.map((fact) => '- ' + fact).join('\n')
  return { text: [evidence, ...paragraphs].filter(Boolean).join('\n\n'), rejected: rejected || text.length > 24_000 }
}

// Explicit hypothetical calculations are deterministic and should not consume
// an Agent round. Knowledge explanations come from the selected model.
export function answerStandaloneFinanceCalculation(question: string, chinese: boolean) {
  const input = question.normalize('NFKC').trim()
  if (input.length > 240 || requiresLedgerEvidence(input)) return ''
  const minor = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return Number(whole + fraction.padEnd(2, '0'))
  }
  const annual = /(?:一年|每年|年度|年能|年可|每年能|每年可|in a year|per year|annually|yearly)/iu.test(input)
  const assumption = /(?:假设|假如|假定|assuming|assume|hypothetical)/iu.test(input)
  const savingQuestion = /(?:能剩|还剩|结余|能存|可存|存下|储蓄|how much|save|left|surplus)/iu.test(input)
  if (!assumption || !savingQuestion) return ''

  const pairs = [...input.matchAll(/(每月|月)?收入\s*([0-9]{1,13}(?:\.[0-9]{1,2})?)\s*元[,，、和及 ]+\s*(每月|月)?支出\s*([0-9]{1,13}(?:\.[0-9]{1,2})?)\s*元/gu)]
  if (pairs.length === 1) {
    const income = minor(pairs[0]![2]!)
    const spending = minor(pairs[0]![4]!)
    const monthly = Boolean(pairs[0]![1] || pairs[0]![3] || /\bmonthly\b/iu.test(input))
    const result = (income - spending) * (annual && monthly ? 12 : 1)
    if (!Number.isSafeInteger(result)) return ''
    const formatted = formatMinor(result, 'CNY', 2, chinese)
    return `按你提供的假设，${annual ? '一年' : ''}收入减去支出后的结余是 ${formatted}。`
  }
  if (pairs.length === 2 && annual && /(?:分别|比较|差多少|哪种|情景)/u.test(input)) {
    const values = pairs.map((pair) => {
      const monthly = Boolean(pair[1] || pair[3])
      const result = (minor(pair[2]!) - minor(pair[4]!)) * (monthly ? 12 : 1)
      return Number.isSafeInteger(result) ? formatMinor(result, 'CNY', 2, chinese) : ''
    })
    if (values.every(Boolean)) return `按你提供的假设，情景一每年结余为 ${values[0]}，情景二每年结余为 ${values[1]}。`
  }

  const english = /^assum(?:e|ing) (?:i earn|(?:my )?(?:monthly )?income is) (¥|\$)([0-9]{1,13}(?:\.[0-9]{1,2})?) (?:and (?:i )?spend|and (?:my )?(?:monthly )?(?:expenses|spending) (?:are|is)) (¥|\$)([0-9]{1,13}(?:\.[0-9]{1,2})?)[., ]+(?:in a year,? )?how much (?:can i save|is left|would (?:i have|be) left)\?$/i.exec(input)
  if (!english || english[1] !== english[3]) return ''
  const monthly = /\bmonthly\b/iu.test(input)
  const result = (minor(english[2]!) - minor(english[4]!)) * (annual && monthly ? 12 : 1)
  if (!Number.isSafeInteger(result)) return ''
  const formatted = formatMinor(result, english[1] === '$' ? 'USD' : 'CNY', 2, chinese)
  return `Using the assumptions you provided, ${annual ? 'annual ' : ''}income minus spending leaves ${formatted}.`
}

/**
 * Conservative data-intent gate, not a topic classifier. It detects personal
 * or time-relative questions that need current Ledger evidence. Unclear
 * follow-ups default to the evidence-required path.
 */
export function requiresLedgerEvidence(question: string): boolean {
  const input = question.normalize('NFKC').trim().toLowerCase()
  if (!input) return true
  const explicitHypothesis = /(?:假设|假如|假定|assuming|assume|hypothetical|if )/iu.test(input)
  const actualDataCue = /(?:账本|账单|实际|真实|当前|现在|目前|最近|过去|上(?:个|一)?(?:月|周|年)|近\s*[0-9一二三四五六七八九十]+\s*(?:个)?月|这笔|这次|我的(?:财务|账户|余额|收支|消费|支出|收入|储蓄|资产|负债|净资产|现金流|预算|房贷|贷款|月供|交易)|\b(?:ledger|actual|current|currently|recently|last month|last week|past \w+ months?|my (?:finances?|account|balance|spending|expenses?|income|savings?|assets?|liabilities|net worth|cash ?flow|budget|mortgage|loan|debt(?:-to-assets)? ratio|transactions?)|what did i spend|how much did i spend)\b)/iu.test(input)
  if (explicitHypothesis && !actualDataCue) return false
  const selfReference = /(?:我|本人|我家|我的|自己|\b(?:i|me|my|mine|our|ours)\b)/iu.test(input)
  const ambiguousReference = /(?:这是什么意思|这个意思|它是什么意思|上述|前面说的|\b(?:what does this mean|what this means|what about that|and what about it|this one)\b)/iu.test(input)
  const dataRequest = /(?:分析|核对|统计|查询|查一下|算一下|多少|花了|存不下|存了多少|月供|房贷|贷款余额|还款|收支|财务状况|财务|账目|交易|余额|支出|收入|消费|储蓄|存款|净资产|资产负债|现金流|预算|\b(?:analy[sz]e|review|check|report|summari[sz]e|learn|calculate mine|how much|spent|spend|saving|savings|spending|cash flow|monthly payment|mortgage|loan|transactions?|finances?|expenses?|income|net worth|assets?|liabilities|debt(?:-to-assets)? ratio|budget|balances?|accounts?)\b)/iu.test(input)
  const temporal = /(?:最近|近\s*[0-9一二三四五六七八九十]+|过去|上个月|去年|本月|这半年|这段时间|\b(?:recent|last|past|this month|this year|over the last)\b)/iu.test(input)
  const personalFinance = /(?:我的|我家|本人|我(?:的)?(?:月供|房贷|贷款|余额|消费|支出|收入|财务|存款|储蓄|账本)|我(?:应该|适不适合|能不能|为什么)|\b(?:my|mine|i spent|i saved|i have|should i|am i able)\b)/iu.test(input)
  // Route clear knowledge and generic how-to questions directly to the model.
  // This describes the request shape, not a whitelist of finance concepts.
  // Personal, time-relative and ambiguous follow-ups are handled below.
  const generalEducationIntent = /(?:什么是|什么叫|何为|如何理解|怎么理解|怎么(?:制定|规划|运作|工作|计算|开始|做)|如何(?:制定|规划|运作|工作|计算|开始|做)|怎样(?:制定|规划|运作|工作|计算|开始|做)|为什么|为何|解释|介绍|讲讲|有什么区别|有哪些利弊|有什么利弊|区别是什么|利弊|原理|\b(?:what is|what are|what does .{1,50} mean|what is the difference|difference between|explain|define|pros and cons|advantages and disadvantages|how (?:to|can|do|does|should|would)\b|why does)\b)/iu.test(input)
  if (personalFinance || (selfReference && dataRequest && !generalEducationIntent) ||
      (temporal && dataRequest) || (actualDataCue && dataRequest) || ambiguousReference) return true
  if (generalEducationIntent && !actualDataCue && !temporal) return false
  return true
}
