# Ledger — UI Integration Implementation Plan

> [!IMPORTANT]
> **Historical Planning Baseline / Implemented and evolved.** 本文保留 UI 接入阶段的计划、评审和旧 baseline；它不描述当前生产 runtime。当前行为请参阅 [Ledger 用户指南](../user-guide/ledger.md)、[Ledger Architecture](../architecture/ledger.md) 和 [Ledger UI Language](ledger-ui-language.md)。

## 1. Status / review closure

| 项目 | 审计结果 |
| --- | --- |
| Plan date | 2026-09-05 |
| Remediation date | 2026-09-05（Asia/Shanghai） |
| Implementation Plan status | **Implementation Plan: Ready for Implementation** |
| Implementation Review | **PASS**（Conditional Pass findings closed） |
| Review closure date | 2026-09-05（Asia/Shanghai） |
| Implementation authorization | **Ready for Implementation**；本轮只关闭文档 review，不开始生产实现；编码前仍须 re-audit then-current `main` |
| Review baseline HEAD | `5724e66e78905f3d0518f723eb7c23f2a1e3d360` |
| Remediation audited main HEAD | `5724e66e78905f3d0518f723eb7c23f2a1e3d360` |
| audited HEAD commit | `docs(ledger): refine ui integration contracts` |
| Current committed repository reality | 当前 `main` 已包含 `7ace840 fix(e2e): wait for ledger workspace mount` 与上一轮 UI Integration 文档 remediation；本轮 review closure audit 时 working tree clean |
| Approved implementation-plan baseline | 本轮最终 documentation closure commit 所在的 `main` HEAD；该 SHA 由提交记录确定，coding 前仍须对 then-current `main` 重新审计 |
| Original IP drafting baseline | `85fd6a82f27d2fbaabaf59d9f13746bf0592d964`（historical only；不是当前实现 baseline） |
| Original PRD drafting baseline | `3af6541c8542e12877918159882108f3e3ff6c91`（historical only；不是当前实现 baseline） |
| Current document path | `docs/design/ledger-ui-integration-implementation-plan.md`（本轮重命名后） |
| REQ-003 path / status | repository 中未找到独立文件；本 Prompt 提供的 REQ-003 是本轮 authoritative P0 product input |
| Ledger v1 PRD | `docs/design/ledger-v1-prd.md`；Product Review: **Accepted** |
| Ledger L0 Foundation PRD | `docs/design/ledger-l0-foundation-prd.md`；Architecture Review: **Accepted** |
| UI Integration PRD | `docs/design/ledger-ui-integration-prd.md`；Product Review: **Accepted**（PASS） |
| L0 Implementation Plan | `docs/design/ledger-l0-foundation-implementation-plan.md`；内容中的 baseline 是旧的，不能代替当前代码审计 |
| latest migration in repository | `server/migrations/0013_ledger_foundation.sql`；已有 `ledger_settings.has_created_account`，本轮不新增 migration |
| current shared Ledger protocol | `shared/ledgerProtocol.ts`；当前 `LedgerSettingsDto` 只有 `baseCurrency`、`currencyExponent`、`timezone`、`version`、`createdAt`、`updatedAt`，尚未暴露 `hasCreatedAccount` |
| current Ledger service | `server/ledger/service.ts`；内部 `LedgerSettings.hasCreatedAccount` 已存在，首个 Account 创建后单调置为 true，当前 `toSettingsDto` 未返回它 |
| current API routes | `server/ledger/routes/**` 挂载于 `/api/ledger`；Settings、Accounts、Categories、Transactions、Overview、Trend、Adjustment routes 已存在 |
| current frontend route state | `src/router/index.ts` 当前仍注册 `/bills`、`/bills/transactions`，尚未注册 canonical `/ledger*` |
| current Bills mock state | `BillsView.vue`、`BillsTransactionsView.vue` 和 Bills components/features 仍运行时读取 `billsMockData`；新增记录仍 disabled |
| current verification scripts | `package.json` 中有 `typecheck`、`build`、`test`、`test:unit`、`test:e2e`、`test:e2e:auth`、`test:e2e:draft-store`、deployment smoke 等；无专用 `test:e2e:ledger` script |
| local runtime | Node `v24.15.0`，npm `11.12.1` |
| CI matrix | Node 24 on Ubuntu/macOS/Windows；Node 22 on Ubuntu |

本 Plan 已完成 Implementation Review，状态为 `Ready for Implementation`，但不能被解释为已经实施或已发布。编码开始前仍需满足：

1. 使用本轮 documentation closure commit 作为计划基线；
2. implementation 开始前再次 audit then-current `main`，确认没有新的生产代码或合同漂移；
3. 先完成 UI.1 中 planned `LedgerSettingsDto.hasCreatedAccount` 最小 projection prerequisite，再让 UI bootstrap 依赖该字段。

本轮未修改 `src/**`、`server/**`、`shared/**`、migration、tests、`package.json`、router、CI 或 Bills/Ledger UI。`LedgerSettingsDto.hasCreatedAccount` 仍是本 Plan 规划的生产前置，本轮没有把它写入代码。

当前 main 中的 e2e workspace mount 修复是既有 committed history，不是本轮 working-tree 变更。

## 2. Plan 目的与权威边界

REQ-003 的目标是把已经可用的 Ledger L0 API 接到 Nuvyn 用户界面，形成：

```text
进入 Ledger
  → 初始化 baseCurrency / timezone
  → 创建第一个 Account
  → + 记一笔
  → 保存真实 Transaction
  → Projection / Dashboard / Recent Transactions 更新
  → 刷新页面后数据仍然存在
```

本 Plan 只决定 repository 落地、前端边界、实现顺序和验证证据，不重新设计 Ledger 的财务语义。以下内容始终由已 Accepted 的上位文档和实际 L0 API 负责：

- natural balance 与 Account nature；
- Income、Expense、Transfer、Adjustment 的金融效果；
- Account、Category、Transaction lifecycle；
- opening balance 与 opening date 解释；
- baseCurrency / timezone lifecycle；
- UTC milliseconds、ISO 4217 exponent 和 minor-unit 表示；
- Overview、period、trend、breakdown 的服务端计算；
- `expectedVersion`、soft delete、persistent idempotency 与错误码。

前端不得实现第二套余额引擎、period engine、Category identity、currency exponent table 或 projection reducer。

## 3. Repository audit

### 3.1 Git、migration 与 L0 实现现实

审计基于当前 main HEAD，而不是旧 L0 Plan 的 `693dccf46638094cd54a369770f782d820df22f9` baseline。

当前 Ledger 相关提交已经包含：

- Settings、Accounts、Categories API；
- Transactions、Adjustment API；
- persistent idempotency replay；
- transaction lifecycle ordering；
- live Ledger projections；
- SQLite migration `0013_ledger_foundation.sql`；
- server/API、domain、repository、projection、validation、error、time、money 和 idempotency 测试。

`server/index.ts` 已将 Ledger route 挂载为 `/api/ledger`，并继承现有 `/api/*` owner authentication boundary。Ledger routes 统一使用 `Cache-Control: no-store`。因此 UI Integration 不需要新增认证体系、数据库 migration、server financial service 或 API route；但 re-audit 发现需要在 UI.1 增加一个只读 Settings DTO lifecycle projection，复用现有 server marker，不改变金融语义或数据库结构。

### 3.2 当前前端现实

审计了：

- `src/views/BillsView.vue`；
- `src/views/BillsTransactionsView.vue`；
- `src/components/bills/**`；
- `src/features/bills/**`；
- `src/router/index.ts`；
- `src/App.vue`、`src/components/NavBar.vue`、`src/style.css`；
- `src/lib/auth-session.ts`、`src/lib/api.ts`、`src/composables/useToast.ts`、`src/composables/useFocusTrap.ts`；
- `e2e/ledger-workspace.spec.ts` 及相关 View、Router、NavBar、auth redirect tests。

当前事实如下：

| 区域 | 当前实现 | UI Integration 处理 |
| --- | --- | --- |
| Dashboard | `BillsView.vue` 直接读取 `billsMockData` | 重写为真实 Ledger projection |
| Transactions | `BillsTransactionsView.vue` 读取 mock；新增和 filters disabled | 重写为真实分页列表、创建、查看、编辑、soft-delete |
| Account / Category | 没有真实 Ledger UI | 新增 Ledger UI surface |
| Routes | 只有 `/bills`、`/bills/transactions` | 增加 canonical `/ledger*`；旧地址只 redirect |
| Navigation | Ledger scope chip 仍 push `bills` route | 改为 canonical `ledger` route |
| App shell | 以 `bills-mode` 和 Bills predicate 区分 workspace | 使用 Ledger route predicate 和 Ledger-scoped classes |
| Components | Bills cards 的 props、formatters、aggregations 都依赖 mock model | 仅复用视觉意图；输入改为 shared DTO / projection |
| Features | `src/features/bills/mockData.ts` 明确是无 persistence fixture | UI Integration runtime 不得再 import；完成迁移后删除 |
| Dialog | Nuvyn 已有 Teleport、`role=dialog`、Escape、focus trap pattern | 复用 `useFocusTrap` 与现有 shell，不引入新 UI framework |
| Error / toast | `authFetch` 观察 session expiry；`jsonOrThrow` 保留 status/body/code；`useToast` 提供 info/success/error | Ledger API boundary 统一归一化；页面保留字段级错误和恢复动作 |
| i18n | `useI18n` 是轻量 zh/en 字符串表，Bills prototype 多数文案硬编码 | 新 Ledger 用户可见文案进入 `ledger.*` keys；不继续新增 Bills 文案 |

### 3.3 测试和验证现实

当前的 `e2e/ledger-workspace.spec.ts` 是 Bills prototype characterization：它访问 `/bills`、断言 `bills-page`、`bills-mode`、mock asset card 和 mock scrollbar。UI Integration 必须将它改成 canonical Ledger shell / no-mock characterization，不能保留“mock 渲染成功”作为产品证据。

当前已有的 Ledger 服务端回归集中在：

- `server/__tests__/ledger-api.test.ts`；
- `server/ledger/*.test.ts`。

这些测试已经覆盖 owner boundary、初始化、Account/Category/Transaction/Transfer/Adjustment、idempotency、cursor、Overview、trend 和 lifecycle。UI Integration 默认不修改这些 server tests；只有审计发现 API contract gap 时才能另行停下并回到 authoritative document。

### 3.4 Package scripts 与 CI matrix

当前 `package.json` 中实际存在的相关 commands：

```text
npm run typecheck:client
npm run typecheck:server
npm run typecheck
npm run build
npm run test:unit
npm test
npm run test:e2e
npm run test:e2e:draft-store
npm run test:e2e:auth
npm run test:tags-scale
npm run test:deployment-auth
npm run test:deployment-vault-lifecycle
npm run lint:icons
npm run lint:icons:strict
```

CI 的 browser 命令还直接使用：

```text
npx playwright install chromium
node node_modules/@playwright/test/cli.js test --config=playwright.cross-platform.config.ts --reporter=line,github
```

`.github/workflows/ci.yml` 当前包含 `verify`、`tags-scale`、`docker-smoke`、`auth-browser`、`visual` jobs。UI Integration 不会把不存在的 `npm run test:e2e:ledger` 当作当前 command；如后续需要隔离的 Ledger E2E config，将使用已存在的 Playwright CLI 直接调用，或在独立 review 中添加 script。

## 4. Roadmap relationship

`docs/design/ledger-v1-prd.md` 中已经 Accepted 的 roadmap 是 capability roadmap，编号保持不变：L0 Foundation、L1 Accounts、L2 Transactions、L3 Transfers & Balance Integrity、L4 Dashboard Real Data、L5 Filtering & Search、L6 Categories，以及后续 L7/L8。

Ledger UI Integration 是一个跨 capability 的 delivery milestone，不是新的 roadmap phase，也不占用 “L1” 名称。它把 Accounts、Transactions、Transfers、Dashboard、basic filtering 和 minimum Category UI 组合为第一个完整的用户可用 UI 闭环。full Category Management、Adjustment UI、free-text Search 等未纳入本次 delivery 的能力，仍留在原 roadmap 或后续独立 requirement。

本 Plan 使用 REQ-003 和 UI Integration PRD 冻结的 delivery scope，不修改 `ledger-v1-prd.md` 的 L1–L8 编号，不重新定义任何 financial、lifecycle、projection、amount 或 idempotency contract。full Category Management、Adjustment UI、free-text search 的延后是本次 delivery cut，不是未解决的 phase conflict。

因此这里没有 unresolved Product / Architecture Contract Conflict blocker。UI Integration PRD 已为 `Accepted`，本 Plan 的 Implementation Review findings 已关闭；`hasCreatedAccount` visibility gap 是一个已识别、最小且有明确落点的 UI.1 planned prerequisite，不是未决的产品或架构 blocker。编码开始前仍必须 re-audit then-current `main`。

