# Ledger — UI Integration PRD

> [!IMPORTANT]
> **Historical Planning Baseline / Implemented and evolved.** 本文保留 UI 接入阶段的产品决策与 review 记录；当前代码已经超出该 baseline。当前行为请参阅 [Ledger 用户指南](../user-guide/ledger.md)、[Ledger Architecture](../architecture/ledger.md) 和 [Ledger UI Language](ledger-ui-language.md)。

## 1. Status / review closure

| 项目 | 结论 |
| --- | --- |
| Product Review | **Accepted** |
| PRD 状态 | Product Review: Accepted |
| Remediation date | 2026-09-05（Asia/Shanghai） |
| Product Review closure date | 2026-09-05（Asia/Shanghai） |
| Product Review result | PASS / Accepted |
| Review baseline HEAD | `5724e66e78905f3d0518f723eb7c23f2a1e3d360` |
| Remediation audited main HEAD | `5724e66e78905f3d0518f723eb7c23f2a1e3d360` |
| Current committed repository reality | 当前 `main` 已包含 `7ace840 fix(e2e): wait for ledger workspace mount` 与上一轮 UI Integration 文档 remediation；本轮 review closure audit 时 working tree clean |
| Original PRD drafting baseline | `3af6541c8542e12877918159882108f3e3ff6c91`（historical only；不是当前实现 baseline） |
| Current document path | `docs/design/ledger-ui-integration-prd.md`（本轮重命名后） |
| 产品输入 | REQ-003「Ledger UI 接入与记账闭环」；本 Prompt 提供的内容是本轮 authoritative product input |
| 领域/架构上位合同 | [`docs/design/ledger-v1-prd.md`](ledger-v1-prd.md)、[`docs/design/ledger-l0-foundation-prd.md`](ledger-l0-foundation-prd.md) |
| 本轮边界 | 只关闭本 PRD 的 Product Review；不修改生产代码，不开始 UI implementation |

Ledger v1 PRD 已是 Product Review: Accepted；L0 Foundation PRD 已冻结 Ledger 的领域、生命周期、金额、时间、projection、错误与幂等语义。本 PRD 定义一个跨多个 capability epic 的 UI Integration delivery milestone：把 Accounts、Transactions、Transfers、Dashboard、basic filtering 和 minimum Category UI 组合成第一个用户可用闭环。它不能重新定义上位合同，也不改变 Ledger v1 的 L1–L8 roadmap 编号。

### 1.1 Repository audit summary

本轮审计读取了以下 repository reality：

| 审计对象 | 当前事实 | 对本 PRD 的结论 |
| --- | --- | --- |
| `docs/design/ledger-v1-prd.md` | 已接受的 Ledger 定位、自然余额、Transaction union、Account/Category 生命周期、Overview 语义与阶段边界 | 作为产品/领域语义 authority |
| `docs/design/ledger-l0-foundation-prd.md` | 已冻结单一 `baseCurrency`、IANA `timezone`、首个 Account 后锁定、UTC instant、minor-unit、Transfer、Adjustment、soft delete、expectedVersion、幂等 replay 与错误边界 | UI 不得通过便利行为绕过这些约束 |
| `docs/design/ledger-l0-foundation-implementation-plan.md` | L0 明确不切换 UI、不接入 mock Dashboard；`/api/ledger/*` 的路由和状态边界已被规划/验证 | 当前任务是独立 UI cutover 阶段，不把 L0 重新解释为 UI 已完成 |
| `src/views/BillsView.vue` | Dashboard 仍直接读取 `billsMockData`；展示资产、分类占比、四个 period、趋势和最近交易 | 只能作为视觉/信息原型参考，不能作为数据事实 |
| `src/views/BillsTransactionsView.vue` | 交易页面展示 mock 记录；新增、收入、支出、日期筛选仍 disabled | 本次交付必须将其变为真实 Transactions 工作区 |
| `src/components/bills/**`、`src/features/bills/**` | 仍是 Bills 命名、fixture 数据与 JS number 聚合；原型没有 Transfer 和真实持久化 | 用户可见命名和数据源必须切换；技术遗留不自动等于产品需求 |
| `src/router/index.ts` | 当前正式 UI route 主要是 `/bills`、`/bills/transactions` | 本 PRD 冻结 `/ledger`、`/ledger/transactions` 为 canonical product route |
| `e2e/ledger-workspace.spec.ts` | 当前工作区回归仍以 `/bills`、共享 Navbar、主题和滚动边界为 prototype 基线；等待 workspace mount 的修改已包含在当前 main 的 committed `7ace840` 中 | 只作为审计/迁移回归事实；本轮不修改它 |
| `server/ledger/**` | 已有 Settings、Accounts、Categories、Transactions、Adjustment、Overview/trend、持久化、生命周期、幂等和错误处理能力 | UI Integration 可以建立在真实 Ledger API 上 |
| `shared/ledgerProtocol.ts` | DTO 明确区分 income、expense、transfer、adjustment；创建请求明确字段 shape；Overview 提供资产、负债、净资产、periods、trend、recentTransactions | UI 字段与类型切换必须服从 shared contract |
| `shared/ledgerCurrency.ts` | 提供受支持货币及其 ISO 4217 exponent，包括 CNY、JPY、KWD | UI 不得假定所有货币都是 2 位小数 |
| `shared/ledgerNormalization.ts` | Category identity 为 trim 后的大小写不敏感规范化 | 快速新增分类不能静默创建重复 identity |

### 1.2 Roadmap relationship

本 PRD 不创建新的 roadmap phase。`docs/design/ledger-v1-prd.md` 中已经 Accepted 的 capability roadmap 保持不变：L0 Foundation、L1 Accounts、L2 Transactions、L3 Transfers & Balance Integrity、L4 Dashboard Real Data、L5 Filtering & Search、L6 Categories，以及后续 L7/L8。

Ledger UI Integration 是一个跨 capability 的 delivery milestone，而不是新的 “L1” 阶段。它把 Accounts、Transactions、Transfers、Dashboard、basic filtering 和 minimum Category UI 组合成第一个用户可用的 UI 闭环。full Category Management、Adjustment UI、free-text Search 等没有纳入本次 delivery 的能力，仍归属于原 roadmap 或后续独立 requirement；本 delivery 不改变任何 Accepted financial、lifecycle、projection 或 idempotency contract。

因此当前没有需要阻塞本 PRD 的 Product / Architecture Contract Conflict。`hasCreatedAccount` 是 UI 正确呈现设置锁定生命周期所需的只读可见性投影；其最小 DTO 暴露属于后续 Implementation Plan 的实现前置，不改变本 PRD 已接受的产品行为。若后续 review 要改变财务语义，必须先修订 v1/L0 authoritative document，不能由本 PRD 或后续 Implementation Plan 静默决定。

## 2. Problem

Nuvyn 目前有一个看起来像 Ledger 的 Bills prototype，但它还不是用户可用的账本：

- Dashboard 和 Transactions 仍使用 `billsMockData`；
- “新增记录”不可用，用户不能从界面创建真实记录；
- 用户不能从界面完成 Ledger 初始化或创建第一个 Account；
- Dashboard 没有连接真实资产、负债、净资产、收支与趋势 projection；
- UI 仍大量使用 Bills 命名，正式 route 仍主要是 `/bills`；
- 原型中的金额、分类和交易结构不能证明符合真实 Ledger contract。

因此当前问题不是 L0 API 缺失，而是产品没有完成从 “API 可用” 到 “用户可用” 的 UI 接入。本次 delivery 要让 owner 在 Ledger 内完成首次建立账户、真实记账、查看结果和继续维护的闭环。

## 3. Product goal

本次 UI Integration delivery milestone 的目标是让一个新 owner 不需要调用 API、理解 SQLite、理解 minor unit、理解 natural balance、理解幂等或 projection，就可以：

1. 进入 Ledger 并完成基础货币、时区和第一个账户设置；
2. 创建并维护自己的资产账户和负债账户；
3. 通过 `+ 记一笔` 快速创建收入、支出或转账；
4. 查看真实账户余额、总资产、总负债、净资产、期间收支、分类结构、趋势和最近交易；
5. 在保存、刷新、重新登录后仍看到同一份 authoritative Ledger 数据；
6. 在网络失败、响应丢失、版本冲突或 session 过期时知道下一步如何恢复。

本次交付成功的用户感受是：Ledger 是自己的账本，而不是带有财务外观的演示页面。

## 4. User / usage model

Ledger 面向单个 owner，是 Nuvyn Personal OS 的四个核心一级 Workspace 之一。完整的系统级产品定位见 [Nuvyn — Personal OS](../product.md)：

```text
Note   → 我知道什么
Diary  → 我经历了什么
Ledger → 我的钱发生了什么
Board  → 我正在思考和构思什么
```

Ledger 的主要使用任务是：

- 快速记下刚发生的一笔收入、支出或账户转账；
- 打开 Ledger 后快速回答“我现在有多少钱、欠多少钱、钱在哪里”；
- 回看最近交易并定位某一笔记录；
- 在账户余额变更、账户归档或恢复时理解后果。

