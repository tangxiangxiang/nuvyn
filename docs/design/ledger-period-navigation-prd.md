# Ledger — Historical Period Navigation PRD

> [!IMPORTANT]
> **Historical Planning Baseline / Implemented and evolved.** 本文记录历史期间导航的产品决策沿革，不是当前实现 authority。当前行为请参阅 [Ledger 用户指南](../user-guide/ledger.md) 和 [Ledger Architecture](../architecture/ledger.md)。

**日期：** 2026-09-05

**模块：** Ledger

**状态：** Product Review: Accepted

**类型：** 功能增强

**优先级：** P1

## 1. 产品概述

Ledger Dashboard 当前主要回答：

> 我今天、本周、本月、今年的收支怎么样？

随着真实交易数据不断积累，用户还需要回答：

> 昨天怎么样？
>
> 上周怎么样？
>
> 2026 年 8 月 20 日那一天怎么样？
>
> 那一天所在的一周、一个月、一年分别发生了什么？

本功能为 Ledger Dashboard 引入统一的 `anchorDate`（基准日期）。用户选择一个日期后，Ledger 以：

```text
anchorDate + Ledger timezone
```

作为唯一历史时间上下文，由 Server 计算该日期所属的：

```text
当日
所在周
所在月
所在年
```

并提供对应的：

```text
收入
支出
收支结余
分类结构
趋势
相关交易
```

默认 `anchorDate` 为 Ledger timezone 下的今天，因此默认 Dashboard 使用体验保持不变。

## 2. 产品目标

本功能的目标不是简单增加一个 Date Picker，而是为 Ledger Dashboard 建立统一、可回溯、由 Server authoritative projection 驱动的历史时间上下文。

完成后，用户应能够通过选择一个日期，自然回答：

```text
今天怎么样？
昨天怎么样？
上周怎么样？
上个月怎么样？
去年怎么样？
任意历史日期所在的日 / 周 / 月 / 年怎么样？
```

时间职责边界固定为：

```text
UI 选择时间
Server 解释时间
Server 计算金额
UI 展示结果
```

Frontend 不成为第二套 period 或 aggregation authority。

## 3. 非目标

本功能不实现：

- 自定义任意 `start/end` date range；
- 独立的日、周、月、年四套日期选择器；
- 日历热力图；
- 同比、环比；
- 去年同期；
- 财务报表系统；
- 自定义周起始日；
- 保存筛选方案；
- Budget；
- Forecast；
- Recurring Transaction；
- Import / Export；
- AI 财务分析；
- 历史资产估值；
- 历史 Account balance snapshot；
- 多币种 / FX。

同时不扩展 Ledger 的既有产品范围：

- Budget；
- recurring transaction；
- bank sync；
- CSV import/export；
- OCR；
- AI classification；
- AI finance analysis；
- investment pricing；
- property valuation；
- vehicle depreciation；
- debt payoff planning；
- household/shared Ledger；
- enterprise accounting。

特别说明：本功能不提供“某一天时我当时有多少钱”的历史资产快照。Ledger 当前的总资产、总负债、净资产和账户当前余额仍然表示当前状态。本功能增强的是历史期间活动，而不是历史 balance sheet snapshot。

## 4. 核心产品模型

### 4.1 一个 Dashboard，一个 `anchorDate`

Dashboard 同一时刻只能存在一个 `anchorDate`。例如：

```text
2026-08-20
```

整个历史期间浏览围绕该日期展开。

禁止设计为：

```text
Day    = 2026-08-20
Week   = 2026-07-06
Month  = 2026-05
Year   = 2025
```

避免同一 Dashboard 出现四个互相矛盾的时间上下文。

### 4.2 默认 `anchorDate`

默认值为 Ledger timezone 下的今天。Ledger today 必须由 `LedgerSettings.timezone` 决定，不得直接使用浏览器 local timezone 作为 authority。

例如：

```text
Ledger timezone = Asia/Shanghai
Browser timezone = America/Los_Angeles
```