## 5. Accepted API contract audit

### 5.1 Settings / initialization

| API | 当前 contract | 前端计划 |
| --- | --- | --- |
| `GET /api/ledger/settings` | 当前已初始化返回的 `LedgerSettingsDto` 包含 `baseCurrency`、`currencyExponent`、`timezone`、`version`、`createdAt`、`updatedAt`；当前 DTO **不包含** `hasCreatedAccount`；未初始化返回 `404 ledger-not-found` | 只有这个明确的 404 才进入 `UNINITIALIZED`；UI.1 完成 planned DTO projection 后，使用只读 `hasCreatedAccount` 区分 `FIRST_ACCOUNT_REQUIRED` 与 `NO_ACTIVE_ACCOUNT`；其他错误不能被误判为首次使用 |
| `POST /api/ledger/settings` | exact payload `{ baseCurrency, timezone }`；需要 `Idempotency-Key`；成功 `201`；服务端同时 seed 默认 Categories；当前 response DTO 尚未暴露 `hasCreatedAccount` | UI 要求主动确认两个值；成功后以 response 为准并加载真实 Categories；UI.1 使 response 带上 read-only lifecycle marker |
| `PATCH /api/ledger/settings` | 带 `expectedVersion`；首个 Account 创建前可改；首个 Account 后 `baseCurrency` / `timezone` 分别受 locked error 保护；当前 response DTO 尚未暴露 `hasCreatedAccount` | UI Integration onboarding 必须允许返回上一步修正未冻结设置；lock gate 使用 planned read-only marker，并不提供绕过 lock 的快捷操作 |

`baseCurrency` 不由 browser locale 静默决定。browser timezone 只能作为可见预选建议；用户必须主动确认 `baseCurrency` 和 `timezone`。首个 Account 成功后两个值由服务端 lifecycle 冻结。当前 server/domain 已有 `hasCreatedAccount` marker，但它尚未进入 browser-visible DTO；这项最小 projection addition 是 UI.1 的 planned production prerequisite，不是本轮已经存在的 API 能力。

### 5.2 Accounts

| API | 当前 contract | 前端计划 |
| --- | --- | --- |
| `GET /api/ledger/accounts?includeArchived=false` | 返回 Account DTO；默认不含 archived；`includeArchived=true` 返回历史 Account | Dashboard / create selector 只使用 active accounts；Account management 与 Transactions history filter 使用 `includeArchived=true` 并标记 archived |
| `GET /api/ledger/accounts/:id` | 返回 Account DTO，包括 `currentBalanceMinor`、`version`、`archivedAt` | Account detail 以此为 authoritative snapshot |
| `GET /api/ledger/accounts/:id/transactions` | 返回 account、movement、transaction page；支持 `includeDeleted`、cursor 等 query；Account 本身即使 archived 仍可查询 | detail 页用 `includeDeleted=true&limit=1` 判断是否存在历史，不能由余额猜 history；历史筛选保留 archived Account context |
| `POST /api/ledger/accounts` | exact create fields：`name`、`type`、`nature`、`openingBalanceMinor`、`openingDate`、`currency`、`note`；需要 `Idempotency-Key` | Account 表单使用用户金额；currency 只读继承 baseCurrency |
| `PATCH /api/ledger/accounts/:id` | `expectedVersion`；无历史可改 financial interpretation fields；有历史只能改 `name`/`note`；archived 只能改 `name`/`note` | UI 根据 authoritative history 显示可编辑字段；不让用户尝试服务端拒绝的字段 |
| `POST /api/ledger/accounts/:id/archive` | `expectedVersion`；current balance 必须为 0 | 非零时展示可理解的余额和处理方向，不自动生成交易 |
| `POST /api/ledger/accounts/:id/restore` | `expectedVersion`；恢复 archived Account | 恢复后重新加载 accounts / overview |
| `DELETE /api/ledger/accounts/:id` | physical delete；无 history 才允许 | UI Integration 不暴露；保留为 server capability，不作为普通维护动作 |

合法 Account type/nature pairing 由 server `domain.ts` / validation authority 决定：cash、bank、wallet 是 asset；credit_card、loan 是 liability；other 才允许用户选择“我拥有的钱 / 我欠的钱”。

### 5.3 Categories

| API | 当前 contract | 前端计划 |
| --- | --- | --- |
| `GET /api/ledger/categories?kind=income\|expense&includeArchived=false` | 返回真实 Category；默认排除 archived；`includeArchived=true` 返回历史 Category | create selector 只使用 active kind；Transactions history filter 使用 `includeArchived=true` 并标记 archived |
| `POST /api/ledger/categories` | `{ kind, name }`；需要 `Idempotency-Key`；normalized identity 和 duplicate 由 server 决定 | Transaction Sheet 提供 kind 固定的 quick create；成功后使用 response 的真实 ID |
| Category PATCH / archive / restore / DELETE | API 已存在；history、identity、archived rules 由 server 决定 | UI Integration 不做 full Category Management 页面，不暴露这些普通管理动作 |

初始化时的默认 Category 由 `server/ledger/defaultCategories.ts` seed，不能从 `billsMockData` 或前端硬编码推导。当前默认 catalog 为：

- Expense：餐饮、交通、购物、住房、日用、娱乐、医疗、教育、旅行、人情、其他；
- Income：工资、奖金、投资收益、兼职、退款、红包、其他。

### 5.4 Transactions

| Transaction type | 当前 create payload | UI Integration 表单 |
| --- | --- | --- |
| `income` | `type`、positive `amountMinor`、`accountId`、`categoryId`、UTC `occurredAt`、`payee`、`note` | 金额、账户、收入分类、日期/时间；payee/note optional |
| `expense` | `type`、positive `amountMinor`、`accountId`、`categoryId`、UTC `occurredAt`、`payee`、`note` | 金额、账户、支出分类、日期/时间；payee/note optional |
| `transfer` | `type`、positive `amountMinor`、`fromAccountId`、`toAccountId`、UTC `occurredAt`、`note` | 金额、转出账户、转入账户、日期/时间；note optional |
| `adjustment` | generic transaction create 被 server 拒绝；必须走 Account Adjustment endpoint | UI Integration 不放进普通新增入口；已有 Adjustment 只读展示 |

`GET /api/ledger/transactions` 支持 `type`、`accountId`、`categoryId`、`from`、`to`、`search`、`includeDeleted`、`limit`、`cursor`。`accountId` 会匹配普通交易账户以及 Transfer 的 from/to，`categoryId` 会匹配 income/expense 的关联分类；查询按 ID 过滤，不因 Account 或 Category 当前 archived 而隐藏其历史 active Transaction。UI Integration 只暴露 PRD 已冻结的 type/account/category/date basic filters，不在 UI 顺手加入 free-text search 或高级保存筛选。

`PATCH /api/ledger/transactions/:id` 需要 `expectedVersion`，type immutable；`DELETE` 是 terminal soft delete，需要 `expectedVersion`。如果已有 Transaction 关联 archived Account，server 只允许 income/expense 修改 `note`/`payee`，只允许 transfer 修改 `note`；amount、occurredAt、account/category、from/to 等 financial fields 会被拒绝。对任何关联 archived Account 的 Transaction，DELETE 也会被拒绝。UI Integration 必须在客户端先反映这些限制，而不是依赖 generic 409；Adjustment 仍只读，Transaction delete 无 restore UI。

### 5.5 Projections

`GET /api/ledger/overview?scope=today|week|month|year|all` 已返回：

- `currency`、`currencyExponent`；
- `assetTotalMinor`、`liabilityTotalMinor`、`netWorthMinor`；
- account summaries 与 current balances；
- selected scope 的 `cashflow`；
- selected scope 的 income/expense `categoryBreakdown`；
- fixed `periods`：today/week/month/year；
- recent active transactions；
- recent calendar-month `trend`。

`scope` 只改变 cashflow 与 category breakdown；资产、负债、净资产、账户余额、periods、trend、recentTransactions 服从现有 server semantics。UI Integration 默认请求 `scope=month`，scope 切换时重新消费 projection，不在 client 重新定义边界或做 `reduce()`。

### 5.6 Settings lifecycle visibility gap（planned UI.1 prerequisite）

re-audit 确认当前 shared `LedgerSettingsDto` 只有以下字段：

```text
baseCurrency
currencyExponent
timezone
version
createdAt
updatedAt
```

当前 `server/ledger/domain.ts` 的内部 `LedgerSettings` 已有 `hasCreatedAccount`，`server/ledger/service.ts` 的 `toSettingsDto` 也从现有 marker 生成其它 Settings 字段，但当前 GET/POST/PATCH Settings response 没有把该 marker 暴露给 browser。第一次 Account 成功创建时 server 已将 marker 从 `false` 单调更新为 `true`；之后即使无历史 Account 被 physical DELETE，marker 仍保持 `true`。

这是一个只读 lifecycle projection gap，不是 schema redesign、migration 或 financial semantic change。UI.1 必须作为最小 planned production prerequisite 完成：

- 在 `shared/ledgerProtocol.ts` 的 `LedgerSettingsDto` 增加 `readonly hasCreatedAccount: boolean`；
- 在实际 Settings DTO mapping（当前为 `server/ledger/service.ts` 的 `toSettingsDto`）中返回该值；
- GET、POST、PATCH `/api/ledger/settings` 都返回它；
- 保持现有 `ledger_settings.has_created_account` persistence、锁定规则和 Account 创建事务不变；不新增 SQLite 列或 migration；
- client 只能读取该字段，不得写回或从 `accounts.length` 推断 settings lock。

因此，当前 API 已覆盖绝大多数 REQ-003 / UI Integration PRD capability；唯一已知缺口是上述最小 browser-visible lifecycle projection。该缺口已有明确 remediation、测试责任和 UI.1 落点，不构成 unresolved P0/P1 blocker，但在 UI bootstrap 依赖它的实现之前必须关闭。

## 6. Target frontend architecture

### 6.1 API boundary

计划新增一个 feature-owned boundary：`src/features/ledger/api.ts`。

它是所有 Ledger HTTP 请求的唯一入口，职责为：

- 调用现有 `src/lib/auth-session.ts` 的 `authFetch`；
- 解析现有 `{ error, code, details }` envelope；
- 使用 `shared/ledgerProtocol.ts` 的 DTO / request types；
- 组织 query、`Idempotency-Key` 和 `expectedVersion`；
- 把 401 session expiry、Ledger error code、网络失败和 malformed response 归一化为 feature error；
- 不承载余额、分类、period 或 transaction semantics。

Vue components 不直接写 `fetch('/api/ledger/...')`，也不从 `server/ledger/**` import。browser-safe 的 shared imports 只允许来自：

- `shared/ledgerProtocol.ts`；
- `shared/ledgerCurrency.ts`；
- `shared/ledgerNormalization.ts`。

`server/ledger/time.ts` 使用 server-side Temporal boundary，不进入 browser bundle。

### 6.2 Feature-local state and refresh

计划新增 `src/features/ledger/ledgerStore.ts` 作为轻量 feature-local reactive store，不引入 Pinia 或新的 state library。它统一持有：

- Ledger settings 与 lifecycle state；
- active / archived Account snapshots；
- income / expense Categories；
- selected Overview scope 与 Overview projection；
- current Transactions query、page、next cursor；
- selected Account detail；
- request epochs、loading、recoverable error 和 mutation status。

所有 Ledger views 通过这个 store 的 actions 读取或刷新，不各自维护一份 account/overview/transaction copy。store 必须有显式 `reset()`，在 session expiry、logout、workspace unmount 或新 owner session 开始时清除上一个 owner 的财务 presentation state；但 `reset()` 不得删除尚未确认的 create intent。presentation store 与 pending-create recovery record 是两个不同生命周期，后者按 §11.5 的规则独立保留或清理。

推荐的 refresh contract：

1. 初始化后 reload settings + categories；
2. 首个 Account 创建后 reload accounts + overview；
3. transaction create/edit/delete 后 reload accounts + overview + 当前 transaction query；
4. Category quick create 后以 response 更新 Category selector，并在需要时重新读取当前 kind；
5. Account edit/archive/restore 后 reload accounts、detail 和 overview；
6. reload 使用 request epoch 丢弃旧请求完成结果，防止慢响应覆盖新 authoritative snapshot。

正常 mutation 成功时，UI 先保留 server mutation response，再立即请求受影响的 authoritative projections。refresh 失败时不能回到 mock；可以显示“已保存，汇总刷新失败”的可恢复状态，并允许 retry。

### 6.3 Money presentation boundary

计划新增 `src/features/ledger/money.ts`，但不实现新的金额 authority：

```text
user decimal string
  → shared parseDecimalToMinor(value, currency)
  → API integer minor unit

API integer minor unit
  → shared formatMinorToDecimal(value, currency)
  → locale presentation
```