Ledger 不是专业会计系统、银行账户聚合器、企业财务系统，也不引入多人共享、角色、家庭账本或外部金融授权。

## 5. Product principles

### 5.1 真实数据优先

只要 Ledger UI Integration 已进入本次 delivery，loading、error、uninitialized、empty 都必须呈现对应真实状态。任何状态都不得 fallback 到 `billsMockData`，也不得把 Demo 数据伪装成 owner 数据。

### 5.2 服务端是财务规则 authority

UI 可以提供即时校验和友好提示，但 Account、Category、Transaction 的关系、余额效果、生命周期、版本冲突、幂等重试和 projection 结果以服务端为准。UI 不通过本地估算把金额当作最终事实。

### 5.3 低摩擦，但关键值必须明确

高频记账只要求用户完成必要字段；但 baseCurrency、timezone、Account、Category 和金额等会影响财务解释的值必须被用户看见并确认，不能静默猜测。

### 5.4 让自然余额可理解

用户看到的是“我拥有的钱”“我欠的钱”“账户余额”“净资产”等产品语言。必要时补充“资产/负债”术语，但不能通过取绝对值、反转符号或含糊文案隐藏透支、信用余额或负债变化。

### 5.5 历史优先

归档、编辑和删除必须尊重已有交易历史。一个操作不能为了让页面看起来更整齐而删除历史、释放分类 identity 或隐藏非零账户。

### 5.6 一次 create intent 只产生一次结果

所有会创建持久化记录的 create mutation 都遵循同一套可确认状态：Settings create、Account create、Category quick create、Transaction create，以及未来若有 UI 的 Adjustment create。

```text
DRAFT
  ↓ submit
SUBMITTING
  ├─ 明确成功 → CONFIRMED
  ├─ 明确的 validation / deterministic conflict / 503 failure → DRAFT / ERROR
  └─ 结果未知（timeout、connection reset、response lost）→ UNCERTAIN

UNCERTAIN
  ├─ retry same canonical payload + same Idempotency-Key → CONFIRMED
  └─ cancel / new intent → 先确认原 intent 的 authoritative result
```

一次 intent 在第一次 submit 时绑定一个 stable Idempotency-Key 和 canonical payload。`UNCERTAIN` 不是普通可编辑错误：用户不能直接修改金额、账户、分类、时间或其他 canonical payload 字段后用新 key 再提交，因为原请求可能已经在 server commit。只有原 intent 被确认成功，或被确认没有创建成功，用户才可以开始新的 payload + 新 key intent。明确收到的 HTTP 400 validation、deterministic 409 或 503 `ledger-write-busy` 是已知的、可恢复的明确失败，可以回到可编辑状态；网络超时、连接重置、响应丢失或没有收到响应必须进入 `UNCERTAIN`。一次记账意图最终只能产生一笔记录。

### 5.7 时间和货币必须可解释

货币显示遵循 Ledger baseCurrency 和 ISO 4217 exponent；日期、时间和 period 遵循冻结的 Ledger timezone。浏览器的 locale/timezone 只能用于预选或展示辅助，不能成为 Ledger 的隐式 authority。

## 6. Entry states

每次进入任意 Ledger route，都先呈现真实的 Ledger 状态。以下状态是正式产品状态，不是临时异常。

| 状态 | 用户看到什么 | 用户下一步 |
| --- | --- | --- |
| 未初始化 | Ledger 欢迎/设置页面；不显示伪造的 Dashboard 数字 | 明确选择 baseCurrency 和 timezone，并点击继续 |
| `FIRST_ACCOUNT_REQUIRED`：`settings.hasCreatedAccount=false` 且当前没有可用 Account | “完成第一个账户”页面或 onboarding 第二步；不显示全是 0 的正常 Dashboard | 创建第一个 Account，或选择稍后创建；下次进入仍回到此状态 |
| 有 Account 但没有 Transaction | 真实 Dashboard shell；资产/负债/净资产来自真实 opening balance，收支、趋势和最近交易显示可解释 empty state | 点击 `+ 记一笔` 创建第一笔真实交易 |
| 正常有数据 | 完整 Dashboard 和 Transactions 工作区 | 记账、查看、编辑、删除或维护账户 |
| Loading | 页面级或区域级 loading 状态；未知数值不显示为 0 | 等待当前读取完成；不可执行的 action 保持不可用 |
| Recoverable Error | 区分表单错误、网络失败、暂时不可用、版本冲突等，并提供对应恢复动作 | 修正字段、重试、重新加载或重新登录 |
| Session expired | 明确提示 session 已过期并进入登录流程；未保存输入不被宣称为已保存 | 重新登录后回到原 Ledger context，再确认未完成操作 |
| `NO_ACTIVE_ACCOUNT`：`settings.hasCreatedAccount=true` 且当前没有 active Account（可能是全部归档，也可能是无历史 Account 被 physical delete 后实体为 0） | 显示当前设置已锁定、当前没有可用于新记账的 active Account；保留可用的历史上下文 | 从账户管理恢复一个 archived Account（若存在），或创建一个新的 active Account；不能用 mock 或静默创建账户 |

### 6.1 未初始化与首个账户/无 active 账户状态不显示正常 Dashboard shell

未初始化和 `FIRST_ACCOUNT_REQUIRED` 时，不显示资产、负债、趋势等看似正常但没有下一步的 Dashboard shell。`NO_ACTIVE_ACCOUNT` 也不显示可保存的正常记账 Dashboard，但要保留账户历史上下文，并同时提供“恢复账户”（若存在 archived Account）和“创建新账户”两个明确 CTA。可以保留 Nuvyn 全局 Navbar 和 Ledger 身份，但主区域必须是有明确 CTA 的 onboarding/empty experience。UI 必须使用只读的 `settings.hasCreatedAccount` lifecycle authority，不能用 `accounts.length` 猜测设置是否仍可编辑。

有 Account 无 Transaction 时显示真实 Dashboard shell，因为此时 opening balance 和账户状态本身已经是有效的 Ledger 数据；所有 0 必须明确表示“还没有交易”，不能表示加载失败或 mock。

## 7. Initialization experience

### 7.1 形式：连续 onboarding，两个明确步骤

初始化和第一个 Account 是一个连续 onboarding，但不是把所有字段塞进一个不可解释的大表单：

```text
Step 1  设置 Ledger：baseCurrency + timezone
   ↓ 成功
Step 2  创建第一个 Account
   ↓ 成功
Ledger Dashboard
```

这样安排是因为 Account currency 必须匹配 baseCurrency，而第一条 Account 创建成功会同时冻结 baseCurrency 和 timezone。用户可以在 Step 2 退出，但退出后进入“已初始化、无 Account”状态，而不是进入全是 0 的 Dashboard。

### 7.2 Step 1：设置 Ledger

页面标题和文案方向：

- 标题：`开始使用 Ledger`；
- 说明：Ledger 会用这些设置显示金额、解释日期并计算今天/本周/本月/今年；
- 锁定提示：创建第一个账户后，baseCurrency 和 timezone 会锁定，之后不会在没有明确新产品契约的情况下随意切换。

用户必须明确确认两个值：

| 值 | 用户语言 | 产品行为 |
| --- | --- | --- |
| `baseCurrency` | 基础货币 | 必须由用户选择受支持的 ISO 4217 currency；不根据浏览器 locale 静默决定，不提供隐式 USD/CNY 等最终默认值 |
| `timezone` | Ledger 时区 | 必须由用户选择 named IANA timezone；若浏览器能提供有效 IANA timezone，可作为可见的预选建议，但用户仍必须点击继续确认 |

具体规则：

- 两个字段都必填；缺一不可继续；
- 预选值永远不是已保存值，页面不能自动提交；
- 页面在保存前展示最终选择，尤其提示 timezone 会影响交易显示日期和 period 边界；
- 不显示 `currencyExponent` 让用户编辑；小数位由货币定义自动得到；
- 不承诺未来可以任意切换。现有 Accepted contract 允许在首个 Account 创建前修改，首个 Account 创建成功后 immutable；UI 必须与此一致；
- 保存成功后立即进入 Step 2，并以服务端返回的设置为准；默认 Categories 同时由真实 Ledger 初始化流程提供，不能从 mock 读取。

Step 1 的主按钮是 `继续创建第一个账户`，不是 `完成`。用户应知道下一步仍需创建 Account 才能开始记账。

### 7.3 Initialization failure

- 用户修正得了的问题（缺失值、格式不对、不支持的 currency/timezone）显示在对应字段旁，保留其他输入；
- 网络失败或 temporary unavailable 显示“Ledger 暂时无法连接/暂时不可用”，保留选择并提供 `重试`；
- 如果保存请求之后响应丢失，重试同一意图仍只能得到一次初始化结果；
- 如果另一个 session 已完成初始化，重新读取真实状态并进入 Step 2，不把 `settings-already-initialized` 显示为无法恢复的系统错误；
- 不显示 SQL、stack、SQLite、内部路径或原始错误 dump。

## 8. First Account experience

### 8.1 页面目标