则“今天”仍按 `Asia/Shanghai` 判断。

### 4.3 历史日期范围

第一版允许选择 Ledger timezone 下的今天及其之前的任意合法 calendar date，不允许选择未来日期。原因是本功能定义为历史期间浏览，而不是未来计划或 forecast。

Date Picker 的产品约束为：

```text
max = Ledger today
```

这里的 `Ledger today` 必须由 Server 根据注入的当前时间与
`LedgerSettings.timezone` 得出。Client 在已经获得 Server 返回的
`todayDate` 后，可以用它设置 Date Picker 的 `max` 作为 UX 优化，但这
不是日期合法性的 authority。

日期校验分为两层：

- Client 可以本地识别 `YYYY-MM-DD` 格式非法或不存在的 calendar date，
  这种值不得发送给 Server；
- 格式合法但可能晚于 Ledger today 的日期，仍必须由 Server 做最终校验。

Server 仍必须验证所有传入日期，不能只依赖 Client。

### 4.4 Week boundary

Ledger week 正式冻结为 Monday → Sunday。`week.start` 是 `anchorDate` 所在
周的 Monday 00:00，`week.end` 是下一周 Monday 00:00 的 exclusive boundary；
内部期间使用 `[startAt, endAt)`。

Ledger Server 是 week boundary authority。Client 不得采用 Sunday-start、
browser locale week rule 或 locale-dependent first day of week。

例如 `anchorDate=2026-08-20` 时，week 从 2026-08-17 00:00 开始，到
2026-08-24 00:00 exclusive 结束，用户可见日期为 `2026年8月17日 – 8月23日`。

## 5. Dashboard 时间上下文

Dashboard 信息分为当前状态和期间型数据两类。

### 5.1 当前状态

以下信息始终表示“现在”：

```text
总资产
总负债
净资产
账户当前余额
active Account list
```

这些值继续来自当前 authoritative projection。当用户选择历史日期时，不得把这些数据伪装成历史资产。

例如用户浏览 `2025-06-15` 时，总资产仍然表示：

```text
我现在有多少钱
```

而不是 `2025-06-15` 当天有多少钱。

历史模式下应提供轻量说明：

```text
资产与账户余额仍为当前值；以下收支分析按 2025年6月15日 浏览。
```

### 5.2 期间型数据 authority matrix

以下矩阵冻结每个 Dashboard 数据区域的时间 authority：

| Dashboard 数据 | `anchorDate` | `scope` | 冻结语义 |
| --- | --- | --- | --- |
| 总资产 / 总负债 / 净资产 | 否 | 否 | 当前状态 |
| Accounts current balance | 否 | 否 | 当前状态 |
| Selected cashflow | 是 | 是 | 统计 `anchorDate` 所属的完整 day/week/month/year；`all` 为 Ledger beginning 至 `anchorDate` 当天结束 |
| Category Breakdown | 是 | 是 | 与 selected cashflow 使用完全相同的 anchored scope |
| Period Summaries | 是 | 否 | 同时返回 `anchorDate` 的完整 day、week、month、year |
| Trend | 是 | 否 | 以 `anchorDate` 所在月为最后月份的 6 个完整 calendar months |
| Recent Transactions | 是 | 否 | 截止 `anchorDate` 当天结束的 active Transactions |

因此，只有 selected cashflow 和 Category Breakdown 使用用户当前选择的
`scope`。期间摘要、Trend 和 Recent Transactions 都只由
`anchorDate` 决定。不得出现这些区域分别使用不同日期上下文的状态。

对于 selected cashflow 与 Category Breakdown，`today`、`week`、`month`
和 `year` 都是完整的自然日、自然周、自然月和自然年，不是从该期间
开始累计到 `anchorDate` 的 partial period。只有 `scope=all` 使用截至
`anchorDate` 当天结束的 cutoff 语义。

## 6. 期间摘要

Dashboard 中原有的“固定期间摘要”正式改名为“期间摘要”。统一日期选择
属于整个“期间分析”区域的顶部，不属于某一张期间摘要卡；收支、分类、
期间摘要、趋势和最近交易都在该日期上下文下展示。

