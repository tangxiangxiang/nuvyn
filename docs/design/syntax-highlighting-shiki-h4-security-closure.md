# Nuvyn Shiki H4 — Style-to-Class & Security Closure

本记录是 SHIKI-H4 的实现与验证证据。H4 只关闭 Shiki token 的
style-to-class 和安全边界，不包含 H5 主题 selector、H6 PDF token palette
或 H7 highlight.js cleanup。

## 1. Phase metadata

| 项目 | 内容 |
| --- | --- |
| Phase | SHIKI-H4 — Style-to-Class & Security Closure |
| H4 base / H3 completion | `070f6dec544dab957e277b816d7b4cc5a53da820` |
| Implementation baseline | `2be6b2c57b5d7cb76b359220f361bacb55661099` |
| H3 completion commit | `070f6dec544dab957e277b816d7b4cc5a53da820` |
| H4 completion commit | `e302c55791f779aead8bfa45ce9a9733245796d8` |
| Runtime | Node `v24.15.0`, npm `11.12.1`; Docker baseline remains `node:22-bookworm-slim` |
| Status | H4 COMPLETE; H5/H6/H7 NOT STARTED |

## 2. H3 → H4 renderer delta

H3 已经把 normal Markdown fence 的 HTML 生成切换到同步 Shiki
`codeToHtml()`，但生产调用尚未传入 `transformerStyleToClass`。H4 增加了两条
受控边界：

```text
ready Shiki runtime
    ↓
codeToHtml(..., transformers: [one shared styleTransformer])
    ↓
class-based Shiki HTML
    ↓
complete transformer.getCSS() snapshot
    ↓
document.head style#nuvyn-shiki-generated-styles
    ↓
DOMPurify with FORBID_ATTR: ['style'] unchanged
    ↓
sanitized article HTML
```

`src/lib/markdown.ts` 在完整同步 `md.render()` 返回后调用
`syncGeneratedShikiStylesheet()`，再将同一份 article HTML 交给
`sanitizeMarkdownHtml()`。generated stylesheet 不会进入 article HTML，也不会
经过 Markdown 的 `v-html` surface。

## 3. Transformer lifecycle

`src/lib/shiki.ts` module scope 只创建一个：

```text
transformerStyleToClass({ classPrefix: 'nuvyn-shiki-' })
```

生产 `highlightShikiFence()` 将这个相同的对象传入每次 Shiki
`codeToHtml()`。没有 per-fence、per-document、per-language 或 per-component
transformer。H4 没有改变 H1/H2 的 highlighter singleton、language registry、
single-flight load 或失败语义。

稳定合同：

| 项目 | 已验证合同 |
| --- | --- |
| Transformer instance count | 1 |
| Class prefix | `nuvyn-shiki-` |
| Production transformer active | YES |
| Transformer output | class-based；不依赖 article inline style |
| Token CSS source | 仅 `styleTransformer.getCSS()` 的 Shiki theme snapshot |

## 4. Sanitized HTML contract

Known language fence 在 sanitizer 前后都保留结构性 class：

```html
<pre class="shiki ... nuvyn-shiki-..."><code>
  <span class="line"><span class="nuvyn-shiki-...">token</span></span>
</code></pre>
```

H4 断言：

- `pre.shiki`、`code`、`span.line` 和至少一个 `nuvyn-shiki-*` class 存在；
- sanitized article 内 `style` attribute 数量为 0；
- sanitized article 内不存在 generated `style` element；
- 不依赖精确 hash suffix，只依赖固定 class prefix；
- unknown、empty、grammar unavailable 和 `codeToHtml()` failure 仍使用 H3 的
  escaped `pre.shiki.nuvyn-shiki-plain` fallback。

## 5. Generated CSS trust boundary

不可信输入仍然包括 Markdown source、raw HTML、fence source、fence info、
WikiLink resolver 结果和 document content。它们只能影响 Shiki 的 HTML token
内容，不能直接成为 CSS text 或 Nuvyn class name。

可信输入只有：

- Shiki bundled `github-light` / `github-dark` theme definitions；
- `transformerStyleToClass` 根据这些 theme token style 生成的 CSS snapshot；
- Nuvyn 自己管理的 stylesheet element。

`syncGeneratedShikiStylesheet()` 只写 `getGeneratedShikiCss()` 的完整返回值，
不拼接 Markdown、source、language、meta 或用户文本。用户 source sentinel
在 article text 中可见，但不会出现在 generated CSS。

## 6. Stylesheet owner lifecycle

唯一 owner：

```text
document.head
└── style#nuvyn-shiki-generated-styles
```

实现细节：