Step 2 的目标不是让用户学习会计，而是回答“这笔钱/这笔欠款现在在哪里”。页面显示已选择的 baseCurrency 和 timezone 作为只读上下文，并让用户创建第一个可用于记账的 Account。Step 2 必须同时提供明确的 `[修改 Ledger 设置]` 入口，因为首个 Account 创建成功前这两个设置仍可按 Accepted contract 修改。

### 8.1.1 First Account 前的 Settings 返回行为

- Step 2 始终显示当前 authoritative 的基础货币和时区摘要，并显示“创建第一个账户后，这两个设置将锁定”的说明；
- 用户点击 `[修改 Ledger 设置]` 后返回 Step 1（或等价的 Settings surface），可以修改 baseCurrency、timezone；
- 用户必须在 Step 1 再次主动确认修改；保存使用当前 Settings `version`，成功后以服务端返回值刷新并重新进入 Step 2；
- 在 Step 2 修改设置不会自动创建 Account，也不会把未确认的值当成已锁定值；
- 如果并发 session 已创建首个 Account，重新读取 authoritative state，停止返回修改并进入正常 Dashboard/相应状态；不要用旧的 Step 2 草稿覆盖已锁定设置；
- 首个 Account 创建成功后，Step 2 不再提供修改 locked fields 的入口，只显示当前值和锁定说明。

### 8.2 字段与用户语言

| Contract 字段 | 用户可见字段 | 必填/默认 | 产品定义 |
| --- | --- | --- | --- |
| `name` | 账户名称 | 必填 | 例如“招商银行”；是用户识别账户的名称，不要求全局唯一 |
| `type` | 账户类型 | 必填 | 选择现金、银行账户、钱包、信用卡、贷款或其他 |
| `nature` | 钱的性质 | 对已知 type 自动决定；`other` 必选 | 首选语言是“我拥有的钱 / 我欠的钱”；可在辅助说明中标注“资产 / 负债” |
| `openingBalanceMinor` | 期初余额 | 可填，默认 0 | 表示 opening date 开始时的起点，不是隐藏的一笔交易；输入正常货币金额，不输入 minor units |
| `openingDate` | 起始日期 | 必填；默认 Ledger timezone 下的今天 | 表示该账户从哪一个 Ledger 本地日期开始计算；用户可以修改 |
| `currency` | 账户币种 | 必填但只读 | 继承 Ledger baseCurrency；本次交付不允许选择其他币种或 FX |
| `note` | 备注 | 可选 | 保存账号尾号、用途等帮助 owner 识别账户的信息；不要提示输入密码或 token |

### 8.3 Account type 的简化呈现

UI 使用以下用户语言和默认性质：

| Contract type | 用户可见名称 | 默认/允许性质 | 解释方向 |
| --- | --- | --- | --- |
| `cash` | 现金 | 我拥有的钱（asset） | 手头现金 |
| `bank` | 银行账户 | 我拥有的钱（asset） | 银行卡、存款 |
| `wallet` | 钱包 | 我拥有的钱（asset） | 支付宝、微信等数字钱包 |
| `credit_card` | 信用卡 | 我欠的钱（liability） | 消费后形成的欠款 |
| `loan` | 贷款 | 我欠的钱（liability） | 贷款余额 |
| `other` | 其他 | 用户选择 | 自定义账户；必须明确是“我拥有的钱”还是“我欠的钱” |

已知 type 的性质不可在 UI 中选择不合法的组合。`other` 需要用一个易懂的二选一，而不是要求用户理解 `nature` 的内部值。

### 8.4 Opening balance 的解释

表单必须让用户理解：

- 填 `¥10,000.00` 表示在 opening date 开始时账户已有/欠有这笔余额；
- 不知道或暂时不想填时可以保持 `0`，不会阻止创建；
- opening balance 可以是带符号金额，以保留透支或信用余额等真实状态；
- 对 asset，正数通常表示 owner 持有的钱；对 liability，正数通常表示 owner 欠的钱；
- 余额修正不能通过一个隐藏的“当前余额”字段直接覆盖。本次交付不新增 financial semantics；后续需要余额校正时必须遵守既有 Adjustment contract。

### 8.5 创建成功与失败

- 第一个 Account 创建成功后，用户进入真实 `/ledger` Dashboard；
- Dashboard 立即显示该 Account、opening balance、资产/负债/净资产和“还没有交易”的下一步；
- 创建 Account 与首个 Account lifecycle freeze 遵循服务端原子合同；UI 不在本地提前声称设置已锁定；
- 创建失败时保留表单内容，区分字段错误、网络/temporary unavailable、session expired；
- 用户重复点击或响应丢失不能创建两个相同意图的 Account；
- 用户选择稍后创建时回到 `FIRST_ACCOUNT_REQUIRED` 状态；下次进入仍提供创建第一个 Account 的主 CTA。

## 9. Ledger Dashboard

### 9.1 Dashboard 的首要问题

用户打开 Ledger 最想知道的顺序是：

1. 我现在有多少钱？
2. 我欠多少钱？
3. 我的净资产是多少？
4. 钱分别在哪些账户？
5. 最近收入和支出是多少？
6. 最近发生了什么交易？

Dashboard 围绕这个顺序组织，而不是为了填满页面堆叠图表。

### 9.2 UI Integration 信息架构

Dashboard 的产品层级冻结为：

1. **Ledger header**：当前页面身份、baseCurrency/timezone 的可访问入口或摘要，以及醒目的 `+ 记一笔`；
2. **资产与负债概要**：`totalAssets`、`totalLiabilities`、`netWorth`；
3. **账户列表**：active Account 的当前余额，按“我的钱/我欠的钱”或资产/负债分组；提供 `管理账户`；
4. **选定期间的收支摘要**：默认本月，显示收入、支出、结余；
5. **最近交易**：最近 5 条 active records，提供 `查看全部`；
6. **固定期间摘要**：今天、本周、本月、今年四个 period 的收入、支出和结余；
7. **分类收支与趋势**：作为次级解释区域，帮助 owner 看钱花到哪里、最近月份如何变化。

窄屏时按同一信息优先级纵向排列；不得因为布局收缩而隐藏 `+ 记一笔`、资产/负债/净资产、账户入口或最近交易。

### 9.3 保留、调整、删除、延后

| 当前 prototype 元素 | 本次交付决策 | 冻结的产品要求 |
| --- | --- | --- |
| 资产概要 | 保留并改名/重组为资产与负债概要 | 真实显示资产、负债、净资产；不使用 mock account rows；负债不能通过取绝对值伪装成资产 |
| 账户列表 | 保留并升级为真实 active Account 列表 | 显示当前余额、账户名称、类型/性质；入口进入账户管理 |
| “收支占比”两个 donut | 保留信息目标，调整表达 | 改为清晰的“分类收支”；明确 selected period、收入/支出两类、金额与各自占比；不得只展示没有 period 语境的百分比。具体视觉图表由后续 IP 决定，但必须有可理解的文本/可访问表达 |
| Today / Week / Month / Year | 保留但降为 secondary summary | 四张卡来自 `periods` projection；显示收入、支出、结余；移除 `expense > income` 即“超预算”的语义，因为本次交付没有 Budget |
| 收支趋势 | 保留但降为 secondary analysis | 使用真实最近 6 个 calendar months，包含当前月；显示收入/支出，空数据时给出下一步，不显示 demo 曲线 |
| 最近交易 | 保留并提升优先级 | 使用真实最近 5 条 active records；新增、编辑、删除或刷新后即时反映 |
| “选择账本” | 删除 Bills/多账本误导 | Ledger v1 是单一 owner、单一 base currency；scope 应表达 period，不应暗示多个账本 |
| `is-over-budget` 等原型高亮 | 删除 | 不以收入支出相比较推断预算状态 |
| mock 数字、演示记录、disabled “即将上线” | 删除 | 本次交付不允许任何 mock fallback 或假装可用的 disabled 核心 action |

### 9.4 Overview scope 语义

Dashboard 的收支摘要和分类收支共享一个明确的 scope，默认 `month`（本月），可切换 `today`、`week`、`month`、`year`、`all`。scope 的产品语义必须与既有 Overview contract 一致：

- scope 只改变 `cashflow` 和 `categoryBreakdown`；
- `assetTotal`、`liabilityTotal`、`netWorth`、账户当前余额不按 scope 重新计算；
- 四个固定 period 始终各自计算今天/本周/本月/今年，不随 scope 变成四个相同卡片；
- trend 始终使用最近 calendar months，不受 cashflow scope 影响；
- recentTransactions 始终是最新 5 条 active records，不受 scope 过滤；
- `all` 表示所有 active income/expense 历史记录，不是 prototype 的 mock 年度数据；
- Transfer 和 Adjustment 不进入收入/支出或分类统计，但 Transfer 可以出现在最近交易和 Account Detail movement 中。

## 10. Primary action — + 记一笔

### 10.1 一级行为

`+ 记一笔` 是 Dashboard 的一等主操作，用户不需要先进入 Transactions 再找新增。它在有至少一个 active Account 且 Ledger 处于正常可操作状态时可用。