金额输入使用 string，不使用 browser floating-point number 作为财务中间值。显示层使用 response 的 `currency` / `currencyExponent` 和 `Intl.NumberFormat` 做 presentation；不能硬编码 `100 cents`、2 位小数或任意 currency symbol。

必须用 CNY、JPY、KWD 测试：

- CNY `38` 显示为 `¥38.00` / 对应 locale representation；
- JPY 不显示伪造的 `.00`；
- KWD 按 3 位小数；
- 输入精度超过 exponent、非法 decimal、overflow、0/负数交易金额都在正确层级被拒绝。

### 6.4 Time presentation boundary

计划新增 browser-safe `src/features/ledger/time.ts`：

- 使用 Ledger settings 返回的 named IANA timezone 作为唯一用户可见时区；
- 使用现有已安装的 `@js-temporal/polyfill` 处理 local date/time 到 UTC millisecond 的转换，避免手写 DST 偏移；
- 使用 `Intl.DateTimeFormat(..., { timeZone: settings.timezone })` 展示 stored UTC instant；
- 新建表单打开时 default 为当前 instant，但以 Ledger timezone 拆分成用户可编辑的日期与时间；
- Dashboard `today/week/month/year` 的边界完全取 server projection 的 `startAt` / `endAt`，client 不重新计算。

browser timezone 可以帮助生成 initialization 预选，但不得替代 Ledger timezone 传输或显示 authority。

## 7. Ledger state model

### 7.1 Workspace lifecycle

```text
BOOTSTRAPPING
    ├── GET settings = 404 ledger-not-found → UNINITIALIZED
    ├── settings.hasCreatedAccount=false + no current/active Account → FIRST_ACCOUNT_REQUIRED
    ├── settings.hasCreatedAccount=true + no active Account
    │       → NO_ACTIVE_ACCOUNT（archived-only 或 current entity 为 0）
    └── settings.hasCreatedAccount=true + active Account → READY

UNINITIALIZED
    → INITIALIZING
    → FIRST_ACCOUNT_REQUIRED

FIRST_ACCOUNT_REQUIRED
    → ACCOUNT_CREATING
    → READY
    → FIRST_ACCOUNT_REQUIRED（取消/稍后）

NO_ACTIVE_ACCOUNT
    → restore archived Account（若存在）→ READY
    → create new Account（即使存在 archived/history Account）→ READY

READY
    → OVERVIEW_LOADING / mutation sub-state
    → READY

任何 protected request 的明确 401 auth-session-required
    → SESSION_EXPIRED
```

loading、recoverable error、session expired 是 overlay/status state，不允许用旧 projection 或 mock 填充主内容。

### 7.2 Entry state rules

| 状态 | UI 行为 | 下一步 |
| --- | --- | --- |
| `UNINITIALIZED` | 只显示 Ledger initialization surface；不显示正常 Dashboard shell | 选择并确认 baseCurrency / timezone |
| `FIRST_ACCOUNT_REQUIRED` | `settings.hasCreatedAccount=false` 且当前没有可用 Account；显示已初始化上下文和明确首个 Account CTA；不显示全 0 Dashboard | 创建第一个 Account，或稍后返回此状态 |
| `NO_ACTIVE_ACCOUNT` | `settings.hasCreatedAccount=true` 且没有 active Account；显示 Account 管理/归档说明，保留 archived/history context | 恢复一个 archived Account（若存在），或创建一个新的 active Account |
| `READY` + 0 transactions | 显示真实 Dashboard shell；余额来自 Account/opening balance；recent/period/trend 使用真实空数据 | `+ 记一笔` |
| `READY` + transactions | 显示完整真实 projection、Account 和 recent records | 继续记账或查看 Transactions |
| loading | skeleton/status；primary mutation disabled | 等待或按页面提供 retry |
| recoverable error | 说明影响范围并提供 retry/reload | 用户修复或重试 |
| `SESSION_EXPIRED` | 不泄露 stale Ledger 数据；沿用全局登录 redirect / expiry notice | 重新登录 |

### 7.3 Create intent mutation state

所有 create mutation（Settings、Account、Category quick create、Transaction，以及未来若接入 UI 的 Adjustment）都必须有独立的 intent sub-state：

```text
CREATE_INTENT_DRAFT
        ↓ submit
CREATE_INTENT_SUBMITTING
   ├─ definite success → CREATE_INTENT_CONFIRMED
   ├─ definite 400 / deterministic 409 / 503 failure → DRAFT / ERROR
   └─ outcome unknown → CREATE_INTENT_UNCERTAIN

CREATE_INTENT_UNCERTAIN
   ├─ retry same canonical payload + same Idempotency-Key
   │       → CONFIRMED
   └─ cancel / new intent
           → first confirm the original authoritative result
```

`CREATE_INTENT_UNCERTAIN` 与普通 validation error 必须是不同状态。进入 UNCERTAIN 后，canonical payload 字段不可直接编辑；不能因为用户修改金额、Account、Category 或时间就生成新 key。只有原 intent 被确认成功，或被确认没有创建成功后，才允许新的 payload + 新 Idempotency-Key。intent snapshot/key 至少要跨 component re-render、transport retry 和 sheet 状态变化保持；如果页面 reload 后仍有未确认 intent，UI 必须先提供原 intent 的结果确认/恢复路径，不能让用户无提示地开始第二个 create。`settings.hasCreatedAccount` 是判断 `FIRST_ACCOUNT_REQUIRED` 与 `NO_ACTIVE_ACCOUNT` 的唯一 lifecycle authority；`accounts.length` 不能替代它。

## 8. Route / naming / shell migration

### 8.1 Canonical routes

实现时在 `src/router/index.ts` 注册：

| 用途 | canonical route | 建议 route name |
| --- | --- | --- |
| Dashboard / onboarding | `/ledger` | `ledger` |
| Transactions | `/ledger/transactions` | `ledger-transactions` |
| Account list | `/ledger/accounts` | `ledger-accounts` |
| Account detail | `/ledger/accounts/:id` | `ledger-account` |

以上路由保持当前 workspace shell contract：`fullWidth: true`、`workspace: true`、`sidebar: false`。Ledger 仍是共享 Nuvyn App Shell 中的 body workspace，不创建第二个 Navbar 或 Vault sidebars。

### 8.2 Legacy routes

UI Integration 保留以下 compatibility redirects，不再渲染 Bills page：

```text
/bills              → /ledger
/bills/transactions → /ledger/transactions
```

redirect 保留合法 query/hash context，避免登录 deep link、旧书签和旧入口丢失上下文。redirect 目标必须是 canonical route，不能形成 `/bills` ↔ `/ledger` loop。

`/bills` compatibility route 在 UI Integration release 保留；删除时机不属于本次 delivery implementation，必须在后续 release 满足“旧链接 inventory 完成、用户通知/迁移策略确认、Product Review 明确退休”的独立 gate 后再删除。

### 8.3 Auth redirect and navigation

`src/lib/auth-redirect.ts` 的 same-origin allowlist 必须同时识别：

- `/ledger` 及其 canonical descendants；
- `/bills` legacy paths。

`src/components/NavBar.vue` 的 Ledger scope chip 改为 push `{ name: 'ledger' }`。`src/App.vue` 和 Navbar 以 `/ledger` predicate 管理 compact workspace chrome；旧 Bills path 只在 redirect 尚未完成的 router boundary 处理。

当前 shared-shell prop `isVault` 是内部历史命名，不是用户可见产品术语。UI Integration 不为了 rename 而扩大 shell refactor；但 `isBills` 行为 predicate、`bills-mode` / `bills-nav-mode` route classes 和 Ledger feature 的用户可见 copy 必须迁移为 Ledger 语义。`src/style.css` 中对应 scope selector / variable 一并迁移。

### 8.4 Prototype file migration

不要机械保留 Bills runtime graph：

| 当前文件/目录 | 计划处理 |
| --- | --- |
| `src/views/BillsView.vue` | 重写为 `src/views/LedgerView.vue`；所有 runtime import 清零后删除旧文件 |
| `src/views/BillsTransactionsView.vue` | 重写为 `src/views/LedgerTransactionsView.vue`；清零后删除旧文件 |
| `src/components/bills/BillsAssetOverviewCard.vue` | 重写为真实 DTO-driven Ledger asset/liability/net worth/account surface |
| `src/components/bills/BillsCategoryBreakdownCard.vue` | 重写为带 selected period、金额和 accessible text 的真实 breakdown surface |
| `src/components/bills/BillsPeriodCard.vue` | 重写为 server `periods` presentation；删除 budget/highlight 语义 |
| `src/components/bills/BillsRecentTransactionsCard.vue` | 重写为真实 transaction DTO list；支持行点击/empty/create context |
| `src/components/bills/BillsTrendCard.vue` | 重写为真实 trend；补文本替代表达，不显示 demo 曲线 |
| `src/features/bills/mockData.ts` | 所有 runtime import 清零后删除；不能作为 fallback |
| `src/features/bills/aggregations.ts` | 若只服务 mock，迁移后删除；不得被 Ledger 用来计算 financial projection |
| `src/features/bills/formatters.ts` | 删除；替换为 Ledger currency boundary |
| `src/components/bills/**/tests`、`src/features/bills/**/tests` | 改为 Ledger DTO/presentation tests 后删除 mock characterization |

可复用的是现有视觉/interaction pattern，不是 Bills domain types、mock aggregation 或 Bills product terminology。

## 9. Initialization 与 first Account implementation

### 9.1 Initialization

计划新增/重写：

- `src/views/LedgerView.vue`；
- `src/components/ledger/LedgerOnboarding.vue`；
- `src/components/ledger/LedgerInitializationForm.vue`；
- 对应 view/component tests。

行为顺序：

1. mounted 时通过 API boundary 读取 settings；
2. 只有 `404 ledger-not-found` 进入 initialization；
3. 页面显示 baseCurrency、timezone 的用途、period 影响和首个 Account 后锁定的时机；
4. currency 使用受支持 ISO code selector；timezone 使用 named IANA selector；browser timezone 只能作为可见 preselect；
5. 用户点击 `继续创建第一个账户` 后才提交；前端不自动 POST；
6. 生成一个 settings create intent key；明确成功或明确失败后才结束 intent；只有 timeout/connection reset/response loss 等 transport outcome unknown 才进入 `CREATE_INTENT_UNCERTAIN`，retry/检查复用同一 canonical payload 和同一 key；在结果确认前不得修改 payload 或创建新 key；收到 503 `ledger-write-busy` 是 definite failure，保留输入并回到 `DRAFT / ERROR`，不进入 UNCERTAIN；
7. 成功后以 response settings 为准，进入 first Account step；默认 Categories 由真实 API 加载；
8. 如果 concurrent session 已初始化，重新读取 settings；根据 `hasCreatedAccount=false` 进入 `FIRST_ACCOUNT_REQUIRED`，根据 `hasCreatedAccount=true` 且无 active Account 进入 `NO_ACTIVE_ACCOUNT`，不把 `ledger-settings-already-initialized` 变成不可恢复错误；
9. 用户取消 Step 2 时保持 `FIRST_ACCOUNT_REQUIRED`，再次进入仍给出 create Account CTA；
10. initialization failure 保留用户输入，字段问题就地提示；收到 503 `ledger-write-busy` 是 definite temporary failure，保留输入并允许新的 formal retry，不进入 UNCERTAIN；只有 transport outcome unknown 才进入 UNCERTAIN 并提供同一 intent 的 retry/检查；明确失败才回到可编辑状态，401 交给 session expiry flow。

### 9.2 First Account

计划新增/重写：

- `src/components/ledger/LedgerFirstAccountForm.vue`；
- `src/components/ledger/LedgerAccountForm.vue`（后续 Account edit 共用）；
- `src/components/ledger/LedgerAccountTypeFields.vue`（仅在需要时拆出，不能复制 server pairing authority）；
- 对应 tests。

字段落地：

| 用户字段 | transport | 实现要求 |
| --- | --- | --- |
| 账户名称 | `name` | 必填，用户识别名称，不假设唯一 |
| 账户类型 | `type` | cash/bank/wallet/credit_card/loan/other 的用户语言；不显示内部 snake case |
| 钱的性质 | `nature` | 已知 type 自动锁定；other 显示“我拥有的钱 / 我欠的钱” |
| 期初余额 | `openingBalanceMinor` | string decimal → shared parser；默认 0；允许 signed opening state；不让用户输入 minor unit |
| 起始日期 | `openingDate` | Ledger timezone 下 local date；默认今天；用户可改 |
| 账户币种 | `currency` | 只读显示 baseCurrency；不允许 FX / cross-currency |
| 备注 | `note` | optional；提示用途/尾号，不提示密码/token |

