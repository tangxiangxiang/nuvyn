# AI Settings 多配置管理：实现与验证报告

日期：2026-10-29。当前基线：`f9a6d46`（包含新合入的 PWA 主线提交）。

实现、测试和文档已完成；完整浏览器回归仍有一项 Slash Commands 文本竞态，WebKit 验证受原生进程崩溃阻断，不能将本次结果描述为全量测试通过。本次 AI 改动未提交、推送、发布或部署。

## 1. 原架构审计

原设置按 `ai.active.provider` 选择 Anthropic / OpenAI 槽位，每种协议只有一套 Key、URL、Model。凭据使用现有 AES-256-GCM，主密钥依次来自 `NUVYN_MASTER_KEY`、`NUVYN_MASTER_KEY_FILE`、外部 `data/.nuvyn-master-key`；历史库还可能有 `ai.encryption.key` 或明文旧格式。

`getAiRuntimeConfig()` 是各 AI 功能的配置入口。原 Chat Backend 只按协议缓存适配器，但每个工具轮次会重新读取配置，因此需要将请求的协议、模型、端点和凭据一起固定。会话和消息使用独立表，本次不改变其格式。

## 2. 新数据结构与导入

- Migration `0039_ai_profiles.sql` 新增专用 `ai_profiles` 表，使用稳定 ID、名称、协议、加密凭据、URL、模型和毫秒时间戳。
- 新建 Profile 使用 UUID；旧槽位使用幂等的 `legacy-anthropic` / `legacy-openai` 身份。名称和模型均不是主键。
- `ai.active.profileId` 保存唯一默认 ID，空值表示没有默认配置。新增和选中编辑都不会自动改变默认项。
- Schema migration 不操作主密钥；`getDb()` 在初始化时单独执行事务性旧数据导入，并记录 `ai.profiles.imported.v1`。
- 仅有模型或 URL 的旧槽位也会保留。原活动协议没有对应配置时，不会偷偷激活另一个协议。
- 现代 AES 密文原样复制。需要转换的历史格式先用原解密链路验证所有凭据，再加密 Profile 副本；不会把密文当明文二次加密。
- 原 Provider KV 记录保留为升级恢复数据。导入完成后，Profile 是唯一运行时权威，不进行正常双写，重启不会重新导入过期槽位。
- 数据导入失败时，Profile 行、默认 ID 和完成标记一起回滚。普通 GET 不反复尝试失败的转换；恢复原主密钥后可显式重试迁移。

现代密文缺少或不匹配主密钥时，仍能查看 Profile 元数据、固定掩码和安全错误码。不能使用的默认配置不会回退到其它 Profile。明确清除仅针对选定凭据；不会自动清空其它配置或生成替代主密钥。

隔离测试覆盖空库、单协议、双协议、部分字段、两种旧默认、现代/历史加密、明文旧格式、缺失/错误/不可读主密钥、导入故障回滚、重复导入、SQLite 重开和新旧记录共存。另使用真实 v38 文件数据库和容器重启验证导入与旧会话保留。

## 3. API 与兼容边界

| API | 行为 |
| --- | --- |
| `GET /api/ai/profiles` | 列表、默认 ID、掩码和凭据错误元数据；不返回明文或密文 |
| `POST /api/ai/profiles` | 创建独立配置，不自动激活 |
| `PATCH /api/ai/profiles/:id` | 按 ID 修改；省略或空 Key 保留原值，`clearKey: true` 明确清除 |
| `DELETE /api/ai/profiles/:id` | 删除非默认项；默认项须先替换或显式 `disableDefault: true` |
| `PUT /api/ai/profiles/:id/activate` | 事务切换默认；校验目标存在、保存了 Key 且能解密 |
| `POST /api/ai/profiles/:id/test-connection` | 测试该 Profile 和未保存表单，不保存或激活 |
| `POST /api/ai/profiles/test-connection` | 测试尚未保存的新配置 |
| `POST /api/ai/profiles/retry-migration` | 恢复主密钥后，显式重试历史凭据导入 |

切换协议并保留旧 Key 必须确认，或提供新凭据；测试连接同样执行此保护。测试复用现有 `probeAiConnection()`，不会读取其它 Profile 的 Key。超时、认证、模型和 Tool Calling 错误分类保持可用，上游 Key 被脱敏。

旧 Settings GET 返回默认 Profile 的兼容视图，credential-status 仍可在无主密钥时返回存储状态。旧写入/测试出现同协议多配置歧义时返回 409，写入前拒绝，不选择随机配置。旧 PUT 保留已定义的兼容语义；新 UI 只使用 Profile API。所有接口继续受现有 Owner Session 保护。

## 4. Runtime 与 UI

