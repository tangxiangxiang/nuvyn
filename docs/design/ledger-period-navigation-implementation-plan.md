# Ledger — Historical Period Navigation Implementation Plan

> [!IMPORTANT]
> **Historical Planning Baseline / Implemented and evolved.** 本文记录历史期间导航的计划基线与当时的实施门槛，不是当前实现 authority。当前行为请参阅 [Ledger 用户指南](../user-guide/ledger.md) 和 [Ledger Architecture](../architecture/ledger.md)。

**日期：** 2026-09-05

**模块：** Ledger

**Source PRD：** `docs/design/ledger-period-navigation-prd.md`

**Audited main HEAD：** `512e16c923224b9ddc5c8afbb0e791e72100ac99`

**Audit working tree：** clean；`main` synchronized with `github/main`

**Product Review baseline：** `Product Review: Accepted`

**Implementation gate：** `Implementation Review: PASS`；`Ready for Implementation: Yes`

**Baseline：** `512e16c923224b9ddc5c8afbb0e791e72100ac99`

**Implementation Review：** PASS

**Ready for Implementation：** Yes

---

## 1. Implementation Goal

实现 Ledger Dashboard 的统一历史期间浏览能力。

核心输入：

```text
anchorDate
+
scope
+
LedgerSettings.timezone
+
Server clock
```

核心输出：

```text
Current Snapshot
+
Anchored Period Analysis
```

最终责任边界：

```text
Current Snapshot
→ 永远表示现在

Selected Cashflow
→ anchorDate + scope

Category Breakdown
→ anchorDate + scope

Period Summaries
→ anchorDate

Trend
→ anchorDate

Recent Transactions
→ anchorDate cutoff

Calendar / timezone / financial aggregation
→ Server authority

Route / Date Picker / presentation
→ Client
```

Frontend 不得通过获取 Transaction history 后自行进行财务聚合。

---

# 2. Frozen Product Semantics

本 Implementation Plan 不重新讨论 Product Decisions。

以下语义已经冻结。

## 2.1 anchorDate

Dashboard 同一时刻只有一个：

```text
anchorDate
```

Canonical historical URL：

```text
/ledger?date=YYYY-MM-DD
```

Canonical today URL：

```text
/ledger
```

---

## 2.2 Period semantics

对于：

```text
anchorDate = 2026-08-20
```

固定语义为：

```text
today
→ 2026-08-20 完整自然日

week
→ 2026-08-17 ~ 2026-08-23 完整自然周

month
→ 2026-08 完整自然月

year
→ 2026 完整自然年

all
→ Ledger beginning
   ~ 2026-08-21 00:00 exclusive
```

`today/week/month/year` 不使用 partial-period semantics。

例如：

```text
anchorDate = 2026-08-20
scope = month
```

必须统计：

```text
2026-08-01 00:00
→
2026-09-01 00:00 exclusive
```

包括 8 月 21 日～31 日已经存在的历史 Transaction。

不得只统计：

```text
8月1日
→
8月20日
```

---

## 2.3 Current Snapshot

以下字段永远表示当前状态：

```text
assetTotalMinor
liabilityTotalMinor
netWorthMinor
accounts[].currentBalanceMinor
active Account list
```

Account Summary 中当前已有的 current-month movement 也继续按照 Server current time 计算。

历史 `anchorDate` 不得改变这些字段的语义。

---

## 2.4 Trend

Trend 固定：

```text
6 complete calendar months
```

最后一个月：

```text
anchorDate 所在月
```

例如：

```text
anchorDate = 2025-06-15
```

必须得到：

```text
2025-01
2025-02
2025-03
2025-04
2025-05
2025-06
```

---

## 2.5 Recent Transactions

Recent Transactions：

```text
limit = 5
```

它的产品语义是：

```text
截止 anchorDate 当天结束之前，最近的最多 5 笔 active Transactions
```

Transaction 必须：

```text
deletedAt === null
```

并满足：

```text
occurredAt < startOfNextLedgerDate(anchorDate)
```

排序必须使用 Ledger canonical transaction order：

```text
occurredAt DESC
→ createdAt DESC
→ id DESC
```

Account / Category 已归档：

```text
不排除 Transaction
```

只有 Transaction 本身 soft-delete 才排除。

---

# 3. Current Architecture Audit

Baseline implementation 已具备：

```text
Server Temporal calendar primitives
Server Ledger timezone authority
Server Overview projection
Client Ledger store
requestEpoch latest-request-wins
Dashboard period presentation
Vue Router canonical Ledger route
legacy /bills redirects
```

但当前 Overview 时间模型仍是：

```text
Server now
↓
today/week/month/year
```

需要升级为：

```text
Server now
+
optional anchorDate
↓
anchored periods
```

---

# 4. High-level Architecture

目标数据流：

```text
URL
/ledger?date=2026-08-20
        │
        ▼
LedgerView
validate route date syntax
        │
        ▼
Ledger Store
requestedAnchorDate = 2026-08-20
scope = month
        │
        ▼
Frontend API

GET /api/ledger/overview?scope=month&anchorDate=2026-08-20
        │
        ▼
Server Route
parse scope
parse anchorDate
        │
        ▼
Projection
capture Server now ONCE
load Ledger timezone
derive todayDate
validate anchorDate <= todayDate
derive ranges
        │
        ▼
Repository
bounded transaction queries
        │
        ▼
LedgerOverviewDto
{
  context,
  current snapshot,
  anchored projection
}
        │
        ▼
Store
latest request wins
        │
        ▼
Dashboard
current snapshot + period analysis
```

---

# 5. Shared Protocol

修改：

```text
shared/ledgerProtocol.ts
```

新增：

```ts
export interface LedgerOverviewContext {
  readonly anchorDate: string
  readonly todayDate: string
  readonly isToday: boolean
  readonly scope: LedgerOverviewScope
}
```

扩展：

```ts
export interface LedgerOverviewDto {
  readonly context: LedgerOverviewContext

  readonly currency: string
  readonly currencyExponent: number

  readonly assetTotalMinor: number
  readonly liabilityTotalMinor: number
  readonly netWorthMinor: number
  readonly accounts: readonly LedgerAccountSummary[]

  readonly cashflow: LedgerCashflowSummary

  readonly categoryBreakdown: {
    readonly income: readonly LedgerCategorySlice[]
    readonly expense: readonly LedgerCategorySlice[]
  }

  readonly periods: readonly LedgerPeriodSummary[]
  readonly trend: readonly LedgerTrendPoint[]
  readonly recentTransactions: readonly LedgerTransactionDto[]
}
```

`context` 是 transport contract，不允许只在 Server 内部存在。

Frontend 不应通过：

```text
requested URL
Browser Date.now()
Browser timezone
```

推测 Server context。

---

# 6. Server Calendar Primitives

主要修改：

```text
server/ledger/time.ts
```

继续使用：

```text
@js-temporal/polyfill
Temporal.PlainDate
Temporal.ZonedDateTime
```

不得改回：

```text
new Date("YYYY-MM-DD")
browser/local timezone arithmetic
24 * 60 * 60 * 1000
```

---