提交时使用 Account create idempotency key。成功后必须以 server response 的 `currentBalanceMinor` / `version` 为准，进入 `/ledger` 的真实 Dashboard；不能用本地 opening balance 计算资产或净资产。

First Account step 同时显示当前 baseCurrency/timezone 和 `[修改 Ledger 设置]`。点击后返回初始化 Settings surface，使用当前 Settings `version` 调用 PATCH；保存成功后以服务端返回值刷新并重新进入 First Account。只要首个 Account 尚未成功创建，该返回入口都有效；首个 Account 成功后 server lock 生效，UI 不再允许编辑这两个字段。若并发 session 已先完成首个 Account，必须重新读取状态而不是用旧表单覆盖 locked settings。

## 10. Account UI implementation

### 10.1 Surfaces and files

计划新增：

- `src/views/LedgerAccountsView.vue`；
- `src/views/LedgerAccountDetailView.vue`；
- `src/components/ledger/LedgerAccountList.vue`；
- `src/components/ledger/LedgerAccountRow.vue`；
- `src/components/ledger/LedgerAccountForm.vue`；
- `src/components/ledger/LedgerArchivedAccounts.vue`；
- `src/components/ledger/LedgerAccountMovement.vue`；
- 对应 tests。

入口固定为：

- Dashboard Account section 的 `管理账户`；
- `/ledger/accounts` 页面入口；
- Account row/detail 进入 `/ledger/accounts/:id`。

### 10.2 Edit/archive/restore rules

- 首次创建和无历史 Account：显示所有 contract-allowed financial fields；currency 永远不可改；
- 已有任何历史（包括 deleted transaction）：只显示 name/note edit；使用 account transaction endpoint with `includeDeleted=true` 判断 history；
- archived Account：默认只显示 name/note edit；其他字段先 restore；
- archive 需要 current balance 为 0，409 `ledger-account-nonzero-balance` 显示当前余额和可恢复方向；
- stale `expectedVersion` 映射为“账户已被其他更新改变，请重新加载”，不覆盖他人修改；
- restore 成功后重新读取 authoritative list/detail/overview；
- physical DELETE 不出现在 UI，不做“为了 API 完整而删除”按钮。

## 11. Transaction creation implementation

### 11.1 `+ 记一笔`

Dashboard 和 Transactions page 都显示 `+ 记一笔`，但 Dashboard 是一级主 action。计划由 `LedgerView.vue` / `LedgerDashboard.vue` 提供统一 open action，Account detail 可以带入 source Account context。

状态行为：

- active Account 存在且数据可用：打开 Transaction Sheet；
- 一个 active Account：预选但仍显示 Account selector；
- 多个 active Account：无 context 时要求明确选择；
- `FIRST_ACCOUNT_REQUIRED`：转向 first Account CTA，不打开不可保存的 Sheet；
- `NO_ACTIVE_ACCOUNT`：转向 restore archived Account（若存在）或 create new Account，不打开不可保存的 Sheet；
- loading/error：disabled 或显示对应 retry，不打开依赖 stale data 的可保存 form；
- narrow layout：action 仍可见，keyboard 可触达。

### 11.2 Unified Transaction Sheet

计划新增：

- `src/components/ledger/LedgerTransactionSheet.vue`；
- `src/components/ledger/LedgerTransactionTypePicker.vue`；
- `src/components/ledger/LedgerTransactionFields.vue`；
- `src/components/ledger/LedgerCategoryQuickCreate.vue`；
- `src/components/ledger/LedgerTransactionDetails.vue`；
- 对应 component tests。

打开 create form 时默认 `expense`。用户可以切换 `expense / income / transfer`；切换只保留金额、时间、备注等 common draft，并清除不适用的 Account/Category/payee 字段，不把 expense Category 静默带到 income。

| 类型 | 显示字段 | 隐藏字段 | 校验 |
| --- | --- | --- | --- |
| 支出 | 金额、active Account、active expense Category、发生时间、optional payee、optional note | from/to Account | 金额为正；Category kind=expense；账户 active |
| 收入 | 金额、active Account、active income Category、发生时间、optional payee、optional note | from/to Account | 金额为正；Category kind=income；账户 active |
| 转账 | 金额、active from Account、active to Account、发生时间、optional note | Category、payee | 金额为正；from ≠ to；两账户 active |

Account selector 使用真实 Account DTO 的 name、用户可读 type/nature、当前余额；archived Account 不进入 create options。Category selector 使用真实 API response；没有 active kind 时显示 kind-fixed quick create，不允许保存空 Category。

### 11.3 Amount / date / form behavior

- amount 输入为 decimal string，显示 currency code/symbol 和正确 exponent；
- transaction amount 的 0、负数、超精度、非法格式和 overflow 先做字段级提示，server 仍是最终 authority；
- occurredAt 默认打开 Sheet 时的 now instant，以 Ledger timezone 显示；用户分别修改 date/time；提交转换为 UTC ms；
- payee 只在 income/expense 出现，文案可按上下文为“交易对象/来源”；
- note 在三种类型出现且 optional；
- 编辑 existing ordinary transaction 时预填 DTO，type 显示但不可切换；
- dirty form 关闭前确认丢弃；saving 期间禁止关闭、Escape 重复提交或二次 submit；
- 保存成功只有在 server response 和 authoritative refresh path 建立后才显示已记账；refresh 失败显示可恢复提示，不显示猜测余额。

### 11.4 Idempotency-Key lifecycle and UNCERTAIN safety

对于 Settings、Account、Category quick create、Transaction create，以及未来若接入 UI 的 Adjustment create，client 采用统一的 intent state：

```text
CREATE_INTENT_DRAFT
        ↓ first submit
CREATE_INTENT_SUBMITTING
   ├─ definite success → CREATE_INTENT_CONFIRMED
   ├─ definite 400 / deterministic 409 / 503 failure → DRAFT / ERROR
   └─ timeout / connection reset / response loss → CREATE_INTENT_UNCERTAIN

CREATE_INTENT_UNCERTAIN
   ├─ retry same canonical payload + same key → CONFIRMED
   └─ cancel / new intent → first confirm the original result
```

实现必须遵守：

1. 打开一个新 create intent 时建立 draft；第一次 submit 才生成 opaque UUID/string key，并把 canonical payload snapshot 与 key 绑定到该 intent；
2. server 明确成功后进入 `CONFIRMED`；HTTP 400、server 明确表示 create 未成功的 deterministic 409（例如 semantic conflict、duplicate Category、锁定或 lifecycle conflict）以及已收到的 503 `ledger-write-busy` 都是 definite failure，进入可编辑的 `DRAFT / ERROR`，不进入 UNCERTAIN；该失败确认后，后续正式提交才是新的 intent，并生成新 key；
3. fetch timeout、connection reset、response stream lost、browser 未收到 response 等 outcome unknown 必须进入 `CREATE_INTENT_UNCERTAIN`，不能推断为“肯定未保存”；
4. UNCERTAIN 中的 `[重试确认]`、HTTP transport retry、页面重渲染或网络恢复都必须复用同一 canonical payload 和同一 Idempotency-Key；不得每次 retry 生成新 key；
5. UNCERTAIN 中禁止直接修改 amount、Account、Category、occurredAt 或任何 canonical payload 字段，也禁止用新 key 提交修改后的 payload；sheet 必须将这些字段置为只读，或要求先完成原 intent 的 authoritative result confirmation；
6. UNCERTAIN 中的取消不能抹掉未确认 intent，`cancel / new intent` 必须先通过同一 key + payload 的 retry 或结果检查确认原 intent 成功/未创建；只有确认完成后，用户才可以用新 payload + 新 key 开始新的 create；
7. intent snapshot/key 至少跨 component re-render、sheet 状态变化、transport retry 和 route refresh 保持；跨 hard reload 的 durable recovery 按 §11.5 执行。如果 page reload 后仍存在未确认 intent，必须显示恢复/确认原 intent 的路径，不能让用户无提示地开启第二个 create；
8. `ledger-idempotency-conflict` 是明确的 key/payload 冲突响应，不得自动换 key 重发；保留原 intent 的冲突信息，先确认/结束原 intent 后才能创建新的 intent；
9. 只有 `CONFIRMED` success 或 `CONFIRMED` not-created 后才能清理该 intent；成功后以 response 和 authoritative refresh 为准，不能用本地猜测余额冒充确认。

对于 PATCH / archive / restore / soft-delete，server 使用 `expectedVersion` 而不是 create idempotency。响应丢失时先 reload entity/list 判断 authoritative state；不要在未知状态下盲目覆盖或把版本冲突隐藏成成功。上述 UNCERTAIN create 规则与普通 validation error 是不同状态，测试必须分别证明。

### 11.5 UNCERTAIN durable recovery contract

feature-local reactive store 不能跨 hard reload 生存。因此只要 create intent 已经进入 transport send 阶段，或 transport outcome 可能未知，必须在当前 browser tab 的 `sessionStorage` 中保存最小 recovery record；本方案不使用 `localStorage`。

逻辑结构冻结为：

```text
LedgerPendingCreateIntent {
  version
  operation
  operationScope
  idempotencyKey
  canonicalPayload
  createdAt
}
```

其中必须能够安全 replay 的内容是 operation identity、exact canonical payload、original `Idempotency-Key`、recovery schema version 和创建时间/必要 metadata。record 不得保存 cookie、session token、password、SQL、stack、server internal state 或完整 Ledger snapshot；不写日志或 telemetry。`sessionStorage` 只保存尚未确认结果的 create intent，不保存普通 DRAFT、已保存 Transaction、Dashboard/Account/Category cache 或长期财务数据。

生命周期冻结如下：

```text
DRAFT
  → 不写 durable recovery record

SUBMITTING
  → 在 transport send 前保存最小 retry snapshot；hard reload 后按 UNCERTAIN 恢复

UNCERTAIN
  → recovery record 必须存在

CONFIRMED SUCCESS / CONFIRMED NOT CREATED
  → 删除 recovery record
```

收到明确的 400、deterministic 409 或 503 `ledger-write-busy` 后，当前 intent 已确认未成功，必须删除 recovery record 并回到可编辑 `DRAFT / ERROR`；这类 503 retry 不进入 UNCERTAIN。`ledger-idempotency-conflict` 或其它 manual resolution 完成后，也必须按确定结果删除 record 或转入已确认状态。

页面启动和 route/workspace lifecycle 必须遵守：

1. bootstrap Ledger presentation state；
2. 检查当前 tab 的 unresolved pending create record；
3. 如果 record 可解析，进入 `RECOVERY / CREATE_INTENT_UNCERTAIN`，先处理原 intent，禁止用户无提示开启新的 create；
4. recovery UI 明确提示“上一次操作的结果尚未确认”，提供 `[重试确认]` 或等价 `[重新检查]`；
5. retry 必须使用 exact canonical payload + original `Idempotency-Key`，不因 route change、component unmount、workspace remount、reactive store reset 或普通网络恢复而生成新 key；
6. 原 intent 确认成功或确认未创建后，删除 record，刷新 authoritative state，才允许新 payload + new key；
7. malformed 或 unsupported-version record 必须 fail closed：不 crash、不自动 replay、不生成看似新的 intent；进入安全 recovery/error path，不把损坏 record 当作用户已成功或已失败，并保持 record 生命周期由该安全处理路径明确结束。

`session expiry` / logout 时可以 reset presentation store，但不得无条件删除 unresolved record。用户重新登录后，先以当前 authenticated API/session 重新 bootstrap；recovery record 不用于恢复财务展示，只用于用原 payload + 原 key 请求 authoritative result。server owner-auth/idempotency boundary 负责确认当前 owner；如果无法确认当前 session 或返回 idempotency conflict，UI 停留在安全 recovery/error 状态，不把另一个 owner/session 的 presentation data 合并进来。本轮不增加“忘记此未确认操作” action。

## 12. Category integration

UI Integration 采用 UI Integration PRD 已冻结的方案：**Transaction Sheet 内支持 contextual quick create，full Category Management 延后**。

实施要求：

- expense context 固定 POST `kind=expense`；income context 固定 POST `kind=income`；
- quick create 只要求名称；不显示 kind 二选一，不允许用户误建另一种 kind；
- 使用 Category create idempotency key；
- 成功后以 response Category ID/name 立即选中并继续原 Transaction draft；
- `ledger-duplicate-category` 显示“已有同名分类/请换一个名称”，不自动 unarchive、不生成第二 identity；
- archived Category 不出现在新交易 selector；历史交易仍可显示其名称/归档提示；History filter 通过 `includeArchived=true` 同时提供 active 与 archived Category；
- active Category list loading 时 selector 显示 loading；空列表提供“新建支出分类/新建收入分类”；
- quick create 失败时保留 Transaction draft 和 Category name，允许 retry/改名；
- 不新增 `/ledger/categories` full management route，不暴露 Category rename/archive/restore/delete。

