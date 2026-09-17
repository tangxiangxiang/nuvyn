# Nuvyn Ledger v1 Product Requirements

> [!IMPORTANT]
> **Historical Planning Baseline / Implemented and evolved.** 本文保留 Ledger v1 的产品定位与设计决策，不是当前用户行为或 runtime authority。当前行为请参阅 [Ledger 用户指南](../user-guide/ledger.md) 和 [Ledger Architecture](../architecture/ledger.md)。

## 文档信息

- **状态：** Historical Planning Baseline / Implemented and evolved；原 Product Review: Accepted
- **日期：** 2026-09-02
- **评审基线：** `554091bca76b71b05b4ae73f425b55477e515b79`（`main`）
- **Remediation baseline：** `554091bca76b71b05b4ae73f425b55477e515b79`
- **第二轮 Review baseline：** `fbab19b941a7a47277584563bad24e426a9b07c2`
- **范围：** Ledger v1 的产品定位、领域模型、数据生命周期、信息架构和分阶段边界
- **实现约束：** 本文及其 L0 子 PRD 只定义契约，不直接修改生产代码、SQLite migration、API、测试或 UI
- **配套文档：** [`L0 — Ledger Foundation PRD`](ledger-l0-foundation-prd.md)

本文是 Ledger v1 范围内的产品 source of truth。本轮 Architecture Review remediation 已关闭产品层 P0 契约缺口，Product Review 结果为 PASS / Accepted。Nuvyn 的系统级产品定位和 Workspace 总表以 [Nuvyn — Personal OS](../product.md) 为准；本文只约束 Ledger 的财务语义。后续 Implementation Plan 可以决定实现顺序和文件落点，但不能改变本文或 L0 子 PRD 的财务语义；如果实现证据要求改变契约，必须先修订并重新评审 PRD。

## 1. 产品定位

Ledger 是 Nuvyn 内置的个人财务账本。它不是专业会计系统，也不是银行账户聚合器，而是一个让单个 owner 回答以下问题的 Workspace：

> 我现在有多少钱、欠多少钱、钱放在哪里、最近钱从哪里来，又花到哪里去了？

Nuvyn 的四个核心一级 Workspace 形成清晰分工：

```text
Note   → 我知道什么
Diary  → 我经历了什么
Ledger → 我的钱发生了什么
Board  → 我正在思考和构思什么
```

Ledger 继续遵循 Nuvyn 的产品边界：single-owner、self-hosted、private personal workspace。它不引入多人共享、租户、角色或外部金融账户授权模型。

## 2. 当前状态与问题

当前 Ledger 的可见 UI 仍以历史 Bills 命名实现，是稳定的 client-side 原型：

| 位置 | 当前事实 | v1 影响 |
| --- | --- | --- |
| `src/views/BillsView.vue` | Dashboard 由资产概要、分类占比、时间段、趋势和最近交易卡片组成 | 现有布局可作为 Overview 基线，但数据源必须替换为真实聚合 |
| `src/views/BillsTransactionsView.vue` | 只展示 mock 交易；新增、支出/收入筛选和日期筛选仍 disabled | Transactions 是 v1 的核心写入与查询页面 |
| `src/features/bills/mockData.ts` | 明确声明 fixture 无持久化；交易类型只有 `income/expense`；金额是 JS `number` | 不能直接作为生产领域模型或金额存储协议 |
| `src/features/bills/aggregations.ts` | 聚合的是已渲染账户的 mock balance，并允许 fallback debt | 生产 Dashboard 必须从 SQLite 账户和交易记录推导，不保存统计快照 |
| [`src/router/index.ts`](../../src/router/index.ts) | 当前路由为 `/bills` 和 `/bills/transactions` | `Ledger` 是 canonical domain name；旧 Bills 路径在独立迁移任务前保留兼容策略 |
| [`server/db.ts`](../../server/db.ts) 与 `server/migrations/` | 已有有序 SQLite migration、WAL、foreign keys 和测试数据库注入能力 | Ledger 可以沿用现有存储边界，不需要 Markdown 账单文件 |