## 6.1 Generic Ledger local date validation

当前 opening date 已有专用 validation。

不要直接把 opening-date-specific error contract 用于 `anchorDate`。

增加 generic strict Gregorian local-date primitive。

语义：

```text
input:
YYYY-MM-DD

valid:
2026-08-20
2024-02-29

invalid:
2026-8-20
2026-02-30
abc
2026-99-99
```

建议内部 primitive：

```ts
parseLedgerLocalDate(...)
```

或等价命名。

必须：

```text
regex strict shape
+
Temporal.PlainDate overflow reject
```

同时保持现有：

```text
assertOpeningDate()
```

错误 code / field 行为不变。

---

## 6.2 Server todayDate

增加 Server helper，概念上：

```ts
ledgerLocalDateForInstant(
  instantMs: number,
  timezone: string,
): string
```

结果必须：

```text
YYYY-MM-DD
```

例如同一个 Instant：

```text
Asia/Shanghai
→ 2026-09-06

America/Los_Angeles
→ 2026-09-05
```

Server Overview 使用：

```text
captured nowMs
+
settings.timezone
```

计算 `todayDate`。

一次 Overview request 中：

```text
nowMs 必须只 capture 一次
```

避免跨午夜时：

```text
todayDate
periods
future validation
```

使用不同的 Server time。

---

## 6.3 Anchored period ranges

增加或组合现有 helper，使 Server 可以直接根据：

```text
anchorDate
+
timezone
```

得到：

```text
day
week
month
year
```

全部 `[startMs, endMs)`。

建议概念：

```ts
periodRangesForLocalDate(anchorDate, timezone)
```

不要先把 anchorDate 转成 Browser/host timezone Date。

Week 继续保持现有：

```text
Monday → Sunday
```

---

## 6.4 Six-month anchored ranges

扩展当前 month range primitive，使其可以根据：

```text
anchorDate
```

得到：

```text
6 complete calendar months
ending at anchor month
```

可以增加：

```ts
calendarMonthRangesForLocalDate(...)
```

或通过安全的 anchored instant 复用现有 helper。

必须保持：

```text
DST safe
year boundary safe
```

---

# 7. Server anchorDate Validation

主要修改：

```text
server/ledger/validation.ts
server/ledger/projections.ts
```

HTTP query parser 负责：

```text
shape / calendar validity
```

Projection 在知道：

```text
Server now
Ledger timezone
```

之后负责：

```text
future validation
```

---

## 7.1 Missing anchorDate

```text
GET /api/ledger/overview?scope=month
```

等价于：

```text
anchorDate = Server Ledger today
```

保持 backward compatibility。

---

## 7.2 Invalid anchorDate

例如：

```text
anchorDate=abc
anchorDate=2026-99-99
anchorDate=2026-02-30
```

Server 直接：

```text
400
ledger-validation-failed
details.field = "anchorDate"
```

即使正常 Frontend 不会发送这种请求，Server 也不能依赖 Client validation。

---

## 7.3 Future anchorDate

Server：

```text
todayDate = 2026-09-05
anchorDate = 2026-09-06
```

返回：

```text
400
code = ledger-validation-failed
details.field = "anchorDate"
```

Frontend Browser clock 不参与最终判定。

---

# 8. Overview Internal Input

当前内部：

```ts
getOverview(scope)
```

升级为能够承载：

```text
scope
anchorDate?
```

推荐 internal contract：

```ts
interface LedgerOverviewInput {
  readonly scope: LedgerOverviewScope
  readonly anchorDate?: string
}

getOverview(input: LedgerOverviewInput): LedgerOverviewDto
```

如果为降低 churn 保留 positional arguments，也必须实现完全相同语义。

HTTP contract 不受内部函数形式影响。

---

# 9. Overview Projection Algorithm

`getOverview()` 必须按照固定顺序执行。

## 9.1 Capture context

```text
settings = requireSettings()

nowMs = captureNow() exactly once

todayDate =
  Server nowMs
  converted using settings.timezone

resolvedAnchorDate =
  request.anchorDate ?? todayDate
```

然后验证：

```text
resolvedAnchorDate <= todayDate
```

---

## 9.2 Resolve ranges

根据：

```text
resolvedAnchorDate
settings.timezone
```

得到：

```text
anchorDayRange
fixedPeriods.today
fixedPeriods.week
fixedPeriods.month
fixedPeriods.year
trendRanges[6]
```

---

## 9.3 Selected scope range

如果：

```text
scope === today/week/month/year
```

则：

```text
selectedRange = fixedPeriods[scope]
```

如果：

```text
scope === all
```

则：

```text
selectedRange.start = unbounded
selectedRange.end = anchorDayRange.endMs
```

---

## 9.4 Current Snapshot

继续使用 Server now/current state：

```text
asset totals
liability totals
net worth
account current balances
current Account summaries
```

Current Snapshot 的账户余额 derivation 继续读取每个账户的完整 active
Transaction history（概念上等价于现有
`accountState(account) → listActiveTransactionsForAccount(account.id)`）。
该读取：

```text
不按 anchorDate 截断
不按 selected scope 截断
包含 anchorDate 之后发生的 active Transaction
```

例如在 `anchorDate = 2025-06-15` 的历史模式下，账户于 2026-08-01
发生的 Transaction 仍然必须影响 `currentBalanceMinor`、资产、负债和净资产。

该读取边界不改变 Ledger balance engine、opening balance semantics 或
任何既有 financial calculation authority。

不得使用 `anchorDate` 重算历史 balance。

---

## 9.5 Anchored analytics

只有期间敏感的分析使用 bounded active transaction reads 构建：

```text
cashflow
categoryBreakdown
periods
trend
recentTransactions
```

这类 bounded historical projection reads 不得替代 Current Snapshot
余额 derivation 所需的完整 active account transaction history。

---

## 9.6 Response context

最终返回：

```ts
context: {
  anchorDate: resolvedAnchorDate,
  todayDate,
  isToday: resolvedAnchorDate === todayDate,
  scope,
}
```

---

# 10. Repository Read Strategy

当前 Overview 会取得所有 active Transactions 再进行内存过滤。

Historical Period Navigation 不继续扩大这种模式。

主要修改：

```text
server/ledger/repository.ts
```

增加 projection-oriented bounded reads。

推荐：

```ts
listActiveTransactionsInRange(options: {
  readonly from?: number
  readonly to: number
}): LedgerTransaction[]
```

语义：

```text
deleted_at IS NULL

from supplied:
occurred_at >= from

to:
occurred_at < to

ORDER BY:
occurred_at DESC
created_at DESC
id DESC
```

以及：

```ts
listRecentActiveTransactionsBefore(
  to: number,
  limit: number,
): LedgerTransaction[]
```

SQL：

```text
WHERE deleted_at IS NULL
  AND occurred_at < @to

ORDER BY
  occurred_at DESC,
  created_at DESC,
  id DESC

LIMIT @limit
```

不要让 Dashboard historical projection 借用 paginated Transaction History API。

---

# 11. Projection Query Strategy

为避免：

```text
每一个 period 执行一次完整 transaction scan
```

推荐以下读取模型。