Chat 在开始时取得配置快照，所有工具轮次和压缩请求复用该快照。Title、Summary、Tags、Slug、Commit Message 同样将已解析的快照传给 `generateText()`。默认项中途改变或删除，影响后续请求，不混用本次请求的 Key、URL、模型或协议。协议适配器缓存不保存 Profile 凭据或端点。

设置页沿用 Settings Card，提供紧凑列表、名称、协议、密码字段、URL、模型、保存、连接测试、默认和删除。支持同协议多配置、中英文、默认/选中标识和空状态。未保存修改在切换 Profile、切换设置栏目、关闭和删除时确认；保存失败保留表单。切换不会携带输入的 Key，迟到的探测结果不会覆盖新 Profile；卸载会取消请求、探测及自己的确认框。

NSelect 保留 `to=".settings-backdrop"`；真实鼠标点击、方向键、Enter、Escape 优先关闭菜单、Tab Focus Trap 和模拟平板触摸均有 Chromium 覆盖。没有新增设置一级导航、每篇 Note 模型选择器或 Chat 实现。

## 5. 实际验证

| 命令/任务 | 最终结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过；有既有依赖注解/体积提示 |
| `npm test` 中 Unit | 362 个文件；5441 通过、9 个既有跳过、0 失败 |
| `npm test` 中 History Integration | 185 通过、0 失败 |
| `npm test` 中 Recovery Integration | 198 通过、0 失败 |
| `npm run test:tags-scale` | 6 通过、0 失败 |
| Application Chromium：现有 cross-platform 配置 | 354 通过、1 失败、7 个既有跳过；总计 362 |
| 其中 AI Profile E2E | 4 通过，包括模拟平板触摸 |
| `npm run test:e2e:auth` | 2 通过 |
| WebKit：现有兼容性配置中的 Settings AI | 4 失败；打开 Settings 时 WebKit 原生进程崩溃，不能记为通过 |
| Docker Authentication Smoke | 通过（当前代码的本地缓存 Runtime 测试镜像） |
| Docker Vault Writer Lifecycle Smoke | 通过（同一隔离镜像） |
| Docker v38 升级专项 | 通过：两套旧凭据、原默认、第三套同协议配置、空 Key 保留、切换、重启、旧会话、删除保护、禁用默认、原 KV 保留、日志无 Key |
| `git diff --check` | 通过 |

认证测试更新了设置页实际请求路径；在真实会话撤销后先捕获服务端 401 正文再交给浏览器，避免重定向清除 Chromium 网络正文。保留真实 401、错误码、登录和草稿恢复断言。

新增 schema 后，相关迁移测试只将最新版本断言从 38 同步为 39；没有改变 Ledger、Diary、Board、Tags 的业务断言。

### 未通过与环境边界

1. **Application 未全绿。** Slash Commands 的 Tab 占位符用例预期 `Changed second`，实际出现 `ChangedSecond`；本次没有修改 Slash/Monaco 实现或该用例的断言。原主线首轮窄测 8/8 通过，当前代码窄测 7/8 通过；进一步在未修改主线执行 32 次有界对照得到 28 通过、4 失败，同样出现 `Changedsecond` / `ChangedSecond` 等丢空格或合并文本。已确认主线也有此间歇性失败，内部根因仍待专门定位。本次不修改 Slash 功能、不删断言、不提高 retries，保留完整回归失败记录。
2. **WebKit。** 系统崩溃报告为 `SIGABRT`，栈包含 `WebCore::Style::Color::resolvedColor` / `toStyleColor(ColorMix)`。在独立目录运行未修改主线也复现打开 Settings 时的相同崩溃；没有为了此任务重写全局样式或跳过用例。真实 Safari / iPad 尚未验收。
3. **标准 Docker 从零构建未完成。** 现有阿里云源发生连接失败，临时改官方源后又发生 HTTP 500 / EOF。没有修改仓库 Dockerfile。为继续 Runtime 验证，核对本地缓存 Runtime 的生产依赖与 lockfile，补齐唯一缺失的锁定纯 JS 包 Saxe 0.8.0，复制当前构建和源码得到隔离镜像。Runtime Smoke 通过不等于标准 Docker 构建已通过。
4. 所有测试使用隔离数据库、Vault 和测试 Key，没有调用真实收费模型，也没有验证真实 MiniMax / Agnes 账户连通性。

## 6. 生产升级与回滚

升级前一致备份完整 SQLite 数据卷（含 WAL/SHM）、完整 Vault（含 `.git`、隐藏状态），以及匹配的外部主密钥或主密钥文件。先在隔离副本验证，不直接试验 NAS 数据。

升级后人工确认原配置的协议、URL、模型、默认项和连接，检查旧对话；新增同协议配置后确认原默认保持不变，再显式切换。