当前原型可以说明视觉方向，但不能证明以下产品闭环已经成立：账户余额、负债、信用卡还款、转账、余额调整、CRUD、重启持久化和 Dashboard 真实聚合。

## 3. v1 目标

Ledger v1 只解决五件事：

1. 管理账户。
2. 记录每一笔资金变化。
3. 正确区分收入、支出、转账和余额调整。
4. 从 opening balance 与交易推导账户余额、资产、负债和净资产。
5. 通过 Dashboard 和交易查询让 owner 看懂财务状态。

### 3.1 v1 成功标准

- owner 可以创建资产账户和负债账户，并设置 opening balance。
- owner 可以创建、编辑和软删除收入、支出、转账记录。
- 中国银行 → 支付宝的转账不增加收入或支出；中国银行 → 信用卡的还款同时减少资产和负债。
- 信用卡消费增加负债；用资产账户还款不会再次增加支出。
- 账户余额、资产、负债、净资产和所有 Dashboard 数字在刷新或重启后保持一致。
- 余额不允许通过单独的“当前余额”字段被偷偷覆盖；实际余额差异必须形成可追踪的 Adjustment record。
- 无历史的账户和分类可以物理删除；有历史的 Account 只能在当前余额为零时 archive，有历史的 Category 只能 archive；两者都提供 restore；交易本身也不物理删除。
- 所有金额在持久化和 API 边界都保持精确到最小货币单位，不使用浮点金额。
- 交易类型创建后 immutable；误记类型必须删除旧记录并创建新记录。
- Adjustment 的财务字段创建后 immutable，只允许修改 note；需要重新核对时创建新的 Adjustment。

## 4. 非目标

v1 不包括：

- 预算、预算提醒、储蓄目标或财务规划；
- 投资组合、股票、基金、收益率、贷款摊销和利息计划；
- 银行自动同步、OAuth、银行卡授权或账户聚合；
- OCR、AI 自动分类、自动导入或自动匹配；
- 发票、报销、应收应付、多人共享、权限和团队账本；
- recurring/scheduled transaction；
- split transaction（一笔交易拆多个账户或多个分类）；
- 多币种换算、汇率、跨币种转账；
- 复杂复式会计科目、借贷凭证和专业报表；
- 在 Markdown 中保存 Ledger record；
- L0 阶段的新 UI、mock 数据迁移或 Bills 文件一次性重命名。

## 5. 产品原则

### 5.1 Records 是唯一事实来源

Dashboard 不保存 `monthlyExpense`、`netAssets` 等统计结果。所有展示值都从以下链路推导：

```text
Accounts + Transactions
          ↓
      Balance rules
          ↓
      Aggregations
          ↓
        Dashboard
```

可以为查询建立索引或短生命周期缓存，但不能把缓存当作可编辑的财务事实；缓存失效后必须能从原始记录重建。

### 5.2 Transfer 是独立语义

Transfer 是账户之间的位置变化，不是收入，也不是支出。所有账户内转移、信用卡还款、钱包充值都使用 Transfer；任何把还款再次计入支出的实现都不符合 v1。

### 5.3 余额可解释

账户的当前余额是只读 projection。任何改变余额的动作必须能回答“哪一笔记录造成了这个变化”。Opening balance、普通交易和 Balance Adjustment 都要保留生命周期信息。

### 5.4 金额精确

SQLite 和 API 使用整数最小货币单位，例如 CNY ¥38.50 存为 `3850`。JS `number` 只允许用于展示层的格式化结果，不得作为数据库金额或服务端计算的权威表示。

### 5.5 服务端是财务规则 authority

浏览器可以做表单校验和即时预览，但账户关系、分类类型、余额效果、软删除、版本冲突和 Adjustment delta 必须由服务端在 SQLite 写事务中校验。

### 5.6 历史优先于便利

删除是生命周期状态，不是物理擦除。账户和分类一旦有历史记录，就不能物理删除；Account 只有在当前余额为零时才能通过显式 archive endpoint 归档，并通过显式 restore endpoint 恢复。交易删除保留 `deletedAt` 并进入 terminal `DELETED` 状态，所有正常聚合排除已删除记录。