## 13. Dashboard real-data cutover

### 13.1 Component/data mapping

计划以 `src/views/LedgerView.vue` + `src/components/ledger/LedgerDashboard.vue` 为容器，按以下 mapping 消费 `LedgerOverviewDto`：

| Dashboard information | API source | UI rule |
| --- | --- | --- |
| 总资产 | `assetTotalMinor` | 真实 projection；不由 accounts reduce |
| 总负债 | `liabilityTotalMinor` | 保持 natural balance 语义；不能对负债取 ABS 伪造正数 |
| 净资产 | `netWorthMinor` | 真实 projection |
| Account list | `accounts[]` | name、type/nature、current balance；提供管理账户 |
| selected cashflow | `cashflow` with default `scope=month` | 收入、支出、结余；scope 由 server 定义 |
| Category breakdown | `categoryBreakdown` | 明确收入/支出和 selected period；金额和 accessible text 与视觉图表同时存在 |
| Today/Week/Month/Year | `periods[]` | secondary summary；无 budget warning 或 `expense > income` budget inference |
| Trend | `trend[]` | 最近 calendar months；无 demo series；提供文本替代 |
| Recent transactions | `recentTransactions[]` | server 最新 active records；默认最多 5 条；查看全部进入 canonical Transactions |

### 13.2 Information hierarchy

从上到下固定为：

1. Ledger header + current settings context + `+ 记一笔`；
2. asset / liability / net worth；
3. active Accounts + 管理账户；
4. selected period cashflow；
5. recent transactions；
6. secondary periods、category breakdown、trend。

当前 prototype 的“选择账本”、Bills terminology、mock account accents、budget-style class 和没有 period context 的 donut semantics 删除。Category breakdown / trend 保留真实信息目标，但具体图表形式属于 Accepted 后的 non-blocking visual/content follow-up；实现前只须遵守已冻结的 API mapping、period context 和 accessible data contract。

### 13.3 Empty and refresh behavior

- uninitialized/`FIRST_ACCOUNT_REQUIRED` 不请求并渲染正常 Dashboard shell；
- Account exists/0 transactions 显示完整真实 shell，opening balance/资产/负债/净资产仍来自 projection/account DTO；
- transaction create/edit/delete 成功后统一 reload overview + accounts + relevant transaction page；
- 不使用 `billsMockData` 作为 initial、loading、error、uninitialized 或 empty fallback；
- Dashboard period scope 改变只触发新的 Overview request，不在 client 计算 period boundaries。

## 14. Transactions page implementation

计划新增/重写：

- `src/views/LedgerTransactionsView.vue`；
- `src/components/ledger/LedgerTransactionsList.vue`；
- `src/components/ledger/LedgerTransactionRow.vue`；
- `src/components/ledger/LedgerTransactionFilters.vue`；
- `src/components/ledger/LedgerTransactionDetail.vue`；
- 对应 tests。

页面能力固定为：

- real active transaction list；
- `+ 记一笔`；
- view details；
- filters：全部、支出、收入、转账，Account，Category，Ledger local date range；
- cursor pagination，使用 response `page.nextCursor`；
- loading、error、empty；
- active ordinary income/expense/transfer edit；
- active ordinary income/expense/transfer terminal soft-delete；
- Adjustment 在“全部”中只读显示；不提供 generic adjustment create/edit/delete；
- 默认排序不由 client 重排，服从 `occurredAt DESC, createdAt DESC, id DESC`。

Filters 的 query builder 只发送 API 支持的参数。History filter 的 Account/Category options 必须分别以 `includeArchived=true` 读取，并给 archived entity 加“已归档”标记；选择 archived ID 仍可查询其历史 active Transaction，不能自动恢复或隐藏。Create selector 仍只使用 active Account/Category。日期 range 由 Ledger local date 转为 UTC `from`/`to`，但边界 authority 仍是 server query/projection contract。UI Integration 不加入 free-text search、保存筛选、导入或高级报表。

删除确认必须明确：记录将从默认列表、余额和统计中移除，本次 delivery 没有恢复入口。若关联 Account 已 archived，UI 必须在请求前禁用或拦截删除，提示“需要先恢复相关账户，才能删除这条交易”，并提供 Account restore 路径；恢复后重新读取记录/版本才可重新评估。版本冲突要求 reload 后再决定；不能用 DELETE API 的存在推导出 physical delete 或 restore UI。

编辑 existing Transaction 时，若任一关联 Account 已 archived，UI 必须依据 server contract 预先展示只读 financial fields：Income/Expense 只允许 `note`、`payee`，Transfer 只允许 `note`；amount、occurredAt、account/category、from/to 不可编辑。页面提供“先恢复相关账户”说明和 restore 入口；恢复后重新读取 Transaction 与 version，再决定是否恢复完整编辑能力。若 Account 在 Sheet 打开后被归档，保存前重新读取并应用同一矩阵，不把 server 的 `409 ledger-archived-account` 泛化成普通失败。

## 15. Loading / Empty / Error UX implementation

### 15.1 Empty states

| 状态 | 文案方向 | action |
| --- | --- | --- |
| A. uninitialized | “开始使用 Ledger”；解释 baseCurrency/timezone | `继续设置 Ledger` |
| B. `FIRST_ACCOUNT_REQUIRED`（initialized, 0 Account, `hasCreatedAccount=false`） | “先添加一个账户，Ledger 才能开始记账” | `创建第一个账户` |
| C. Account exists, 0 Transaction | “还没有交易记录” | `+ 记一笔` |
| D. filter result empty | “当前筛选没有匹配的交易” | `清除筛选`；保留 `+ 记一笔` |
| `NO_ACTIVE_ACCOUNT`（`hasCreatedAccount=true` 且无 active Account） | “当前没有可用于记账的账户”；历史账户仍保留 | `恢复账户`（若有 archived） / `创建新账户` |

每个 state 都保留产品身份、下一步和真实上下文；不能只写“暂无数据”。

### 15.2 Error taxonomy and recovery

`src/features/ledger/ledgerErrors.ts` 统一将安全 error code 映射为 UI intent：

| 类别 | 代表 code/status | UI 恢复 |
| --- | --- | --- |
| field validation | 400 `ledger-validation-failed`、invalid currency/timezone/date/decimal | 字段旁说明；保留其他输入 |
| missing entity | 404 account/category/transaction/settings not found | 重新加载对应 surface；不显示 stale entity |
| duplicate Category | 409 `ledger-duplicate-category` | 改名或选择现有 Category；不自动 unarchive |
| archived lifecycle | 409 archived account/category | Create selector 引导换 active entity；历史筛选保留 archived entity；关联 archived Account 的交易编辑/删除在 UI 先显示受限状态并引导 restore |
| version conflict | 409 `ledger-version-conflict` | reload latest；说明其他更新未被覆盖 |
| balance conflict | 409 `ledger-balance-conflict` / nonzero archive | 显示当前 authoritative 状态；用户处理后重试 |
| lifecycle/semantic conflict | locked、history、type immutable、deleted、invalid pair/kind/currency | 不暴露内部细节；解释该操作不适用于当前状态 |
| idempotency conflict | 409 `ledger-idempotency-conflict` | 这是明确的 key/payload conflict；不自动换 key；先确认/结束原 intent，再创建新 intent |
| deterministic create failure | 400 validation、明确的 409 semantic/version/lifecycle/duplicate failure，或已收到 503 `ledger-write-busy` | 明确表示本次 create 未成功；回到可编辑 DRAFT/ERROR，清理 pending recovery；后续 formal submit 是 new intent + new key |
| network / response loss | fetch timeout、connection reset、response stream loss、browser 未收到 response | outcome unknown 进入 `CREATE_INTENT_UNCERTAIN`；canonical fields 只读；仅允许同 payload + 同 key 的 retry/检查 |
| server temporary unavailable | 已收到 503 `ledger-write-busy` | server 已明确本次请求未成功完成；保留输入并允许 retry；与没有收到 response 的 UNCERTAIN 分开处理 |
| session expired | 401 `auth-session-required` | 交给现有 auth observer/router；清理 Ledger presentation store 但保留 unresolved recovery record，重新登录后先恢复/确认原 intent，再恢复正常 Ledger presentation |
| unknown internal error | 500 `ledger-internal-error` | “Ledger 暂时无法完成操作，请稍后重试”；不显示 SQL/stack/SQLite |

在 Sheet 中，字段错误不关闭表单；系统故障不丢输入；mutation response 未确认时不鼓励用户重新开一笔。

## 16. Responsive / accessibility implementation requirements

实现必须复用当前 Nuvyn dialog/focus patterns：

- `useFocusTrap`；
- Teleport to body；
- `role="dialog"`、`aria-modal="true"`；
- 打开时 initial focus 到 first actionable field；
- 关闭时 focus 回到 `+ 记一笔`、edit 或 create trigger；
- Escape、取消和 dirty confirmation 一致；
- keyboard Tab 顺序覆盖 type、金额、Account、Category、date/time、note、save/cancel；
- `aria-label`、`aria-describedby`、`aria-invalid` 与 field error 关联；
- saving/refresh 用 `aria-busy` / status announcement；
- error announcement 不只依赖颜色；
- income、expense、liability 使用文字、符号或结构辅助颜色表达；
- charts 必须提供列表/summary text alternative。

窄屏行为：

- Sheet/Dialog 变为可滚动的 viewport-constrained surface，footer action 在完成表单时可达；
- `+ 记一笔`、Account 管理、保存、取消不因宽度被隐藏；
- Account form 和 Transactions filters 可以纵向排列；
- 不要求完整 mobile redesign，不引入新的 responsive framework。

## 17. Implementation slices

以下 slices 是建议的实现顺序；每个 slice 都以真实 API 和上一个 slice 的 exit criteria 为依赖。它们不是当前轮要执行的代码变更。

### UI.1 — Ledger frontend boundary and browser-safe primitives

**Inputs**

- `shared/ledgerProtocol.ts`；
- `shared/ledgerCurrency.ts`；
- `shared/ledgerNormalization.ts`；
- existing `authFetch` / `jsonOrThrow` pattern；
- §5 API contract；
- Settings lifecycle marker gap：当前 server/domain 已有 `hasCreatedAccount`，但当前 `LedgerSettingsDto` 未暴露。

**Files**

- `src/features/ledger/api.ts`；
- `src/features/ledger/ledgerErrors.ts`；
- `src/features/ledger/ledgerStore.ts`；
- `src/features/ledger/money.ts`；
- `src/features/ledger/time.ts`；
- `shared/ledgerProtocol.ts`（planned `LedgerSettingsDto.hasCreatedAccount`）；
- `server/ledger/service.ts`（当前 Settings DTO mapping；planned projection）；
- `server/__tests__/ledger-api.test.ts`；
- `server/ledger/service.test.ts`；
- `server/ledger/idempotency.test.ts`（若 Settings replay DTO fixture 覆盖该字段）；
- `src/features/ledger/__tests__/api.test.ts`；
- `src/features/ledger/__tests__/money.test.ts`；
- `src/features/ledger/__tests__/time.test.ts`；
- `src/features/ledger/__tests__/ledgerStore.test.ts`。

**Implementation**

- 建立唯一 Ledger API boundary；
- 使用 shared DTO 与 error envelope；
- 建立 lifecycle state、request epoch 和 central invalidation；
- 建立 stable create intent key lifecycle；
- 暴露只读 `LedgerSettingsDto.hasCreatedAccount`，让 bootstrap 用它区分 `FIRST_ACCOUNT_REQUIRED` 与 `NO_ACTIVE_ACCOUNT`；
- 保持 server 内已有 `has_created_account` marker 的单调性；不新增 SQLite 列、migration 或 client lock authority；
- 建立 CNY/JPY/KWD money parsing/display primitives；
- 建立 Ledger timezone local date/time ↔ UTC transport/display primitives；
- 建立 §11.5 的 `sessionStorage` pending-create recovery record；不把普通 draft/cache 写入 durable recovery；
- 不引入 Pinia，不 import server modules，不实现 projection reducer。

**Tests**

- request path、method、JSON、authFetch、error normalization；
- 同一 create intent 的 transport retry 使用 same key + same canonical payload；UNCERTAIN 中 payload mutation 被拒绝；明确失败结束后下一次 formal submit 使用 new intent + new key；confirmed success 后新记录使用 new intent + new key；
- 401 / 404 / 409 / 503 / malformed body；503 definite failure 不进入 UNCERTAIN；
- money exponent / precision / overflow；
- Asia/Shanghai 与 DST timezone roundtrip；
- store reset、presentation/recovery lifecycle separation、stale response epoch、no-mock invariant；
- Settings DTO `hasCreatedAccount` 的 false → true、physical delete 后保持 true，以及 bootstrap 不以 `accounts.length` 猜测 lock；
- sessionStorage recovery record 的 hard reload、malformed version、confirmed cleanup 和 503 definite-failure cleanup。