## 11.1 Period transaction window

Period summaries：

```text
day
week
month
year
```

先计算四个 ranges 的：

```text
minimum start
maximum end
```

执行一次：

```text
listActiveTransactionsInRange()
```

再在 Server 内对这个 bounded result 按四个 Server-owned ranges 分组。

---

## 11.2 Selected scope

如果：

```text
scope !== all
```

selected scope 是 fixed periods 中的一个。

可以直接从 period transaction window 过滤，不额外读取数据库。

如果：

```text
scope === all
```

单独读取：

```text
from = unbounded
to = anchorDayRange.endMs
```

这是 `all` 唯一允许的历史-wide query。

---

## 11.3 Trend

读取：

```text
trendRanges[0].startMs
→
trendRanges[5].endMs
```

然后 Server 按 6 个 month ranges 聚合。

---

## 11.4 Recent

Recent 不从 trend window 推导。

否则：

```text
过去 6 个月没有 Transaction
但 8 个月前有 Transaction
```

会错误地显示 empty。

必须使用独立：

```text
listRecentActiveTransactionsBefore(
  anchorDayRange.endMs,
  5,
)
```

---

# 12. Repository Index Audit

实现前审计：

```text
server/db.ts
```

其中 migration runner 按版本执行：

```text
server/migrations/*.sql
```

Ledger foundation schema：

```text
server/migrations/0013_ledger_foundation.sql
```

当前已有 index：

```text
idx_ledger_transactions_active_order
```

它覆盖：

```text
deleted_at
occurred_at DESC
created_at DESC
id DESC
```

与本 Plan 的 bounded range / recent cutoff 查询条件和 canonical
ordering 对齐。

重点确认是否已有支持：

```text
ledger_transactions.occurred_at
```

以及 canonical order：

```text
occurred_at
created_at
id
```

的 index；该审计结论已关闭当前 migration/index blocker。

本功能默认：

```text
No database migration is planned for Historical Period Navigation.
No new index migration is planned.
```

只有 implementation-time 的 `EXPLAIN QUERY PLAN` 或明确的
benchmark/profile evidence 证明现有 index 无法支持 planned query 时，
才允许重新开启 index migration decision。

如果届时确实需要 migration，才可以新增后续：

```text
server/migrations/<next_version>_*.sql
```

并且必须：

```text
遵循现有 migration framework
新增 migration test
验证 existing vault upgrade
验证 fresh database
```

禁止顺手重构整个 Ledger schema。

---

# 13. Overview Route

修改：

```text
server/ledger/routes/projections.ts
```

当前：

```text
GET /overview?scope=
```

升级：

```text
GET /overview
  ?scope=month
  &anchorDate=2026-08-20
```

route 负责：

```text
parseOverviewScope
parse optional anchorDate
pass typed input to projection
```

不要把 timezone/calculation 放进 Hono route。

Route 保持薄层。

---

# 14. Standalone Trend Endpoint

现有：

```text
GET /api/ledger/trend
```

不属于本次 Historical Dashboard navigation contract。

Dashboard 已通过：

```text
LedgerOverviewDto.trend
```

取得 trend。

因此本轮：

```text
不要增加 anchorDate 到 standalone /trend
不要修改 standalone trend semantics
```

除非实现 audit 证明当前 Dashboard 实际仍依赖该 endpoint。

避免制造两个 historical trend contracts。

---

# 15. Frontend API

修改：

```text
src/features/ledger/api.ts
```

升级：

```ts
getLedgerOverview(input: {
  readonly scope: LedgerOverviewScope
  readonly anchorDate: string | undefined
})
```

调用方必须传入完整 object input。`scope` 是必填的 request context，任何
Overview request 都必须序列化 `scope`；不得通过省略它让 Server 使用
`scope=all` 的默认语义。

`anchorDate: undefined` 只表示 canonical today request，并且只允许省略
`anchorDate` query parameter。它不得通过省略 object input field 或改回旧的
positional signature 隐式改变既有 historical context，也不得省略 `scope`。

Canonical today 的 HTTP contract：

```text
input:
{
  scope: 'month',
  anchorDate: undefined,
}

request:
GET /api/ledger/overview?scope=month
```

此时 query 中必须存在 `scope=month`，且不得存在 `anchorDate`。

Historical request 的 HTTP contract：

```text
input:
{
  scope: 'month',
  anchorDate: '2026-08-20',
}

request:
GET /api/ledger/overview?scope=month&anchorDate=2026-08-20
```

其它 scope 同理：canonical today 始终发送对应的 `scope`，只在存在
explicit historical anchor 时发送 `anchorDate`：

```text
scope=today + anchorDate=undefined → ?scope=today
scope=week  + anchorDate=undefined → ?scope=week
scope=month + anchorDate=undefined → ?scope=month
scope=year  + anchorDate=undefined → ?scope=year
scope=all   + anchorDate=undefined → ?scope=all
```

Overview query invariant：

```text
Overview requests always send scope.
Canonical today omits only anchorDate; it never omits scope.
```

请求：

```text
/api/ledger/overview?scope=month&anchorDate=2026-08-20
```

today canonical route：

```text
anchorDate === undefined
```

时只省略 `anchorDate` query parameter；`scope` query parameter 仍然必须发送。

---

# 16. Overview Response Validation

当前 Overview client validation 较浅。

本功能至少必须严格验证新的：

```text
context
```

不能直接相信：

```text
value as LedgerOverviewDto
```

至少检查：

```text
context exists
context.anchorDate string
context.todayDate string
context.isToday boolean
context.scope valid LedgerOverviewScope
```

并保持现有 malformed-response strategy。

原因：

Date Picker：

```text
max
historical mode
canonical route
return today
```

全部依赖该 context。

缺失 context 不允许 silently fallback 到 Browser clock。

---

# 17. Frontend Calendar Route Helper

推荐新增：

```text
src/features/ledger/periodNavigation.ts
```

职责只包含 presentation/navigation date parsing。

例如：

```ts
parseLedgerRouteDate(value): string | null
```

必须使用：

```text
strict YYYY-MM-DD
+
Temporal.PlainDate overflow reject
```

不得使用：

```text
new Date(value)
Date.parse(value)
Browser timezone
```

该 helper 只能判断：

```text
syntactically/calendar valid
```

不能自己成为 future-date authority。

---

# 18. Store State

修改：

```text
src/features/ledger/ledgerStore.ts
```

增加显式 Overview request context。

建议：

```ts
overviewScope: LedgerOverviewScope

overviewRequestedAnchorDate:
  string | undefined
```

含义：

```text
undefined
→ canonical /ledger
→ ask Server for today's Ledger date

string
→ canonical historical request
```

不要用：

```text
overview.context.anchorDate
```

直接替代 `overviewRequestedAnchorDate`。

这是两个不同概念。

例如 canonical today：

```text
overviewRequestedAnchorDate = undefined

overview.context.anchorDate = 2026-09-05
```

这样跨午夜后的下一次 refresh：

```text
仍会请求 Server today
```

而不会把昨天固定成一个 historical anchor。

---

# 19. Store Overview Matching

