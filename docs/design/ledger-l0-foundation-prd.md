# L0 — Ledger Foundation PRD

> [!IMPORTANT]
> **Historical Planning Baseline / Implemented and evolved.** 本文保留 L0 领域与架构决策的历史记录；当前实现已继续演进。当前行为请参阅 [Ledger 用户指南](../user-guide/ledger.md) 和 [Ledger Architecture](../architecture/ledger.md)。

## 文档信息

- **状态：** Historical Planning Baseline / Implemented and evolved；原 Architecture Review: Accepted
- **日期：** 2026-09-02
- **依赖：** [Nuvyn Ledger v1 Product Requirements](ledger-v1-prd.md)
- **Remediation baseline：** `554091bca76b71b05b4ae73f425b55477e515b79`
- **第二轮 Review baseline：** `fbab19b941a7a47277584563bad24e426a9b07c2`
- **范围：** Ledger 的领域基础、SQLite schema 契约、API 契约、金额/时间协议、生命周期与测试门槛
- **实现约束：** L0 不写新 UI，不切换 Dashboard 数据源，不导入 mock 数据，不一次性重命名 Bills 文件

本文不是 Implementation Plan。它冻结“实现必须表达什么”。本轮 Architecture Review remediation 已关闭列出的 P0 契约缺口，Architecture Review 结果为 PASS / Accepted；下一步再单独拆 Implementation Plan，决定 migration 文件、服务模块、路由文件、测试文件和提交顺序。

## 1. L0 目标

L0 完成后，后续开发不得再重新解释以下五个概念：

~~~text
Account
Transaction
Transfer
Category
Balance
~~~

具体需要冻结：

1. canonical domain name 与 Bills 兼容边界；
2. 金额的精度、币种和时间表示；
3. Account 的 natural balance 与资产/负债效果；
4. Transaction discriminated union 和字段约束；
5. opening balance、Adjustment、软删除和版本冲突；
6. SQLite 表、外键、索引和 migration 原则；
7. owner-authenticated API 的请求、响应和错误契约；
8. 从原始 records 推导余额和 Dashboard 的测试不变量。

## 2. 现状审计

### 2.1 已有可复用基础