历史模式示例：

```text
期间分析

[ 查看日期：2026年8月20日 📅 ]    [ 回到今天 ]

期间摘要

当日
2026年8月20日

所在周
2026年8月17日 – 8月23日

所在月
2026年8月

所在年
2026年
```

默认今天：

```text
期间分析

[ 查看日期：2026年9月5日 📅 ]

期间摘要

今天
2026年9月5日

本周
2026年8月31日 – 9月6日

本月
2026年9月

今年
2026年
```

### 6.1 标题语义

当 `anchorDate = Ledger today` 时，使用：

```text
今天
本周
本月
今年
```

当 `anchorDate != Ledger today` 时，使用：

```text
当日
所在周
所在月
所在年
```

历史模式禁止继续显示“今天、本周、本月、今年”，因为这些词表示当前时间，会产生错误语义。

### 6.2 日期展示

日期只展示 calendar meaning，不展示 `00:00`、`23:59`、小时、分钟、秒、UTC、offset、millisecond 或 exclusive boundary。

展示规则：

| 期间 | 展示规则 | 示例 |
| --- | --- | --- |
| Day | `YYYY年M月D日` | `2026年9月5日` |
| Week（同年） | `YYYY年M月D日 – M月D日` | `2026年8月31日 – 9月6日` |
| Week（跨年） | `YYYY年M月D日 – YYYY年M月D日` | `2026年12月28日 – 2027年1月3日` |
| Month | `YYYY年M月` | `2026年9月` |
| Year | `YYYY年` | `2026年` |

日期必须继续根据 `store.settings.timezone` 格式化，不得使用浏览器 timezone。内部的 `[startAt, endAt)` period 不变；周和日的用户可见结束日期必须根据 exclusive `endAt` 的前一个可见时刻或等价安全方式取得。例如 `2026-08-31 00:00` 到 `2026-09-07 00:00` 应显示为 `2026年8月31日 – 9月6日`。

## 7. Date Picker 与回到今天

第一版只提供：

```text
选择日期
回到今天
```

不提供上一天、下一天、上一周、下一周、上个月、下个月、上一年或下一年导航。这些属于未来增强。

当 `anchorDate != Ledger today` 时显示“回到今天”。点击后将 `anchorDate` 设置为 Ledger today，并恢复“今天、本周、本月、今年”和默认当前期间数据。当已经位于今天时，“回到今天”隐藏。

## 8. URL 与浏览器导航

Dashboard 历史日期使用 canonical route query：

```text
/ledger?date=YYYY-MM-DD
```

例如：

```text
/ledger?date=2026-08-20
```

这样可以让 refresh 保留当前浏览日期、Browser Back / Forward 自然工作、历史日期可收藏，并让时间状态可观察。

当 `anchorDate` 为 Ledger today 时，canonical URL 为：

```text
/ledger
```

而不是 `/ledger?date=<today>`。点击“回到今天”时移除 `date` query。

### 8.1 无效日期 query

`?date=abc`、`?date=2026-99-99` 或未来日期不得导致页面 crash。格式
非法或不存在的 calendar date 可以由 Client 在请求前识别，产品行为为：

```text
Client 不发送 anchored request
→ fallback 到 Ledger today
→ remove invalid date query
```

不得向 Server 发送错误日期后继续显示 stale historical data。

格式合法但属于未来的日期不能由 Browser clock 最终判定。Client 可以在
已经拿到 authoritative `todayDate` 后提前限制 Date Picker，但仍允许
合法 query 进入 Server validation。若 Server 返回
`400 ledger-validation-failed`，且 `details.field = "anchorDate"`，则：

```text
Server 判定 future
→ Client canonicalize 到 /ledger
→ 重新请求 Ledger today 的默认 overview
```

这类 future query 的处理是导航规范化，不是历史 projection 的 recoverable
data error。

### 8.2 Browser Back / Forward