因为切换日期期间可以继续保留 Current Snapshot，

不能简单：

```text
state.overview = null
```

否则资产卡会一起闪烁。

增加 computed / helper：

```text
overviewMatchesRequest
```

语义：

如果：

```text
overviewRequestedAnchorDate === undefined
```

则要求：

```text
overview.context.isToday
overview.context.scope === overviewScope
```

如果有 explicit anchor：

```text
overview.context.anchorDate === overviewRequestedAnchorDate
overview.context.scope === overviewScope
```

当：

```text
overviewMatchesRequest === false
```

Current Snapshot 仍可使用旧 Overview。

但 period-sensitive UI：

```text
cashflow
category
periods
trend
recent
```

不得展示为最新数据。

---

# 20. refreshOverview

不得继续使用容易误调用的 positional optional contract：

```text
refreshOverview(scope, anchorDate?)
```

Store 冻结为显式的 request-context contract：

```ts
interface LedgerOverviewRequestContext {
  readonly scope: LedgerOverviewScope
  readonly anchorDate: string | undefined
}

setOverviewRequestContext(
  context: LedgerOverviewRequestContext,
): void

refreshOverview(): Promise<LedgerOverviewRefreshResult>
```

`LedgerOverviewRequestContext.scope` 始终是必填值。`refreshOverview()` 的
HTTP 序列化不得因为 `anchorDate` 为 `undefined` 而省略 `scope`；canonical
today 只省略 `anchorDate` query parameter。

其中：

```text
state.overviewScope
state.overviewRequestedAnchorDate
```

共同构成当前 Overview request context；
`overviewRequestedAnchorDate` 是 requested anchor 的 authoritative state，
不是可由调用者通过省略参数隐式覆盖的可选值。

Route synchronization 或 scope navigation 必须先写入完整 context，再调用
无参数的 `refreshOverview()`。因此：

```text
当前 scope = month
当前 overviewRequestedAnchorDate = 2025-06-15
切换 scope = year
→ 新 context = { scope: 'year', anchorDate: '2025-06-15' }
```

Retry 不传新的 anchor，必须读取并复用 Store 当前 context：

```text
same scope
+
same overviewRequestedAnchorDate
```

Mutation refresh / `refreshData()` 也必须调用当前 context 的
`refreshOverview()`，不得回到默认 today。

Canonical `/ledger` 是唯一的特殊情况：route synchronization 明确设置：

```text
overviewRequestedAnchorDate = undefined
```

并在后续 refresh 中持续保持 `undefined`，以便由 Server 决定当天日期。

这不意味着省略整个 Overview query。Canonical `/ledger` 必须沿用当前
`overviewScope` 序列化 `scope`，例如当前 scope 为 `month` 时请求：

```text
GET /api/ledger/overview?scope=month
```

必须保持以下 invariant：

```text
Omitting an explicit anchor argument must never reset
an existing historical request context to today.

Overview requests always send scope.
Canonical today omits only anchorDate; it never omits scope.
```

请求开始前使用现有：

```text
requestEpoch
```

实现 latest-request-wins；当前 request context 也必须与该 epoch 一起记录。

请求开始时：

```text
state.overviewScope = request.scope
state.overviewRequestedAnchorDate = request.anchorDate
state.loading = true
state.error = null
```

成功：

```text
only current epoch may replace overview
```

失败：

```text
only current epoch may publish shared error/state
```

快速：

```text
8月
→ 7月
→ 6月
```

即使 8 月最后返回，也不能覆盖 6 月，或发布会影响 6 月 route 的 error。

---

# 20.1 Overview Request Outcome Contract

`refreshOverview()` 必须提供 Overview-specific 的 typed outcome channel。
Router coordinator 不得通过观察共享的通用 `state.error` 猜测某一笔
Overview request 的结果。

采用 project-native 等价实现时，语义必须至少等同于：

```ts
type LedgerOverviewRefreshResult =
  | {
      readonly status: 'success'
      readonly requestEpoch: number
      readonly request: LedgerOverviewRequestContext
      readonly overview: LedgerOverviewDto
    }
  | {
      readonly status: 'error'
      readonly requestEpoch: number
      readonly request: LedgerOverviewRequestContext
      readonly error: LedgerApiError
    }
  | {
      readonly status: 'stale'
      readonly requestEpoch: number
      readonly request: LedgerOverviewRequestContext
    }
```

或者由 Store 暴露等价的：

```text
overviewRequestState
overviewRequestContext
overviewError
overviewRequestEpoch
```

但必须满足：

1. Router coordinator 可以识别当前 anchored Overview request 是否返回：

   ```text
   code = ledger-validation-failed
   details.field = "anchorDate"
   ```

2. outcome 必须绑定 request epoch 和 request context。只有仍然对应当前
   route/context 的 outcome 才能驱动 route canonicalization。

3. stale request 的 future-date error 不得覆盖较新的 historical navigation。

   ```text
   Request A: future anchorDate
   用户立即切换到 Request B: 2025-06-15
   A 最后失败
   → 不得把 B 的 route replace 成 /ledger
   ```

4. network、500、503、malformed response 等普通 historical error 不得被
   归类为 future validation。

当前 request 的 future anchor validation：

```text
future anchor validation
→ router.replace('/ledger')
→ clear explicit requested anchor
→ request default today Overview
```

普通 historical error：

```text
retain URL
retain requested anchor
show retry
do not canonicalize
```

该 outcome contract 是 Router 判断 future canonicalization 的唯一依据；
共享 error 仅用于展示对应的当前请求错误。

---

# 21. Preserve Historical Context Across Refresh

这是实现中的重要 regression boundary。

当前：

```text
create mutation
→ refreshData()
→ Overview refresh
```

Historical mode 下不能：

```text
2025-06-15
create/edit/delete
→ refreshData()
→ silently return today's Overview
```

所有内部 Overview refresh 必须继续携带：

```text
state.overviewScope
state.overviewRequestedAnchorDate
```

包括：

```text
refreshData()
post-create refresh
post-edit refresh
post-delete refresh
Account archive/restore effects
Category mutation refresh
```

Canonical `/ledger` 时：

```text
overviewRequestedAnchorDate = undefined
```

继续保持 undefined。

---

# 22. Route Ownership

修改：

```text
src/views/LedgerView.vue
```

`LedgerView` 成为：

```text
route query ↔ Ledger overview request
```

协调层。

Dashboard 不直接解析 Vue Router query。

增加：

```ts
useRoute()
useRouter()
```

---

# 23. Initial Route Synchronization

初次进入：

```text
/ledger?date=2026-08-20
```

流程：

```text
1. parse route query syntax

2. invalid syntax/calendar date
   → router.replace({ name: 'ledger' })
   → do not send invalid anchored request

3. bootstrap Ledger current workspace

4. for valid explicit date
   → request anchored Overview

5. do not expose stale current-period data
   as historical data while anchored request is pending
```

实现可以复用初始 default Overview 的 Current Snapshot。

但 Period Analysis 在：

```text
route date
!=
overview.context.anchorDate
```

期间必须显示 loading/skeleton，而不是 today data。

---

# 24. Route Date Changes

