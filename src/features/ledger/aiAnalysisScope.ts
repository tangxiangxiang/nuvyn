import { Temporal } from '@js-temporal/polyfill'
import type { LedgerAiAnalysisKind, LedgerAiAnalysisScope } from '../../../shared/ledgerAiAnalysis'

/** Recognizes common Ledger requests. The proposed dates are shown before any data is read. */
export function proposeLedgerAiAnalysis(
  text: string,
  timezone: string | undefined,
  now = Date.now(),
): LedgerAiAnalysisScope | undefined {
  const question = text.toLowerCase()
  const comparative = /这两个月|两个月.*区别|compare.*(?:months|last month)|these two months/.test(question)
  const spending = /消费结构|钱.*花.*哪|spending breakdown|where.*money.*go/.test(question)
  const followUp = /^(?:那|那么)?上个?月呢[？?]?$|^(?:what |how )?about last month[?]?$/.test(question.trim())
  const financial = /收支|消费|支出|收入|还款|财务|账本|ledger|income|expense|spending|repayment|financ/.test(question)
  const analysis = /分析|查看|总结|回顾|趋势|情况|对比|analy[sz]e|analysis|review|summary|trend|compare/.test(question)
  const general = /什么是|如何理解|解释.{0,8}概念|what (?:is|are)|define|explain.*concept/.test(question)
  if (!followUp && !comparative && !spending && (!financial || !analysis || general)) return undefined

  const kind: LedgerAiAnalysisKind = comparative || /趋势|trend/.test(question)
    ? 'trend'
    : spending || /(?:分析|查看).{0,14}(?:支出|消费)|analy[sz]e.*spending/.test(question) && !/收支|收入|income/.test(question)
      ? 'spending'
      : /还款|repayment/.test(question) && !/收支|支出|收入|财务|income|expense|financ/.test(question)
        ? 'repayment'
        : 'cashflow'
  const today = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timezone ?? Temporal.Now.timeZoneId()).toPlainDate()
  const monthStart = today.with({ day: 1 })
  let from = monthStart
  let to = today

  try {
    const dates = question.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []
    const month = question.match(/\b(\d{4})[-年](\d{1,2})(?:月|\b)/)
    const standaloneMonth = question.match(/(?<![\d-])(\d{1,2})月/)
    const recent = question.match(/(?:最近|过去)\s*(\d{1,2})\s*个?月|(?:last|past)\s+(\d{1,2})\s+months/)
    if (dates.length > 0) {
      from = Temporal.PlainDate.from(dates[0]!)
      to = Temporal.PlainDate.from(dates[1] ?? dates[0]!)
    } else if (month || standaloneMonth && !recent) {
      from = Temporal.PlainDate.from({
        year: month ? Number(month[1]) : today.year,
        month: Number(month?.[2] ?? standaloneMonth?.[1]),
        day: 1,
      }, { overflow: 'reject' })
      to = from.add({ months: 1 }).subtract({ days: 1 })
      if (Temporal.PlainDate.compare(from, monthStart) === 0) to = today
    } else if (comparative) {
      from = monthStart.subtract({ months: 1 })
    } else if (/上(?:个)?月|last month/.test(question)) {
      from = monthStart.subtract({ months: 1 })
      to = monthStart.subtract({ days: 1 })
    } else if (recent || /半年|六个月|six months/.test(question) || kind === 'trend') {
      const count = recent ? Number(recent[1] ?? recent[2]) : 6
      if (count < 1 || count > 12) return undefined
      from = monthStart.subtract({ months: count - 1 })
    }
  } catch {
    return undefined
  }
  const days = from.until(to).days
  return days >= 0 && days < 366 ? { kind, from: from.toString(), to: to.toString() } : undefined
}