### 5.7 Create retry 必须安全

所有会创建 Ledger 持久化记录的 POST mutation 使用持久化的 `Idempotency-Key`。同一 instance、operation scope 和 key 的 canonical request 只能成功一次；idempotency record 必须保存第一次成功响应的 HTTP status 和 canonical safe JSON body，成为 response replay record，而不只是 result identity。服务端先查找既有 record，相同请求重试直接 replay 保存的 status/body，不重新执行领域 mutation，也不通过 result ID 读取可变资源来重建响应；不同请求复用同一 key 返回确定性的 conflict。session、cookie、SQL details 和 request-specific volatile headers 不进入 response snapshot。idempotency claim、response snapshot 与 financial mutation 在同一 SQLite write transaction 中提交。

## 6. v1 领域模型

### 6.1 Ledger settings

一个 Nuvyn instance 只有一个 Ledger 配置：

```ts
LedgerSettings {
  baseCurrency: string   // ISO 4217 uppercase, v1 建立后不可随意切换
  currencyExponent: number // derived from ISO 4217; read-only projection
  timezone: string       // IANA timezone，所有 period 边界使用它
  version: number
  createdAt: number
  updatedAt: number
}
```

v1 是单一 reporting currency。账户保留 `currency` 字段以便未来扩展，但当前所有账户和交易必须与 `baseCurrency` 一致；系统不做 FX conversion。`baseCurrency` 与 `timezone` 都遵循同一 frozen lifecycle：Ledger 尚未成功创建过任何 Account 时可以通过 Settings 修改；第一条 Account 创建成功后，两者都 immutable。这个 freeze marker 是单调的，即使之后物理删除了一个无历史 Account 也不会解冻；是否已经有 Transaction 不影响结果。v1 不增加 `openingAt` UTC column，也不通过 timezone migration 重新解释 opening boundary。

```text
No Account has ever been created
  → baseCurrency / timezone can change
First Account created
  → baseCurrency / timezone frozen
```

交易时间以 UTC instant 持久化，展示和 period 边界使用冻结的 Ledger timezone。`currencyExponent` 按 ISO 4217 currency definition 推导，不允许客户端覆盖；例如 CNY/USD 为 2、JPY 为 0、KWD 为 3。UI 的 decimal parsing 和 formatting 必须使用该 exponent，不能假设所有货币都是两位小数。Settings PATCH 在 frozen state 下如果请求不同的 timezone 返回 `409 ledger-timezone-locked`；如果请求不同的 baseCurrency 返回 `409 ledger-base-currency-locked`，两者都不得修改数据库。

对应的 settings API 为 `GET /api/ledger/settings`、首次初始化的 `POST /api/ledger/settings` 和带 `expectedVersion` 的 `PATCH /api/ledger/settings`。Settings POST 使用 `Idempotency-Key`；首次 Account 创建成功后，timezone/baseCurrency 的改变都被拒绝。

### 6.2 Account

Account 表示钱在哪里，或债务欠在哪里。

```ts
LedgerAccount {
  id: string
  name: string
  type: 'cash' | 'bank' | 'wallet' | 'credit_card' | 'loan' | 'other'
  nature: 'asset' | 'liability'
  openingBalanceMinor: number
  openingDate: string       // YYYY-MM-DD, Ledger timezone
  currency: string
  note?: string
  archivedAt?: number
  version: number
  createdAt: number
  updatedAt: number
}
```

`type` 和 `nature` 不是同一个字段：前者描述账户是什么，后者描述它在财务上如何计入净资产。内置类型有默认组合：`cash/bank/wallet → asset`，`credit_card/loan → liability`；`other` 由 owner 选择。已产生交易后，`nature` 和会改变历史余额解释的字段不可直接修改。

Account name 不要求全局唯一；两个“中国银行”可以通过 type、note、账号尾号和 UI context 区分。Account ID 是稳定身份，不因 rename 改变。

