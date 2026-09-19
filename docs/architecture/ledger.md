# Ledger Architecture

> [!IMPORTANT]
> 本文是 Ledger 当前运行时架构的技术 authority，依据 shared contracts、server implementation、SQLite migrations 和 tests 编写。历史 PRD 记录设计来源，但不能覆盖当前 runtime facts。

## Ledger as a Personal OS Workspace

Ledger 是 Nuvyn Personal OS 中负责个人财务事件的一级 Workspace：

```text
Ledger → What happens to my money
```

它与 Note、Diary、Board 共享同一个 owner 和系统边界，但保留适合账户、交易、分类和余额投影的领域模型。Ledger 不是专业会计系统或银行聚合器；本文件只定义其当前运行时架构。完整的 Workspace 语义见 [Nuvyn — Personal OS](../product.md)。

## 1. Module Map

- shared/ledgerProtocol.ts：浏览器与服务端共用的 DTO、请求类型、枚举和内置图标目录。
- server/ledger/：validation 负责边界解析，repository 负责 SQLite，service 负责写入与生命周期，balance 负责自然余额，projections 负责读模型，routes/ 暴露 HTTP API，idempotency 与 writeTransaction 负责可靠写入。
- src/features/ledger/：API client、store、金额/时间适配、错误和新建恢复。
- src/components/ledger/：初始化、账户、交易表单、统一交易详情、图标和选择器渲染。
- src/views/LedgerView.vue、LedgerTransactionsView.vue、LedgerAccountsView.vue、LedgerAccountDetailView.vue：四个页面级入口。
- server/migrations/0013_* 至 0029_*：Ledger SQLite schema 演进。

## 2. Domain Model

核心实体是 LedgerSettings、LedgerAccount、LedgerCategory 和 LedgerTransaction。

~~~text
Account nature:  asset | liability
Category kind:   income | expense
Transaction:     income | expense | transfer | adjustment
Transfer kind:   general | repayment | withdrawal
Fee mode:        extra | deducted
System key:      interest | fee
~~~

金额在跨运行时协议和数据库中都使用安全整数 minor units；显示层根据 currency exponent 转换为小数金额。Account 保存期初余额和期初日期，current balance 由有效交易投影得到。Category 的身份是 kind 加 trim/lowercase 后的 normalized name。

Transfer 的 amountMinor 表示实际 transfer principal：`general` 和 `repayment` 直接表示转账 / 还款本金；withdrawal 在 `extra` 下表示提现请求金额，在 `deducted` 下表示扣除手续费后的到账金额。feeMinor 是独立的 companion Expense 金额；它在写入时由 transfer kind 决定系统分类。

## 3. Natural Balance Model

server/ledger/balance.ts 的 transactionEffectForAccount 是 TypeScript/domain 层的 natural-balance authority。repository 为账户位置余额查询维护等价的 SQL effect projection；两者必须保持相同的账务语义。不能用“转出账户减、转入账户加”概括所有账户：

- 资产：收入和转入增加自然余额；支出和转出减少自然余额。
- 负债：支出和转出增加债务自然余额；收入和转入减少债务自然余额。

因此资产 → 负债的 repayment 会同时得到资产减少和负债减少。还款本金不会进入 Expense；若有利息，利息 Expense 另行作用于转出资产账户。删除的交易效果为零，调整记录的 amountMinor 必须等于目标余额减计算余额。

## 4. Transfer Semantics

服务端 assertTransferKindAccounts 是最终校验，前端只负责根据子类型收窄选择项：

- general：允许合法的账户组合，表示普通资金移动。
- repayment：只允许 asset → liability。
- withdrawal：只允许 asset → asset。

账户必须不同、属于同一基础货币且处于可用状态。普通 transfer 不产生收支；服务器拒绝 general 携带 fee。repayment 不接受 feeMode。新建 withdrawal 的当前表单默认使用 `deducted`；对已持久化的 legacy withdrawal，如果已有 fee 且缺少 feeMode，则按 `extra` 解释。已有 withdrawal 没有 fee 且缺少 feeMode 时，编辑表单在首次增加手续费时仍默认 `deducted`。

## 5. Composite Transactions