Transactions 页面 header 也提供同一个 `+ 记一笔` 入口，保证用户从交易工作区可以继续记账；但 Dashboard 的入口是产品最高频主 CTA。

### 10.2 不同状态下的行为

| 状态 | 点击 `+ 记一笔` 的行为 |
| --- | --- |
| 未初始化 | 不显示普通 Dashboard CTA；初始化页只显示继续初始化 action |
| 已初始化但没有 Account | 不打开 Transaction Sheet；进入/聚焦第一个 Account 创建流程 |
| 有一个 active Account | 打开记账交互，Account 默认选中该账户 |
| 有多个 active Account | 打开记账交互；若从 Account Detail 进入则预选来源账户，否则要求用户明确选择账户 |
| 所有 Account 已归档 | 不打开可保存的空表单；引导恢复一个 Account 或创建新的 Account |
| Loading | 保持不可用并显示 loading，不提交未知数据 |
| Recoverable Error | 显示对应恢复 action；不以旧 mock 数据继续打开可写表单 |

桌面和窄屏都必须保留这个 action 的可见入口。窄屏不要求完整 mobile redesign，但必须能从当前页面打开、滚动并提交记账表单。

## 11. Transaction creation

### 11.1 统一交互模型

产品采用统一的 Transaction Sheet/Dialog 交互模型；“Sheet/Dialog”是产品形态描述，不冻结 Vue component 或具体技术实现。

打开后默认 Transaction type 为 **支出（expense）**，因为它是最高频的日常记账动作。用户可以在新建状态切换为收入或转账。

类型切换规则：

- 新建时可在 `支出 / 收入 / 转账` 之间切换；
- 切换后只保留通用字段（金额、时间、备注），显示对应类型字段；
- 切换到收入/支出时显示单一 Account、对应 Category 和 payee；
- 切换到转账时显示转出账户、转入账户，隐藏 Category 和 payee；
- 类型切换不自动把一个 expense Category 当作 income Category，也不把原 Account silently 复制到不适用字段；
- 编辑已有 Transaction 时 type 显示但不可切换。误记类型必须按既有 contract 删除旧记录并新建正确类型，不能把 PATCH 当作改型。

### 11.2 字段总表

| Transaction type | 必填字段 | 可选字段 | 不显示/不适用 |
| --- | --- | --- | --- |
| 支出 `expense` | 金额、Account、expense Category、发生时间 | payee、备注 | from/to Account |
| 收入 `income` | 金额、Account、income Category、发生时间 | payee、备注 | from/to Account |
| 转账 `transfer` | 金额、转出 Account、转入 Account、发生时间 | 备注 | Category、payee |

本次交付的主记账 Sheet 不创建 Adjustment。已有 Adjustment 由真实 API 返回时可以在 Transactions 的“全部”中被查看，但不作为三种普通记账类型的第四个快捷入口；Adjustment 的创建与专门管理留给后续明确的产品需求。

### 11.3 Account selector

- 新交易只允许选择 active Account；archived Account 不出现在可选列表；
- Account 选择项显示名称、用户可识别的 type/性质和当前余额，避免两个同名账户无法区分；
- 只有一个 active Account 时可预选，但仍让用户看见选中的账户；
- 有多个 Account 且没有明确来源 context 时不强行猜测；必须让用户确认；
- 转账的转出和转入不能是同一个 Account；选择后应立即给出易懂的错误提示；
- 如果没有可用 Account，表单转为创建/恢复 Account 的下一步，而不是显示无法保存的普通空表单。

### 11.4 Category selector

- 支出只显示 active expense Category；
- 收入只显示 active income Category；
- archived Category 不可用于新 Transaction；
- Category 选择项使用真实 name 和 stable identity，不从 mock 映射；
- 选择器必须明确是“支出分类”或“收入来源”，不能把 Account 和 Category 混成一个字段；
- Category 列表为空时，保存不可用并显示 `新建支出分类` 或 `新建收入分类` 的明确 action，见第 16 节。

### 11.5 Amount input

- 用户输入正常的十进制货币金额，不输入 minor units；
- income、expense、transfer 的金额必须为正数，0 和负数不可保存；
- 输入错误、精度超过当前货币或金额溢出时显示字段级提示；
- 表单始终显示当前 Ledger currency 的 symbol/code 与正确小数位；
- UI 不允许用户覆盖 `currencyExponent`，也不把浏览器 locale 的 rounding 当作 authority。

### 11.6 Account、Category、时间、备注字段的默认值

- Account：按第 11.3 节规则预选；
- Category：不为了省一次点击而预选一个可能错误的分类；只有用户明确选择或快速新建后才填入；
- `occurredAt`：默认打开表单时的“现在”，以 Ledger timezone 展示；保存时仍受服务端允许的未来范围和 opening boundary 校验；
- 日期/时间：用户可以分别修改日期和时间；不只提供一个无法解释的 UTC 数值；
- payee：收入/支出可选，使用“交易对象/来源”这类上下文文案；
- note：所有三种类型可选；空 note 是合法的；
- dirty form：用户点击取消或关闭时，如有未保存变化，必须先确认丢弃；保存中不能因为再次点击产生第二次提交。

### 11.7 Save / cancel / saving / failure / success

| 状态 | 用户体验 |
| --- | --- |
| 可保存 | `保存` 明确可见；表单错误在字段旁展示 |
| 保存中 | 显示 `正在保存…`；阻止重复提交；保留当前输入；不显示一个未经确认的永久余额结果 |
| 取消 | 未修改可直接关闭；有修改时确认丢弃；不会删除已保存记录 |
| 保存失败 | Sheet 保持打开并保留输入；字段错误要求修正，系统错误提供重试/重新加载/重新登录等正确 action |
| 保存成功 | 关闭或完成 Sheet，给出“已记账”反馈；回到来源 context；立即刷新/呈现 authoritative Transaction、Account balance、资产/负债/净资产、period summary、trend/breakdown 和 recent list |
| 响应丢失/超时 | 明确进入 `UNCERTAIN`，提示“这次保存的结果尚未确认”；canonical payload 字段暂时不可编辑；只提供使用相同 payload + 相同 Idempotency-Key 的 `[重试确认]` 或 `[重新检查]`；在原 intent 结果确认前不能取消后直接新建另一笔 |

明确的 HTTP 400 validation 或 deterministic 409（例如 semantic conflict、version conflict、duplicate Category）表示 server 已确认本次 create 没有成功，可以回到可编辑的 `DRAFT / ERROR`，下一次正式 submit 才开始新的 intent 并使用新 key。`UNCERTAIN` 则不允许直接改金额、Account、Category、时间或其他 canonical payload 后换 key；这条规则同样适用于 Settings、Account、Category create，以及未来的 Adjustment create。

用户不需要手工刷新浏览器。实现可以重新读取 projection，但产品结果必须是保存成功后 UI 立即反映 authoritative state。

## 12. Income

收入的产品语义是“有一笔钱进入某个 Account，并归入一个 income Category”。表单字段为：

- 金额；
- Account；
- income Category；
- occurredAt；
- 可选 payee/来源；
- 可选 note。

UI 不要求用户理解 `amountMinor`，也不让用户输入负数来表示收入。服务端按照既有 natural balance 语义计算资产或负债账户的余额效果，并将该记录计入 income summary；UI 不能本地重写这一效果。

收入 Category 只能从 `kind=income` 的 active Category 中选择。Transfer 不应通过收入表单创建。

## 13. Expense

支出的产品语义是“从某个 Account 发生一笔支出，并归入一个 expense Category”。表单字段为：

- 金额；
- Account；
- expense Category；
- occurredAt；
- 可选 payee/交易对象；
- 可选 note。

UI 必须以正数金额呈现支出，不要求用户输入负号。对 liability Account，消费会增加欠款；这类结果必须通过账户/余额文案让用户可理解，不能把信用卡消费错误显示成资产减少或隐藏为负数魔法。

支出 Category 只能从 `kind=expense` 的 active Category 中选择。Expense 只产生一笔 Transaction，并计入 expense summary；不能用 Transfer 代替真实消费。

## 14. Transfer

转账的产品语义是“钱从一个 Account 移到另一个 Account”，不是收入，也不是支出。

表单字段为：

- 金额；
- 转出账户 `fromAccount`；
- 转入账户 `toAccount`；
- occurredAt；
- 可选 note。

冻结行为：

- 不显示 Category；
- 不显示 payee；
- from/to 必须不同；
- 两个账户都必须是 active 且与 Ledger baseCurrency 一致；
- 一次保存只创建一条 Transfer record；
- 转账不进入 Dashboard income/expense 或 Category breakdown；
- 信用卡还款使用 Transfer，不能再次记成 Expense；
- Account movement 可以显示转入/转出，但 Dashboard 收支统计不因此增加。

服务端仍是 from/to effect 和自然余额的 authority。UI 不通过创建两条相反记录来模拟一次 Transfer。

## 15. Account UX

### 15.1 入口与信息架构

Account management 从两个稳定入口进入：

- Dashboard 账户区域的 `管理账户`；
- Ledger 二级导航或页面入口的 `账户`，canonical route 为 `/ledger/accounts`。