如果用户依次选择 `2026-08-20`、`2026-07-15`，Browser Back 应恢复 `2026-08-20`，Browser Forward 再恢复 `2026-07-15`。Route query 是 `anchorDate` 的浏览器级 source of truth，Component 不维护一套与 URL 冲突的日期 history。

## 9. Scope 与 `anchorDate`

Dashboard 现有 scope `today`、`week`、`month`、`year`、`all` 保留 transport/domain value。用户文案根据 `anchorDate` 动态调整：

| 模式 | today | week | month | year | all |
| --- | --- | --- | --- | --- | --- |
| 今天 | 今天 | 本周 | 本月 | 今年 | 全部 |
| 历史日期 | 当日 | 所在周 | 所在月 | 所在年 | 全部 |

例如 `anchorDate = 2026-08-20`：

```text
scope=today → 2026-08-20
scope=week  → 2026-08-17 ~ 2026-08-23（完整自然周）
scope=month → 2026-08（完整自然月）
scope=year  → 2026（完整自然年）
scope=all   → Ledger 开始记录以来，到 anchorDate 当天结束为止
```

正式冻结：`today` 是 anchorDate 完整当天，`week` 是 anchorDate 所在的
完整自然周，`month` 是 anchorDate 所在的完整自然月，`year` 是
anchorDate 所在的完整自然年；`all` 仍受 `anchorDate` 约束。历史模式下
`anchorDate=2025-06-15&scope=all` 不得包含 `2025-06-16` 之后的交易。

## 10. Dashboard 数据区域

### 10.1 Selected cashflow

Selected cashflow 的收入、支出和收支结余必须使用 `anchorDate + selected scope`。例如 `anchorDate=2026-08-20`、`scope=month` 时，显示的是 2026 年 8 月的真实收支，不得继续显示当前月份。

### 10.2 Category Breakdown

Category Breakdown 与 selected cashflow 共享完全相同的 `anchorDate + scope`。例如 `anchorDate=2026-08-20`、`scope=month` 时，分类区域表示 2026 年 8 月分类，而不是当前月份分类。

分类金额继续来自 Server breakdown。百分比可以继续由 Frontend 根据 Server 返回的 category amounts 做 presentation calculation，但 Frontend 不重新计算 financial totals。

### 10.3 期间摘要

无论 selected scope 当前选择什么，期间摘要始终同时显示 `anchorDate` 当日、所在周、所在月和所在年。每张卡展示收入、支出和收支结余，均由 Server projection 返回。

### 10.4 Trend

Trend 跟随 `anchorDate`，固定展示 6 个完整 calendar months。最后一个月
是 `anchorDate` 所在的月份，前面依次为该月之前的 5 个月。例如
`anchorDate=2025-06-15` 时，Trend 必须展示：

```text
2025-01、2025-02、2025-03、2025-04、2025-05、2025-06
```

不得继续以当前月份作为历史模式的最后月份，也不得把月份数量留给
实现阶段自行解释。

### 10.5 Recent Transactions

历史模式中的 Recent Transactions 定义为：在 `anchorDate` 当天结束之前，
最近的最多 5 笔 active Transactions。这里的 active transaction 明确定义为：
`deletedAt === null`。结果固定为 `limit = 5`；关联的 Account 或 Category
是否已归档，不影响该历史 Transaction 进入 Recent Transactions，归档实体仍
应使用其历史可识别信息展示。排序使用 Ledger canonical transaction order：

```text
occurredAt DESC
→ createdAt DESC
→ id DESC
```

因此，Recent Transactions 的完整产品定义是：“截止 `anchorDate` 当天结束
之前，最近的最多 5 笔 active Transactions”。例如 `anchorDate=2025-06-15`
时，不得出现 2025-06-16 或更晚的交易；默认 today 也遵守同一 `limit`、
active、cutoff 和排序规则。

时间 cutoff 使用 Ledger timezone 下 `anchorDate` 次日 00:00 的 exclusive
boundary：只有满足