用户 Date Picker 选择：

```text
2026-08-20
```

使用：

```ts
router.push({
  name: 'ledger',
  query: { date: '2026-08-20' },
})
```

让 Browser Back 能回到之前日期。

不要直接：

```text
store.refreshOverview(...)
```

而不同步 URL。

应先由 route synchronization 更新完整的
`LedgerOverviewRequestContext`，再调用无参数的
`store.refreshOverview()`。

Route 是 browser-level date source of truth。

---

# 25. Return Today

用户点击：

```text
回到今天
```

执行用户导航：

```ts
router.push({ name: 'ledger' })
```

然后由 route synchronization：

```text
overviewRequestedAnchorDate = undefined
```

请求：

```text
GET /api/ledger/overview?scope=<current>
```

其中 `<current>` 是当前 Store request context 中的必填 `scope`；Return
Today 只清除 `anchorDate`，不得删除 `scope` query parameter。比如当前
scope 为 `month` 时，实际请求必须是：

```text
GET /api/ledger/overview?scope=month
```

不要把：

```text
todayDate
```

写进：

```text
?date=
```

---

# 26. Canonical ?date=<today>

如果 URL：

```text
/ledger?date=2026-09-05
```

Server response：

```text
context.isToday = true
```

该数据本身是正确的。

但 canonical URL 应归一化为：

```text
/ledger
```

使用：

```text
router.replace()
```

而不是 `push()`，避免 Browser history 中留下等价重复状态。

实现时可选择是否再请求一次 default Overview。

如果现有 projection 已经是同一个 Server today 数据，可以避免无意义的重复请求，但 Store 必须最终把：

```text
overviewRequestedAnchorDate
```

归一化为：

```text
undefined
```

以保证未来 refresh 不固定旧日期。

---

# 27. Invalid URL

以下：

```text
?date=abc
?date=2026-99-99
?date=2026-02-30
```

Client：

```text
strict parse fails
→ router.replace('/ledger')
→ no invalid anchored request
```

不得进入：

```text
RECOVERABLE_ERROR
```

---

# 28. Future URL

格式合法：

```text
/ledger?date=2026-09-06
```

不能由 Browser clock 最终决定。

必须允许 Server authority 生效。

Server 返回：

```text
400
ledger-validation-failed
details.field = anchorDate
```

Client 识别该特定错误：

```text
router.replace('/ledger')
→ request default today Overview
```

该行为只能由当前 request 的 Overview-specific typed outcome 触发，并且
必须确认 outcome 的 request epoch/context 仍与当前 route 一致。不得通过
观察共享通用 error，或处理已经 stale 的 request 结果，来执行
canonicalization。

这不是普通 historical loading error。

不要显示：

```text
这个期间的数据暂时无法加载
```

然后让用户停留在 future URL。

---

# 29. Normal Historical Error

例如：

```text
/ledger?date=2025-06-15
```

遇到：

```text
network error
500
503
```

行为：

```text
retain URL
retain requested date
retain Current Snapshot if already available
hide/suppress stale period data
show period error
provide retry
```

Router 必须从 Overview-specific request outcome 区分这类普通错误与
`details.field = "anchorDate"` 的 future validation；普通错误不得触发
route canonicalization。

Retry 必须使用：

```text
same scope
same anchorDate
```

不得回到 today。

---

# 30. Dashboard Component

主要修改：

```text
src/components/ledger/LedgerDashboard.vue
```

把目前：

```text
固定期间摘要
```

改为：

```text
期间摘要
```

并在整个 period-sensitive area 之前加入：

```text
期间分析

查看日期
[ date input ] [ 回到今天 ]
```

Date control 不属于：

```text
Period Summary card
```

而属于：

```text
Cashflow
Category
Period Summary
Trend
Recent Transactions
```

共同时间上下文。

---

# 31. Date Picker

第一版使用：

```html
<input type="date">
```

作为默认实现。

如果 audit 发现 Nuvyn 已经有共享且成熟的同等 calendar-date control：

```text
可复用
```

否则：

```text
不要引入新 dependency
```

machine value：

```text
YYYY-MM-DD
```

`max`：

```text
overview.context.todayDate
```

不能：

```text
new Date()
Browser today
```

---

# 32. Date Picker Display Value

当 historical route：

```text
requested date
```

优先立即显示 route/request date。

当 canonical today：

```text
overview.context.todayDate
```

作为 display value。

这样用户选择新日期后，不会出现：

```text
Picker = old date
URL = new date
```

---

# 33. Return Today Button

显示条件：

```text
historical route / request
```

或者：

```text
overview.context.isToday === false
```

canonical today：

```text
隐藏
```

---

# 34. Dynamic Scope Labels

Transport values保持：

```text
today
week
month
year
all
```

Today mode：

```text
今天
本周
本月
今年
全部
```

Historical mode：

```text
当日
所在周
所在月
所在年
全部
```

不得改变 domain enum。

只改变 presentation label。

---

# 35. Dynamic Period Card Labels

Today：

```text
今天
本周
本月
今年
```

Historical：

```text
当日
所在周
所在月
所在年
```

来源：

```text
overview.context.isToday
```

而不是 Browser clock。

---

# 36. Period Date Labels

继续复用：

```text
formatLedgerPeriodLabel()
```

不要重新实现 period boundary formatting。

预期：

```text
Day:
2026年8月20日

Week:
2026年8月17日 – 8月23日

Cross-year week:
2026年12月28日 – 2027年1月3日

Month:
2026年8月

Year:
2026年
```

内部 exclusive `endAt` 不暴露。

---

# 37. Current Snapshot Historical Hint

当：

```text
overview.context.isToday === false
```

显示轻量说明：

```text
当前资产与账户余额保持实时；以下期间数据按 2026年8月20日 浏览。
```

日期使用 existing Ledger date presentation helper。

这是：

```text
info
```

不是：

```text
warning
error
```

---

# 38. Period Loading State

当：

```text
store.overviewMatchesRequest === false
```

或者 active Overview request 正在切换 context：

Current Snapshot：

```text
继续显示
```

Period Analysis：

```text
显示 loading/skeleton/status
```

不得继续显示旧：

```text
cashflow
category
period summaries
trend
recent transactions
```

让用户误以为它们属于新日期。

---

# 39. Recent Transactions UI

Today mode：

```text
最近交易
最近 5 笔真实记录
```

如果 Today mode 的 Recent Transactions 为空，继续使用当前 today
empty semantics；当 Ledger 确实没有任何记录时，可以保留通用的创建交易
CTA。

Historical mode：

```text
最近交易
截至选择日期的最近 5 笔记录
```

如果合法的 historical `anchorDate` 在其 cutoff 之前没有 active
Transaction，必须显示：

```text
截至该日期还没有交易记录
```

这表示 cutoff-specific empty，而不是表示整个 Ledger 从未有交易。此时：

```text
不是 Error
不自动跳回 today
不显示“记下第一笔”这类全局首次交易 CTA
```

第一版 historical empty 不显示创建交易 CTA；如果以后保留按钮，也只能是
不改变 historical context 的通用操作。

继续使用现有 archived Account label mapping。