Account detail 可以使用 `/ledger/accounts/:id` 作为 canonical detail route。产品不要求沿用 prototype 的 card 结构或 Bills 文件命名。

账户页面按“我的钱（资产）”和“我欠的钱（负债）”分组，默认只显示 active Account；归档账户放在明确的“已归档账户”区域中，提供恢复 action。

每个 Account 至少能查看：名称、type、性质、currency、opening balance、opening date、note、当前余额、归档状态，以及进入该账户全部交易和本月 movement summary 的入口。movement 文案遵循既有 contract：asset 使用“流入/流出”，liability 使用“新增负债/减少负债”，不能把 debt movement 误称为个人现金流。

### 15.2 新增与编辑

新增 Account 复用第 8 节字段和产品语言；currency 继承 baseCurrency，不能在新增时选择跨币种。

本次交付支持 Account edit，但按历史状态限制可见字段：

| Account 状态 | 本次交付可编辑字段 | 说明 |
| --- | --- | --- |
| active、没有任何交易历史 | name、note、type、nature、opening balance、opening date | UI 必须仍保证合法 type/nature 组合；currency 不可编辑 |
| active、已有交易历史 | name、note | type、nature、opening balance、opening date 等会重新解释历史的字段不提供可编辑入口 |
| archived | name、note | 其他字段须先恢复；archived Account 不能被新交易使用 |

如果 UI 无法确认某 Account 是否已有历史，应避免让用户编辑会改变财务解释的字段，并在读取 authoritative state 后再决定。

### 15.3 Archive / restore

- `归档账户` 是明确的 lifecycle action，不是删除名称或隐藏当前余额；
- 只有 current balance 为 0 的 Account 可以归档；资产和负债都适用同一 gate；
- 非零时显示当前余额和“需要先处理余额/取消归档”的恢复方向，不自动生成交易、不静默改余额；
- 归档后保留历史，默认 Account selector 不再提供该账户；
- `恢复账户` 从已归档列表执行，恢复后账户可用于新交易；
- 归档/恢复失败时区分版本冲突、非零余额、网络失败和 session expired；
- 不因归档改变 Dashboard 既有历史数据的解释。

### 15.4 Physical delete

本次 UI Integration 不暴露 physical Account delete，即使 server 有对应 API。普通 owner 的核心任务是维护和归档，而不是擦除账户身份；有历史的 Account 更不能通过 UI 删除。无历史账户的物理删除属于本次交付 non-goal，后续如需暴露必须另立产品决策并处理 history/freeze 影响。

## 16. Category UX

### 16.1 Real Category data

收入和支出必须使用真实 Ledger Category。首次初始化成功后，服务端按 Accepted v1 catalog 提供默认 flat Categories：

```text
Expense: 餐饮、交通、购物、住房、日用、娱乐、医疗、教育、旅行、人情、其他
Income:  工资、奖金、投资收益、兼职、退款、红包、其他
```

本次交付不创建第二套 UI-only 分类映射，也不把分类名称硬编码成 mock 数据。

### 16.2 Quick create 决策：本次交付支持，kind 固定

本次 UI Integration **支持 Transaction Sheet 内快速新增 Category**，但只提供最小的 contextual create：

- 从支出表单进入时，创建 kind 固定为 expense；
- 从收入表单进入时，创建 kind 固定为 income；
- 用户只输入分类名称；
- 创建成功后立即选中该真实 Category；
- 新建操作必须遵守真实 Category identity、重复检查、幂等和 archived identity 不自动恢复的 contract；
- duplicate name 或已归档 identity 冲突时保留表单，提示换一个名称或使用未来的分类管理能力，不能静默 unarchive 或生成看似相同的第二分类。

这样可以让用户在实际记账时完成闭环，同时避免把 Account、Category kind 或 flat-category 语义交给用户猜测。

### 16.3 Full Category Management 不在本次交付

本次交付不提供独立的完整 Category Management surface，不支持在本轮 UI 中 rename、archive、restore、physical delete 或层级分类管理。相关能力留给后续独立需求；但本次交付必须正确处理这些状态已经存在于真实 API 的情况：

- archived Category 不进入新交易 selector；
- 历史交易和历史 breakdown 不因 Category archived 而消失；
- 历史记录可显示“已归档”提示帮助理解；
- 空的 active Category 列表必须给出 `新建分类` action，而不是“暂无数据”后让用户卡住；
- 若快速新增失败，Sheet 保持打开并提供重试/换名。

## 17. Transactions UX

### 17.1 页面与列表

canonical Transactions route 为 `/ledger/transactions`。页面是一个真实的 Transaction 工作区，至少提供：

- active Transaction list；
- `+ 记一笔`；
- 点击行查看详情；
- 类型、账户、分类和日期范围的 basic filter；
- 明确的 empty state；
- 编辑和删除 ordinary Transaction 的入口。

列表默认只读 active records，按既有 canonical order 展示：`occurredAt DESC, createdAt DESC, id DESC`。日期按 Ledger timezone 分组或展示。列表行至少让用户看懂类型、金额、发生时间、Account，以及收入/支出的 Category 和 payee；Transfer 显示 from → to；Adjustment 若出现在“全部”中显示为“余额调整”并保持可解释。

### 17.2 Filters

本次交付的 basic filter 冻结为：

| Filter | 行为 |
| --- | --- |
| 类型 | 全部、支出、收入、转账；“全部”包含 Adjustment；不伪造一个 server 未定义的 adjustment filter |
| Account | 可按普通 Account 或 Transfer 的 from/to 查询；与 Account Detail 语义一致；selector 同时列出 active 与 archived Account，archived 项明确标记“已归档”并仍可查询历史 |
| Category | 只匹配 income/expense；selector 同时列出 active 与 archived Category，archived 项明确标记“已归档”并仍可查询历史；Transfer/Adjustment 不因 Category filter 被错误包含 |
| 日期范围 | 用户选择 Ledger local date 的 from/to；默认是全部时间，不显示 prototype 固定的假月份 |

历史筛选使用真实 Account/Category 列表的 archived entities；archived entity 不会被隐藏、自动恢复或当成不存在。Create selector 与 History filter 分离：新交易仍只能选择 active Account 和 active Category。历史交易仍显示其 Category 名称及归档标记，Dashboard 历史 aggregation 不因 Category archived 而丢失。默认仍排除 soft-deleted records，除非未来有独立产品需求暴露 `includeDeleted`。

free-text search、复杂保存筛选、导入和高级报表不属于本次交付的 basic filter。现有 query contract 的 `search` 能力不被本 PRD 重新定义，是否在后续阶段暴露由独立需求决定。

### 17.3 Edit 决策：进入本次交付

本次交付支持 active **income、expense、transfer** 的编辑。编辑复用统一 Sheet，但：

- Transaction type 显示为只读，不能改型；
- income/expense 可修改金额、Account、Category、occurredAt、payee、note，且新的 Account/Category 必须 active、kind 正确并满足 opening boundary；
- transfer 可修改金额、from/to、occurredAt、note，且 from/to 必须不同；
- 编辑成功后立即反映所有受影响账户余额、Dashboard totals、period、trend、breakdown 和列表顺序；
- 版本冲突不能覆盖其他修改，必须让用户 reload 最新数据后再决定；
- Adjustment 在本次交付中只读；其财务字段不提供编辑入口，符合 Adjustment immutable contract。

### 17.3.1 Archived Account 关联交易的编辑

如果已有 ordinary Transaction 关联一个或多个 archived Account，UI 必须先根据 authoritative Account state 调整编辑能力，而不是让所有字段看似可编辑、保存后才收到 generic 409：

| 交易类型 | archived Account 存在时可编辑 | 必须只读/禁止修改 |
| --- | --- | --- |
| Income / Expense | `note`、`payee` | `amount`、`occurredAt`、`account`、`category` |
| Transfer | `note` | `amount`、`occurredAt`、`fromAccount`、`toAccount` |

页面显示“该交易使用了已归档账户。若要修改金额、账户、分类或发生时间，请先恢复相关账户”，并提供 `[恢复账户]` 入口。恢复相关 Account 后必须重新读取交易和版本，再决定是否恢复可编辑 financial fields。若 Account 在 sheet 打开后才被归档，也必须在保存前重新应用这套规则。Adjustment 无论账户状态如何都保持本次交付的只读行为。

### 17.4 Delete 决策：进入本次交付，产品呈现为不可恢复的删除

本次交付支持 ordinary Transaction 的删除，服务端语义是 soft delete、terminal、不可 restore。UI 呈现为：

- action 文案是 `删除记录`，不使用“撤销余额”或“恢复交易”等误导性文案；
- 删除前必须确认，并说明该记录将不再出现在默认列表、余额或统计中，且本次交付没有恢复入口；
- 删除成功后立即从默认 Transactions、recentTransactions、账户余额、资产/负债/净资产、period、trend 和 breakdown 中移除其 effect；
- 如果记录关联 archived Account，“删除记录”不能直接提交成功；UI 应禁用或拦截 action，提示“需要先恢复相关账户，才能删除这条交易”，并提供 `[恢复账户]` 入口。恢复后重新读取记录/版本，删除 action 才可按正常规则重新评估；
- 其他删除失败时保留当前页面和记录，提供版本冲突 reload 或系统重试；
- 不暴露 physical delete，也不为已删除 Transaction 提供 restore action；
- Adjustment 删除不属于本次交付普通删除入口，避免用户在没有专门余额校正理解时误删 reconciliation record。