还款和提现在账务层是多条 atomic rows，在产品层是一次操作。存在附加金额时，服务端在同一个写事务中创建 parent Transfer 和 companion Expense，并用同一个 groupId 绑定：

~~~text
repayment  = transfer(principal) + optional expense(interest)
withdrawal = transfer(requested amount, adjusted by feeMode) + optional expense(fee)
~~~

利息、手续费从不直接加进 transfer.amountMinor。group 的编辑会校验并同步更新 companion row；group 的删除会把仍有效的相关 rows 一起 soft-delete。

## 6. Interest / Fee

系统分类是 expense kind 的受保护 Category：

- systemKey interest 对应“利息”，由 repayment 的 feeMinor 使用。
- systemKey fee 对应“手续费”，由 withdrawal 的 feeMinor 使用。

服务端通过 systemKey 查找，而不是通过可变的中文名称查找。系统分类不能重命名、改 kind、归档或删除；普通分类仍按 kind 加 normalized name 保持唯一。

## 7. feeMode

提现的 feeMode 只影响 transfer row 的金额与两个账户的效果：

| 模式 | transfer.amountMinor | 转出资产 | 转入资产 | Expense |
| --- | ---: | ---: | ---: | ---: |
| extra | 请求金额 | 请求金额 + 手续费 | 请求金额 | 手续费 |
| deducted | 请求金额 - 手续费 | 请求金额 | 请求金额 - 手续费 | 手续费 |

deducted 必须保证扣费后 transfer 金额仍为正数。读取时 bundle.totalMinor 为 transfer.amountMinor 加 chargeMinor：`extra` 下表示实际总扣款，`deducted` 下还原为提现请求金额。

## 8. Read Projection / Bundle

LedgerTransferBundleSummary 提供 chargeMinor 和 totalMinor，只属于读取投影，不改变原子交易的 amountMinor。交易表格和详情可以把 parent Transfer 渲染成一行完整业务；账户余额仍逐行通过 balance engine 计算。对 repayment，目标负债只受本金 Transfer 影响；对 withdrawal，目标资产只受 transfer 金额影响。

Overview 投影提供当前资产、负债、净资产、收支、账户、分类切片、四个固定期间、趋势和最近交易。固定期间按 Ledger 时区计算，过去日期可以作为 anchor；趋势是 anchor 所在月份及其前 11 个连续日历月。Dashboard 最近交易、Account Detail 最近交易和 Transactions View 的交易行都复用 `LedgerTransactionDetailSheet.vue`，页面只负责选中交易与刷新自己的 projection，不复制详情或 grouped transaction 逻辑。current snapshot 与期间收支是不同语义，系统没有把历史期间伪装成历史资产负债表快照。

## 9. Companion Expense Visibility

grouped companion Expense 是真实的 transaction row，在普通 transaction query 和交易记录 read model 中也 intentionally visible。还款利息和提现手续费可以与 parent Transfer 同时出现在交易记录中，并可按 expense、系统分类、账户或 groupId 查询；按账户筛选时，相关 transfer 与 companion Expense 可以同时命中。某些 Overview projection 可以按产品语义折叠或隐藏 companion。

read visibility 不等于 independent mutation ownership：companion Expense 不作为独立业务对象编辑或删除。用户修改或删除还款 / 提现 grouped operation 时，由 parent Transfer 原子维护整个 group；direct get、patch、delete companion 仍受保护。includeDeleted 可用于内部一致性检查。

行可见性也不等于聚合规则：cashflow、category breakdown、账户余额和账户 movement 都会统计 companion Expense；分页和汇总对显式筛选条件保持一致。

companion Expense 的 payee 是写入 `ledger_transactions.payee`、并在交易发生时固定下来的 snapshot：withdrawal fee 使用 `${fromAccount.name}提现手续费`，repayment interest 使用 `${toAccount.name}还款利息`。账户改名不会修改已有 snapshot。普通的 note、location、amount、feeMinor 或 feeMode 修改也保留现有 payee；只有 transferKind、fromAccountId 或 toAccountId 真正改变交易 identity 时，才根据新的交易事实重新生成 snapshot。

## 10. Transaction Query & Pagination

transaction query 支持 type、accountId、categoryId、groupId、from、to、search、includeDeleted、limit、cursor 和 offset。cursor 是按 occurredAt、createdAt、id 排序的 keyset cursor；offset 供页码式读取使用，两者不能同时提供。服务端默认 limit 为 50，最大为 200。