**Exit criteria**

- 所有未来 Ledger UI 可以只依赖 API boundary/store；
- 没有 component 需要直接 fetch `/api/ledger`；
- GET/POST/PATCH Settings response 的 `hasCreatedAccount` projection contract 已由 server/shared tests 证明；
- UI bootstrap 能唯一地区分 `FIRST_ACCOUNT_REQUIRED` 与 `NO_ACTIVE_ACCOUNT`；
- amountMinor、period、balance 没有 client authority；
- UNCERTAIN intent 可跨 hard reload 恢复，confirmed/definite failure 后不会残留 recovery record；
- targeted unit tests 通过。

**Dependencies**

- 无生产 UI 依赖；但 `hasCreatedAccount` DTO addition 是 UI bootstrap 前必须完成的最小 planned server/shared prerequisite；必须遵守 §4 roadmap relationship，不改变这些 boundary。

### UI.2 — Canonical route and shared shell migration

**Inputs**

- 当前 `/bills` route、NavBar scope chip、App body class 和 auth redirect；
- §8 route contract。

**Files**

- `src/router/index.ts`；
- `src/lib/auth-redirect.ts`；
- `src/components/NavBar.vue`；
- `src/App.vue`；
- `src/style.css`；
- `src/composables/useI18n.ts`；
- `src/router/__tests__/index.test.ts`；
- `src/lib/__tests__/auth-redirect.test.ts`；
- `src/components/__tests__/NavBar.test.ts`。

**Implementation**

- 注册 `/ledger`、`/ledger/transactions`、`/ledger/accounts`、`/ledger/accounts/:id`；
- 保留 `/bills` legacy redirects；
- 更新 auth deep-link allowlist；
- scope chip 指向 `ledger` route；
- 保留共享 Nuvyn shell/fullWidth/sidebar 行为；
- 迁移 route-scoped Bills classes 到 Ledger classes；
- 添加 Ledger copy keys；
- 不让 legacy route 渲染 mock page。

**Tests**

- canonical route record/meta；
- authenticated/unauthenticated deep link；
- `/bills` → `/ledger`、`/bills/transactions` → `/ledger/transactions` 保留 query/hash；
- Note/Diary/Vault/auth navigation regression；
- scope chip active state 和 no duplicate Navbar；
- old Bills terminology 不出现在新用户可见 route。

**Exit criteria**

- `/ledger*` 成为唯一新入口；
- legacy path 只 redirect；
- shell 不再依赖 Bills product route；
- route tests 通过。

**Dependencies**

- UI.1 API boundary不是 route 的硬依赖，但新 Ledger view 在后续 slice 接入。

### UI.3 — Initialization and first Account onboarding

**Inputs**

- UI Integration PRD initialization/first Account decisions；
- Settings/Account API contract；
- `LedgerSettingsDto.hasCreatedAccount` lifecycle projection from UI.1；
- UI.1 state/API primitives；
- UI.2 canonical `/ledger` route。

**Files**

- `src/views/LedgerView.vue`；
- `src/components/ledger/LedgerOnboarding.vue`；
- `src/components/ledger/LedgerInitializationForm.vue`；
- `src/components/ledger/LedgerFirstAccountForm.vue`；
- `src/components/ledger/LedgerAccountForm.vue`；
- `src/views/__tests__/LedgerView.test.ts`；
- `src/components/ledger/__tests__/LedgerInitializationForm.test.ts`；
- `src/components/ledger/__tests__/LedgerAccountForm.test.ts`。

**Implementation**

- 使用 `settings.hasCreatedAccount` 实现 `UNINITIALIZED → FIRST_ACCOUNT_REQUIRED → READY` 两步连续 onboarding；`hasCreatedAccount=true` 且无 active Account 时进入 `NO_ACTIVE_ACCOUNT`，不误称为 first Account；
- 显示 lock timing、currency/timezone 说明；
- First Account step 显示 `[修改 Ledger 设置]`，允许在首个 Account 成功前返回并 PATCH 当前 settings version；成功后重新进入 First Account，首个 Account 成功后保持 server lock；
- 实现 account type/nature user language；
- decimal opening balance 转 minor；
- settings/account create 遵守 DRAFT/SUBMITTING/CONFIRMED/UNCERTAIN；结果未知时复用同一 canonical payload + stable key，不能直接改 payload 开新 key；
- first Account 成功后 reload authoritative state，不本地算 dashboard。

**Tests**

- 404 settings 进入 initialization；
- explicit CNY/Asia/Shanghai confirmation；
- browser timezone 只做预选、不自动提交；
- initialization success/failure/concurrent initialize；
- first Account 前返回修改 settings，settings PATCH version conflict，以及创建 first Account 后 lock 不可编辑；
- first Account fields、type/nature、opening balance/date/currency/note；
- `FIRST_ACCOUNT_REQUIRED` empty action、`NO_ACTIVE_ACCOUNT` 的 create-new action、cancel/re-entry、session expiry；
- response loss/timeout 进入 UNCERTAIN，不能直接修改 canonical payload；hard reload 后从 sessionStorage recovery record 恢复；
- `hasCreatedAccount=false` 允许 settings edit，first Account 成功后变为 true 并锁定；物理删除无历史 Account 后仍为 true。

**Exit criteria**

- 新 owner 可以不调用 API 直接完成 settings + first Account；
- `FIRST_ACCOUNT_REQUIRED` 不显示伪造全 0 Dashboard；
- reload 后状态由真实 API 重新判定。

**Dependencies**

- UI.1、UI.2。

### UI.4 — Account management and Account detail

**Inputs**

- L0 Account lifecycle / expectedVersion contract；
- UI.3 shared Account form；
- account transaction endpoint。

**Files**

- `src/views/LedgerAccountsView.vue`；
- `src/views/LedgerAccountDetailView.vue`；
- `src/components/ledger/LedgerAccountList.vue`；
- `src/components/ledger/LedgerAccountRow.vue`；
- `src/components/ledger/LedgerArchivedAccounts.vue`；
- `src/components/ledger/LedgerAccountMovement.vue`；
- `src/views/__tests__/LedgerAccountsView.test.ts`；
- `src/views/__tests__/LedgerAccountDetailView.test.ts`；
- `src/components/ledger/__tests__/LedgerAccountManagement.test.ts`。

**Implementation**

- list active/archived accounts；
- create/edit/archive/restore；
- 以 `settings.hasCreatedAccount` 而非 `accounts.length` 判断 `FIRST_ACCOUNT_REQUIRED` 与 `NO_ACTIVE_ACCOUNT`；
- based on `includeDeleted=true` history gate editable fields；
- NO_ACTIVE_ACCOUNT 同时提供 restore archived Account 与 create new Account；
- display asset/liability wording and server current balance；
- archive zero-balance requirement；
- no physical delete control；
- post-mutation invalidate accounts/detail/overview。

**Tests**

- no-history edit vs history-only name/note edit；
- archived edit restriction；
- archive nonzero error；
- restore and expectedVersion conflict；
- archived-only state 的 create-new 与 restore 两条路径；
- Account detail movement/list/cursor；
- no delete button。

**Exit criteria**

- 用户可以从 Dashboard 或 `/ledger/accounts` 完成基本 Account 管理；
- 账户余额/历史来自 server；
- 归档 Account 不进入 create selectors。

**Dependencies**

- UI.1、UI.3；Dashboard action wiring may initially be a stable link。

### UI.5 — Transaction Sheet, three types, and Category quick create

**Inputs**

- UI Integration PRD transaction decisions；
- transaction/category API contracts；
- UI.1 idempotency/money/time primitives；
- existing `useFocusTrap` / Dialog pattern。

**Files**

- `src/components/ledger/LedgerTransactionSheet.vue`；
- `src/components/ledger/LedgerTransactionTypePicker.vue`；
- `src/components/ledger/LedgerTransactionFields.vue`；
- `src/components/ledger/LedgerCategoryQuickCreate.vue`；
- `src/components/ledger/LedgerTransactionDetails.vue`；
- `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts`；
- `src/components/ledger/__tests__/LedgerCategoryQuickCreate.test.ts`。

**Implementation**

- default expense；
- dynamic fields for income/expense/transfer；
- active Account/Category selectors；
- kind-fixed Category quick create；
- amount/date/note/payee form behavior；
- create key stable retry；
- create intent 的 DRAFT/SUBMITTING/CONFIRMED/UNCERTAIN；UNCERTAIN 中 canonical fields 只读，retry 使用同 payload + 同 key；
- duplicate submit/dirty close/focus trap；
- success refresh accounts/overview/recent/list。

**Tests**

- all three payload shapes match shared protocol；
- transfer has one record, no category/payee, distinct accounts；
- Category kind filtering/archived exclusion/empty quick create；
- CNY/JPY/KWD input；
- response loss retry uses same key；
- response loss 后尝试修改 amount/account/category/time 会被阻止，只有确认原 intent 后才能新建；
- field error/system error/session expiry；
- keyboard, Escape, focus restoration、narrow viewport。

**Exit criteria**

- Dashboard `+ 记一笔` can create real income/expense/transfer；
- no direct component fetch；
- no duplicate transaction under retry；
- no mock fallback in any Sheet state。

**Dependencies**

- UI.1、UI.3、UI.4。

### UI.6 — Dashboard live projection cutover

**Inputs**

- Overview DTO and scope semantics；
- existing Bills visual characterization only as layout reference；
- UI.5 successful mutation contract。

**Files**

- `src/components/ledger/LedgerDashboard.vue`；
- `src/components/ledger/LedgerAssetOverview.vue`；
- `src/components/ledger/LedgerPeriodSummary.vue`；
- `src/components/ledger/LedgerCategoryBreakdown.vue`；
- `src/components/ledger/LedgerTrend.vue`；
- `src/components/ledger/LedgerRecentTransactions.vue`；
- `src/views/__tests__/LedgerView.test.ts`；
- component tests for each live projection surface。

**Implementation**

- replace every `billsMockData` read with store Overview；
- map all totals/periods/trend/recent values from server；
- default scope month；
- keep periods secondary and remove budget semantics；
- keep breakdown/trend as secondary real-data explanatory surfaces；
- add `+ 记一笔`、Account management、Transactions links；
- implement uninitialized/`FIRST_ACCOUNT_REQUIRED`/zero-transaction/loading/error states。

**Tests**

- exact DTO mapping without client financial reduce；
- post-expense asset/net-worth/balance update；
- transfer does not add income/expense；
- category breakdown selected scope；
- trend and periods use response values；
- refresh failure never mounts mock；
- dark theme/readability regression against Ledger selectors。

**Exit criteria**

- `/ledger` contains no runtime import of `billsMockData`；
- Dashboard values equal live API response before and after mutations；
- all seven primary questions have a visible or linked answer。

**Dependencies**

- UI.1、UI.3、UI.4、UI.5。

### UI.7 — Transactions live list and ordinary mutation UI

**Inputs**

- Transactions query/cursor contract；
- UI.5 Sheet；
- expectedVersion / soft-delete contract。

**Files**

- `src/views/LedgerTransactionsView.vue`；
- `src/components/ledger/LedgerTransactionsList.vue`；
- `src/components/ledger/LedgerTransactionRow.vue`；
- `src/components/ledger/LedgerTransactionFilters.vue`；
- `src/components/ledger/LedgerTransactionDetail.vue`；
- `src/views/__tests__/LedgerTransactionsView.test.ts`；
- `src/components/ledger/__tests__/LedgerTransactionsList.test.ts`。

**Implementation**

- real list + cursor next page；
- type/account/category/date filters；
- Account/Category history filter 以 `includeArchived=true` 加载并标记 archived entity；create selectors 仍只用 active entity；
- empty/loading/error/session states；
- view details；
- edit ordinary transaction with immutable type；
- archived Account 关联 Income/Expense 只允许 payee/note，Transfer 只允许 note；financial fields 显示只读；
- terminal soft-delete with confirmation；
- archived Account 关联交易的 delete 在 UI 先阻止并引导 restore；
- adjustment read-only；
- mutation refresh current list + dashboard/account projections。

**Tests**

- server order/cursor and filter query construction；
- transfer row from/to；
- archived history display；
- archived Account/Category history filters 可选、可查询且有归档标记；archived entity 不进入 create selector；
- edit field matrix；
- archived Account edit field matrix 与 restore-before-delete；
- expectedVersion conflict reload；
- soft-delete removes record/effect and offers no restore；
- Adjustment has no edit/delete control；
- filtered empty state clears filters。

**Exit criteria**

- `/ledger/transactions` is fully real-data；
- no disabled “即将上线” core action remains；
- edit/delete semantics match server without client re-calculation。

**Dependencies**

- UI.1、UI.5、UI.6。

### UI.8 — Bills prototype cleanup and accessibility/responsive hardening

