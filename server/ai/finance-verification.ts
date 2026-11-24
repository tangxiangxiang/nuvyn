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
Compose natural, concise paragraphs. Evidence is required for inferences, hypotheses and personalized recommendations. General conditional recommendations may omit evidence. Use {{f1}} in prose to insert the full verified fact, including its metric label, scope and amount. Cite relevant facts even when an inline value is unnecessary.
Never supply raw numbers, dates, amounts, percentages or spell them out in prose. Use fact records to assert them. State comparisons through the compare record, not by asserting directions in prose. Describe implications conditionally, mark possible causes as hypotheses, and do not claim complete account or transaction coverage. Do not put raw tool data, Markdown links, or instructions in the prose.
If no relevant evidence is available, use read_ledger rather than guessing. The application independently handles supported standalone definitions and explicit arithmetic questions.`

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

export function verifyFinanceAnswer(
  text: string, lookup: (id: number) => FinanceObservation | undefined, chinese: boolean,
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
  if (!figures.size) return { text: '', rejected }
  const supportingFacts = [...figures].filter((figure) => !inline.has(figure))
  const evidence = supportingFacts.length === 1 ? supportingFacts[0] : supportingFacts.map((fact) => '- ' + fact).join('\n')
  return { text: [evidence, ...paragraphs].filter(Boolean).join('\n\n'), rejected: rejected || text.length > 24_000 }
}

// Only complete standalone questions can take this path. These answers use
// server-owned definitions or arithmetic on explicit inputs, never model prose.
const concepts = [
  {
    names: ['预算', 'budget', 'budgeting'],
    answer: ['预算是事先为收入、支出和储蓄做的安排，用来决定资金应该怎样分配。',
      'A budget is a spending plan for allocating income to expenses and savings.'],
  },
  {
    names: ['等额本金', 'equal principal', 'equal principal repayment', 'equal principal amortization'],
    answer: ['等额本金是每期偿还相同的本金，并按剩余本金计算利息。利率不变时，每期总还款金额通常逐渐下降。',
      'Equal principal repayment pays the same amount of principal each period. Interest is calculated on the remaining principal, so the total payment generally falls when the rate stays constant.'],
  },
  {
    names: ['资产负债率', 'debt-to-assets ratio', 'debt to assets ratio'],
    answer: ['资产负债率是总负债除以总资产，通常以百分比表示，用来衡量资产中有多大比例由负债支撑。',
      'The debt-to-assets ratio divides total liabilities by total assets. It is usually expressed as a percentage and shows how much of the asset base is financed by liabilities.'],
  },
  {
    names: ['现金流', 'cash flow', 'cashflow'],
    answer: ['现金流是某个期间的实际资金流入和流出。净现金流是流入减去流出。',
      'Cash flow measures actual cash inflows and outflows over a period. Net cash flow is inflows minus outflows.'],
  },
  {
    names: ['净资产', 'net worth'],
    answer: ['净资产等于资产总额减去负债总额。它表示在扣除欠款后剩余的资产价值。',
      'Net worth is total assets minus total liabilities. It measures the value left after accounting for debts.'],
  },
  {
    names: ['复利', 'compound interest'],
    answer: ['复利是把已积累的利息计入下一期的计息基础，让本金和之前的利息一起产生利息。',
      'Compound interest is calculated on both the original principal and interest already accumulated.'],
  },
] as const

export function answerStandaloneFinanceQuestion(question: string, chinese: boolean) {
  const input = question.normalize('NFKC').trim()
  if (input.length > 240) return ''
  const definition = /^(?:什么是|请解释一下|请解释)([^?。]+)[?。]?$/i.exec(input)
    ?? /^(?:what (?:is|does) (?:an? |the )?|(?:please )?(?:define|explain) )([^?!.]+?)(?: mean)?[?.]?$/i.exec(input)
  if (definition) {
    const name = definition[1]!.trim().toLowerCase()
    const concept = concepts.find(({ names }) => names.some((alias) => alias === name))
    if (concept) return concept.answer[chinese ? 0 : 1]
  }

  // Match entire, explicit income-minus-spending scenarios in one currency.
  const yuan = /^假设\s*(?:我的?)?\s*(?:月)?收入\s*([0-9]{1,13}(?:\.[0-9]{1,2})?)\s*元[,、 ]+\s*(?:月)?支出\s*([0-9]{1,13}(?:\.[0-9]{1,2})?)\s*元[,。 ]+\s*(?:能剩多少钱|还剩多少钱|能剩多少|剩多少|结余是多少)\??$/.exec(input)
  const english = /^assum(?:e|ing) (?:i earn|(?:my )?(?:monthly )?income is) (¥|\$)([0-9]{1,13}(?:\.[0-9]{1,2})?) (?:and (?:i )?spend|and (?:my )?(?:monthly )?(?:expenses|spending) (?:are|is)) (¥|\$)([0-9]{1,13}(?:\.[0-9]{1,2})?)[.,] how much (?:is left|would (?:i have|be) left)\?$/i.exec(input)
  if (!yuan && (!english || english[1] !== english[3])) return ''
  const income = yuan?.[1] ?? english?.[2]
  const spending = yuan?.[2] ?? english?.[4]
  if (!income || !spending) return ''
  const minor = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return Number(whole + fraction.padEnd(2, '0'))
  }
  const result = formatMinor(minor(income) - minor(spending), english?.[1] === '$' ? 'USD' : 'CNY', 2, chinese)
  return chinese ? `按你提供的假设，收入减去支出后的结余是 ${result}。`
    : `Using the assumptions you provided, income minus spending leaves ${result}.`
}