金额采用账户的 natural balance 表示：资产账户正数代表持有，负数可以表示透支；负债账户正数代表欠款，负数可以表示信用余额。Dashboard 的总额仍按 `nature` 计算，不能用“所有 balance 直接相加”代替资产减负债。

Opening balance 是账户在 opening date 开始时的起点，不是隐藏交易。已有交易后不能直接编辑 opening balance；需要通过 Adjustment 修正。

Account lifecycle 使用显式 endpoint：

```text
ACTIVE  --POST /api/ledger/accounts/:id/archive-->  ARCHIVED
ARCHIVED --POST /api/ledger/accounts/:id/restore--> ACTIVE
```

任何 Account（无论是否有历史）只有 `currentBalanceMinor === 0` 时才能 archive；非零资产或非零负债都返回 `409 ledger-account-nonzero-balance`。无历史的 Account 可以 DELETE；有任何历史 transaction row（包括已删除记录）后不能 DELETE。Archived Account 保留历史、current balance 仍为零并继续参与当前 projection/历史查询，但不出现在默认 Account list，也不能被新 transaction 引用。涉及 archived Account 的交易 PATCH 只允许修改 note/payee；任何其他字段或 DELETE 都必须先 restore，避免重新解释或移除零余额 gate 所保护的 balance effect。Archive/restore 都是显式 endpoint，要求 `expectedVersion`；archived Account restore 成功后 version 增加，active Account restore 是 `200` 幂等 no-op 且 version 不变，恢复后可重新用于新 transaction。

Account rename 不改变 stable ID；历史 transaction 在 v1 通过 stable ID 关联当前 Account，并显示当前 Account name，不保存不可变的 name snapshot。

### 6.3 Transaction

Transaction 是 Ledger 的中心。v1 的类型为：

| 类型 | 账户字段 | 分类 | 余额效果 | 收支统计 |
| --- | --- | --- | --- | --- |
| `income` | 一个 `accountId` | 必须是 income category | 资产 `+amount`；负债 `-amount` | income `+amount` |
| `expense` | 一个 `accountId` | 必须是 expense category | 资产 `-amount`；负债 `+amount` | expense `+amount` |
| `transfer` | `fromAccountId` + `toAccountId` | 必须为空 | from 应用 outgoing delta；to 应用 incoming delta（按账户 nature 取符号） | 不计入 income/expense |
| `adjustment` | 一个 `accountId` | 必须为空 | `target - calculated` | 不计入 income/expense |

普通记录的金额 `amountMinor` 必须大于零；Adjustment 的 `amountMinor` 是有符号 delta，不能为零。每笔 income/expense 只有一个账户和一个分类；v1 不做 split transaction。

典型例子：

```text
expense  星巴克 ¥38       支付宝       balance -38，expense +38
income   工资 ¥21,800      中国银行     balance +21,800，income +21,800
transfer 中国银行 → 支付宝 ¥1,000       前者 -1,000，后者 +1,000
transfer 中国银行 → 招商信用卡 ¥3,000   资产 -3,000，负债 -3,000
expense  买电脑 ¥3,000     招商信用卡   负债 +3,000，expense +3,000
```

Transfer 不需要 Category。信用卡还款是 Transfer；真正的消费才是 Expense。

Transaction 至少包含：

```ts
LedgerTransaction {
  id: string
  type: 'income' | 'expense' | 'transfer' | 'adjustment'
  amountMinor: number
  accountId?: string
  fromAccountId?: string
  toAccountId?: string
  categoryId?: string
  occurredAt: number
  payee?: string
  note?: string
  adjustmentCalculatedBalanceMinor?: number
  adjustmentTargetBalanceMinor?: number
  deletedAt?: number
  version: number
  createdAt: number
  updatedAt: number
}
```

Transaction 的 lifecycle 只有两态：

```text
ACTIVE
  | PATCH（只更新允许的字段）
  | DELETE（soft delete）
  v
DELETED  // terminal
```