- server/db.ts 已经按编号加载 server/migrations/*.sql，使用 SQLite WAL、foreign_keys=ON，并提供 in-memory/test DB 注入。
- docs/architecture/overview.md 和 docs/architecture/storage.md 已经确立“Markdown 文件 + SQLite metadata + vault Git”的双存储边界。
- 现有 API 由 Hono server 统一处理，owner session 是服务端的访问边界。
- e2e/ledger-workspace.spec.ts 已验证 Ledger 在共享 Nuvyn App Shell 中运行，而不是另一个 Vault shell。

### 2.2 当前原型不能直接升级为生产模型

- `src/features/bills/mockData.ts` 的注释明确说明数据是 client-side fixtures、无 persistence；BillsTransactionType 只有 income | expense。
- BillsAccount.balance 和交易 amount 是 JS number；这不满足精确金额的 SQLite/API 契约。
- mock liability balance 以正数 debt 展示，当前聚合函数直接求和；代码没有信用卡消费/还款的自然余额效果。
- `src/views/BillsTransactionsView.vue` 的新增、支出、收入、日期操作仍 disabled，并提示后续开放。
- 当前路由仍是 /bills 和 /bills/transactions，不存在 Ledger API、Ledger migration 或真实 CRUD。

因此 L0 不尝试“把 mock 类型加几个 union member”来冒充领域基础；mock 只作为 UI characterization fixture 保留。

## 3. L0 决策

### 3.1 命名与兼容策略

Ledger 是唯一 canonical product/domain name。新领域类型、服务、表和 API 使用 Ledger 前缀或 ledger_ 命名：

~~~text
LedgerAccount
LedgerTransaction
LedgerCategory
ledger_accounts
ledger_transactions
ledger_categories
/api/ledger/...
~~~

现有 BillsView.vue、BillsTransactionsView.vue、src/features/bills/、src/components/bills/、/bills 路由和已有测试属于 prototype compatibility surface。L0 不做大规模 rename，也不删除 /bills；后续 UI migration 必须单独定义：

- canonical 新路由为 /ledger、/ledger/transactions、/ledger/accounts、/ledger/categories；
- 旧 /bills 路径在迁移期 redirect 或 alias 到对应 Ledger 页面；
- 旧 Bills component 名称不再用于新业务逻辑，但在没有迁移完成前可以保留 characterization tests。

L0 不要求现在引入上述新路由；它只冻结未来不会继续扩张 /bills 命名的方向。

### 3.2 金额协议

所有持久化和 API 金额均为 integer minor units：

~~~text
CNY ¥38.50  →  amountMinor = 3850
USD $10.00  →  amountMinor = 1000
~~~

规则：

- amountMinor 在收入、支出和转账中必须是正整数；
- Adjustment 使用有符号 amountMinor 表示 delta；
- opening balance 和账户 projection 可以是有符号整数，以表示透支或信用余额；
- 服务端不能依赖 IEEE-754 浮点运算来决定余额或聚合；
- API 不同时发送一个可能产生歧义的 decimal amount；UI 格式化由 currency formatter 负责；
- 所有记录带有或可解析出同一 Ledger 的 currency，v1 禁止跨 currency 写入。

SQLite 金额列使用 INTEGER，并由服务端检查安全整数范围；超过运行时安全范围的金额返回 validation error，不发生隐式截断。v1 支持任意单一 ISO 4217 base currency，但一个 Ledger instance 同时只使用一种 currency，不做 FX conversion。

minor-unit exponent 按 ISO 4217 currency definition 解释，不假设固定两位小数：CNY/USD 为 2、JPY 为 0、KWD 为 3。Settings read projection 返回 derived currencyExponent；客户端不能提交或覆盖它。decimal parsing、formatting、金额输入校验和 API 展示必须使用该 exponent。

### 3.3 时间协议

- 服务端 createdAt、updatedAt、deletedAt、occurredAt 均使用 UTC milliseconds since epoch，与 server/db.ts 现有约定一致。
- LedgerSettings.timezone 是 IANA timezone；交易时间以 UTC instant 持久化。
- Ledger 尚未成功创建过任何 Account 时，timezone 可以通过 Settings PATCH 修改；第一条 Account 创建成功后 timezone immutable。这个 freeze marker 是单调的，即使之后物理删除无历史 Account 也不会解冻；Transactions 是否已经存在不影响结果。
- v1 不增加 openingAt UTC column，也不通过 timezone migration 重新解释历史 opening boundary。
- period 的“今天/本周/本月/今年”和本地日期分组都使用已冻结的 Ledger timezone，不使用浏览器当前 timezone 作为隐式事实。
- openingDate 使用 Ledger timezone 下的 YYYY-MM-DD，表示该日开始时的 opening position。
- v1 不支持 scheduled/future records；occurredAt 不得晚于服务端当前时间（允许实现统一定义的小 clock-skew tolerance）。
- occurredAt 不能早于相关账户的 openingDate；Transfer 必须同时满足 from/to 两个账户的 opening date。
- 所有 period 使用 half-open interval [start, end)；week starts Monday，范围为 [Monday 00:00, next Monday 00:00)。

### 3.4 Account balance 采用 natural balance

为保留 UI 中“资产余额”和“负债金额”的直觉，同时正确处理信用卡，本 PRD 采用 natural balance：

| Account nature | 正数含义 | 普通 UI 显示 |
| --- | --- | --- |
| asset | 持有的资产 | ¥12,640 |
| liability | 欠下的债务 | ¥18,000 欠款 |

余额允许有符号 edge state：资产负数表示透支，负债负数表示信用余额。实现不得在数据库层静默 ABS()；展示层必须说明异常方向。

对一笔金额为 m 的记录，账户 delta 为：

| Transaction | asset account delta | liability account delta |
| --- | ---: | ---: |
| income | +m | -m |
| expense | -m | +m |
| transfer outgoing | -m | +m |
| transfer incoming | +m | -m |

这张表同时覆盖：

~~~text
银行 → 支付宝       asset -m, asset +m
银行 → 信用卡还款    asset -m, liability -m
信用卡消费           liability +m
信用卡退款           liability -m（income）
~~~

因此：

~~~text
currentBalance(account)
  = openingBalance
  + Σ active transaction delta

assets      = Σ balance where nature = asset
liabilities = Σ balance where nature = liability
netWorth    = assets - liabilities
~~~

账户余额、资产、负债和净资产都必须由这些规则推导。不能再引入一个可被表单直接修改的 current_balance source of truth。

Account name 不要求全局唯一；多个同名 Account 通过 type、note、账号尾号和 UI context 区分。Account ID 是稳定身份，rename 不改变 ID。

Account lifecycle 使用显式命令：

~~~text
ACTIVE  --POST /api/ledger/accounts/:id/archive-->  ARCHIVED
ARCHIVED --POST /api/ledger/accounts/:id/restore--> ACTIVE
~~~

任何 Account（无论是否有历史）只有 currentBalanceMinor === 0 时才能 archive。非零资产或非零负债都返回 409 ledger-account-nonzero-balance，并可安全返回 currentBalanceMinor；不得泄露 SQL 或内部路径。无历史的 Account 可以 physical DELETE；有任何 transaction row（包括 deleted row）后不能 physical DELETE。Archived Account 保留历史、current balance 仍为零并继续参与当前 projection/历史查询，但默认 Accounts query 隐藏它，且不能被新 transaction 引用。涉及 archived Account 的交易 PATCH 只允许修改 note/payee；任何其他字段或 DELETE 都必须先 restore，避免重新解释或移除零余额 gate 所保护的 balance effect。Restore 要求 expectedVersion；active Account restore 是 200 idempotent no-op 且 version 不变，archived Account restore 成功后递增 version 并可重新用于新 transaction。

Account rename 不改变 stable ID；历史 transaction 通过 stable ID 关联当前 Account，并显示当前 Account name，不保存不可变的 name snapshot。

### 3.5 Transaction discriminated union

领域层的最小结构如下；实际 TypeScript 可以采用 tagged union，但语义必须相同：

~~~ts
type LedgerTransaction =
  | {
      type: 'income' | 'expense'
      amountMinor: number       // > 0
      accountId: string
      categoryId: string
      occurredAt: number
      payee?: string
      note?: string
    }
  | {
      type: 'transfer'
      amountMinor: number       // > 0
      fromAccountId: string
      toAccountId: string
      occurredAt: number
      note?: string
    }
  | {
      type: 'adjustment'
      amountMinor: number       // signed delta, !== 0
      accountId: string
      adjustmentCalculatedBalanceMinor: number
      adjustmentTargetBalanceMinor: number
      occurredAt: number
      note?: string
    }
~~~

约束：

- transfer 的 from/to 不能相同；
- transfer 没有 category；
- income 必须引用 income category，expense 必须引用 expense category；
- adjustment 没有 category，且 target/calculated/delta 必须满足 delta = target - calculated；
- 新建或改变关联的 active transaction 只能引用 active account/category；已有 transaction 可以继续保留 archived account/category 的历史 foreign key，transaction PATCH 不能把关联改指向 archived entity，archive 操作也不得改写该 foreign key；涉及 archived Account 的 transaction PATCH 只允许 note/payee，其他 PATCH 或 DELETE 必须先 restore；
- v1 每笔 income/expense 只有一个 account 和一个 category；
- 新建普通交易不能写入 archived account；
- 被软删除的交易不再产生余额 effect，也不出现在默认聚合中。

Transaction lifecycle 只有 ACTIVE 和 terminal DELETED：

~~~text
ACTIVE
  | PATCH（不改变 type；Adjustment 只允许 note）
  | DELETE（soft delete）
  v
DELETED
~~~

Transaction.type 创建后 immutable；PATCH 试图改变 type 返回 409 ledger-transaction-type-immutable。误记类型时 soft delete 旧记录并创建新记录。DELETED transaction retained in SQLite、不可 PATCH，并从默认查询、余额和 aggregation 排除；DELETED state 检查优先于 PATCH payload 校验，因此所有已删除交易的 PATCH 返回 409 ledger-transaction-deleted。v1 不支持 transaction restore。DELETE 请求仍必须带 expectedVersion；ACTIVE 删除校验该版本，已删除记录的重复 DELETE 只要求字段存在并返回 200 和当前 deleted representation，保持 terminal 幂等且不产生第二次 financial effect。

Adjustment 创建后 account、amount、occurredAt、calculated/target 和 type 都 immutable，只允许 PATCH note；对其他字段的 PATCH 返回 409 ledger-adjustment-immutable。Adjustment 可以 soft delete，但删除必须有显式 warning、递增 version、移除 balance effect 并重新推导 balance；删除后的 Adjustment 仍不可 PATCH，重复 DELETE 采用与其他 DELETED transaction 相同的幂等语义。再次核对必须创建新的 Adjustment。

### 3.6 Opening balance 与 Adjustment

Opening balance 只在账户建立或无历史交易时可编辑。已产生交易后，用户通过“调整余额”输入 target balance：

~~~text
BEGIN IMMEDIATE
  calculated = deriveCurrentBalance(account)
  delta = target - calculated
  if delta != 0:
    insert adjustment(account, calculated, target, delta)
COMMIT
~~~

每个 Adjustment request 都必须携带 expectedCalculatedBalanceMinor；它必须与写事务内的 calculated 一致，否则返回 409 ledger-balance-conflict，不创建记录。若 target 等于 calculated，返回确定性的 200 no-op，不创建零金额 adjustment。

expectedCalculatedBalanceMinor 是 Adjustment request 的 REQUIRED field，不是可选优化。服务端必须在 BEGIN IMMEDIATE 内按以下顺序执行：

~~~text
existing = lookup idempotency(operation_scope, Idempotency-Key)
if existing:
  if existing.fingerprint != requestFingerprint:
    return 409 ledger-idempotency-conflict
  return existing.response_status + deserialize(existing.response_body_json)
actualCalculated = deriveCurrentBalance(account)
if actualCalculated != expectedCalculatedBalanceMinor:
  return 409 ledger-balance-conflict
delta = targetBalance - actualCalculated
if delta == 0:
  response = 200 { adjustment: null, account: authoritative projection, noOp: true }
  persist response replay record as no-op
  return response
else:
  insert Adjustment
  build canonical safe response
  persist response replay record and mutation atomically
COMMIT
~~~

两个 stale client 基于同一 calculated balance 发起 Adjustment 时，只有第一个可以成功；第二个必须得到 409 ledger-balance-conflict，不能基于新的 actual balance 重新计算 delta 后成功。Adjustment 不算 income/expense，也不改变分类统计；它在 Transactions 的“全部”列表中可解释地显示。

### 3.7 归档、软删除和版本

- Account 和 Category 有 archivedAt；archive 不删除历史、不从历史统计中移除。Account archive 前必须已经是零余额，因此 archived Account 的 authoritative current balance 保持为零，不会把非零资金隐藏在默认列表之外。
- 有任何 transaction row（包括已软删除）引用的 Account/Category 不能物理删除。
- Account archive 还必须满足 currentBalanceMinor === 0；否则返回 409 ledger-account-nonzero-balance。Account archive/restore 使用显式 lifecycle endpoint，不通过 PATCH archivedAt 旁路。
- Category archive 不释放其 normalized identity；Category 需要显式 restore endpoint，恢复原 stable ID 后才能重新用于新交易。
- Transaction 只支持 soft delete，至少保留 deletedAt；DELETED 是 terminal state，不支持 restore。
- 每个可更新实体有单调递增的 integer version（从 1 开始，每次成功 mutation 加 1）；PATCH、DELETE、archive、restore 都必须提交 expectedVersion。Create 使用 Idempotency-Key，不使用 expectedVersion。
- 版本不匹配返回 409 ledger-version-conflict 并返回当前实体的安全摘要，不能覆盖其他写入。
- 所有 Ledger 写入在 SQLite BEGIN IMMEDIATE 内完成；Adjustment 的 calculated read 和 insert 必须在同一事务内。
- 删除、编辑或 archive 后，客户端执行 authoritative refresh，不依赖可能过期的乐观余额补丁。

所有会创建持久化记录的 POST mutation 都要求 Idempotency-Key：Settings、Account、Category、Transaction 和 Account Adjustment。Archive/restore 是带 expectedVersion 的 lifecycle command，不通过 PATCH archivedAt 实现。

## 4. SQLite schema contract

以下是逻辑 schema。具体 migration 文件编号和 SQL 排版属于后续 Implementation Plan，但列语义、约束和关系是 L0 contract。ID 由服务端生成 opaque string，客户端不能指定或修改。

### 4.1 ledger_settings

单例表：

| 列 | 类型/约束 | 说明 |
| --- | --- | --- |
| singleton_id | INTEGER PK，必须为 1 | one Ledger per Nuvyn instance |
| base_currency | TEXT NOT NULL | uppercase ISO 4217 code |
| timezone | TEXT NOT NULL | IANA timezone |
| has_created_account | INTEGER NOT NULL DEFAULT 0 CHECK (has_created_account IN (0, 1)) | monotonic timezone/baseCurrency freeze marker |
| version | INTEGER NOT NULL | optimistic concurrency |
| created_at / updated_at | INTEGER NOT NULL | UTC ms |

首次初始化必须幂等；不从 billsMockData 写入任何账户、交易或金额。第一条 Account 与 `has_created_account = 1` 必须在同一 write transaction 中提交，之后该 marker 永不清零；因此删除无历史 Account 也不会解冻 timezone/baseCurrency。currencyExponent 不作为可编辑列持久化，而是由受支持的 ISO 4217 base_currency definition 推导。

### 4.2 ledger_accounts

必须包含：

~~~text
id TEXT PRIMARY KEY
name TEXT NOT NULL
type TEXT NOT NULL CHECK (type IN ('cash', 'bank', 'wallet', 'credit_card', 'loan', 'other'))
nature TEXT NOT NULL CHECK (nature IN ('asset', 'liability'))
opening_balance_minor INTEGER NOT NULL
opening_date TEXT NOT NULL
currency TEXT NOT NULL
note TEXT NOT NULL DEFAULT ''
archived_at INTEGER NULL
version INTEGER NOT NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
~~~

契约：

- currency = ledger_settings.base_currency；
- type/nature 的已知组合由服务端校验，other 可选择 nature；
- name 必须非空并有统一长度上限；
- 不增加 name UNIQUE constraint；多个 Account 可以同名；
- opening date 必须是严格有效的 Gregorian YYYY-MM-DD；
- 不设置 current_balance_minor、asset_total、debt_total 或其他统计快照列；
- 不增加 opening_at UTC column；
- 为交易查询提供按 archived_at、updated_at 的必要索引，实际索引名由 plan 固定。

### 4.3 ledger_categories

必须包含：

~~~text
id TEXT PRIMARY KEY
kind TEXT NOT NULL CHECK (kind IN ('income', 'expense'))
name TEXT NOT NULL
normalized_name TEXT NOT NULL
archived_at INTEGER NULL
version INTEGER NOT NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
UNIQUE(kind, normalized_name)
~~~

normalized_name 使用服务端和客户端共享的 trim() 后再调用 locale-independent toLowerCase() 的 identity contract；不做 NFKC，空字符串无效，不能依赖 SQLite locale。v1 是 flat categories，不包含 parent_id；未来层级分类必须通过新的 migration 和单独 PRD 增加。

### 4.4 ledger_transactions

必须包含：

~~~text
id TEXT PRIMARY KEY
type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer', 'adjustment'))
amount_minor INTEGER NOT NULL
account_id TEXT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT
from_account_id TEXT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT
to_account_id TEXT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT
category_id TEXT NULL REFERENCES ledger_categories(id) ON DELETE RESTRICT
occurred_at INTEGER NOT NULL
payee TEXT NOT NULL DEFAULT ''
note TEXT NOT NULL DEFAULT ''
adjustment_calculated_balance_minor INTEGER NULL
adjustment_target_balance_minor INTEGER NULL
deleted_at INTEGER NULL
version INTEGER NOT NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
~~~

行级 invariant：

~~~text
income/expense:
  account_id != NULL
  from_account_id == NULL
  to_account_id == NULL
  category_id != NULL
  amount_minor > 0
  adjustment_* == NULL

transfer:
  account_id == NULL
  from_account_id != NULL
  to_account_id != NULL
  from_account_id != to_account_id
  category_id == NULL
  amount_minor > 0
  adjustment_* == NULL

adjustment:
  account_id != NULL
  from_account_id == NULL
  to_account_id == NULL
  category_id == NULL
  amount_minor != 0
  adjustment_calculated_balance_minor != NULL
  adjustment_target_balance_minor != NULL
  amount_minor = target - calculated
~~~

Implementation Plan 必须把上述 row-local invariant 落为等价 SQLite CHECK 约束，而不只在服务端描述。逻辑约束至少包括：

~~~sql
CHECK (
  typeof(amount_minor) = 'integer'
),
CHECK (
  (
    type IN ('income', 'expense')
    AND account_id IS NOT NULL
    AND from_account_id IS NULL
    AND to_account_id IS NULL
    AND category_id IS NOT NULL
    AND amount_minor > 0
    AND adjustment_calculated_balance_minor IS NULL
    AND adjustment_target_balance_minor IS NULL
  )
  OR (
    type = 'transfer'
    AND account_id IS NULL
    AND from_account_id IS NOT NULL
    AND to_account_id IS NOT NULL
    AND from_account_id <> to_account_id
    AND category_id IS NULL
    AND amount_minor > 0
    AND adjustment_calculated_balance_minor IS NULL
    AND adjustment_target_balance_minor IS NULL
  )
  OR (
    type = 'adjustment'
    AND account_id IS NOT NULL
    AND from_account_id IS NULL
    AND to_account_id IS NULL
    AND category_id IS NULL
    AND amount_minor <> 0
    AND adjustment_calculated_balance_minor IS NOT NULL
    AND adjustment_target_balance_minor IS NOT NULL
    AND typeof(adjustment_calculated_balance_minor) = 'integer'
    AND typeof(adjustment_target_balance_minor) = 'integer'
  )
),
CHECK (
  type <> 'adjustment'
  OR amount_minor = adjustment_target_balance_minor - adjustment_calculated_balance_minor
)
~~~

SQLite 能表达的约束应落在 schema；涉及另一张表的 category kind、currency、archived state、opening date 和未来时间由服务端在同一个 write transaction 中校验。

### 4.5 ledger_idempotency

所有 create mutation 的 retry safety 由 SQLite 持久化状态提供，而不是进程内 Map。`ledger_idempotency` 是 response replay record，而不是只保存结果身份；逻辑表至少包含：

~~~text
operation_scope TEXT NOT NULL
idempotency_key TEXT NOT NULL
request_fingerprint TEXT NOT NULL
response_status INTEGER NOT NULL
response_body_json TEXT NOT NULL
result_status TEXT NOT NULL CHECK (result_status IN ('committed', 'no-op'))
result_type TEXT
result_id TEXT
created_at INTEGER NOT NULL
UNIQUE(operation_scope, idempotency_key)
~~~

`Idempotency-Key` 的值是 client-generated opaque UUID/string，服务端不解释其格式。`operation_scope` 是 method + canonical operation/target 的语义范围，例如 Account Adjustment endpoint 与目标 Account 的组合；`operation_scope + idempotency_key` 是当前 single-instance Nuvyn 的唯一 retry identity，不增加 tenant/user foreign key。`request_fingerprint` 是 canonical request（完成字段规范化、默认值处理和 stable serialization 后，不包含 Idempotency-Key header）。`response_status` 保存第一次成功响应的 HTTP status；`response_body_json` 保存第一次响应的 canonical safe Ledger JSON body，例如创建时的 transaction/account representation，或 Adjustment no-op 的 `{ adjustment: null, account: ..., noOp: true }`。它们是 replay 的唯一 authority，不能依赖 `result_id` 重读当前资源或重建 response。snapshot 不包含 session、cookie、SQL details 或 request-specific volatile headers，也不因 result entity 后续被编辑、软删除或物理删除而变化。`result_type/result_id/result_status` 可以保留用于关联、诊断和区分 committed/no-op，但不能替代 response snapshot；`result_id` 对普通 create 可以是新资源 ID，对 Adjustment no-op 可以是目标 Account ID，对 Settings singleton 可以是固定 singleton identity。

只有 committed mutation 或 committed no-op 才写入 idempotency row；validation、version conflict 和 balance conflict 不消费 key。每个 create 的事务首先查找既有 idempotency row：相同 key + 相同 fingerprint 在新的领域校验前直接返回保存的 `response_status` + `response_body_json`，不重跑 mutation、不查询当前 mutable resource，也不 resurrect 已物理删除的 result entity；相同 key + 不同 fingerprint 返回 409 ledger-idempotency-conflict。idempotency row、response snapshot 与 financial mutation 必须在同一个 SQLite `BEGIN IMMEDIATE` transaction 中提交：要么三者都 commit，要么三者都 rollback。物理删除业务实体不得级联删除其 replay record。

### 4.6 Foreign key 与物理删除

Ledger tables 使用 foreign_keys=ON。Account/Category 的 referenced delete 使用 RESTRICT，防止历史引用被级联清除。Transaction 的默认删除路径只写 deleted_at；物理 delete 不是用户 API。

### 4.7 默认分类 seed

默认分类是可管理的应用数据，不是不可变 SQL enum。首次 Ledger 初始化时以幂等 seed 创建 v1 默认分类；如果 owner 已存在同一 normalized identity，不重复插入、不覆盖显示名称。默认分类 archive 后不应在下一次启动被自动恢复。

## 5. API contract

所有 /api/ledger/* 路由继承现有 owner session middleware，使用 Cache-Control: no-store 处理敏感的财务响应。API 的金额字段统一使用 *Minor 整数，时间字段使用 UTC ms；响应使用 camelCase，SQL 保持 snake_case。

### 5.1 错误 envelope

Ledger 错误沿用 Nuvyn 的顶层 JSON 约定：

~~~json
{
  "error": "Human-readable message",
  "code": "ledger-version-conflict",
  "details": {}
}
~~~

至少需要稳定错误码：

~~~text
ledger-validation-failed
ledger-not-found
ledger-duplicate-category
ledger-archived-account
ledger-archived-category
ledger-invalid-account-pair
ledger-currency-mismatch
ledger-opening-date-conflict
ledger-timezone-locked
ledger-base-currency-locked
ledger-balance-conflict
ledger-version-conflict
ledger-account-has-history
ledger-account-nonzero-balance
ledger-category-has-history
ledger-settings-already-initialized
ledger-transaction-type-immutable
ledger-transaction-deleted
ledger-adjustment-immutable
ledger-idempotency-conflict
~~~

错误消息不能泄露 SQL、堆栈或数据库文件路径；字段级 validation details 可以返回安全的字段名和错误原因。

### 5.1.1 Idempotency-Key replay

Settings、Account、Category、Transaction 和 Account Adjustment 的 POST 都要求 `Idempotency-Key`。首次成功 mutation 或 no-op 必须在同一个 `BEGIN IMMEDIATE` 中写入 domain mutation、canonical safe response snapshot 和 `ledger_idempotency` row；只保存 HTTP status 与 JSON body，不保存 session、cookie、SQL details 或 request-specific volatile headers。相同 `operation_scope + key` 且 fingerprint 相同的 retry 直接返回保存的原始 status/body，不重新执行 mutation，不从当前资源重建 response，也不因资源后来被 PATCH、DELETE、物理删除或余额变化而改变；相同 key + 不同 fingerprint 返回 `409 ledger-idempotency-conflict`。失败的 validation、version conflict 和 balance conflict 不消费 key。

### 5.2 Settings

~~~text
GET  /api/ledger/settings
POST /api/ledger/settings       // 首次初始化；已初始化时无匹配 replay 返回 409
PATCH /api/ledger/settings      // 带 expectedVersion；仅 has_created_account=0 时可改 timezone/baseCurrency
~~~

Settings 的 POST、PATCH 都要求 owner auth；POST 要求 Idempotency-Key。`has_created_account = 0` 时 timezone/baseCurrency 可以改变；第一条 Account 创建成功后两者都 frozen。之后 timezone 改动返回 409 ledger-timezone-locked，baseCurrency 改动返回 409 ledger-base-currency-locked，数据库不得改变。

### 5.3 Accounts

~~~text
GET    /api/ledger/accounts?includeArchived=false
POST   /api/ledger/accounts
GET    /api/ledger/accounts/:id
PATCH  /api/ledger/accounts/:id
DELETE /api/ledger/accounts/:id
POST   /api/ledger/accounts/:id/archive
POST   /api/ledger/accounts/:id/restore
POST   /api/ledger/accounts/:id/adjust
~~~

创建请求至少包含 name、type、nature、openingBalanceMinor、openingDate 和 currency，并要求 Idempotency-Key。Account response 返回 currentBalanceMinor projection，但该字段只读且不得出现在 PATCH 可写字段中。Account name 不要求唯一。

PATCH、DELETE、archive、restore 都必须提交 expectedVersion；archive 还要求 currentBalanceMinor === 0，否则返回 409 ledger-account-nonzero-balance。archive/restore 不能通过 PATCH archivedAt 旁路。无历史 Account 才允许 physical DELETE；有任何 transaction row（包括 deleted row）返回 ledger-account-has-history。Archived Account 不能被新 transaction 引用；restore 要求 expectedVersion，active Account restore 为 idempotent no-op。

Adjustment request：

~~~json
{
  "targetBalanceMinor": 12600,
  "occurredAt": 1788300000000,
  "note": "与支付宝实际余额核对",
  "expectedCalculatedBalanceMinor": 12543
}
~~~

服务端在 BEGIN IMMEDIATE 中重算 calculated balance；成功响应同时返回 adjustment transaction 和调整后的 account projection。targetBalanceMinor 与 expectedCalculatedBalanceMinor 都是必填；expectedCalculatedBalanceMinor 不匹配时返回 409 ledger-balance-conflict，不得基于新 balance 重算后继续成功。Adjustment POST 要求 Idempotency-Key，且 response replay record 与 Adjustment insert 在同一 SQLite write transaction 中提交。

当 targetBalanceMinor 等于 calculated balance 时，返回确定性的 200 response，不创建零金额 transaction：

~~~json
{
  "adjustment": null,
  "account": { "...": "authoritative account projection" },
  "noOp": true
}
~~~

### 5.4 Categories

~~~text
GET    /api/ledger/categories?kind=income|expense&includeArchived=false
POST   /api/ledger/categories
PATCH  /api/ledger/categories/:id
DELETE /api/ledger/categories/:id
POST   /api/ledger/categories/:id/archive
POST   /api/ledger/categories/:id/restore
~~~

POST create 要求 Idempotency-Key；PATCH、DELETE、archive、restore 都要求 expectedVersion。DELETE 只允许没有任何 transaction history 的分类；有历史时返回 ledger-category-has-history，调用方应使用 archive。Category rename 保持 stable ID，历史 transaction 在 v1 显示当前 category name，不保存不可变 name snapshot。Category archive 不释放 UNIQUE(kind, normalized_name) identity；archived category 不能用于新 transaction，但历史 active transaction 仍可查询。archived Category restore 保持 stable ID、递增 version 并使分类重新可用；active Category restore 为 200 idempotent no-op 且 version 不变。v1 是 flat categories，不存在 parent。

### 5.5 Transactions

~~~text
GET    /api/ledger/transactions
POST   /api/ledger/transactions
GET    /api/ledger/transactions/:id
PATCH  /api/ledger/transactions/:id
DELETE /api/ledger/transactions/:id
~~~

POST create 要求 Idempotency-Key。PATCH 和 DELETE 都必须提交 expectedVersion；PATCH 不得改变 Transaction.type。type 创建后 immutable，改型必须 soft delete 后 create 新记录；尝试改 type 返回 409 ledger-transaction-type-immutable。DELETED transaction 的 PATCH 返回 409 ledger-transaction-deleted；v1 不支持 restore。DELETE 已删除记录在 expectedVersion 字段存在时返回 200 和当前 deleted representation，保持幂等，不重复产生 effect；ACTIVE 删除仍严格校验 expectedVersion。

Adjustment PATCH 只允许 note；修改 type、account、amount、occurredAt、calculated/target 或其他 financial semantics 返回 409 ledger-adjustment-immutable。Adjustment DELETE 是 soft delete，带显式 warning，由统一 transaction lifecycle 处理；删除会移除 balance effect，版本递增，且不产生第二次 effect。

列表查询至少接受：

~~~text
type=all|income|expense|transfer
accountId
categoryId
from
to
search
includeDeleted=false
limit
cursor
~~~

adjustment 在 type=all 中返回；是否提供独立 adjustment filter 不属于 L0 必须 UI。默认列表只返回 active transactions。创建和编辑使用第 3.5 节 discriminated union；服务端忽略或拒绝与 type 不匹配的多余字段。

`accountId=X` 必须匹配 `account_id = X OR from_account_id = X OR to_account_id = X`，所以 Account Detail 的全部交易包含 income、expense、transfer incoming/outgoing 和 adjustment。`categoryId=X` 只匹配 income/expense 的 category；Transfer/Adjustment 永不匹配 category filter。明确传入 archived category ID 时，仍允许查询其历史 active transactions。`includeDeleted=false` 排除所有 soft-deleted rows。

所有 transaction list、Account Detail list 和 recent projection 使用同一 canonical order：`occurredAt DESC, createdAt DESC, id DESC`。不能依赖 SQLite unspecified row order；cursor 至少携带最后一条的 occurredAt、createdAt 和 id，L5 只能决定 opaque encoding，不能重定义排序。

### 5.6 Overview / projections

~~~text
GET /api/ledger/overview?scope=today|week|month|year|all
GET /api/ledger/trend?months=6
GET /api/ledger/accounts/:id/transactions
~~~

Overview response 必须由 live accounts/categories/transactions 计算，至少包含：

~~~ts
LedgerOverview {
  currency: string
  assetTotalMinor: number
  liabilityTotalMinor: number
  netWorthMinor: number
  accounts: LedgerAccountSummary[]
  cashflow: { incomeMinor: number; expenseMinor: number; balanceMinor: number }
  categoryBreakdown: { income: LedgerCategorySlice[]; expense: LedgerCategorySlice[] }
  periods: LedgerPeriodSummary[]
  trend: LedgerTrendPoint[]
  recentTransactions: LedgerTransaction[]
}
~~~

Overview 是 read projection，不创建快照记录，也不能被客户端 POST 回写。

### 5.7 Overview scope 与固定 projection

overview 的 scope 只影响 `cashflow` 和 `categoryBreakdown`。以下字段永远表示当前 projection，不按 scope 重新计算：`assetTotalMinor`、`liabilityTotalMinor`、`netWorthMinor` 和 accounts/current balances。`periods` 始终返回 today、week、month、year 四张各自按固定范围计算的 summary；`trend` 始终返回最近月份序列；`recentTransactions` 始终返回最近 5 条 active records，不受 scope 过滤。

Period 使用 Ledger timezone 和 half-open interval `[start, end)`：today 是当地日 00:00 到下一日 00:00；week 是周一 00:00 到下一个周一 00:00；month 是当月第一日到下月第一日；year 是当年 1 月 1 日到下一年 1 月 1 日。恰好在 start 的 transaction 包含在当前 period，恰好在 end 的 transaction 只属于下一个 period。

Trend 默认是包括当前月在内的最近 6 个 calendar months，而不是过去 180 天。例如 Ledger timezone 当前为 2026-09-02 时，返回 2026-04 至 2026-09，每月范围为 `[monthStart, nextMonthStart)`。`months` 只能改变数量，不能改变 calendar-month boundary。

Account Detail 的 movement projection 使用统一字段：

~~~ts
{
  balanceIncreaseMinor: number
  balanceDecreaseMinor: number
}
~~~

对每笔 active、非 Adjustment transaction，按 Account natural balance delta 分桶：正 delta 进入 balanceIncrease，负 delta 的绝对值进入 balanceDecrease。Asset UI 将它们分别标为“流入/流出”；liability UI 将它们标为“新增负债/减少负债”。Adjustment 不计入 movement summary；Transfer 计入 movement summary，但不计入 Dashboard income/expense。

## 6. 写事务与并发边界

### 6.1 普通写入

Account、Category、Transaction 的 create/update/archive/delete 均在一个 SQLite write transaction 内完成：

~~~text
validate input
  → read current rows
  → check expectedVersion / lifecycle / cross-row rules
  → write mutation
  → increment version
  → return authoritative rows/projections
~~~

### 6.2 Adjustment

Adjustment 的 calculated balance read、delta calculation 和 transaction insert 不能拆成两个 HTTP 或两个 SQLite transaction。并发调整必须串行化；第二个 stale target 返回 409，而不是把两个目标余额盲目叠加。

### 6.3 编辑和删除

编辑交易可能改变账户、分类、日期和金额，因此必须在一个写事务内校验旧记录、重写整行并刷新所有受影响账户的 projection。软删除也必须提升 transaction version，使旧客户端无法再次覆盖。

### 6.4 客户端 refresh

Ledger mutation 成功后客户端以服务端响应或一次 authoritative GET 刷新受影响集合。L0 不允许通过“本地给余额加减一个估计值”作为唯一刷新路径；本地 optimistic UI 不能成为持久化事实。

## 7. Migration 与启动契约

- 新 Ledger migration 必须追加到当前 migration 序列，不能修改已发布 migration 文件。
- migration 只创建 Ledger schema、约束、索引和幂等默认分类基础；不从 billsMockData、截图或现有 Bills UI 数字回填财务记录。
- 空数据库、现有 Nuvyn 数据库、重复启动和测试 in-memory DB 都必须得到同一 schema 结果。
- migration 失败不能部分留下“看似完成”的 Ledger schema；利用现有 migration runner 的 transaction 行为保证 schema_version 不提前推进。
- Ledger API 在 schema 不可用时 fail closed；不能回退到 mock 作为生产写入或 Dashboard 事实来源。
- 备份文档需要在 Ledger 实现完成时明确 data/nuvyn.db、WAL/SHM 和 vault 的一起备份要求；L0 不新增第二个数据库。

## 8. L0 测试契约

L0 implementation plan 至少必须覆盖以下测试族。这里冻结的是必须证明的行为；本轮不新增或修改测试文件。

### 8.1 Schema / migration

- migration 在空库和当前 schema 末端库上成功；schema_version、重复启动、foreign key、RESTRICT 和默认分类 seed 幂等；
- schema 中不存在 current balance 或 Dashboard snapshot source-of-truth 列；Account name 没有全局 unique；Category schema 没有 `parent_id`；
- `ledger_idempotency` 的 `(operation_scope, idempotency_key)` 唯一约束有效，`response_status` 和 `response_body_json` 可在重启后读取并直接 replay；业务 result entity 的后续修改或物理删除不会改变这份 snapshot；
- 金额、type discriminator 和 adjustment CHECK 约束拒绝非法行，尤其是 income/expense、transfer、adjustment 的字段 shape 和 delta 关系。

### 8.2 Time / currency

- `has_created_account = 0` 时 PATCH timezone 成功；创建第一条 Account 后不同 timezone 返回 409 `ledger-timezone-locked`、数据库值不变；删除该无历史 Account 后 marker 仍为 1、timezone 仍 locked；同样证明 baseCurrency 的 frozen lifecycle 和 `ledger-base-currency-locked`；
- week starts Monday；transaction exactly at period start 被包含，exactly at next period start 只进入下一个 period，不同时落入两个 period；today/week/month/year 都使用 Ledger timezone 的 `[start, end)`；
- v1 保留通用 ISO 4217 支持，因此至少覆盖 2-decimal currency（如 CNY/USD）、0-decimal currency（如 JPY）和 3-decimal currency（如 KWD）的 minor-unit parsing/formatting。

### 8.3 Domain / balance matrix

- asset income/expense；liability expense（信用卡消费）和 liability income（退款/credit）；
- asset → asset、asset → liability、liability → asset、liability → liability 的 transfer；
- transfer 不改净资产和收支统计，信用卡还款不再次计入 expense；
- opening balance + records 的精确 minor-unit 计算；overdraft/credit edge state 不被 ABS() 或浮点舍入破坏；
- Adjustment target/calculated/delta 一致，零 delta no-op 不创建 transaction row。

### 8.4 Lifecycle / concurrency

- zero-balance asset 和 liability Account archive 成功；nonzero asset 和 nonzero liability archive 都返回 409 `ledger-account-nonzero-balance`，安全 details 可返回当前余额且不泄露 SQL；
- archived Account restore 保持 stable ID、递增 version 并重新可用于新 transaction；active restore 幂等；archive/restore 缺失或 stale expectedVersion 被拒绝；
- archived Account 的 transaction PATCH 仅允许 note/payee，其他字段和 DELETE 在 restore 前被拒绝，保证 zero-balance invariant；
- account/category 无 history 可物理删除；有 history（包括 soft-deleted transaction）只能 archive；archive/restore 不 cascade、null foreign key 或改写历史 transaction；
- Category archive 不释放 `(kind, normalized_name)` identity，restore 保持 ID；archived category 不能用于新 transaction；
- transaction soft delete 后不再影响余额和聚合，数据库行仍存在；DELETED PATCH 被拒绝，使用第一次请求的 stale expectedVersion 重复 DELETE 仍返回同一确定性 deleted representation，且不递增 version；
- transaction type change 被拒绝；Adjustment 的 financial fields 被拒绝修改、note 可修改；Adjustment soft delete 移除 effect、递增 version，且 stale expectedVersion 不能覆盖新写入；
- 两个 SQLite 连接并发 Adjustment 只能有一个接受同一 stale target，第二个得到 409 `ledger-balance-conflict`；
- 交易 edit 同时影响旧账户、新账户、旧分类和新分类时保持全局一致。

### 8.5 Idempotency / atomicity

- 同一个 POST transaction 使用同一 key 重试只创建一行；模拟 response loss，随后 PATCH 原 transaction，再 retry 时仍返回第一次保存的 response status/body，而不是当前 version/amount；
- Account create 成功后物理删除该无历史 Account，再用相同 key retry，仍返回第一次保存的 Account response，不重建 Account、不返回当前 not-found；
- Adjustment no-op 成功后改变 Account balance，再用相同 key retry，仍返回第一次保存的 `noOp: true` response 和第一次的 account projection；
- 同一 `operation_scope + key` 使用不同 canonical payload 返回 409 `ledger-idempotency-conflict`；Settings、Account、Category、Transaction 和 Adjustment create 都遵守同一规则；
- 关闭并重新打开 SQLite 或重启 server 后，同 key retry 仍返回原 response status/body，不重复 mutation；
- financial mutation、response replay record 与 idempotency state 在同一写事务中原子提交，证明只能 all commit 或 all rollback；no-op 也持久化原始 response snapshot。

### 8.6 Query / overview projection

- `accountId=X` 命中 income、expense、transfer from、transfer to 和 adjustment；`categoryId=X` 排除 transfer/adjustment；明确传入 archived category ID 仍能查询其历史 active transaction；`includeDeleted=false` 排除 soft-deleted；
- list/recent/cursor 使用 `occurredAt DESC, createdAt DESC, id DESC`，cursor 与该顺序一致，不依赖 SQLite unspecified order；
- overview scope 只改变 cashflow/categoryBreakdown；当前 assets/liabilities/net worth/accounts 不 periodize；periods 始终返回 today/week/month/year；recentTransactions 始终最新 5 条 active records；
- trend 包含当前月的最近 6 个 calendar months（不是 rolling 180 days），每月使用 `[monthStart, nextMonthStart)`；
- Account Detail 的 movement summary 按 natural-balance delta 正负分桶，Transfer 计入、Adjustment 排除，并按 asset/liability 使用不误导的 UI wording。

### 8.7 API / auth

- anonymous requests 被现有 owner session boundary 拒绝；
- account/category/type/currency/opening-date 交叉校验在服务端有效；
- response 使用 camelCase integer minor units，不返回 raw SQL/stack；错误码覆盖 timezone lock、nonzero archive、immutable type/adjustment、deleted transaction、idempotency conflict、balance/version conflict；
- overview 在插入、编辑、删除、转账、调整、重启后都从 live rows 得到正确结果。

### 8.8 Regression boundary

- 当前 Bills 原型 characterization tests 在 L0 不被无意破坏；
- e2e/ledger-workspace.spec.ts 的共享 App Shell、单 Navbar、主题和滚动边界继续通过；
- L0 不新增或改变生产 UI，因此不以 UI 截图通过作为 Foundation gate。

## 9. L0 Exit Gate

本轮 remediation 已将以下条目全部冻结并标记为 Architecture Review Accepted；实现时必须以本文和 Product PRD 为输入，不能把这些问题留给 Implementation Plan 再决定：

- [x] Ledger v1 PRD 与本 L0 PRD 的金额、余额、Transfer、Adjustment 和生命周期语义无冲突。
- [x] canonical Ledger / legacy Bills 兼容策略被接受。
- [x] integer minor units、single base currency、ISO 4217 exponent、timezone 和 UTC timestamp 契约被接受。
- [x] timezone lifecycle 已冻结：`has_created_account = 0` 可改；First Account created 后 immutable，且物理删除无历史 Account 不会解冻；有 `ledger-timezone-locked`。
- [x] week boundary 已冻结为 Monday 00:00，所有 period 使用 Ledger timezone 的 `[start, end)`。
- [x] natural balance effect matrix 被接受，尤其是信用卡消费和还款。
- [x] nonzero Account archive 被阻止；Account archive/restore 和 Category archive/restore contract 已冻结。
- [x] transaction lifecycle 已冻结为 ACTIVE → terminal DELETED；deleted transaction 不可 PATCH、不支持 restore，重复 DELETE 语义确定。
- [x] Transaction.type 创建后 immutable；Adjustment financial semantics 创建后 immutable、只允许 note PATCH。
- [x] Adjustment stale-write contract 已冻结：`expectedCalculatedBalanceMinor` 必填、`BEGIN IMMEDIATE` 内校验、stale 返回 `ledger-balance-conflict`、zero delta 是显式 no-op。
- [x] idempotent create contract 已冻结为 response replay record：所有 create mutation 使用持久化 `Idempotency-Key`，保存第一次 response status/body，request mismatch 返回 `ledger-idempotency-conflict`，response snapshot 与 mutation 原子提交，retry 不从可变 resource 重建 response。
- [x] `ledger_*` schema contract、foreign keys、RESTRICT、soft delete、row-local CHECK、无 Account name uniqueness 和 flat Category（无 `parent_id`）被接受。
- [x] API route、request/response、owner auth、expectedVersion、Idempotency-Key 和 error codes 边界被接受。
- [x] `accountId` filter 覆盖 transfer from/to；`categoryId` 排除 transfer/adjustment；archived category history query 语义已冻结。
- [x] Overview scope、固定 periods、calendar-month trend、recent transaction ordering 和 Account movement projection 语义已冻结。
- [x] migration 不回填 mock、Overview 不保存统计快照、不写 Markdown 的边界被接受。
- [x] 测试矩阵覆盖 timezone、period boundary、archive/restore、transaction lifecycle/type、Adjustment race/no-op、idempotency atomicity、filters、overview 和 currency exponent。
- [x] 没有 unresolved architectural decision；后续实现计划不得隐式改变上述契约，若实现证据要求变化必须回到 PRD 重新评审。

因此本 L0 文档的 Architecture Review 状态为 **Accepted**。下一份文档才是 Ledger L0 Foundation Implementation Plan；在此之前不开始 Ledger 新 UI、真实数据切换或任何 API implementation。本轮只完成设计文档 remediation，不代表已实现、已完成或已发布。