### 17.5 Empty states

- 没有任何交易：说明“还没有交易记录”，并提供 `+ 记一笔`；
- 有账户但当前筛选结果为空：说明当前筛选没有匹配结果，并提供 `清除筛选`；
- 尚未初始化或没有 Account：遵循第 6 节 gating，先完成 onboarding，不显示交易列表假空态；
- 任何 empty state 都不能显示 mock 交易或假计数。

## 18. Money presentation

用户只接触正常货币金额。`amountMinor` 是 transport/persistence contract，不是用户输入格式。

### 18.1 Display and input

- CNY 输入 `38`，显示为 `¥38.00`；
- JPY 使用 0 位小数，例如 `¥38`，不强行显示 `¥38.00`；
- KWD 使用 3 位小数，例如 `KWD 38.000`；
- 其他 currency 按 shared ISO 4217 exponent 显示；
- 账户、Transaction、Dashboard totals、period、trend 和 breakdown 必须使用同一 baseCurrency 与 exponent；
- 用户永远不需要输入 3800 来表示 ¥38.00，也不应在错误信息中看到 minor-unit 数值；
- 负号只在 opening balance、自然余额或结果语义需要时出现；income/expense/transfer 输入本身不接受负数；
- UI 不提供多币种账户、FX、汇率或客户端自定义小数位。

### 18.2 Sign and liability wording

总资产、总负债、净资产来自 authoritative projection：

```text
totalAssets      = 所有 asset Account currentBalance 的总和
totalLiabilities = 所有 liability Account currentBalance 的总和
netWorth         = totalAssets - totalLiabilities
```

显示时必须保留 projection 的符号和意义。负债账户的正余额通常表示欠款；负数可以表示 credit balance/超过应付的状态，不能静默取绝对值。

## 19. Time / timezone presentation

### 19.1 Ledger timezone 是 authority

- 所有 Transaction 时间以 UTC instant 持久化，但用户输入、显示和 period 边界使用冻结的 Ledger timezone；
- browser timezone 不能偷偷代替 Ledger timezone；
- Ledger timezone 在首个 Account 创建后 immutable；在此之前可按既有 Settings contract 修改；
- 页面应在设置、交易表单或日期辅助文案中让用户知道当前使用的 timezone。

### 19.2 New transaction time

- 新建 Transaction 默认发生时间为打开表单时的“现在”；
- “现在”按 Ledger timezone 展示日期/时间概念，保存的 instant 由真实 Ledger contract 处理；
- 用户可以修改日期和时间；
- occurredAt 不能早于所引用 Account 的 opening date 在 Ledger timezone 下的 opening boundary；
- 太远的未来时间被拒绝时，显示“交易时间不能晚于允许的当前时间范围”之类的用户语言，不显示内部未来容差或 UTC 数值；
- 日期输入必须让用户知道选择的是 Ledger local date，而不是系统浏览器的另一个日期。

### 19.3 Dashboard periods

Today、Week、Month、Year 使用 Ledger timezone 的固定 period：

- 今天：当地日 00:00 到下一日 00:00；
- 本周：周一 00:00 到下一个周一 00:00；
- 本月：当月第一日 00:00 到下月第一日 00:00；
- 今年：当年 1 月 1 日 00:00 到下一年 1 月 1 日 00:00。

边界采用 `[start, end)`：恰好在 start 的交易属于当前 period，恰好在 end 的交易属于下一个 period。趋势使用最近 6 个 calendar months，不能替换成浏览器本地的 rolling 180 days。

## 20. Empty / Loading / Error states

### 20.1 Empty state contract

| 状态 | 主要文案方向 | 主 action |
| --- | --- | --- |
| A. 未初始化 Ledger | “开始设置 Ledger”；说明 baseCurrency/timezone 用途与锁定时机 | `开始设置` |
| B. 已初始化、无 Account | “先创建一个账户，Ledger 才能开始记账”；显示当前 currency/timezone | `创建第一个账户`；可 `修改设置` 或稍后返回 |
| C. 有 Account、无 Transaction | “账户已准备好，还没有交易”；展示真实 opening/current balances | `+ 记一笔` |
| D. 某个筛选结果为空 | “没有符合当前筛选的交易”；说明筛选条件仍生效 | `清除筛选`，同时保留 `+ 记一笔` |

Category selector 的空状态也属于正式 empty state：显示没有可用的收入/支出分类，并提供固定 kind 的 `新建分类`，不只显示“暂无数据”。

### 20.2 Loading

- 初次读取 Settings、Accounts、Categories、Overview 或 Transactions 时显示对应 loading；
- loading 中的数值不以 0 代替，避免把“未知”误读为真实零余额；
- 保存/编辑/删除/归档时只锁定相关 action，明确显示进行中；
- 页面切换或 scope/filter 改变时，旧数据不能被标注为新筛选已确认的数据；
- loading 完成后以 authoritative response 更新；失败后进入 recoverable error，而不是切换到 mock。

### 20.3 Error taxonomy and recovery

| 情况 | 用户可见体验 | 恢复动作 |
| --- | --- | --- |
| 字段校验/金额精度/日期错误 | 字段级、人话提示；保留其他输入 | 修正字段后继续 |
| 初始化失败 | 如果是值的问题指向字段；如果是系统问题说明 Ledger 暂不可用 | 修正、重试或稍后再试 |
| Account 创建失败 | 保留表单；区分名称/类型/余额等输入问题和系统失败 | 修正或重试 |
| Transaction 保存失败 | Sheet 保持打开；不宣称已保存 | 修正、重试或取消 |
| 明确失败（HTTP 400 validation 或 deterministic 409） | 明确告知本次 create 未成功，保留表单并允许修正 | 回到 `DRAFT / ERROR`；下一次正式提交才建立新的 intent 和 key |
| 网络失败/响应超时/连接重置/响应丢失 | 进入 `UNCERTAIN`，提示“无法确认这次操作的结果”，不直接提示“肯定未保存”；canonical payload 暂时只读 | 只能用同一 payload + 同一 Idempotency-Key `[重试确认]` 或 `[重新检查]`；原 intent 确认前不能取消后新建 |
| server 返回 temporary unavailable / `ledger-write-busy` | 明确说明本次请求未成功完成：“Ledger 暂时不可用” | 保留用户输入，允许重试；这与没有收到响应的 `UNCERTAIN` 分开处理 |
| nonzero Account archive | 显示当前余额和归档条件 | 先处理余额、取消操作或稍后再归档 |
| archived Account/Category | 明确该资源已归档，不能用于这次新财务操作 | Account 可从本次交付的账户管理恢复或创建新的 Account；Category 选择 active resource，Category restore 留待后续管理能力 |
| opening date conflict / category kind mismatch / invalid Account pair | 解释哪个选择不兼容 | 选择合法日期、Category 或 Account |
| version conflict | “数据已被其他操作更新，当前页面不是最新” | `重新加载最新数据`；用户重新确认自己的改动，不覆盖他人写入 |
| session expired | 明确 session 已过期 | `重新登录`，登录后返回原 Ledger context |
| unknown internal error | “Ledger 暂时不可用，请稍后再试” | 重试、重新加载或稍后再试 |

所有错误都不得暴露 SQL、stack、SQLite、内部路径、raw response dump、minor units 或 session/cookie 内容。稳定 error code 可以帮助实现映射，但不要求用户理解或直接看到 code。

## 21. Route / naming migration

### 21.1 Canonical product routes

本次 UI Integration 冻结以下用户可见 canonical route：

| 用途 | Canonical route |
| --- | --- |
| Ledger Dashboard | `/ledger` |
| Transactions | `/ledger/transactions` |
| Account management | `/ledger/accounts` |
| Account detail | `/ledger/accounts/:id` |

Ledger API 继续使用已存在的 `/api/ledger/*`；本 PRD 不提出 `/api/bills` 或新的财务语义。

### 21.2 Legacy Bills compatibility

现有 `/bills` 和 `/bills/transactions` 作为临时兼容地址 redirect 到对应的 `/ledger` 和 `/ledger/transactions`。redirect 应尽量保留合法的用户 query context，不应继续渲染一个独立的 Bills 产品页面。

本次 UI Integration 的用户可见产品命名全部使用 **Ledger**：

- page title、Navbar、二级导航、按钮、empty/loading/error、aria label、帮助文案和成功反馈不再使用 Bills；
- “账单”不能作为 Ledger 的产品名称或主要模块名称；
- legacy route、旧测试、旧文件夹或 migration 记录中暂时存在 `Bills` 是技术兼容事实，不是用户可见术语，也不代表新业务逻辑继续使用它；
- 新的产品 copy、帮助文档和入口不得把用户导向 `/bills`。