不要因为 historical navigation 重新过滤：

```text
archived Account
archived Category
```

---

# 40. Transaction History Page

本功能不把：

```text
/ledger/transactions
```

升级成 anchored Dashboard。

现有：

```text
查看全部
```

行为保持现有 Transaction History navigation。

不要顺手：

```text
给 Transaction History 加 anchorDate
改变它的 filter contract
```

除非后续独立 PRD 定义。

---

# 41. Legacy Route

现有：

```text
/bills
→ /ledger
```

已经保留 query。

保持：

```text
/bills?date=2026-08-20
→
/ledger?date=2026-08-20
```

本轮主要增加 regression test。

不要重写 legacy router architecture。

---

# 42. Server Tests — Time

重点：

```text
server/ledger/time.test.ts
```

至少覆盖：

### A. strict calendar date

```text
2026-08-20 → valid
2024-02-29 → valid
2025-02-29 → invalid
2026-02-30 → invalid
2026-8-20 → invalid
```

### B. todayDate timezone

同一个 Instant：

```text
Asia/Shanghai
America/Los_Angeles
```

返回不同 Ledger local date。

### C. DST

例如：

```text
America/New_York
```

覆盖 DST transition。

不要断言：

```text
一天永远 = 86,400,000ms
```

应断言：

```text
正确 local midnight boundaries
```

### D. week

继续：

```text
Monday → Sunday
```

### E. cross-year week

正确跨：

```text
2026 → 2027
```

### F. six-month ranges

覆盖：

```text
2025-01 anchor
```

向前跨年份。

---

# 43. Server Tests — Projection

重点：

```text
server/ledger/projections.test.ts
```

至少覆盖以下高价值 case。

### Case 1 — omitted anchor

```text
getOverview without anchor
```

保持现有 today behavior。

### Case 2 — context

断言：

```text
context.anchorDate
context.todayDate
context.isToday
context.scope
```

### Case 3 — historical full month

```text
anchorDate = 2026-08-20
scope = month
```

Transaction：

```text
08-01
08-15
08-20
08-25
08-31
09-01
```

预期：

```text
08-25
08-31
```

仍被统计。

```text
09-01
```

不统计。

这是本功能最重要的 regression test 之一。

### Case 4 — historical full week

anchor 在周中。

断言：

```text
anchor 后、但仍属于同周的 Transaction
```

仍进入结果。

### Case 5 — historical year

完整自然年。

### Case 6 — all

只允许：

```text
occurredAt < anchorDay.end
```

### Case 7 — Period Summaries

同时验证：

```text
day
week
month
year
```

全部 anchored。

### Case 8 — Trend

```text
exactly 6 points
```

最后点 = anchor month。

### Case 9 — Recent

断言：

```text
cutoff = startOfNextLedgerDate(anchorDate)
occurredAt < cutoff → include
occurredAt >= cutoff → exclude
deletedAt === null → include
deletedAt !== null → exclude
archived Account linked tx → include
archived Category linked tx → include
limit = 5
canonical ordering:
  occurredAt DESC
  → createdAt DESC
  → id DESC
```

Recent 的结果必须等价于“截止 `anchorDate` 当天结束之前，最近的最多
5 笔 active Transactions”，不得从 trend window 推导。

### Case 10 — Current Snapshot

Historical anchor 时：

```text
asset totals
liability totals
net worth
account current balances
```

仍与 current state 一致。

具体 regression fixture：

```text
anchorDate = 2025-06-15
Account 在 2026-08-01 有一笔 active Transaction
```

预期：

```text
currentBalanceMinor / asset totals 包含该笔 Transaction
historical cashflow 不包含该笔 Transaction
```

该测试必须证明 bounded historical reads 没有截断 Current Snapshot
balance history。

---

# 44. Server Route Tests

覆盖：

```text
GET /api/ledger/overview?scope=<scope>
```

### Canonical today / omitted anchorDate

```text
GET /api/ledger/overview?scope=month
```

成功。

### Historical

```text
?scope=month&anchorDate=2026-08-20
```

成功。

### Invalid

```text
anchorDate=abc
anchorDate=2026-02-30
```

返回：

```text
400
details.field = anchorDate
```

### Future

基于 injectable Server clock：

```text
today = 2026-09-05
anchorDate = 2026-09-06
```

返回：

```text
400
ledger-validation-failed
details.field = anchorDate
```

---

# 45. Repository Tests

新增 bounded read regression：

```text
from inclusive
to exclusive
deleted excluded
canonical order
```

Recent query：

```text
to exclusive
limit respected
deleted excluded
ordering stable
```

---

# 46. Frontend API Tests

覆盖：

Canonical today 使用新的 object signature：

```ts
getLedgerOverview({
  scope: 'month',
  anchorDate: undefined,
})
```

必须断言 request 为：

```text
/api/ledger/overview?scope=month
```

并且同时断言：

```text
scope === 'month'
anchorDate 参数不存在
```

Historical request 也使用 object signature：

```ts
getLedgerOverview({
  scope: 'month',
  anchorDate: '2026-08-20',
})
```

必须断言：

```text
path === /api/ledger/overview
scope === 'month'
anchorDate === '2026-08-20'
```

断言应优先读取 `URLSearchParams`，不依赖 query parameter 的字符串顺序，
除非当前项目测试风格明确固定顺序。

Frontend API Tests 中不得保留任何旧 positional signature；所有调用都必须
使用上面的完整 object input，并显式提供 `scope` 与 `anchorDate`。

Overview malformed-response test：

```text
missing context
missing todayDate
invalid isToday
invalid scope
```

必须 fail closed。

---

# 47. Store Tests

重点覆盖：

### A. Historical request

```text
scope + anchorDate
```

正确发送。

### A.1 Historical scope change preserves anchor

Given：

```text
overviewScope = month
overviewRequestedAnchorDate = 2025-06-15
```

When scope 切换为 `year`，必须发送：

```text
GET /api/ledger/overview?scope=year&anchorDate=2025-06-15
```

不得因 scope change 省略 anchor 而回到 today。

### A.2 Historical retry preserves anchor

历史 request 失败后点击 Retry，必须复用：

```text
same scope
same overviewRequestedAnchorDate
```

Retry 不得发送 omitted anchor，也不得清空 historical request context。

### B. Request race

```text
8月
→ 7月
→ 6月
```

最终只接受 6 月 response。

### C. Failed historical request

保留：

```text
requestedAnchorDate
scope
```

### D. Refresh context

Historical mode：

```text
refreshData()
```

仍请求同一个：

```text
anchorDate
```

### E. Mutation refresh

create/edit/delete 后：

```text
historical anchor preserved
```

Account archive/restore、Category mutation 和 `refreshData()` 同样必须
复用 Store 当前 scope 与 requested anchor。

### F. Canonical today

```text
overviewRequestedAnchorDate = undefined
```

refresh 后仍不固定为旧 `todayDate`。

### G. Overview matching

旧 response 与新 request 不一致：

```text
overviewMatchesRequest = false
```

### H. Overview request outcome

必须验证 `refreshOverview()` 返回或发布 request-specific typed outcome，
并带有 request epoch/context：