**Inputs**

- completed live Dashboard/Transactions/Account surfaces；
- §8 migration contract；
- current `style.css` and existing focus patterns。

**Files**

- delete/rewrite remaining `src/views/Bills*.vue`；
- delete/rewrite remaining `src/components/bills/**`；
- delete `src/features/bills/**` after import graph is empty；
- `src/style.css`；
- `src/App.vue`、`src/components/NavBar.vue` if remaining route classes exist；
- moved/re-written Ledger component tests；
- `e2e/ledger-workspace.spec.ts` characterization update。

**Implementation**

- remove mock imports and mock-only CSS/formatters/aggregations；
- rename runtime selectors/classes to Ledger；
- ensure compatibility routes redirect rather than render old components；
- complete keyboard/focus/error announcement/narrow layout pass；
- keep shared Note/Diary/Vault shell behavior unchanged。

**Tests**

- repository-wide `rg` proves no runtime import of `billsMockData`；
- no new user-visible Bills terminology；
- legacy path redirect；
- shell, theme, scrollbar and non-Ledger workspace regression；
- keyboard and focus behavior at desktop/narrow viewport。

**Exit criteria**

- Bills is only a compatibility path/history in code, not a product surface；
- no mock fallback exists in Ledger lifecycle states；
- old prototype tests no longer claim mock data is the product。

**Dependencies**

- UI.2、UI.6、UI.7。

### UI.9 — Live E2E, regression evidence, and release gate

**Inputs**

- all prior slices；
- current Playwright auth fixture and `scripts/start-draft-e2e.mjs`；
- current CI matrix。

**Files**

- new `e2e/ledger-ui.integration.spec.ts`；
- rewrite `e2e/ledger-workspace.spec.ts`；
- if isolated fresh-db run is needed, new `playwright.ledger.config.ts` using a dedicated port/temp path；
- existing router/NavBar/auth redirect tests updated in place；
- optional docs evidence after implementation, not in this Plan-only round。

**Implementation**

- run live API browser flow without intercepting `/api/ledger/**`；
- use `fixtures/auth.ts` real owner/session；
- use `scripts/start-draft-e2e.mjs` fresh temp DB；
- keep the baseline full closure serial and isolated from characterization state；
- add CI invocation only after review; do not alter CI in this round。

**Tests**

- fresh database → login → `/ledger` → CNY/Asia/Shanghai → first Bank Account ¥10,000 → expense ¥38 → live Dashboard/recent/balance → reload；
- single Transaction assertion and no mock text/data；
- response-loss scenario：server 已成功但 response 丢失，retry 复用同一 key/payload，最终只有一笔 Transaction；UNCERTAIN 中 payload mutation 被拒绝；
- route compatibility and non-Ledger regressions；
- currency exponent, timezone, accessibility-critical behavior；
- loading/error/session expiry/conflict cases at unit/component level and live smoke where deterministic。

**Exit criteria**

- acceptance scenario in §19 passes against real SQLite persistence；
- verification ladder in §20 passes on supported CI matrix；
- final working tree and changed-file inventory are recorded by implementation owner。

**Dependencies**

- UI.1–UI.8；UI Integration PRD Product Review Accepted；UI Integration Plan Implementation Review PASS / Ready for Implementation；implementation 前完成 then-current main re-audit。

## 18. Test file and responsibility matrix

### 18.1 New Ledger unit/component/view tests

| Test file | Responsibility |
| --- | --- |
| `src/features/ledger/__tests__/api.test.ts` | API paths, DTO envelopes, headers, key/version/error behavior |
| `src/features/ledger/__tests__/money.test.ts` | CNY/JPY/KWD exponent, parse/format, precision and overflow |
| `src/features/ledger/__tests__/time.test.ts` | Ledger timezone display, local date/time transport, DST and browser-zone independence |
| `src/features/ledger/__tests__/ledgerStore.test.ts` | state machine, refresh invalidation, stale response protection, reset/no-mock invariant |
| `src/components/ledger/__tests__/LedgerInitializationForm.test.ts` | explicit settings selection, validation, retry and lock explanation |
| `src/components/ledger/__tests__/LedgerAccountForm.test.ts` | first Account and edit field matrix, money/date/nature UI |
| `src/components/ledger/__tests__/LedgerAccountManagement.test.ts` | list, archive, restore, nonzero/error/version states |
| `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts` | type switch, dynamic fields, submit/cancel/saving/error/idempotent retry/focus |
| `src/components/ledger/__tests__/LedgerCategoryQuickCreate.test.ts` | kind-fixed quick create, duplicate, empty/loading/archived behavior |
| `src/components/ledger/__tests__/LedgerTransactionsList.test.ts` | real DTO rendering, cursor, filters, detail/edit/delete/Adjustment read-only |
| `src/views/__tests__/LedgerView.test.ts` | onboarding → live Dashboard state routing and projection mapping |
| `src/views/__tests__/LedgerAccountsView.test.ts` | Account list/detail entry and management actions |
| `src/views/__tests__/LedgerAccountDetailView.test.ts` | account current balance, movement and transaction context |
| `src/views/__tests__/LedgerTransactionsView.test.ts` | live list, filters, create/view/edit/delete and empty/error states |
| `src/components/__tests__/NavBar.test.ts` | Ledger chip canonical navigation and shared shell behavior |
| `src/router/__tests__/index.test.ts` | auth guards, canonical routes, legacy redirects, deep links |
| `src/lib/__tests__/auth-redirect.test.ts` | safe `/ledger` and `/bills` redirect allowlist |

### 18.2 Existing test migration

这些文件会在实现阶段 rewrite/move，不在本轮修改：

- `src/views/__tests__/BillsView.test.ts` → `LedgerView.test.ts`：删除 mock assertions，改为 live store/projection states；
- `src/components/bills/__tests__/BillsAssetOverviewCard.test.ts` → Ledger asset/account projection test；
- `src/components/bills/__tests__/BillsCategoryBreakdownCard.test.ts` → real category slice/period/accessibility test；
- `src/components/bills/__tests__/BillsPeriodCard.test.ts` → server period summary test，删除 over-budget assertion；
- `src/features/bills/__tests__/aggregations.test.ts`：删除 mock financial aggregation test，不替换为 client balance engine；
- `e2e/ledger-workspace.spec.ts`：改为 canonical shell/no-mock/route characterization；
- `src/components/__tests__/NavBar.test.ts`、`src/router/__tests__/index.test.ts`、`src/lib/__tests__/auth-redirect.test.ts`：保留 Note/Diary/auth regression，同时更新 Ledger path/name。

### 18.3 Existing server regression

不新增 frontend workaround 来绕过以下既有 server evidence：

- `server/__tests__/ledger-api.test.ts`；
- `server/ledger/balance.test.ts`；
- `server/ledger/defaultCategories.test.ts`；
- `server/ledger/errors.test.ts`；
- `server/ledger/idempotency.test.ts`；
- `server/ledger/projections.test.ts`；
- `server/ledger/service.test.ts`；
- `server/ledger/time.test.ts`；
- `server/ledger/validation.test.ts`；
- 以及当前 `server/ledger/*.test.ts` 中的 L0 coverage。

UI.1 是本次已登记的唯一最小 API projection remediation：允许更新 `server/__tests__/ledger-api.test.ts`、`server/ledger/service.test.ts` 和必要的 `server/ledger/idempotency.test.ts` fixture，以证明 Settings DTO 的 `hasCreatedAccount` false → true 单调 lifecycle 以及 physical delete 后仍为 true。除此之外，如果 UI Integration 实现发现 API 不足，必须先登记 contract conflict / API gap，停止该 slice，而不是修改 client semantics。

### 18.4 Remediation-specific test cases

以下测试是本轮 contract remediation 的明确责任，不得在 implementation 时合并成一个泛化的“保存失败”测试：

| Case | Planned test file(s) | Required evidence |
| --- | --- | --- |
| A. UNCERTAIN hard reload recovery | `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts`、`src/features/ledger/__tests__/ledgerStore.test.ts`、`e2e/ledger-ui.integration.spec.ts` | server 已成功但 response 丢失；`sessionStorage` recovery record 跨 hard reload 保留；UI 恢复 UNCERTAIN；retry 使用同一 key + canonical payload，server replay 后最终只有一笔 Transaction，record 删除 |
| B. UNCERTAIN 不允许 payload mutation | `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts` | UNCERTAIN 中尝试修改 amount、Account、Category、time 被阻止；只能 retry/check 原 intent，不能开新 key |
| C. Confirmed failure / 503 cleanup | `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts`、`src/features/ledger/__tests__/ledgerStore.test.ts`、`src/features/ledger/__tests__/api.test.ts` | HTTP 400、deterministic 409 或已收到 503 `ledger-write-busy` 都是 definite failure；不进入 UNCERTAIN；清理 pending record；保留输入并允许新的 formal submit，新 intent 使用新 key |
| D. Confirmed success cleanup | `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts`、`src/features/ledger/__tests__/ledgerStore.test.ts` | confirmed success 后 `sessionStorage` record 立即删除；刷新/重挂载不会再次 replay |
| E. Route/component unmount preservation | `src/features/ledger/__tests__/ledgerStore.test.ts`、`src/components/ledger/__tests__/LedgerTransactionSheet.test.ts` | UNCERTAIN 时 route change、component unmount、workspace remount、presentation store reset 都不丢 key/payload/recovery record |
| F. Malformed/unsupported recovery record | `src/features/ledger/__tests__/ledgerStore.test.ts`、`src/components/ledger/__tests__/LedgerTransactionSheet.test.ts` | 损坏或 unsupported version 不 crash、不自动 replay、不生成新 duplicate intent；进入安全 recovery/error path 并 fail closed |
| G. Archived Account transaction edit | `src/components/ledger/__tests__/LedgerTransactionsList.test.ts`、`src/views/__tests__/LedgerTransactionsView.test.ts` | archived Account 关联 Income/Expense 只允许 payee/note；Transfer 只允许 note；financial fields 只读并提供 restore 路径 |
| H. Archived Account transaction delete | `src/components/ledger/__tests__/LedgerTransactionsList.test.ts` | 关联 archived Account 的 ordinary Transaction 删除在 UI 被阻止/拦截，显示 restore-before-delete 提示，不发送会注定失败的普通 DELETE |
| I. History filters | `src/components/ledger/__tests__/LedgerTransactionsList.test.ts`、`src/views/__tests__/LedgerTransactionsView.test.ts` | archived Account 和 archived Category 可用于历史 filter，选项有归档标记，查询能返回历史 active Transaction |
| J. Create selectors | `src/components/ledger/__tests__/LedgerTransactionSheet.test.ts` | archived Account / Category 不出现在 new Transaction selector；只有 active entities 可提交 |
| K. NO_ACTIVE_ACCOUNT | `src/components/ledger/__tests__/LedgerAccountManagement.test.ts`、`src/views/__tests__/LedgerView.test.ts` | `hasCreatedAccount=true` 且无 active Account 时，同时提供 restore archived Account（若存在）和 create new Account 两条可完成路径；accounts 为空也不回到 first-account onboarding |
| L. Settings back-navigation | `src/components/ledger/__tests__/LedgerInitializationForm.test.ts`、`src/components/ledger/__tests__/LedgerAccountForm.test.ts`、`src/views/__tests__/LedgerView.test.ts` | first Account 创建前可返回修改 baseCurrency/timezone；修改后回到 Step 2；first Account 成功后 locked fields 不再可改 |
| M. Settings lifecycle projection | `server/__tests__/ledger-api.test.ts`、`server/ledger/service.test.ts`、`server/ledger/idempotency.test.ts`、`src/features/ledger/__tests__/ledgerStore.test.ts` | GET/POST/PATCH Settings 返回 marker；fresh false、first Account 后 true、physical delete no-history Account 后仍 true；bootstrap 不用 accounts.length 猜 lock |

## 19. User acceptance scenario

### 19.1 Baseline: first real expense

在专用 Ledger E2E 的 fresh database 中：

1. 用户登录 owner session；
2. 打开 `/ledger`；
3. 页面识别 `GET /api/ledger/settings` 的 `404 ledger-not-found`，显示初始化，不显示 Dashboard mock；
4. 用户选择 Base Currency `CNY` 和 Timezone `Asia/Shanghai`，主动确认 lock explanation；
5. 初始化成功，进入 first Account step；
6. 创建 Account：名称“招商银行”、性质资产、type bank、opening balance `¥10,000.00`、opening date、currency `CNY`、note 可为空；
7. 进入真实 Dashboard；
8. 点击 `+ 记一笔`，默认 expense；
9. 选择账户“招商银行”、expense Category“餐饮”、输入 `¥38.00`、时间为当前 Ledger local time；
10. 点击保存；
11. 断言服务端只产生一笔 Transaction；
12. 断言最近交易出现 `¥38.00`；
13. 断言招商银行 current balance 为 `¥9,962.00`；
14. 断言 asset / net worth 和适用 Today/Week/Month/Year projection 更新；
15. 断言 Dashboard 不需要手动浏览器刷新即可更新；
16. 刷新页面后再次读取真实值，数据仍存在；
17. 页面没有 `billsMockData`、星巴克等 fixture data、Bills product copy 或 demo count。