## 22. Responsive / accessibility requirements

本次 UI Integration 继续 desktop-first，但不允许窄屏成为不可用的记账路径：

- 窄屏可完成选择 type、金额、Account、Category、日期/时间、保存和取消；
- Sheet/Dialog 内容可滚动，主要 action 在用户完成表单时仍可找到；
- `+ 记一笔`、账户管理和保存 action 不因窄屏被隐藏；
- 键盘可以完成主要流程：打开、切换 type、移动到字段、提交、取消；
- Sheet/Dialog 打开后有合理的初始 focus，关闭后 focus 回到触发 action；
- Esc、取消和 dirty-form warning 的行为一致；
- 表单错误关联到对应字段，并能通过键盘和辅助技术理解；
- 颜色不是 income/expense/liability 唯一的信息通道；金额符号、文字或结构必须同时表达含义；
- 图表必须有可理解的文本或可访问替代表达，不能只依靠 SVG、颜色或百分比；
- loading、success、error、empty 都能被辅助技术感知，但不制造重复或含糊的状态播报。

具体 Vue component、focus utility、CSS、响应式断点和 state implementation 属于后续 IP，不在本 PRD 决定。

## 23. Scope

### 23.1 UI Integration in-scope

- Ledger initialization UI；
- baseCurrency / timezone setup 与生命周期说明；
- 两步连续 onboarding；
- first Account creation；
- Account 查看、新增、编辑、archive、restore；即使存在 archived Account history，也允许创建新的 active Account；
- Account detail、当前余额和本月 movement 的可理解呈现；
- Dashboard 与一级 `+ 记一笔`；
- income creation；
- expense creation；
- transfer creation；
- 统一 Transaction creation surface；
- 真实 Category selector；
- Transaction Sheet 内按 kind 固定的 Category quick create；
- real Transactions list、view 与 basic filter；
- ordinary income/expense/transfer 的 edit；包含 archived Account 关联交易的受限字段 UX；
- ordinary income/expense/transfer 的 soft-delete UI；包含 archived Account 关联交易的 restore-before-delete UX；
- Dashboard real-data cutover；
- recent transactions；
- assets / liabilities / net worth；
- today/week/month/year period summaries；
- 真实 category breakdown（重新命名、明确 period、包含金额与可理解表达）；
- 真实近 6 个 calendar-month trend；
- loading、empty、recoverable error、session expired；
- canonical `/ledger`、`/ledger/transactions`、账户 route；
- `/bills` → `/ledger` 兼容 redirect；
- 用户可见命名停止使用 Bills；
- 保存成功后的 authoritative refresh；
- response loss/retry 下的一次意图一次记录体验；
- 任何状态都不使用 mock fallback。

### 23.2 UI Integration scope decisions at a glance

| 决策点 | 本次交付决策 |
| --- | --- |
| 初始化与首个 Account | 一个连续 onboarding，两个明确步骤 |
| Dashboard primary action | `+ 记一笔`；默认打开支出 |
| Transaction types | 新建支持支出、收入、转账；Adjustment 不进入普通新增入口 |
| Category quick create | 支持；创建时 kind 固定为当前收入/支出表单 |
| Full Category Management | 不在本次交付；后续独立需求 |
| Account management entry | Dashboard `管理账户` + `/ledger/accounts`；可进入 Account detail |
| Transaction edit | 进入本次交付；只允许保持原 type 的 ordinary Transaction 编辑；archived Account 关联记录按受限字段矩阵处理 |
| Transaction delete | 进入本次交付；服务端 soft delete，UI 明确不可恢复；archived Account 关联记录必须先恢复账户 |
| Physical Account delete | 不在本次 UI Integration 暴露 |
| Dashboard periods | 四个 period 保留为 secondary summary，移除预算式解释 |
| Category breakdown/trend | 保留真实数据，但降为 secondary、明确 period/语义；具体视觉形式属于 non-blocking visual/content follow-up |
| Empty Ledger shell | 未初始化/无 Account 不显示正常 Dashboard shell；有 Account 无 Transaction 显示真实 shell + empty state |
| Product naming | 只对用户使用 Ledger；Bills 仅限 legacy technical compatibility |

## 24. Non-goals

本次 UI Integration 明确排除以下能力：

- Budget、预算提醒、储蓄目标或财务规划；
- recurring/scheduled transaction；
- bank sync、银行授权、账户聚合或支付平台 token；
- CSV import/export；
- OCR；
- AI auto classification；
- AI finance analysis；
- multi-currency Account；
- FX、汇率或跨币种转账；
- investment pricing、投资组合、股票/基金估值；
- property valuation；
- vehicle depreciation；
- debt payoff planning；
- family/shared Ledger；
- enterprise accounting；
- professional bookkeeping、复杂复式会计科目或专业报表；
- new financial semantics；不得重新定义 natural balance、Transfer、Adjustment、Account lifecycle、Category lifecycle、Overview、amount representation 或 idempotency；
- Adjustment 创建、专门余额校正工作流或 Adjustment restore；已有 Adjustment 的真实读取/解释仍服从上位 contract；
- full Category Management（rename、archive、restore、physical delete、hierarchy）；本次交付只有默认/真实 selector 与 contextual quick create；
- physical Account delete；
- Transaction restore；Transaction delete 在本次交付是不可恢复的 soft-delete UI；
- 把 Transaction type 改成另一种 type 的编辑；
- free-text search、保存筛选、复杂报表或导入；
- 完整 mobile redesign；本次交付只要求窄屏可完成核心记账和可访问交互；
- 任何 Vue 文件组织、composable/state library、API client 文件名、fetch strategy、CSS、SQL、migration、test file name 或 commit sequence 的决定。

## 25. Acceptance criteria

### 25.1 Onboarding and initialization

1. 未初始化 owner 进入 `/ledger` 时看不到 mock Dashboard；可以明确选择 baseCurrency 和 timezone，并必须主动点击确认。
2. 浏览器 timezone 只能作为可见预选；baseCurrency 不由浏览器 locale 静默决定。
3. 初始化成功后进入第一个 Account 步骤；直接访问其他 Ledger route 也不会绕过无 Account gating。
4. 初始化后 `settings.hasCreatedAccount=false` 且没有 Account 时，不显示正常的全 0 Dashboard；用户每次都能找到创建第一个 Account 的 CTA。`settings.hasCreatedAccount=true` 且当前没有 active Account 时，进入 `NO_ACTIVE_ACCOUNT`，不能误称为创建第一个账户。
5. 首个 Account 创建前，Step 2 始终提供 `[修改 Ledger 设置]` 返回入口；修改成功后重新进入 Step 2；首个 Account 创建成功后，用户进入真实 Dashboard，且 baseCurrency/timezone 的 lock 行为与 Accepted L0 contract 一致。

### 25.2 Accounts

6. owner 可以创建 cash、bank、wallet、credit_card、loan、other Account，并看到易懂的 asset/liability 解释。
7. owner 可以填写/跳过 opening balance、选择 opening date、查看继承的 currency，并在成功后看到 authoritative current balance。
8. owner 可以从 Dashboard 和 `/ledger/accounts` 查看 active Account，编辑允许的字段，archive 零余额 Account，并恢复已归档 Account；NO_ACTIVE_ACCOUNT 时既可以恢复旧 Account，也可以创建新的 active Account。
9. 非零 Account archive 被阻止时，页面显示当前余额和可恢复方向，而不是隐藏账户或泛化为无意义的失败。
10. 本次 UI Integration 不提供 physical Account delete。

### 25.3 Transactions and categories

11. `+ 记一笔` 在有 active Account 时可用，默认打开 expense，并可切换 income/transfer。
12. expense/income 只显示对应 kind 的 active Category；transfer 不显示 Category 或 payee。
13. owner 可以在 Transaction Sheet 中按当前 kind 快速创建真实 Category，创建成功后可直接选用；失败/重复时不静默创建或恢复。
14. owner 可以创建真实收入、支出和转账；transfer 只形成一次 Transaction，不计入 income/expense。
15. owner 可以查看真实 Transactions、按类型/Account/Category/日期范围做 basic filter，并理解 empty state；Account 和 Category 历史筛选同时支持 active 与 archived entities，并明确标记归档状态。
16. owner 可以查看和编辑 ordinary income/expense/transfer；编辑不得改变 type；关联 archived Account 时，income/expense 只可编辑 payee/note，transfer 只可编辑 note，其余 financial fields 只读。
17. owner 可以确认并 soft-delete ordinary Transaction；删除后无恢复入口，所有相关 projection 立即变化；关联 archived Account 时 UI 先阻止删除并引导恢复账户。
18. Adjustment（如存在）在“全部”列表中可解释显示，但不会伪装成普通 income/expense/transfer，也没有本次交付普通创建/编辑入口。

### 25.4 Dashboard and projection