```text
current future-anchor rejection
→ 可被 Router coordinator 识别并 canonicalize 到 /ledger

stale future-anchor rejection
→ 不得影响更新后的 historical route

ordinary historical 500/network error
→ 保留 historical URL，提供 retry，不 canonicalize
```

### I. Latest request wins for errors as well as data

验证旧 request 的 success 或 error 都不能覆盖新 request 的状态、error 或
route outcome。

---

# 48. LedgerView / Router Tests

至少覆盖：

### A. `/ledger`

正常 today。

### B. `/ledger?date=2026-08-20`

加载 historical Overview。

### C. refresh

历史 URL 保持 historical date。

### D. Back / Forward

```text
8月
→
7月
Back
→
8月
Forward
→
7月
```

### E. invalid route date

```text
/ledger?date=abc
```

canonicalize：

```text
/ledger
```

且不发送 invalid anchored request。

### F. server future rejection

Server：

```text
anchorDate validation failure
```

Client：

```text
replace /ledger
request today
```

测试必须证明这是当前 request-specific outcome 触发的
canonicalization，而不是通过共享 error 猜测。

### F.1 stale future rejection

```text
Request A: future anchorDate
Request B: /ledger?date=2025-06-15
A 的 future validation 最后返回
```

预期：

```text
B 的 historical URL 保持不变
A 不得 replace /ledger
```

### F.2 ordinary historical failure

对 `/ledger?date=2025-06-15` 注入 500 或 network failure，预期：

```text
historical URL 保留
requested anchor 保留
显示 retry
不 canonicalize 到 /ledger
```

### G. explicit today query

```text
/ledger?date=<Server today>
```

canonicalize：

```text
/ledger
```

### H. legacy route

```text
/bills?date=2026-08-20
```

保留 query redirect。

---

# 49. LedgerDashboard Component Tests

更新：

```text
src/components/ledger/__tests__/LedgerDashboard.test.ts
```

至少覆盖：

### Today mode

```text
今天
本周
本月
今年
```

Return Today 不显示。

Date max：

```text
context.todayDate
```

### Historical mode

```text
当日
所在周
所在月
所在年
```

显示：

```text
回到今天
```

### Scope labels

历史：

```text
当日
所在周
所在月
所在年
全部
```

### Date value

Date Picker 正确显示 requested historical date。

### Current snapshot hint

历史模式显示。

today 模式不显示。

### Loading mismatch

requested date 已改变但 Overview 仍是旧 context：

```text
不渲染旧 period-sensitive data
```

### Error

normal historical error：

```text
保留 context
重试可用
```

### Historical Recent empty

合法 historical anchor 的 Recent Transactions 在 cutoff 之前没有记录时：

```text
显示：截至该日期还没有交易记录
不是 Error
不显示：记下第一笔
不自动跳回 today
```

同时保留 today-mode empty regression；Today mode 仍可使用当前
“还没有交易记录”语义及其适用的创建交易 CTA。

### Existing regressions

不得破坏：

```text
category percentage layout
archived Account recent transaction labels
money formatting
Account grouping
period date-only formatting
```

---

# 50. Browser / E2E Coverage

在现有 Ledger E2E infrastructure 中增加一个 canonical historical flow。

建议：

```text
1. 创建多日期 Transaction fixtures

2. 打开 /ledger

3. 选择历史日期

4. assert URL ?date=

5. assert anchored month cashflow

6. assert anchor 后但同月的历史 tx 已计入完整 month

7. reload

8. assert historical state retained

9. choose another historical date

10. Browser Back

11. assert prior date restored

12. 回到今天

13. assert URL == /ledger
```

Server unit tests负责 exhaustive calendar semantics。

E2E 不重复穷举所有 DST / period math。

---

# 51. Accessibility

Date control：

```text
label = 查看日期
```

使用真实：

```html
<input type="date">
<button type="button">
```

Loading：

```text
role=status
aria-live=polite
```

Error：

```text
role=alert
```

不要通过：

```text
CSS pseudo-element
icon-only control
```

表达关键日期状态。

---

# 52. Responsive

窄屏：

```text
Date Picker
Return Today
```

允许纵向排列。

必须避免：

```text
horizontal overflow
amount clipping
inaccessible button
```

不要为这个功能重做整个 Dashboard responsive system。

---

# 53. Performance Boundary

不得由 Client fetch all Transactions，也不要让期间分析无条件：

```text
repository.listActiveTransactions()
→ all history
→ filter everything in memory
```

但 Current Snapshot 是明确的 authority boundary 例外：账户当前余额
derivation 仍必须读取完整 active account transaction history，以保持
NOW 语义。该完整读取：

```text
不使用 anchorDate
不使用 selected scope
不被 bounded period query 替代
```

除 Current Snapshot 所需的账户完整历史外：

```text
scope=all
```

确实需要 Ledger beginning → cutoff 的财务集合外，

其它 historical analytics 都使用 bounded DB reads。

具体而言，bounded reads 只适用于：

```text
cashflow
categoryBreakdown
periods
trend
recentTransactions
```

---

# 54. No Schema Change by Default

Repository audit 已确认：

```text
migration runner = server/db.ts
Ledger schema = server/migrations/0013_ledger_foundation.sql
existing index = idx_ledger_transactions_active_order
```

因此本功能冻结为：

```text
no database schema change
no new index migration
```

只有 implementation-time `EXPLAIN QUERY PLAN` 或明确的
benchmark/profile evidence 证明现有 index 无法支持 planned query 时，
才允许重新开启 index migration decision；届时只能按现有 migration
framework 新增 `server/migrations/<next_version>_*.sql`。

禁止：

```text
new historical snapshot tables
balance snapshot table
materialized monthly tables
```

这些都不属于当前需求。

---

# 55. Files Expected to Change

核心：

```text
shared/ledgerProtocol.ts

server/ledger/time.ts
server/ledger/validation.ts
server/ledger/repository.ts
server/ledger/projections.ts
server/ledger/routes/projections.ts

src/features/ledger/api.ts
src/features/ledger/ledgerStore.ts
src/features/ledger/time.ts
src/features/ledger/periodNavigation.ts   # likely new

src/views/LedgerView.vue
src/components/ledger/LedgerDashboard.vue
```

Tests likely include：

```text
server/ledger/time.test.ts
server/ledger/repository.test.ts
server/ledger/projections.test.ts
Ledger route tests
Ledger API tests
Ledger Store tests
LedgerDashboard.test.ts
LedgerView/router tests
existing Ledger E2E
```

No migration files are expected to change by default.

Conditional only if implementation-time query-plan/benchmark evidence proves
the audited index insufficient：

```text
server/migrations/<next_version>_*.sql
migration tests
```

如果实际测试组织与上述文件名不同：

```text
使用 current repository test structure
```

不要为了匹配本 Plan 创建平行 test framework。

---

# 56. Files That Should Not Change

除非实现中发现明确 contract dependency：

```text
Ledger balance engine
Ledger mutation semantics
Idempotency system
Create recovery protocol
Transaction mutation DTOs
Account lifecycle
Category lifecycle
Authentication
Vault
Note
Diary
```