交易记录页当前使用服务端 offset 分页，UI 页大小为 5、25、50、100。repository 会多取一行判断 nextCursor；默认返回未删除的 transaction rows，包括 grouped companion Expense。

search 在 repository / SQL 层完成，至少匹配持久化的 `location`、`payee`、`note`，并通过关联账户匹配 `account.name`、`fromAccount.name` 和 `toAccount.name`。因此搜索“微信”可以命中“微信零钱 → 招商银行储蓄卡” transfer，也可以通过 persisted payee 命中“微信零钱提现手续费”；搜索“招商”可以命中该 transfer。

## 11. Lifecycle

- Settings 首次创建时同时生成默认 Category；第一个账户创建后 hasCreatedAccount 单调变为 true，base currency 和 timezone 锁定。
- Account 创建校验 type/nature 配对和 currency；有历史后 type、nature、opening balance、opening date 不可改。账户的 UI lifecycle 与 backend domain safety rule 分开定义：

### Account UI lifecycle

Account Detail 的当前 UI 操作是：

~~~text
Active Account
├─ Edit
└─ Archive（currentBalanceMinor === 0）

Archived Account
├─ Restore
└─ Delete（仅 hasHistory === false）
~~~

- Active account 可以编辑和归档，但不直接提供物理删除入口。要从 UI 删除账户，流程是 `Active → Archive → Archived → Delete`。因此无历史但余额非 0 的 active account 需要先编辑期初余额为 0，再归档，最后删除。
- Archived account 的 Account Detail 不显示 Edit；需要先 Restore 才能继续使用编辑入口。服务端仍保留 archived account 的有限非财务字段 patch whitelist，但这不是当前详情页的编辑流程。
- Archive 要求 `currentBalanceMinor === 0`。Archive 是可逆状态变更，不删除 Account，不删除 Transaction；历史记录继续保留，归档账户不能用于新的财务操作，之后可以 Restore。
- UI 中的删除按钮文案是“删除账户”，但它执行的是不可逆的 physical / permanent delete，不是 Archive，也不是回收站。确认弹窗会明确说明操作无法撤销；Account lifecycle 没有 recycle bin。

### Account domain safety rule

物理删除最终由服务端根据账户是否存在任何持久化交易引用决定：

~~~text
repository.hasAccountHistory(accountId) === false
→ 允许物理删除

repository.hasAccountHistory(accountId) === true
→ 必须保留 Account identity
→ DELETE 返回 409 ledger-account-has-history
~~~

历史引用包括 income / expense / adjustment 的 `accountId`，以及 transfer 的 `fromAccountId` / `toAccountId`；soft-deleted transaction 也算历史。服务端的 `hasHistory` 是 `repository.hasAccountHistory(accountId)` 的 authoritative projection，不受最近流水分页、`includeDeleted` 默认值或当前页面是否显示交易影响。backend DELETE 不要求 `archivedAt !== null`；“先归档后删除”是 UI workflow，不是 backend 仅允许 archived account 删除的领域规则。

如果账户已有历史，仍只能修改当前 backend 允许的资料字段，不能修改 type、nature、opening balance 或 opening date 等 financial interpretation fields。

### Lifecycle consistency

如果 Account Detail 初始显示无历史，但另一个页面或标签页随后创建了新的交易，删除请求会由 backend 拒绝并返回 `ledger-account-has-history`。Account Detail 随后重新读取 authoritative state，将 `hasHistory` 更新为 true 并隐藏删除入口；UI 不通过本地猜测覆盖服务端 projection。

- Category 可创建、改名、换图标、移入回收站、恢复或永久删除；已有交易记录的分类不能移入回收站或永久删除，所有内置默认分类受保护。当前设置 UI 将无历史分类的删除操作放入回收站，并在回收站提供恢复和永久删除入口；服务端负责最终历史记录校验。旧版本误归档且已有历史的分类会在迁移时恢复。
- Income、Expense、Transfer 可创建和 PATCH；Adjustment 只能通过 account adjust endpoint 产生。Transaction 删除是 terminal soft delete；带 groupId 的操作按 group 原子删除。
- PATCH、archive、restore、delete 使用 expectedVersion 做乐观并发控制。