19. Dashboard 的 asset、liability、net worth、Account balances、cashflow、periods、trend、category breakdown 和 recent transactions 都来自真实 Ledger 数据。
20. Dashboard 默认以本月为 cashflow/category scope；scope 切换不改变当前资产/负债/净资产、固定 period、trend 或 recent list 的合同语义。
21. 四个 period summary 使用 Ledger timezone、Monday week boundary 和 half-open interval；不会显示预算判断。
22. 最近交易默认为最近 5 条 active records；新增、编辑、删除或刷新后立即更新。
23. Dashboard 保留真实 category breakdown/trend，但不再呈现没有 period 语境的 mock donut 或预算式原型状态。

### 25.5 Money, time, state and safety

24. CNY、JPY、KWD 等不同 exponent currency 的输入和显示正确；用户永远不接触 minor units。
25. 新 Transaction 默认是 Ledger timezone 下的现在；用户可以修改日期/时间；period 不使用 browser timezone。
26. loading、uninitialized、`FIRST_ACCOUNT_REQUIRED`、`NO_ACTIVE_ACCOUNT`、no-transaction、filter-empty、recoverable error、session expired 都有对应的用户下一步。
27. 所有 create mutation 都有 DRAFT/SUBMITTING/CONFIRMED/UNCERTAIN 等价状态；明确收到的 HTTP 400、deterministic 409 或 503 `ledger-write-busy` 不进入 UNCERTAIN，网络超时或响应丢失才进入 UNCERTAIN；UNCERTAIN 中用户不能直接修改 canonical payload 或换 key，只能用同一 payload + 同一 key 重试/检查；最终同一记账意图只产生一笔 Transaction，页面不会靠 mock 或未经确认的本地余额冒充成功。
28. version conflict 要求重新加载/重新确认，不能覆盖其他 owner 写入；未知错误不暴露 SQL、stack、SQLite 或内部路径。

### 25.6 Route and naming

29. `/ledger` 和 `/ledger/transactions` 是 canonical product route；`/bills` 与 `/bills/transactions` 只做兼容 redirect。
30. 新的用户可见标题、按钮、帮助、错误、empty state、aria label 和成功反馈使用 Ledger，不使用 Bills。
31. 页面刷新后真实数据仍存在，且任何 route/state 都不 fallback 到 `billsMockData`。

## 26. User acceptance scenarios

### 26.1 Baseline：新用户完成首次真实记账

前提：owner 已登录；Ledger 尚未初始化；当前时间在 `Asia/Shanghai`。

```text
进入 /ledger
  → Ledger 未初始化，看到设置页面而不是 mock Dashboard
  → 选择 Base Currency: CNY
  → 选择 Timezone: Asia/Shanghai
  → 用户明确点击继续
  → 进入“创建第一个账户”步骤
  → 创建账户：
       名称：招商银行
       类型：银行账户
       性质：我拥有的钱（asset）
       期初余额：¥10,000.00
       起始日期：当前 Ledger local date
       币种：CNY（继承且只读）
       备注：可选
  → 创建成功，进入真实 Dashboard
  → 点击 + 记一笔
  → 默认打开支出；选择/确认：
       金额：¥38.00
       账户：招商银行
       分类：餐饮（expense Category）
       时间：当前 Ledger timezone 时间
       交易对象/备注：可选
  → 保存
```

验收结果：

- 只创建一笔 expense Transaction；没有为一次支出创建第二笔反向记录；
- recent transactions 立即出现 `¥38.00` 的真实支出；
- 招商银行 authoritative current balance 变为 `¥9,962.00`；
- 总资产变为 `¥9,962.00`，总负债为 `¥0.00`，净资产相应变为 `¥9,962.00`；
- Today / Week / Month / Year 中适用的 expense 增加 `¥38.00`，income 不被错误增加，结余相应减少；
- 适用的 category breakdown、trend 和最近交易立即反映真实结果；
- 页面不要求手工刷新；
- 刷新 `/ledger` 后记录和余额仍存在；
- 页面中不出现 mock 交易、mock 账户、演示计数或 `billsMockData` 结果；
- 用户可从 Dashboard 进入 `/ledger/transactions` 查看该记录。

### 26.2 Baseline：响应丢失后的安全重试

前提：owner 已完成初始化并有 active Account，正在创建一笔 `¥38.00` expense。

1. 用户点击保存，网络响应丢失；
2. 页面提示结果尚未确认，保留本次输入并提供重试/检查结果；
3. 用户重试相同记账意图；
4. 系统最终只显示一笔对应 Transaction，余额和 Dashboard 只应用一次 `¥38.00` effect。

## 27. Open questions

以下问题不阻塞本 PRD 的核心产品合同，作为 Accepted 后的 non-blocking visual/content/release follow-up：

1. `/bills` 兼容 redirect 的最终退休时间和旧链接通知策略；在此之前 redirect 规则保持不变。
2. “分类收支”与真实 trend 的最终视觉表达（列表、条形、图表组合）及其视觉密度；金额、period、可访问文本和 scope 语义已经冻结。
3. Account type 的最终中文短标签和辅助说明是否需要按 locale 微调；type/nature 映射不能改变。
4. 后续是否单独提出 full Category Management、Adjustment UI 或 free-text search；本轮已经明确它们不属于本次交付，不得由 IP 顺手加入。

这些问题不允许被 implementation 以默认值悄悄决定为新的财务或生命周期语义；它们也不阻塞本 PRD 的 Accepted 状态。

## 28. Product risks

| 风险 | 影响 | 本次交付缓解方向 |
| --- | --- | --- |
| 用户仍看到 Bills/mock 遗留 | 用户无法判断哪些数据是真的 | canonical route、visible naming 和 no-mock fallback 同时作为验收条件 |
| `FIRST_ACCOUNT_REQUIRED` 全 0 页面缺少下一步 | 新用户无法开始记账 | 使用 dedicated onboarding empty state，不显示正常 Dashboard shell |
| baseCurrency/timezone 锁定让用户意外 | 首个 Account 后修改受限 | 初始化时解释用途和锁定时机；要求主动确认 |
| liability/natural balance 难理解 | 信用卡消费、还款和净资产被误读 | 使用“我欠的钱/减少欠款”等文案，同时保留真实 projection sign |
| 记账表单字段过多 | 高频记账变慢 | 默认 expense、单一 Sheet、只要求类型所需字段，payee/note optional |
| 快速新增分类产生重复或错误 kind | breakdown 不一致 | 当前 kind 固定、真实 Category create、duplicate/archived identity 明确报错 |
| 网络响应丢失造成重复交易 | 财务事实被重复计入 | 用户层保证一次意图一次记录，提供安全 retry/result confirmation |
| 编辑/删除改变多个 projection | 用户认为页面未同步 | 成功后立即反映 authoritative Account、Overview、list、trend、breakdown |
| timezone/DST 边界导致日期错位 | Today/Week/Month/Year 与用户感受不一致 | 所有输入和 period 文案以 Ledger timezone 为准，使用明确 local date/time |
| 窄屏或键盘无法完成 Sheet | desktop-first 变成实际不可用 | 把窄屏完成核心流程、focus、键盘和错误可理解性列为 acceptance criteria |
| 删除不可恢复造成误操作 | 历史记录被意外移出 projection | 二次确认、明确 warning、本次交付不提供 restore；archived Account 先恢复再删除；type 改错需重新创建正确记录 |

## 29. Review gate

本 PRD 的最终状态为：

> **Product Review: Accepted**

Product Review closure：2026-09-05（Asia/Shanghai）；review baseline：`5724e66e78905f3d0518f723eb7c23f2a1e3d360`；review result：**PASS / Accepted**。

本次已关闭并冻结以下产品决定：

- 初始化与首个 Account 是两步连续 onboarding；
- baseCurrency 不自动决定，browser timezone 只能作为可见预选，两个值都必须主动确认；
- Dashboard 的一级 action 是 `+ 记一笔`，默认类型是支出；
- Transaction Sheet 支持支出、收入、转账切换，Transfer 没有 Category；
- 本次交付支持 contextual Category quick create，但不包含 full Category Management；
- Account management 从 Dashboard 和 `/ledger/accounts` 进入，支持新增、查看、编辑、archive、restore，不暴露 physical delete；NO_ACTIVE_ACCOUNT 可恢复旧账户或创建新账户；
- 本次交付支持 ordinary income/expense/transfer 的 edit 和不可恢复 soft-delete，并冻结 archived Account 关联交易的受限字段与 restore-before-delete 行为；
- Dashboard 保留真实 period summary、category breakdown、trend 和 recent transactions，但以资产/负债/净资产、账户和近期行为为优先，并移除预算式 prototype 表达；
- `/ledger`、`/ledger/transactions` 是 canonical route；Bills 只保留兼容 redirect，不再是用户可见产品术语；
- 所有 loading、empty、error、session expired 和 response-loss retry 都是正式体验；没有 mock fallback。

Product Review 结果为 PASS，当前没有 P0/P1 Product Contract Conflict。`hasCreatedAccount` 的 browser-visible projection 是实现这个已接受生命周期行为的最小前置，不改变产品决定；具体计划和 server/shared DTO addition 记录在 `docs/design/ledger-ui-integration-implementation-plan.md`。Implementation Plan 是独立的 implementation review artifact；PRD Accepted 本身不替代 implementation review 或编码前 then-current `main` re-audit。