`Transaction.type` 创建后 immutable。它决定字段 discriminator、账户 effect、分类契约和 cashflow 语义；PATCH 试图把 expense 改成 income、transfer 或 adjustment 等任何其他类型时返回 `409 ledger-transaction-type-immutable`。类型记错时，删除旧记录并创建新记录。

DELETED transaction 保留在 SQLite，排除默认查询、余额和所有 aggregation，且不可 PATCH。v1 不支持 restore transaction。对 DELETED state 的检查优先于 PATCH payload 校验，因此任何已删除交易的 PATCH 都返回 `409 ledger-transaction-deleted`。DELETE 请求仍必须带 `expectedVersion`；ACTIVE 删除校验该版本，已删除记录的重复 DELETE 只要求字段存在并采用 terminal 幂等语义，返回 `200` 和当前 deleted representation，不重复产生任何 financial effect。

Adjustment 是 reconciliation record。创建请求必须提供 `targetBalanceMinor` 和 `expectedCalculatedBalanceMinor`；服务端在 `BEGIN IMMEDIATE` 内重新推导 actual calculated balance，预期值不一致返回 `409 ledger-balance-conflict`，不得基于新值继续重算。目标等于 actual 时返回确定性的 `200` no-op，不创建零金额 transaction：`{ adjustment: null, account: authoritativeAccountProjection, noOp: true }`。创建后 `type`、`accountId`、`amountMinor`、`occurredAt`、`adjustmentCalculatedBalanceMinor` 和 `adjustmentTargetBalanceMinor` 都 immutable；只允许 PATCH `note`，其他财务字段修改返回 `409 ledger-adjustment-immutable`。Adjustment 可以 DELETE，但必须显示显式 warning；删除会移除它的 balance effect、递增 version，并重新推导 authoritative balance。已删除 Adjustment 也不可 PATCH，重复 DELETE 仍返回当前 deleted representation；再次核对必须创建新的 Adjustment。

所有更新、删除和 lifecycle mutation 都要求 `expectedVersion`：Settings/Account/Category/Transaction 的 PATCH、Transaction DELETE、Account/Category archive 和 restore 均适用。所有 create mutation 使用 `Idempotency-Key`，不使用 `expectedVersion`；Adjustment 同时使用 `Idempotency-Key` 和必填的 `expectedCalculatedBalanceMinor`。

### 6.4 Category

Category 回答“钱花在什么地方”或“收入来自什么地方”；Account 回答“钱从哪里扣/进入哪里”。两者不能互换。

```ts
LedgerCategory {
  id: string
  kind: 'income' | 'expense'
  name: string
  normalizedName: string
  archivedAt?: number
  version: number
  createdAt: number
  updatedAt: number
}
```

v1 默认提供以下一级分类；owner 可以在 Categories 中增删改和 archive：

```text
Expense: 餐饮、交通、购物、住房、日用、娱乐、医疗、教育、旅行、人情、其他
Income:  工资、奖金、投资收益、兼职、退款、红包、其他
```

v1 只支持 flat categories，不包含 `parentId` 或层级树；未来若需要二级分类，必须通过新的 migration 和单独 PRD 增加。Category kind 一旦被交易引用不可切换；分类 rename 保持 category ID 不变，历史交易在 v1 显示当前分类名称；被历史记录引用的分类不能物理删除，只能 archive，并可通过显式 restore endpoint 恢复。Archive 不释放 `UNIQUE(kind, normalizedName)` identity，因此之后仍不能创建同一 normalized identity；archived Category restore 保持原 stable ID 并递增 version，active Category restore 是 `200` 幂等 no-op 且 version 不变。Transfer 和 Adjustment 没有分类。

## 7. 余额、净资产与聚合

### 7.1 账户余额

对账户 `a`：

```text
currentBalance(a)
  = openingBalance(a)
  + Σ active transaction effects for a
```

资产和负债的 transaction effect 由第 6.3 节表格决定。`currentBalance` 不作为可编辑的数据库事实保存；如未来增加 materialized projection，必须有可重建和失效策略，并且不能改变 API 语义。

### 7.2 资产、负债、净资产