## 12. Idempotency / Recovery

POST settings、accounts、categories 和 transactions 通过 operation scope、规范化请求指纹和 Idempotency-Key 保护。客户端把新建 intent 暂存于当前标签页 sessionStorage；结果不明确时进入 UNCERTAIN，必须用原 intent 和原 key 重试或确认，不能直接创建第二笔相同操作。服务端事务边界保证 parent 与 companion 一起提交或回滚。

## 13. Routes

页面 canonical routes 是 /ledger、/ledger/transactions、/ledger/accounts 和 /ledger/accounts/:id。旧 /bills、/bills/transactions 只在 router 层重定向到相应 Ledger 页面。

API 以 /api/ledger 为前缀，包含 settings、accounts、categories、transactions、overview 和 trend；账户还提供 /:id/transactions、/:id/balance-trend、/:id/adjust、archive 和 restore。账户详情的最近流水、服务端计算的逐笔余额、余额趋势和 `hasHistory` 由服务端 projection 提供。`hasHistory` 直接来自 `repository.hasAccountHistory(accountId)`，表示持久化交易表中是否曾经有任何交易引用该账户，包括 soft-deleted transaction；它不受最近流水分页、`includeDeleted` 默认值或当前页面是否为空影响。Ledger route 统一使用 no-store，并继承服务端 owner-auth 边界。

## 14. Schema Evolution

当前仓库 Ledger schema version 为 29，迁移顺序如下：

~~~text
0013_ledger_foundation
0014_ledger_account_icon
0015_ledger_account_icon_preferences
0016_ledger_account_card_number
0017_seed_demo_card_numbers
0018_ledger_category_icon
0019_ledger_transaction_location
0020_ledger_transfer_kind
0021_ledger_transaction_groups
0022_ledger_system_categories
0023_ledger_system_category_icons
0024_ledger_default_categories
0025_ledger_recycle_bin_semantics
0026_ledger_account_icon_recycle_bin
0027_ledger_default_category_catalog
0028_ledger_transfer_payee
0029_ledger_companion_payees
~~~

`0029_ledger_companion_payees` 回填历史 repayment / withdrawal companion Expense 的 payee。它只处理明确的 legacy representation（空 payee，以及 repayment 中只保存 destination name 的旧格式），不覆盖已经存在的历史 snapshot；只有实际被修改的 row 才递增 version。

后续 schema 变更必须新增迁移，不应回写已执行文件；领域字段仍需同步 shared protocol、repository、service、projection 和测试。

## 15. Core Invariants

- 所有金额计算使用 minor units 和 checked safe-integer arithmetic。
- transaction records 是 source of truth，余额与概览数字是可重建 projections。
- Transfer principal 不属于 income 或 expense；repayment principal 不会污染支出。
- interest 和 fee 是 Expense，且分别绑定受保护 system category。
- grouped companion payee 是持久化的 transaction-time snapshot；projection 和 UI 不创造数据库中不存在的 companion business label。
- companion Expense 对 transaction query / transaction list read model 可见；某些 Overview projection 可以按产品语义折叠或隐藏它，但它不拥有独立 mutation ownership。
- composite group 的写入、修改和删除保持原子性。
- search 使用持久化 transaction fields 和结构化账户关系。
- 服务端拥有账户性质、transfer kind、货币、时间和生命周期校验。
- Entity mutation 遵循 expectedVersion；create 遵循幂等重放。

## 16. Known Boundaries

- Transfer、repayment 和 withdrawal 的 payee 可以真实持久化到 transaction record。普通 transfer 的表格标题仍可由当前 from/to 账户关系展示，但这不等于数据库不保存 transfer payee。
- /bills 是已确认的兼容路径，不是当前 Ledger product surface。

## 17. Tests

服务端 Ledger 测试覆盖 migration/API/auth/concurrency，以及 balance.test.ts、validation.test.ts、service.test.ts、projections.test.ts、idempotency.test.ts、time.test.ts 和 money.test.ts。客户端测试覆盖 API、store/recovery、时间与金额、初始化、Dashboard/period navigation、transaction sheet、transactions view、accounts view 和 account detail；相关测试位于 src/**/__tests__/ 和 src/views/__tests__/。