```text
occurredAt < startOfNextLedgerDate(anchorDate)
```

的 active Transaction 才能进入结果。不得直接把下一个 calendar date 的
00:00 当作用户可见的交易日期，也不得依赖 Browser timezone 判断 cutoff。

## 11. Server Authority 与 API Contract

这是本 PRD 的硬性架构边界。

Frontend 不得：

```text
fetch all Transactions
→ filter
→ reduce
→ calculate historical summary
```

Frontend 不得自行计算 day、week、month、year boundary、all-time cutoff、trend month range、recent transaction cutoff、income、expense 或 cashflow balance。

Server 使用：

```text
anchorDate + LedgerSettings.timezone
```

作为时间和 projection authority。

### 11.1 Overview query

优先扩展现有：

```http
GET /api/ledger/overview
```

新增 optional query：

```text
anchorDate=YYYY-MM-DD
```

现有 `scope` 继续保留。例如：

```http
GET /api/ledger/overview?scope=month&anchorDate=2026-08-20
```

当 `anchorDate` omitted 时，Server 使用 Ledger timezone 下的 today，现有 caller 保持兼容，其语义等价于 `anchorDate = Ledger today`。

当 `anchorDate` supplied 时，Server 必须：

1. 严格验证 `YYYY-MM-DD`；
2. 使用 Ledger timezone 解释 calendar date；
3. 拒绝未来日期；
4. 计算 anchored day/week/month/year；
5. 计算 selected scope；
6. 返回 authoritative projection。

其中“拒绝未来日期”是 Server authority。格式合法的 future date 可以由
Client 作为一次 anchored request 发送；如果 Server 返回
`400 ledger-validation-failed` 且 `details.field = "anchorDate"`，Client
必须将 URL canonicalize 为 `/ledger`，然后重新请求默认的 Ledger today
projection。Client 不得用浏览器当前日期替代 Server 的判断。

### 11.2 Response context metadata

优先继续复用 `LedgerOverviewDto`，不为同一 Dashboard 创建第二套 Overview DTO。

以下字段根据 `anchorDate` 改变：

```text
cashflow
categoryBreakdown
periods
trend
recentTransactions
```

以下字段继续表示当前状态：

```text
assetTotalMinor
liabilityTotalMinor
netWorthMinor
accounts
```

`LedgerOverviewDto` 必须暴露以下 authoritative context metadata：

```ts
context: {
  anchorDate: string
  todayDate: string
  isToday: boolean
  scope: LedgerOverviewScope
}
```

这里的 `todayDate` 是 Server 根据注入的当前时间和
`LedgerSettings.timezone` 计算出的 Ledger today，而不是 Browser today。
如果现有 wire DTO 约定要求使用平铺字段，也必须等价暴露这四个字段；
不得省略 `todayDate` 或让 Browser 仅根据自己的输入猜测 Server 实际采用
的 anchor date。Server response 是最终 authority。

`todayDate` 至少用于：

- Date Picker 的 `max`；
- 判断当前是否为历史模式；
- “回到今天”的目标日期；
- 对合法 future query 的 UX 预判。

这些用途不能依赖 Browser clock。即使 Client 已经根据已知的
`todayDate` 阻止了 Date Picker 选择，Server 对 future `anchorDate` 的
校验仍必须保留。

### 11.3 Week boundary 与 exclusive `endAt`

Week semantics 在本 PRD 中正式冻结为 Monday → Sunday。`week.start` 是
`anchorDate` 所在周的 Monday 00:00，`week.end` 是下一周 Monday 00:00 的
exclusive boundary。Client 不得采用 Sunday-start、browser locale week rule
或 locale-dependent first day of week；Ledger Server 是唯一的 week boundary
authority。

例如 `anchorDate=2026-08-20` 时：

```text
week.start = 2026-08-17 00:00
week.end   = 2026-08-24 00:00 exclusive
```

内部 period 使用 `[startAt, endAt)`，用户可见日期为：

```text
2026年8月17日 – 8月23日
```