```text
totalAssets
  = Σ currentBalance(a) where a.nature = asset

totalLiabilities
  = Σ currentBalance(a) where a.nature = liability

netWorth
  = totalAssets - totalLiabilities
```

如果账户出现透支或信用余额，账户详情需要标明该状态；v1 不通过静默取绝对值掩盖异常，也不把 liability balance 当作 asset balance 直接相加。

### 7.3 Period boundary

所有 period 使用 Ledger timezone 和 half-open interval `[start, end)`：

| Period | 范围 |
| --- | --- |
| today | 当地日 `00:00` 到下一日 `00:00` |
| week | 周一 `00:00` 到下一个周一 `00:00` |
| month | 当月第一日 `00:00` 到下月第一日 `00:00` |
| year | 当年 1 月 1 日 `00:00` 到下一年 1 月 1 日 `00:00` |

v1 的 week starts Monday。恰好发生在 `start` 的交易属于该 period；恰好发生在 `end` 的交易属于下一个 period，不得同时计入两个 period。

### 7.4 Dashboard scope 语义

`GET /api/ledger/overview?scope=today|week|month|year|all` 中，scope 只影响：

- `cashflow`；
- `categoryBreakdown`。

scope 不影响：

- `assetTotalMinor`、`liabilityTotalMinor`、`netWorthMinor`；
- accounts 及其 current balances；
- periods（始终返回 today/week/month/year 四张各自按自身范围计算的摘要）；
- trend；
- recentTransactions。

因此 Dashboard 的职责固定为：资产概要看当前 projection；收支占比看选中的 scope；四张 period card 看固定 period；趋势看最近月份；最近交易看最新记录。`all` 表示全部 active 历史 income/expense records，不是 mock 年度数据。recentTransactions 始终返回最近 5 条 active records，不受 scope 过滤。

### 7.5 Dashboard 收支

所有 period 和分类统计都按 Ledger timezone 计算，并排除 `deletedAt IS NOT NULL` 的记录：

- income 只来自 `income` transactions；
- expense 只来自 `expense` transactions；
- transfer 和 adjustment 不进入 income/expense 总额；
- archived category 仍出现在历史统计中；历史交易按稳定 category ID 关联当前分类名称，但不能让历史金额消失；
- 最近交易显示最近 5 条 active records，按 `occurredAt DESC`，同时间使用稳定 tie-breaker；
- 趋势 v1 显示最近 6 个日历月的 income/expense，包括当前月，而不是过去 180 天；
- 趋势的每个月使用 `[monthStart, nextMonthStart)`；
- “全部”表示所有可用历史记录，不是 mock 年度数据。

### 7.6 Account Detail movement summary

Account Detail 的本月 movement summary 不是 Dashboard 的 income/expense summary，而是账户余额 movement。统一 projection 字段为：

```ts
{
  balanceIncreaseMinor: number
  balanceDecreaseMinor: number
}
```

对每笔 active、非 Adjustment transaction，先按 Account nature 计算 natural-balance delta：正 delta 进入 `balanceIncreaseMinor`，负 delta 的绝对值进入 `balanceDecreaseMinor`。因此：

| Account | balance increase 的 UI 文案 | balance decrease 的 UI 文案 |
| --- | --- | --- |
| asset | 流入 | 流出 |
| liability | 新增负债 | 减少负债 |

Asset 的 income/transfer incoming 是流入，expense/transfer outgoing 是流出；liability 的 expense/transfer outgoing 是新增负债，income/transfer incoming 是减少负债。Adjustment 不进入 movement summary，只改变 balance projection。Transfer 进入 movement summary，但仍不进入 Dashboard income/expense。

Account Detail 同时可以显示本月 income/expense，但必须把它们与 movement summary 分开展示，不能把 liability 的 debt movement 误称为个人现金流。

### 7.7 Trend 与排序

trend 默认返回包括当前月在内的最近 6 个 calendar months。例如 Ledger timezone 的当前日期为 `2026-09-02`，月份为 `2026-04`、`2026-05`、`2026-06`、`2026-07`、`2026-08`、`2026-09`。所有月份使用 `[monthStart, nextMonthStart)`。

