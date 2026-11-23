import { describe, expect, it } from 'vitest'
import { proposeLedgerAiAnalysis } from '../aiAnalysisScope'

const now = Date.parse('2027-01-01T01:20:00Z')
const propose = (text: string, zone = 'Asia/Shanghai') => proposeLedgerAiAnalysis(text, zone, now)

describe('Ledger analysis proposal', () => {
  it('uses the Ledger time zone for the current month', () => {
    expect(propose('分析我本月的收支情况')).toEqual({ kind: 'cashflow', from: '2027-01-01', to: '2027-01-01' })
    expect(propose('帮我分析本月的财务情况', 'America/Los_Angeles'))
      .toEqual({ kind: 'cashflow', from: '2026-12-01', to: '2026-12-31' })
  })

  it.each([
    ['我最近钱都花在哪里了？', 'spending', '2027-01-01', '2027-01-01'],
    ['请分析我最近六个月的收入、支出和还款趋势', 'trend', '2026-08-01', '2027-01-01'],
    ['帮我分析最近半年的还款情况', 'repayment', '2026-08-01', '2027-01-01'],
    ['分析 2026年11月 收支', 'cashflow', '2026-11-01', '2026-11-30'],
    ['Analyze spending 2026-11-02 to 2026-11-07', 'spending', '2026-11-02', '2026-11-07'],
    ['那上个月呢？', 'cashflow', '2026-12-01', '2026-12-31'],
    ['这两个月有什么区别？', 'trend', '2026-12-01', '2027-01-01'],
  ])('proposes a bounded scope for %s', (message, kind, from, to) => {
    expect(propose(message)).toEqual({ kind, from, to })
  })

  it.each(['什么是还款利息？', '你好', '分析过去 24 个月的财务', '分析 2026-02-30 的支出'])(
    'does not propose a read for %s', (message) => expect(propose(message)).toBeUndefined(),
  )
})