不得直接把 exclusive `endAt` 显示成 8 月 24 日。

### 11.4 Performance

每次 `anchorDate` 或 `scope` 改变，不得 fetch 全部 Transactions。主要请求保持 projection request：

```http
GET /api/ledger/overview
```

数据库继续通过时间范围查询完成统计。实现阶段需要审计现有 `occurredAt` / index strategy；如果现有索引已经满足要求，不增加 migration。本 PRD 不预设必须修改 schema。

### 11.5 Backward compatibility

现有 `GET /api/ledger/overview?scope=month` 继续有效，语义等价于 Ledger timezone 下 today 的 month projection。已有 caller 不应因为新增 `anchorDate` 被强制修改。

## 12. Loading、竞态与错误体验

### 12.1 Loading

用户从 2026-09-05 切换到 2026-08-20 时，历史期间相关区域进入 Loading。Date control 可以立即反映选择，但不能在没有任何 loading indication 的情况下显示旧日期的内容。新 projection 到达后替换相关区域。

当前状态类数据（总资产、总负债、账户余额）不需要随 anchorDate request 闪烁。

### 12.2 Request race

用户快速选择 8 月 20 日、7 月 10 日、6 月 15 日时，旧请求不能覆盖最新日期。最终 UI 必须展示 6 月 15 日对应的 projection。使用当前项目适合的 request epoch、cancellation 或 latest-request-wins 策略。

### 12.3 Error

如果 `anchorDate=2026-08-20` 的请求失败，保持 2026-08-20 作为当前选择，并显示：

```text
这个期间的数据暂时无法加载。
```

提供“重试”。不得自动回到今天、显示旧日期数据冒充成功、清除用户 route query 或使用 mock fallback。

### 12.4 Empty

合法历史期间没有任何 Transaction 不是 Error。例如：

```text
当日
2024年3月12日

收入         ¥0.00
支出         ¥0.00
收支结余      ¥0.00
```

Category Breakdown：

```text
这段期间还没有收入分类。
这段期间还没有支出分类。
```

Recent Transactions：

```text
截至该日期还没有交易记录
```

## 13. Current snapshot clarity

历史模式下，必须避免用户误以为总资产或账户余额也是 `anchorDate` 当时的值。应显示轻量说明：

```text
当前资产与账户余额保持实时；以下期间数据按 2026年8月20日 浏览。
```

不要加入复杂 warning banner。这是信息说明，不是错误状态。

## 14. Date control placement

Date control 位于期间分析区域顶部，不放到总资产卡、账户管理或 Navbar，避免用户误认为整个 Ledger 都切换成历史 snapshot 模式。

推荐视觉结构：

```text
期间分析

查看日期
[ 2026年8月20日 📅 ]    [ 回到今天 ]

收支
分类
期间摘要
趋势
相关交易
```

## 15. Mobile / Narrow viewport

日期选择器在窄屏下，Date Picker 和“回到今天”可以上下排列，但不能导致 horizontal overflow、金额卡片不可读、回到今天不可访问或日期选择器无法操作。

第一版优先使用可靠的 calendar-date input，不引入大型 Date Picker dependency，除非 Nuvyn 当前已经存在统一日期组件。

## 16. Accessibility

Date control 必须有明确 label：

```text
查看日期
```

不能只有 Calendar icon。历史模式提示、Loading 和 Error 应可被 screen reader 读取。“回到今天”使用真实 `button`。Calendar machine value 使用 `YYYY-MM-DD`，用户展示可以本地化。

## 17. Product decisions