所有 transaction list、recentTransactions 和 cursor projection 使用同一 canonical order：

```text
occurredAt DESC,
createdAt DESC,
id DESC
```

不能依赖 SQLite unspecified row order。Cursor 至少表达最后一条的 `occurredAt`、`createdAt` 和 `id`，L5 可以决定 opaque encoding，但不能重新定义排序。

### 7.8 不变量

实现和测试必须证明：

1. Transfer 不改变总净资产，也不改变 income/expense 聚合。
2. Income 使净资产增加 `amount`；Expense 使净资产减少 `amount`。
3. 删除或编辑交易后，账户余额和所有相关聚合都从新记录重新计算。
4. 同一笔 Transfer 只能产生一次 from effect 和一次 to effect。
5. Adjustment 的 delta 等于目标余额减去写事务内读取的 calculated balance。

## 8. 信息架构与交互范围

顶部 Nuvyn Navbar 仍只有：

```text
note | diary | ledger
```

进入 Ledger 后使用二级导航：

```text
概览 | 交易 | 账户 | 分类
```

正式 v1 页面：

### 8.1 Overview

保留当前 Dashboard 的整体布局作为基线：

```text
┌──────────────────┬───────────────┐
│ 资产概要          │ 收支占比       │
├──────────────────┴───────────────┤
│ 今天 │ 本周 │ 本月 │ 今年        │
├──────────────────┬───────────────┤
│ 收支趋势          │ 最近交易       │
└──────────────────┴───────────────┘
```

卡片中的数字来自真实 projection/aggregation；scope 切换只更新约定范围内的 cashflow 和 category breakdown，不重新计算当前资产、负债、净资产或最近交易。最近交易点击“查看全部”进入 Transactions。

### 8.2 Transactions

交易页面是 v1 的主要工作区，至少支持：

- 全部、支出、收入、转账筛选；Adjustment 在全部中可见；
- 账户、分类、日期范围筛选；
- 对 payee 和 note 的搜索；
- 新增、编辑和软删除；
- 按本地日期分组，展示账户、分类、金额和记录类型；
- 最近写入后的 authoritative refresh。

“记一笔”使用右侧 Sheet 或 Dialog，不跳完整新页面。普通支出/收入尽量通过金额、账户、分类、保存四个核心动作完成；转账表单切换为 from/to 账户；Adjustment 使用明确的目标余额确认。

交易查询的 `accountId` 筛选匹配该账户作为普通交易账户、Transfer 的 from 或 to；因此账户详情包含 income、expense、transfer incoming/outgoing 和 adjustment。`categoryId` 只匹配 income/expense，Transfer/Adjustment 永不匹配；明确传入 archived category ID 仍可查询其历史 active transactions。默认排除 soft-deleted records，并统一按 `occurredAt DESC, createdAt DESC, id DESC` 排序。

### 8.3 Accounts

Accounts 页面分资产和负债展示账户当前投影余额，支持创建、编辑名称/备注、显式 archive/restore，以及进入账户详情查看本月 movement summary 和该账户全部交易。资产账户显示本月流入/流出；负债账户显示本月新增负债/减少负债；Adjustment 不计入 movement summary。账户已有交易后不提供 Delete；任何非零余额账户都不能 archive。

### 8.4 Categories

Categories 页面按 income/expense 分组，支持创建、编辑显示名称、显式 archive/restore。v1 只有 flat categories，不提供 parent category。引用中的分类不物理删除；archive 不释放 normalized identity，历史统计不能因 archive 消失。

## 9. 数据生命周期与存储边界

Ledger 是结构化关系数据，正式存储在 Nuvyn 的 SQLite 数据库中：

```text
Markdown vault
├── Note
└── Diary

SQLite
├── Nuvyn metadata
├── AI/auth state
└── Ledger
    ├── settings
    ├── accounts
    ├── categories
    ├── transactions
    └── idempotency state
```