- lookup 限定在 `document.head`，并要求匹配 `style#...`；
- owner 不在 article、不在 sanitized HTML，也不写入 body；
- CSS 为空时不创建空 style owner；
- 首次合法 Shiki output 创建 owner；
- 后续 render 复用同一 DOM element；
- test reset 只移除这个 `document.head` 下的受控 owner，并清空 transformer
  registry，不清理其他 style；
- production render 不会在每次 render 后删除 owner。

## 7. Snapshot / dedupe behavior

每次完整 `md.render()` 后只同步一次 CSS。同步使用：

```text
transformer.getCSS()
    ↓
existing owner.textContent !== snapshot ? replace full textContent : no write
```

因此：

- 不按 fence 创建 style；
- 不 append 新 CSS，避免重复规则；
- 新语言产生新 token class 时，仍使用同一 owner 替换完整 snapshot；
- snapshot 未变化时，owner identity 和 text 保持不变；
- repeated、different-language 和 concurrent render 都只留下一个 owner。

## 8. No-document / incomplete-DOM behavior

当 `document` 不存在、`document.head` 不可用，或 head DOM 写操作失败时，
stylesheet sync 是 best-effort no-op。Shiki HTML 仍按 H3 规则生成，CSS
snapshot 仍可由 `getGeneratedShikiCss()` 读取，Markdown render 不会因为缺少
DOM stylesheet 而失败。

该保护只包住 stylesheet synchronization；不会 catch 或转换：

- highlighter/runtime initialization failure；
- known grammar load failure；
- 单个 `codeToHtml()` failure。

这些错误仍保持 H2/H3 的 reject 或 per-fence plain fallback 语义。

## 9. Concurrency behavior

不同 render 的异步 language preflight 可以交错，但实际 MarkdownIt
`md.render()` 和 Shiki callback 是同步执行的。H4 使用同一 highlighter、同一
transformer 和同一 stylesheet owner；每个完整 render 结束后写入完整
`transformer.getCSS()` snapshot。

当前回归覆盖 `Promise.all([render(js), render(python), render(java)])`：

- 三份结果都保留 class-based Shiki HTML；
- owner count 为 1；
- owner text 与当前完整 `getGeneratedShikiCss()` 相等；
- 没有第二个 transformer 或 global render mutex。

## 10. Raw Markdown security regressions

DOMPurify 配置未改变，尤其是：

```ts
FORBID_ATTR: ['style']
```

H4 组合回归同时放入 Shiki code fence 和 author HTML，证明：

| 输入 | sanitized article 结果 |
| --- | --- |
| `<span style="...">` | `style` removed |
| `onclick` / `onerror` | removed |
| `javascript:` href | blocked；不可执行 href |
| `<script>` / `<style>` | tag removed |
| code 中的 HTML/script/style/event-looking text | escaped code text |
| Shiki token classes | retained |
| Shiki generated CSS | retained only in trusted head owner |

没有为 Shiki 扩大 `ALLOWED_ATTR`，没有允许 Markdown `style`，也没有修改 URI
policy、hooks 或 `FORBID_TAGS`。

## 11. Code-source isolation

单测和 browser test 都使用唯一 source sentinel，以及类似以下的 code text：

```text
NUVYN_H4_USER_SOURCE_SENTINEL_7f3a
NUVYN_H4_BROWSER_SOURCE_SENTINEL_83c1
</style> body { display:none }
--evil: red
.nuvyn-shiki-hijack {}
```

结论：

- sentinel 保留为 article code text；
- generated CSS 不包含 sentinel 或 raw CSS-looking source；
- generated class 名只匹配 `nuvyn-shiki-*`，不包含 source 或 raw info metadata；
- article 返回 HTML 不包含 `nuvyn-shiki-generated-styles`。

## 12. Browser-path evidence

新增 `e2e/markdown-shiki-security.spec.ts`，使用现有
`/__markdown-test` Playwright/Vite 启动路径，并在真实 browser 中动态调用
生产 `src/lib/markdown.ts` render seam。它验证：

- `pre.shiki`、`span.line` 和 `nuvyn-shiki-*` class 存在；
- article 没有 style attributes、author event handlers、script/style tags 或
  managed style owner；
- `style#nuvyn-shiki-generated-styles` 恰好一个，parent 是 `document.head`；
- owner CSS 含 Shiki class/dual-theme variables，但不含 browser source sentinel；
- author style/event 不会执行，`window.__nuvynH4Pwned` 保持 undefined。

browser test 覆盖 head/article security boundary；重复 render 的 owner identity
和 full snapshot replacement 由 jsdom unit tests 覆盖，避免在 E2E 中引入不必要的
fixture 编辑。H4 不断言最终可见 light/dark token color；那属于 H5。

## 13. Markdown / MarkMap / Mermaid regressions

H4 focused tests 保持：