### 19.2 Response-loss retry

在 Transaction create request 已可能到达 server、但浏览器模拟 response loss 的场景：

1. 用户只提交一个 expense intent；
2. UI 显示“结果尚未确认”，Sheet 保持输入；
3. 用户点击 retry；
4. 第二次请求复用同一 `Idempotency-Key`；
5. server replay 或返回第一次结果；
6. Dashboard/recent/account projection 只出现一笔记录；
7. 在结果确认前尝试把金额改为 `¥39.00`、改账户、分类或时间，UI 拒绝该 payload mutation；
8. 只有原 intent 被确认成功或确认没有创建后，用户才可以开始新的显式 intent；此时修改后的 payload 使用新 key。

### 19.3 Settings lifecycle edge states

以下场景必须以 UI.1 planned `LedgerSettingsDto.hasCreatedAccount` 为 authority，而不是以 `accounts.length` 猜测：

1. fresh Settings 返回 `hasCreatedAccount=false`：进入 `FIRST_ACCOUNT_REQUIRED`，显示“创建第一个账户”，Settings 仍可在首个 Account 成功前修改；
2. first Account 成功后 Settings 返回 `hasCreatedAccount=true`：Settings locked；
3. first Account 后 physical DELETE 一个无历史 Account，再读取 Settings：仍返回 `hasCreatedAccount=true`；即使 `accounts=[]`，也进入 `NO_ACTIVE_ACCOUNT`，不回到 first-account onboarding，不允许修改 baseCurrency/timezone；
4. 只有 archived Accounts 时：进入 `NO_ACTIVE_ACCOUNT`，同时提供 restore archived Account（若存在）和 create new active Account。

## 20. Verification ladder

以下 commands 是基于当前 `package.json` / CI 真实存在的命令；带 `playwright.ledger.config.ts` 的命令是计划新增隔离 config 后的直接 CLI invocation，不是当前不存在的 npm script。

### 20.1 Static/build

```text
npm run typecheck:client
npm run typecheck:server
npm run typecheck
npm run build
```

### 20.2 Focused unit and Ledger regression

```text
npm run test:unit
npm test
npx vitest run server/__tests__/ledger-api.test.ts server/ledger
npx vitest run src/features/ledger src/components/ledger src/views/__tests__/LedgerView.test.ts src/views/__tests__/LedgerTransactionsView.test.ts
npx vitest run src/router/__tests__/index.test.ts src/lib/__tests__/auth-redirect.test.ts src/components/__tests__/NavBar.test.ts
```

`npm test` 的当前脚本会继续执行 `test:unit`、`test:history-integration` 和 `test:recovery-integration`，不能用 Ledger targeted run 代替完整 suite。

### 20.3 Browser / E2E

当前通用 E2E：

```text
npx playwright install chromium
npm run test:e2e
node node_modules/@playwright/test/cli.js test e2e/ledger-ui.integration.spec.ts
```

若采用专用 fresh-db config：

```text
node node_modules/@playwright/test/cli.js test --config=playwright.ledger.config.ts e2e/ledger-ui.integration.spec.ts
```

其它现有 browser regressions：

```text
npm run test:e2e:auth
npm run test:e2e:draft-store
```

### 20.4 CI-equivalent verification

必须保留当前 CI 的以下验证：

```text
npm run typecheck
npm run build
npm test
npx playwright install chromium
node node_modules/@playwright/test/cli.js test --config=playwright.cross-platform.config.ts --reporter=line,github
npm run test:e2e:draft-store
npm run test:tags-scale
npm run test:e2e:auth
npm run test:deployment-auth
npm run test:deployment-vault-lifecycle
```

CI matrix 必须继续覆盖：

- Ubuntu + Node 24；
- macOS + Node 24；
- Windows + Node 24；
- Ubuntu + Node 22。

UI Integration implementation owner 还应在 CI workflow 中加入或明确调用专用 live Ledger E2E；本轮不修改 `.github/workflows/ci.yml`。

## 21. Commit strategy

本轮 documentation closure 使用独立 commit（建议：`docs(ledger): close ui integration review`），不混入 production implementation。之后实际编码阶段建议按以下 logical commits 拆分：

1. `feat(ledger): add frontend api and presentation boundary`
   - API boundary、error normalization、store、money/time primitives 和 focused unit tests。
2. `feat(ledger): add canonical ledger routes and shell integration`
   - `/ledger*`、legacy redirects、NavBar/App/auth redirect 和 route tests。
3. `feat(ledger): add ledger initialization and first account flow`
   - onboarding、first Account、idempotent create 和 tests。
4. `feat(ledger): add account management and account detail`
   - list/create/edit/archive/restore/detail；不包含 physical delete。
5. `feat(ledger): add transaction entry and category quick create`
   - unified Sheet、three types、Category selector/quick create、idempotency tests。
6. `feat(ledger): cut over dashboard to live projections`
   - Dashboard DTO mapping、period/breakdown/trend/recent 和 refresh behavior。
7. `feat(ledger): cut over transaction history and mutations`
   - real list、cursor/basic filters、view/edit/soft-delete。
8. `refactor(ledger): remove bills prototype runtime surface`
   - rename/rewrite/delete old components/features、CSS cleanup；不混入无关 shell refactor。
9. `test(ledger): prove live ui persistence and compatibility`
   - live E2E、route/auth/accessibility/regression evidence。

每个 commit 必须可独立 review、可回滚、不带 mock fallback、不改变 server financial semantics。若某个 slice 暴露 API/PRD conflict，应停止该 commit 并先修 authoritative document。

## 22. Product and technical risks

| 风险 | 影响 | Mitigation |
| --- | --- | --- |
| PRD/roadmap phase drift | review 无法判断 capability roadmap 与 UI delivery 的关系 | 文档明确 L1–L8 是 capability roadmap，UI Integration 是跨 capability delivery milestone；不改变 roadmap 编号 |
| Bills mock 遗留 | 用户把 demo 当真实财务数据 | runtime import audit、canonical redirect、no-mock tests |
| 前端自行 reduce projection | 与 L0 balance/period semantics 分叉 | overview/account DTO only；禁止 client financial authority |
| response loss 重复创建 | 真实余额被重复计入 | stable create intent key、Sheet pending state、replay test |
| expectedVersion stale mutation | 覆盖其他 Tab/Session 更新 | reload latest、显示 conflict、绝不强制覆盖 |
| liability wording 误导 | 用户误读信用卡消费/还款 | natural balance copy、server amounts、文字和符号不只依赖颜色 |
| timezone/DST 错位 | Today/Week/Month/Year 显示不一致 | server period authority、browser-safe Temporal input helper、zone tests |
| Category kind/archived drift | income/expense breakdown 错乱 | server-filtered selector、kind-fixed quick create、duplicate handling |
| narrow/focus unusable | 高频记账无法完成 | focus trap、keyboard、scrollable sheet、narrow viewport E2E/component tests |
| hard delete误暴露 | 历史/identity 破坏 | Account physical delete 和 Category full management 不进 UI Integration |
| visual requirements未冻结 | 图表实现返工 | 先冻结 data/accessibility contract；visual detail 作为 Accepted 后的 non-blocking UX/content follow-up，不改变 implementation contract |

## 23. Open questions

以下问题不改变当前 API boundary，也不阻塞本 Plan 的 `Ready for Implementation`；它们是 non-blocking follow-up：

1. `/bills` compatibility redirect 的最终退休 release、旧链接通知和 telemetry 条件是什么；UI Integration 只保留 redirect，不自行删除。
2. Category breakdown / trend 的最终视觉形式和密度；本 Plan 已冻结真实 DTO mapping、period context 和 accessible text，但未冻结 exact chart/CSS。
3. Ledger zh/en copy 的最终短标签；不得因此改变 type/nature 或错误恢复语义。

以下不再是 open question，已由 UI Integration PRD 冻结：

- onboarding 是两步连续流程；
- `+ 记一笔` 默认 expense；
- UI Integration 支持 income/expense/transfer；
- Category quick create kind 固定；
- Account 管理入口和 physical delete non-goal；
- Transaction ordinary edit/delete；
- canonical `/ledger*` 和 legacy `/bills` redirect；
- no mock fallback；
- response-loss retry 复用同一 key。

## 24. Blockers and readiness

### Technical blockers

**No unresolved P0/P1 technical blocker.** 现有 API、shared DTO、currency metadata、projection、lifecycle、idempotency 和 owner auth 已覆盖本 Plan 的技术主轴；唯一发现的 `LedgerSettingsDto.hasCreatedAccount` visibility gap 已冻结为 UI.1 的最小 planned prerequisite，复用现有 server marker，不新增 migration 或 financial semantics。

### Governance / contract gates

1. **UI Integration PRD 已 Product Review: Accepted（PASS）。**
2. **本 Plan 已 Implementation Review: PASS，状态为 Ready for Implementation。**
3. **implementation 前必须重新 audit then-current `main`。** 这是防止文档 baseline 再次漂移的执行 gate，不是当前 blocker。

因此本文件最终状态为：

> **Implementation Plan: Ready for Implementation**

Implementation Review result：**PASS**（此前 Conditional Pass findings 已关闭）。本状态不代表本轮已开始或已完成生产实现；实现 owner 仍必须在 coding 前执行 then-current `main` re-audit，并先完成 UI.1 的 planned `hasCreatedAccount` DTO projection prerequisite。

## 25. Exit gate

本 Plan 的 Ready for Implementation exit gate 已完成：

- [x] UI Integration PRD status 已为 Product Review: Accepted；
- [x] capability roadmap 与 UI Integration delivery milestone 的关系已被 review 识别；无需修改或重编号 `ledger-v1-prd.md` 的 L1–L8；
- [x] canonical `/ledger`、`/ledger/transactions`、`/ledger/accounts` routes；
- [x] `/bills` compatibility redirect strategy 和 retirement gate；
- [x] feature API boundary 与 browser-safe shared imports；
- [x] feature-local state model、reset 和 refresh/invalidation；
- [x] `LedgerSettingsDto.hasCreatedAccount` lifecycle projection 及其 UI.1 planned prerequisite；
- [x] `FIRST_ACCOUNT_REQUIRED` / `NO_ACTIVE_ACCOUNT` 的唯一 state semantics，不以 `accounts.length` 代替 lock authority；
- [x] initialization / first Account 两步流程；
- [x] First Account 创建前可返回修改 Settings，创建成功后保持 settings lock；
- [x] `+ 记一笔` 与 unified Transaction Sheet；
- [x] three transaction payloads、Account/Category selector rules；
- [x] create intent 的 DRAFT/SUBMITTING/CONFIRMED/UNCERTAIN 状态，以及 UNCERTAIN 的同 payload/同 key retry 和 payload lock；
- [x] 503 `ledger-write-busy` definite failure semantics，不进入 UNCERTAIN；
- [x] UNCERTAIN hard reload 的 `sessionStorage` recovery record、lifecycle、session expiry preservation 和 malformed-record fail-closed behavior；
- [x] Category quick create 及 full Category Management non-goal；
- [x] create selectors 只显示 active entity，history filters 支持并标记 archived Account/Category；
- [x] money input/output 与 currency exponent；
- [x] Ledger timezone input/display 与 server period authority；
- [x] Dashboard projection mapping、period/breakdown/trend/recent hierarchy；
- [x] ordinary edit/delete 与 Adjustment read-only；archived Account 关联交易的受限 edit 和 restore-before-delete；
- [x] NO_ACTIVE_ACCOUNT 同时支持 restore archived Account 与 create new Account；
- [x] idempotency key lifecycle；
- [x] loading/empty/error/session/conflict states；
- [x] responsive/accessibility strategy；
- [x] exact test files、fresh DB real-data E2E；
- [x] verification ladder、CI matrix 和 commit sequence。

本轮完成的文件范围以 §26 为准；本轮 closure 不开始生产代码、修改 router、更新 package script 或执行 UI migration。Ready for Implementation 只表示 Plan review 已通过。

## 26. This round changed files

本轮 Documentation Remediation 实际修改：

- `docs/design/ledger-ui-integration-implementation-plan.md`（关闭 Conditional Pass findings，升级为 Ready for Implementation）
- `docs/design/ledger-ui-integration-prd.md`（关闭 Product Review，升级为 Accepted）

本轮未修改：

- `src/**`、`server/**`、`shared/**`；
- migrations、tests、`package.json`、router、CI；
- Bills / Ledger UI。