Ledger 不写 `ledger/*.md`，也不把交易混入 Note/Diary frontmatter。数据库、WAL/SHM 文件都属于现有 `data/` 备份范围；Ledger 不保存银行密码、支付平台 token 或第三方账户授权信息。SQLite 中还持久化 Ledger create mutation 的 idempotency state；它不是业务财务记录，但必须与对应 mutation 一起备份和恢复。

生命周期规则：

| 对象 | 无历史引用 | 有历史引用 |
| --- | --- | --- |
| Account | 可以物理删除 | 只能在 current balance 为零时 archive；可 restore，历史仍参与查询/净资产 |
| Category | 可以物理删除 | 只能 archive；可 restore，历史交易仍保留关联，identity 不释放 |
| Transaction | 不提供物理删除 | 使用 `deletedAt` 进入 terminal DELETED；正常查询和聚合排除，不可 restore |
| Opening balance | 无交易时可修改 | 通过 Adjustment 修改实际结果 |
| Current balance | 永远不可直接写 | 从 opening balance + active records 推导 |

所有写操作需要 owner session，服务端使用 SQLite transaction。现有 Nuvyn 的 auth、WAL、foreign key、备份和恢复边界继续适用。

所有会创建持久化记录的 create mutation 使用 `Idempotency-Key`：Settings、Account、Category、Transaction 和 Balance Adjustment。key、operation identity/scope、canonical request fingerprint、response status、canonical safe response body 和可选的 result identity 都持久化在 SQLite；response status/body 是 replay authority，result identity 只用于关联或诊断。服务端先查找既有 idempotency record，相同 key + 相同 canonical request 重试时直接 replay 保存的原始 response，不重复执行，也不从当前可变资源重建；即使资源后来被编辑、删除或余额已改变，replay 仍返回第一次 response。相同 key + 不同 request 返回 `409 ledger-idempotency-conflict`。idempotency state 与 financial mutation 必须在同一个 SQLite write transaction 中提交，不能依赖内存；response snapshot 不随 result entity 的物理删除而级联删除。

## 10. Epic Roadmap

### L0 — Foundation

冻结 schema、金额和时间协议、命名、migration 边界、CRUD/API 契约、版本冲突和余额规则。不写新 UI。

### L1 — Accounts

实现账户初始化、CRUD、opening balance、账户详情和 archive/restore。

### L2 — Transactions

实现 income/expense 的创建、编辑、软删除和真实 Transactions 列表。

### L3 — Transfers & Balance Integrity

实现 transfer、信用卡还款、Balance Adjustment、写事务一致性和并发冲突。

### L4 — Dashboard Real Data

将当前 Bills mock Dashboard 切换到真实 aggregation，保留已验证的布局和主题/响应式边界。

### L5 — Filtering & Search

实现交易类型、账户、分类、日期范围和搜索；补齐分页或游标策略。

### L6 — Categories

实现默认分类、flat 分类 CRUD、archive/restore 和历史引用规则。

### L7 — Import / Export

在独立 schema/preview/rollback 契约下加入 CSV 导入导出；不把导入混入 L2/L3 的普通写路径。

### L8 — Backup / Recovery / Hardening

补齐迁移发布、备份恢复演练、跨进程并发、性能、安全、错误恢复和 release evidence。

## 11. 分阶段完成定义

Ledger v1 只有在以下条件同时满足时才算完成：

- L0–L6 的产品能力和数据库/API 契约已通过各自 phase gate；
- Dashboard 不再依赖 `billsMockData`；
- migration、API、服务端聚合和 UI 均使用同一金额/余额语义；
- transfer、信用卡还款、expense on liability、Adjustment 和 soft delete 有回归测试；
- 账户、分类、交易在刷新、重启、备份恢复后保持可解释；
- 仍明确不支持的 L7/L8 能力有用户可见或文档化边界。

Product Review 已 Accepted；production implementation not yet authorized。下一步是在两篇 PRD 的契约不再变化的前提下，单独编写 Ledger L0 Foundation Implementation Plan；本轮不代表已实现、已完成或已发布。