旧镜像不理解新增的多 Profile，并可能读取保留的过期 KV。不能把切换 Docker Tag 当成可靠回滚。应恢复同一升级前时间点的 SQLite、Vault 和主密钥备份，再使用兼容旧镜像。本任务没有部署、修改生产 `.env`、连接 NAS 或重启生产容器。

## 7. 修改文件清单

- `docs/architecture/ai.md`：更新 Profile 架构、使用说明或安全升级/回滚说明。
- `docs/deployment/docker-release.md`：更新 Profile 架构、使用说明或安全升级/回滚说明。
- `docs/deployment/security.md`：更新 Profile 架构、使用说明或安全升级/回滚说明。
- `docs/design/ai-profiles-implementation.md`：本实现、验证、限制和文件清单报告。
- `docs/user-guide/ai.md`：更新 Profile 架构、使用说明或安全升级/回滚说明。
- `e2e/auth-browser.spec.ts`：真实菜单/CRUD/触摸验证或新请求路径的认证回归。
- `e2e/settings-ai.spec.ts`：真实菜单/CRUD/触摸验证或新请求路径的认证回归。
- `playwright.pdf-compat.config.ts`：让 Settings AI 使用现有 Chromium/WebKit 兼容性设施。
- `server/__tests__/ai-profile-routes.test.ts`：迁移、安全、兼容、运行时快照或 Settings 交互回归测试。
- `server/__tests__/ai-profile-runtime.test.ts`：迁移、安全、兼容、运行时快照或 Settings 交互回归测试。
- `server/__tests__/ai-profiles.test.ts`：迁移、安全、兼容、运行时快照或 Settings 交互回归测试。
- `server/__tests__/ai-routes.test.ts`：迁移、安全、兼容、运行时快照或 Settings 交互回归测试。
- `server/__tests__/ai-settings.test.ts`：迁移、安全、兼容、运行时快照或 Settings 交互回归测试。
- `server/__tests__/auth.migration.test.ts`：仅同步最新 Schema 版本断言为 39，保留业务断言。
- `server/__tests__/crashRecovery.test.ts`：仅同步最新 Schema 版本断言为 39，保留业务断言。
- `server/__tests__/ledger-migration.test.ts`：仅同步最新 Schema 版本断言为 39，保留业务断言。
- `server/__tests__/ledger-persistence.test.ts`：仅同步最新 Schema 版本断言为 39，保留业务断言。
- `server/__tests__/openai-http.test.ts`：迁移、安全、兼容、运行时快照或 Settings 交互回归测试。
- `server/__tests__/tagManagement.scale.test.ts`：仅同步最新 Schema 版本断言为 39，保留业务断言。
- `server/__tests__/tagUndoFoundation.test.ts`：仅同步最新 Schema 版本断言为 39，保留业务断言。
- `server/ai/chat.ts`：透传本次请求的完整配置快照。
- `server/ai/commitMessage.ts`：透传本次请求的完整配置快照。
- `server/ai/compaction.ts`：透传本次请求的完整配置快照。
- `server/ai/llm.ts`：透传本次请求的完整配置快照。
- `server/ai/profileRoutes.ts`：Profile API、校验、脱敏和连接测试。
- `server/ai/profiles.ts`：事务导入、CRUD、恢复、唯一默认、凭据隔离和兼容桥接。
- `server/ai/routes.ts`：挂载 Profile API、拒绝旧接口歧义、捕获 Chat 快照。
- `server/ai/settings.ts`：复用旧解密链路并将 Runtime/兼容视图指向 Profile。
- `server/ai/slug.ts`：透传本次请求的完整配置快照。
- `server/ai/summary.ts`：透传本次请求的完整配置快照。
- `server/ai/tags.ts`：透传本次请求的完整配置快照。
- `server/ai/title.ts`：透传本次请求的完整配置快照。
- `server/board/materialApi.test.ts`：仅同步最新 Schema 版本断言为 39，保留业务断言。
- `server/db.ts`：显式初始化导入，凭据异常不阻断恢复界面。
- `server/migrations/0039_ai_profiles.sql`：新增 Profile Schema，不在 SQL 中转换凭据。
- `shared/aiProfiles.ts`：共享 Profile 和输入/列表协议。
- `src/components/vault/SettingsAiSection.vue`：Profile 列表、详情、确认、探测与请求生命周期。
- `src/components/vault/SettingsModal.vue`：承载 Profile 页面并接入离开保护，保留其它设置栏目。
- `src/components/vault/__tests__/SettingsModal.test.ts`：迁移、安全、兼容、运行时快照或 Settings 交互回归测试。
- `src/composables/useI18n.ts`：中英文 Profile 文案及协议标签。
- `src/lib/ai-api.ts`：Profile 客户端 API 与共享类型。
- `src/style.css`：仅增加 Settings Profile 列表与操作布局样式。