- runtime initialization failure 仍 reject 并可 retry；
- grammar load failure 仍只让对应 fence 使用 plain fallback；
- unknown、empty、no-fence 不初始化 Shiki；
- MarkMap exact `markmap` 和 Mermaid exact `mermaid` 仍先于 Shiki；
- placeholder class、`data-content` 和 mount lifecycle 未修改；
- isolated discovery env、resolver call count 和 concurrent resolver isolation 未修改；
- H3 的 known language、alias、HTML escaping、codeToHtml failure regressions 继续通过。

## 14. Build / bundle evidence

Evidence commands：

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/shiki.test.ts \
  src/lib/__tests__/markdown.test.ts \
  src/lib/__tests__/markmapSecurity.test.ts
npm run typecheck
npm run build
```

实际结果：

| Command / evidence | Result |
| --- | --- |
| H4 focused Shiki/Markdown/MarkMap | PASS — 3 files / 82 tests |
| Extended Markdown surface, PDF readiness, Mermaid/MarkMap regressions | PASS — 9 files / 148 tests |
| H4 browser security | PASS — 1 Chromium test |
| Markdown visual light/dark | PASS — 2 tests |
| PDF export/layout/pagination regression | PASS — 4 tests |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — 3,929 modules transformed |
| `npm run test:unit` | FAIL — 3 files / 21 tests failed; 3,095 passed / 2 skipped |

Full unit 的 21 个失败仍是既有环境限制：`server/__tests__/openai-http.test.ts`
的 19 个 `listen EPERM 127.0.0.1`，以及 Round-15/Round-16 child `tsx` IPC
pipe 的两个 `listen EPERM`。没有出现 Shiki、Markdown、DOMPurify、client、
resolver、MarkMap 或 Mermaid 回归。

Build 只报告既有 Rolldown `INVALID_ANNOTATION`（`@vueuse/core`）和大 chunk
warnings。代表性输出保持按需拆分：

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| `index-ty3O2Tbq.js` | 231.72 kB | 77.96 kB |
| `VaultView-CpB9upHe.js` | 1,866.55 kB | 533.50 kB |
| `javascript-Cb010CKM.js` | 174.88 kB | 16.68 kB |
| `typescript-C17ZkDe8.js` | 181.13 kB | 16.28 kB |
| `python-gzcpVVnB.js` | 69.94 kB | 9.09 kB |
| `java-D4RbCvBe.js` | 27.27 kB | 4.30 kB |
| `sql-DGnQv6iD.js` | 23.48 kB | 7.50 kB |

没有创建 `src/shiki.css`，也没有额外静态 Shiki CSS asset；generated CSS
只在 runtime transformer registry 有实际 token style 后写入 head owner。旧
`highlight.js` dependency 和 `src/hljs-dark.css` 仍保留到 H7，语言 grammar/theme
仍是异步 chunks。

## 15. Known environment limitations

默认 sandbox 首次启动 Playwright webServer 时因本地绑定
`127.0.0.1:4174` 返回 `EPERM`；在获准的本地端口环境重跑后 H4 browser、Markdown
visual 和 PDF 回归均通过。这是测试环境限制，不是 H4 应用失败。

Full unit 的 server/tsx `listen EPERM` 按 command FAIL 记录为 pre-existing
environment limitation，不能改称 PASS。H4 security、Markdown、DOMPurify、
MarkMap、Mermaid 和 client tests 没有新失败。

## 16. H4 exit criteria

- [x] production `codeToHtml()` 使用唯一 shared `transformerStyleToClass`；
- [x] `nuvyn-shiki-*` classes survive DOMPurify；
- [x] sanitized article 没有 Shiki/user inline style；
- [x] `FORBID_ATTR: ['style']` unchanged；
- [x] trusted generated CSS 只有一个 head owner；
- [x] owner 使用完整 snapshot replacement，不 append；
- [x] owner 不进入 article HTML；
- [x] user style/event/URI/code injection regressions pass；
- [x] no-document/head-unavailable path safe；
- [x] repeated/concurrent renders dedupe owner；
- [x] MarkMap/Mermaid、fallback、runtime failure contracts unchanged；
- [x] browser security evidence exists；
- [x] H5 theme integration 未开始；
- [x] H6 PDF integration 未开始；
- [x] H7 highlight.js cleanup 未开始。

## 17. H5 handoff

H4 交付的是“class + trusted CSS snapshot + sanitizer-safe article”合同，不是最终
可见主题行为。下一阶段必须在不重新 tokenization 的前提下接入：

```text
system light
system dark
forced light
forced dark
```

H5 应以现有 generated CSS 中的 `--shiki-light`、`--shiki-dark`、background
variables 和实际 Nuvyn `data-theme` precedence 为依据；H4 不创建
`src/shiki.css`，不修改 `useTheme`、`src/main.ts`、PDF 或 highlight.js cleanup。

Current next phase:

```text
SHIKI-H5 — Theme Integration
```