不得顺手重构。

---

# 57. Implementation Sequence

## Phase 1 — Shared + Time Contract

完成：

```text
LedgerOverviewContext
strict local-date primitive
todayDate primitive
anchored period ranges
anchored 6-month ranges
anchor query validation
```

测试完成后再进入 projections。

建议 commit：

```text
feat(ledger): add anchored overview time contracts
```

---

## Phase 2 — Repository + Server Projection

完成：

```text
bounded active transaction reads
recent-before-cutoff read
anchored getOverview
complete period semantics
all cutoff
6-month trend
context metadata
current snapshot isolation
```

建议 commit：

```text
feat(ledger): anchor overview projections
```

---

## Phase 3 — HTTP + Frontend API + Store

完成：

```text
anchorDate Overview query
context response validation
requested anchor state
latest-request-wins
historical refresh preservation
```

建议 commit：

```text
feat(ledger): add period navigation state
```

---

## Phase 4 — Route Navigation

完成：

```text
/ledger?date=
strict query normalization
Browser Back / Forward
future canonicalization
today canonicalization
```

建议 commit：

```text
feat(ledger): add historical period routing
```

---

## Phase 5 — Dashboard UI

完成：

```text
期间分析
Date Picker
回到今天
dynamic labels
historical hint
period loading/error state
期间摘要 rename
```

建议 commit：

```text
feat(ledger): add historical period controls
```

---

## Phase 6 — Integration Closure

完成：

```text
server regressions
frontend regressions
route regressions
legacy redirect
E2E
typecheck
build
diff check
```

建议 commit：

```text
test(ledger): prove historical period navigation
```

---

# 58. Important Implementation Invariants

以下任何一个被破坏都视为 blocker。

```text
1.
Browser clock never decides financial date authority.

2.
Server captures request now only once.

3.
Ledger timezone owns calendar boundaries.

4.
today/week/month/year are full natural periods.

5.
all alone uses anchor-day cutoff semantics.

6.
Current balance never becomes historical balance.

7.
Frontend never SUMs Transaction history for financial totals.

8.
Future validation remains on Server.

9.
Current route /ledger never pins explicit todayDate in store.

10.
Historical refresh never silently resets to today.

11.
Stale Overview must never masquerade as newly selected date.

12.
Soft-deleted Transaction excluded from Recent.

13.
Archived Account / Category does not erase historical Transaction.

14.
Recent cutoff is exclusive next-day Ledger midnight.

15.
Trend is exactly six complete calendar months.
```

---

# 59. Verification

先执行 touched-file focused tests。

例如：

```bash
npx vitest run \
  server/ledger/time.test.ts \
  server/ledger/projections.test.ts
```

其它测试文件按当前 repository 实际路径加入。

然后执行完整 unit：

```bash
npm run test:unit
```

类型：

```bash
npm run typecheck
```

构建：

```bash
npm run build
```

Ledger E2E / targeted E2E：

```bash
npm run test:e2e -- <actual-ledger-spec>
```

如果当前 Playwright CLI forwarding 与脚本不匹配，使用项目已有 Ledger E2E invocation，不修改 package scripts 只为执行单个测试。

最后：

```bash
git diff --check
git status --short
```

---

# 60. Manual QA

至少人工验证：

```text
1. /ledger 默认 today

2. 今天标题：
   今天 / 本周 / 本月 / 今年

3. 选择昨天

4. URL 出现 ?date=

5. 标题变：
   当日 / 所在周 / 所在月 / 所在年

6. 选择月中日期

7. 本月统计包含 anchorDate 之后、
   但仍属于同一历史月份的 Transaction

8. Back / Forward

9. Refresh

10. 回到今天

11. URL 恢复 /ledger

12. Current assets 在历史模式保持当前值

13. 历史模式出现 Current Snapshot 说明

14. archived Account historical Transaction 正常显示名称

15. invalid date URL 自动规范化

16. future date 不留下错误历史视图

17. 切换日期时不显示旧期间金额冒充新日期

18. 手机宽度 Date Picker 不溢出
```

---

# 61. Implementation Review Checklist

进入 Coding 前确认：

```text
[ ] Shared context DTO 已冻结
[ ] Server todayDate authority 已冻结
[ ] strict anchorDate validation 已冻结
[ ] complete natural period semantics 已冻结
[ ] all cutoff semantics 已冻结
[ ] repository bounded-read strategy 已冻结
[ ] Recent dedicated cutoff query 已冻结
[ ] current snapshot remains NOW 已冻结
[ ] standalone /trend 不扩 scope 已冻结
[ ] Store explicit-anchor vs resolved-anchor distinction已冻结
[ ] historical scope change preserves requested anchor 已冻结
[ ] historical retry preserves requested anchor 已冻结
[ ] mutation refresh preserves requested anchor 已冻结
[ ] canonical today keeps requested anchor undefined 已冻结
[ ] canonical today serializes scope and omits only anchorDate 已冻结
[ ] Frontend API Tests use object signature and assert scope is present 已冻结
[ ] route query ownership 已冻结
[ ] invalid/future handling 已冻结
[ ] Overview request outcome is request-specific 已冻结
[ ] stale future validation cannot canonicalize newer route 已冻结
[ ] stale projection handling 已冻结
[ ] Current Snapshot balance retains full active account history 已冻结
[ ] bounded reads apply only to period-sensitive analytics 已冻结
[ ] existing ledger transaction index audited sufficient 已冻结
[ ] no migration planned by default 已冻结
[ ] historical recent empty copy is cutoff-specific 已冻结
[ ] historical recent empty does not show first-transaction CTA 已冻结
[ ] Date Picker max uses Server todayDate 已冻结
[ ] test strategy complete
[ ] no unresolved persistence/index blocker；已由 repository index audit 关闭
[ ] no blocking implementation open question
```

---

# 62. Implementation Review Exit Criteria

本 Plan 可以进入：

```text
Implementation Review: PASS
Ready for Implementation: Yes
```

前提：

```text
P0 = 0
P1 = 0

No architecture ambiguity
No calendar authority ambiguity
No current-vs-historical balance ambiguity
No URL source-of-truth ambiguity
No stale-data ambiguity
Overview requests always serialize scope; canonical today omits only anchorDate
Overview request outcome is request-specific and epoch-bound
Historical scope change/retry/mutation refresh preserve requested anchor
Current Snapshot retains full active account history
Bounded reads are limited to period-sensitive analytics
Repository index audit is complete; no migration is planned by default
Historical Recent empty UX is cutoff-specific and has no first-transaction CTA
No unresolved persistence/index blocker
```

---

# 63. Completion Definition

完成实现后：

```text
User chooses one Ledger-local date
        ↓
URL records the historical context
        ↓
Server validates that date
        ↓
Server derives full anchored periods
        ↓
Server calculates authoritative projections
        ↓
Dashboard displays:

Current Snapshot
+
Historical Period Analysis
```

并且始终满足：

```text
当前资产看现在。

期间分析看 anchorDate。

scope 决定 anchored period 粒度。

Server 决定 calendar 和金额。

URL 决定 browser historical navigation。
```