| Decision | Result |
| --- | --- |
| 历史时间模型 | 单一 `anchorDate` |
| 默认日期 | Ledger timezone 下 today |
| 未来日期 | 不允许 |
| URL | `/ledger?date=YYYY-MM-DD` |
| Week boundary | Monday 00:00 → 下一周 Monday 00:00 exclusive；用户可见为 Monday → Sunday |
| 历史标题 | 当日 / 所在周 / 所在月 / 所在年 |
| 今天标题 | 今天 / 本周 / 本月 / 今年 |
| selected cashflow | 跟随 `anchorDate + scope` |
| Category Breakdown | 跟随 `anchorDate + scope` |
| period summaries | 跟随 `anchorDate` |
| trend | 跟随 `anchorDate`，固定为以 anchorDate 所在月为末月的 6 个完整月份 |
| recentTransactions | 截止 `anchorDate` 当天结束的最多 5 笔；只包含 `deletedAt === null`，按 `occurredAt DESC → createdAt DESC → id DESC` 排序，归档 Account / Category 不排除历史记录 |
| `scope=all` | Ledger beginning → `anchorDate` end |
| current asset/account balance | 不历史化，仍表示当前值 |
| frontend aggregation | 禁止 |
| Server timezone authority | 保持 |
| Server today metadata | `todayDate` 必须随 Overview context 返回 |
| 第一版 navigation | Date Picker + 回到今天 |
| previous/next navigation | Deferred |
| arbitrary range | Deferred |

## 18. Legacy route compatibility

现有 `/bills` 到 `/ledger` 的 compatibility strategy 保持不变。若 legacy URL 带合法 `?date=2026-08-20`，redirect 应保留 query。

## 19. Acceptance criteria

### Scenario A — Default Today

Given：

```text
Ledger timezone = Asia/Shanghai
Ledger today = 2026-09-05
```

When 打开 `/ledger`，Date control 为 `2026-09-05`，标题为“今天、本周、本月、今年”，所有期间型 Dashboard 数据与现有默认行为一致。

### Scenario B — Historical Date

When 用户选择 `2026-08-20`，URL 为 `/ledger?date=2026-08-20`，期间摘要为：

```text
当日
2026年8月20日

所在周
2026年8月17日 – 8月23日

所在月
2026年8月

所在年
2026年
```

selected `month` cashflow 和 Category Breakdown 都属于完整的 2026 年 8
月，而不是只统计 8 月 1 日至 8 月 20 日；selected `week` 同理统计
`2026-08-17` 至 `2026-08-23` 的完整自然周，即 Monday 00:00 至下一周
Monday 00:00 的 `[startAt, endAt)` 区间。

### Scenario C — Reload

Given `/ledger?date=2026-08-20`，Browser reload 后仍显示 `anchorDate=2026-08-20`，不得回到今天。

### Scenario D — Back / Forward

用户从 8 月 20 日切换到 7 月 10 日后，点击 Browser Back 恢复 8 月 20 日，点击 Forward 恢复 7 月 10 日，projection 同步恢复。

### Scenario E — Return Today

Given `/ledger?date=2026-08-20`，点击“回到今天”后 URL 为 `/ledger`，标题恢复“今天、本周、本月、今年”。

### Scenario F — Historical All

Given `anchorDate=2025-06-15`、`scope=all`，cashflow 和 Category Breakdown 只统计 Ledger beginning 至 2025-06-15 当天结束，不包含 2025-06-16 之后的数据。

### Scenario G — Timezone

同一个真实 UTC 时刻在 `Asia/Shanghai` 为 9 月 6 日、在 `America/Los_Angeles` 为 9 月 5 日。当 Ledger timezone 为 `Asia/Shanghai` 时，today 和 day boundaries 必须按 9 月 6 日处理，Browser timezone 不影响 projection。

### Scenario H — Cross-year Week

当 anchorDate 位于跨年周时，UI 正确显示：

```text
2026年12月28日 – 2027年1月3日
```

该周固定从 Monday 00:00 开始，到 2027 年 1 月 4 日 Monday 00:00
exclusive 结束；不得依据 browser locale 或其他 locale week rule 改变边界。

不能省略第二个年份造成歧义。

### Scenario I — Current Snapshot

用户浏览 `2025-06-15` 时，总资产、总负债、净资产和 Account current balances 仍为当前真实值，同时 UI 明确说明这些不是 2025-06-15 的历史资产 snapshot。

### Scenario J — Empty Historical Date

当 `anchorDate=2024-01-01` 且此前没有交易时，期间摘要正常显示收入、支出和结余为零，且不是 Error。

### Scenario K — Request Race

快速选择 `2026-08-20`、`2026-07-20`、`2026-06-20` 时，即使 8 月 request 最后返回，UI 最终仍保持 6 月 20 日的 projection。

### Scenario L — Invalid URL

访问 `/ledger?date=invalid` 或 `/ledger?date=2026-99-99` 时，Client 不
发送 anchored request，不 crash、不进入 Error page，直接 canonicalize 到
`/ledger`，再用 Server 返回的 `todayDate` 请求并显示当前 Dashboard。

访问格式合法但晚于 Server `todayDate` 的 URL 时，Server 返回
`400 ledger-validation-failed`（`details.field = "anchorDate"`）；Client
随后 canonicalize 到 `/ledger`，重新请求 Ledger today 的默认 Dashboard，
不得显示 stale historical data，也不得用 Browser clock 自行决定结果。

### Scenario M — Six-month Trend

Given `anchorDate=2025-06-15`，Trend 必须展示 2025 年 1 月至 6 月共 6
个完整 calendar months，最后一个月为 anchorDate 所在月，不得使用当前月
作为历史趋势的结束月。

### Scenario N — Recent Transactions

Given `anchorDate=2025-06-15`，Recent Transactions 必须返回截至
`2025-06-16 00:00` exclusive 之前，按 `occurredAt DESC → createdAt DESC →
id DESC` 排序的最多 5 笔 Transactions。结果只包含 `deletedAt === null`；
关联 Account 或 Category 已归档时，仍必须保留该历史 Transaction。

## 20. Privacy 与 Analytics

本功能不要求新增 telemetry。不得为了本功能将用户浏览过的历史财务日期和财务内容发送到第三方 telemetry。

不得将 `anchorDate`、financial summary、category breakdown 或 transaction data 发送到 Ledger 功能之外不必要的外部服务。

## 21. Open questions

以下为非阻塞的 visual questions：

1. Date Picker 使用原生 date input 还是 Nuvyn 已有日期组件；
2. 历史模式提示放在 Date control 下方还是 Period section header；
3. “当日 / 所在周 / 所在月 / 所在年”是否保持当前 card title 字号；
4. Date Picker 是否显示 Calendar icon。

以下不是 Open Question，已经冻结：

```text
单一 anchorDate
Server authority
URL query
未来日期禁止
all 截止 anchorDate
selected cashflow/category → anchorDate + scope
period summaries/trend → anchorDate
recentTransactions → 截止 anchorDate 当天结束
当前资产余额不历史化
```

## 22. Product Review exit criteria

本 PRD 已达到 Product Review: Accepted。Review 已确认：

- 一个统一 `anchorDate`；
- 当前状态与历史期间数据边界清晰；
- Dashboard 不存在互相矛盾的时间上下文；
- `/ledger?date=` 行为明确；
- refresh / back / forward 行为明确；
- `scope=all` 历史语义明确；
- recent transactions 历史语义明确；
- trend 历史语义明确；
- Week boundary 明确冻结为 Monday → Sunday，`week.start` 为 Monday 00:00，
  `week.end` 为下一周 Monday 00:00 exclusive，且由 Ledger Server authoritative；
- Recent Transactions 明确冻结为最多 5 笔，`limit = 5`，只包含
  `deletedAt === null`，使用 `occurredAt DESC → createdAt DESC → id DESC` 排序，
  归档 Account / Category 不排除历史记录；
- `today` / `week` / `month` / `year` 为 anchorDate 所属的完整自然期间；
- Overview response 提供 Server-authoritative `todayDate`；
- future date 明确禁止；
- Ledger timezone 仍为唯一 calendar authority；
- Server 仍为 projection authority；
- Frontend 不自行聚合 Transaction；
- 不需要历史 balance snapshot 才能交付；
- 无阻塞 Product Open Question。

本文件当前状态为 `Product Review: Accepted`。
