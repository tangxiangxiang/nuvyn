# Nuvyn — Replace highlight.js with Shiki

Repository:

`tangxiangxiang/nuvyn`

Target branch:

`main`

## Objective

Replace the existing `highlight.js` based Markdown syntax highlighting implementation with **Shiki 4.x**, while preserving Nuvyn's existing Markdown architecture, security model, theme behavior, Mermaid/MarkMap handling, PDF export behavior, and test coverage.

This is a focused syntax-highlighting migration.

Do not perform unrelated UI refactors or Markdown architecture rewrites.

---

# 1. Current architecture

Before changing code, inspect the current implementation, especially:

* `package.json`
* `package-lock.json`
* `src/lib/markdown.ts`
* `src/lib/__tests__/markdown.test.ts`
* `src/hljs-dark.css`
* `src/style.css`
* `src/lib/pdfExport.ts`
* ReadingPane / Markdown preview rendering code
* theme switching implementation
* all tests that reference `hljs`, `highlight.js`, code fences, `<pre>` or `<code>`

The existing Markdown pipeline is roughly:

```text
Markdown
   ↓
markdown-it
   ↓
highlight.js
   ↓
HTML
   ↓
DOMPurify
   ↓
Vue v-html
   ↓
ReadingPane
```

The desired pipeline is:

```text
Markdown
   ↓
markdown-it
   ↓
Shiki
   ↓
style-to-class transformation
   ↓
DOMPurify
   ↓
Vue v-html
   ↓
ReadingPane
```

Do not replace `markdown-it`.

Do not rewrite the entire Markdown rendering system.

---

# 2. Core migration

Remove:

```text
highlight.js
highlight.js/styles/github.css
src/hljs-dark.css
```

Remove all remaining runtime references to:

```text
highlight.js
hljs
.hljs
.hljs-*
```

Add Shiki 4.x and the matching Shiki transformer package.

Prefer the current compatible versions, approximately:

```text
shiki ^4.4.x
@shikijs/transformers ^4.4.x
```

Keep both packages in runtime dependencies if they are imported by the browser application.

Update `package-lock.json` normally through npm.

Do not hand-edit lockfile dependency graphs.

---

# 3. Preserve the existing Markdown pipeline

The existing `render()` API must remain asynchronous:

```ts
render(markdown, options): Promise<string>
```

Do not force callers to change unnecessarily.

Create a long-lived Shiki highlighter singleton.

Do NOT create a new highlighter for every:

* Markdown document
* render
* code fence
* editor update

Highlighter initialization should happen once and be cached similarly to the current Markdown singleton initialization.

---

# 4. Do NOT migrate to markdown-it-async

Do not introduce `markdown-it-async` unless absolutely required.

Do not replace the existing MarkdownIt instance with another Markdown parser.

Nuvyn already owns an asynchronous `render()` boundary, so initialize/load Shiki before the synchronous MarkdownIt rendering phase.

The intended architecture is:

```text
render(markdown)
    ↓
get MarkdownIt + Shiki singleton
    ↓
discover required fenced-code languages
    ↓
await missing Shiki languages
    ↓
md.render(...)
    ↓
sanitize
```

Once languages are loaded, Shiki's highlighter should perform the actual code-to-HTML operation synchronously inside the MarkdownIt highlight callback.

---

# 5. Dynamic language loading

Do NOT eagerly initialize every Shiki language.

Avoid loading the complete language catalog during application startup.

Before rendering a document:

1. inspect its fenced code blocks;
2. collect language identifiers;
3. ignore:

   * `markmap`
   * `mermaid`
   * empty fences;
4. normalize known aliases where necessary;
5. asynchronously load missing Shiki languages;
6. cache them in the singleton highlighter.

Use Shiki's bundled language registry / aliases rather than maintaining a huge custom language list.

The following common fences must work:

```text
js
javascript
ts
typescript
tsx
jsx
vue
html
css
scss
json
yaml
yml
md
markdown
java
python
py
sql
bash
shell
sh
powershell
c
cpp
csharp
go
rust
php
kotlin
docker
dockerfile
xml
diff
```

Do not regress valid Shiki-supported languages merely because they are not in this example list.

---

# 6. Unknown language fallback

Unknown language names must NEVER make Markdown rendering fail.

For example:

````markdown
```some-random-language
hello <world>
```
````

must render as escaped plain code.

Requirements:

* no exception leaks to the reader;
* HTML must be escaped;
* code remains readable;
* fence remains a normal code block;
* no MarkMap or Mermaid handling is triggered.

A malformed or unsupported language must not break the whole document.

---

# 7. Preserve MarkMap and Mermaid behavior exactly

This is critical.

The current special handling for:

````text
```markmap
````

and:

````text
```mermaid
````

must remain outside Shiki highlighting.

Preserve the existing placeholder contract:

```text
.markmap-mount
.mermaid-mount
data-content
encodeURIComponent(...)
```

Do not send Mermaid or MarkMap source through Shiki.

Do not modify their mount lifecycle as part of this PR.

Do not weaken their sanitizer/security behavior.

Existing MarkMap and Mermaid tests must continue to pass.

---

# 8. Theme design

Use Shiki's built-in GitHub themes:

```text
github-light
github-dark
```

The purpose is to preserve the current visual character of Nuvyn, which already uses highlight.js GitHub light/dark themes.

Configure Shiki using dual themes.

Conceptually:

```ts
themes: {
  light: 'github-light',
  dark: 'github-dark',
}
```

Use:

```ts
defaultColor: false
```

so Nuvyn controls theme application through CSS.

The application must continue supporting:

1. system light
2. system dark
3. explicitly forced light
4. explicitly forced dark

The existing Nuvyn behavior where:

```text
data-theme="light"
```

overrides a dark operating-system preference must remain intact.

Likewise:

```text
data-theme="dark"
```

must force the dark Shiki colors.

Switching theme must NOT require re-rendering the Markdown document.

Theme switching must be CSS-driven.

---

# 9. CRITICAL SECURITY REQUIREMENT — no Shiki inline styles

The current Markdown sanitizer intentionally forbids:

```text
style
```

attributes.

DO NOT solve Shiki integration by globally allowing `style`.

Do not weaken:

```ts
FORBID_ATTR: ['style']
```

for arbitrary Markdown HTML.

Do not allow arbitrary user-authored Markdown HTML to inject style attributes.

Shiki normally generates token colors using inline styles, so use:

```text
@shikijs/transformers
transformerStyleToClass
```

to convert Shiki inline styles into generated CSS classes.

For example, the final sanitized article HTML should conceptually contain:

```html
<pre class="shiki ...">
  <code>
    <span class="line">
      <span class="nuvyn-shiki-...">const</span>
    </span>
  </code>
</pre>
```

and NOT:

```html
<span style="color: ...">
```

The final sanitized Markdown HTML should contain **zero Shiki-generated `style` attributes**.

---

# 10. Shiki generated stylesheet

Create one reusable style-to-class transformer instance.

Use a Nuvyn-specific prefix, for example:

```text
nuvyn-shiki-
```

Do not create duplicate style rules for each render.

The generated transformer CSS should be managed by Nuvyn itself.

Preferred implementation:

```text
single Shiki transformer
        ↓
transformer.getCSS()
        ↓
single managed stylesheet/style element
```

If a runtime `<style>` element is required, it must:

* contain only CSS generated from trusted Shiki themes;
* never contain raw user Markdown content;
* have a stable ID;
* be reused rather than duplicated;
* update only when new generated Shiki classes appear;
* work safely when `document` is unavailable during tests/non-browser execution.

Example conceptual ID:

```text
nuvyn-shiki-generated-styles
```

Do not inject one `<style>` tag per code block.

Do not put generated `<style>` elements inside the sanitized Markdown article.

---

# 11. Static Shiki theme CSS

Replace `src/hljs-dark.css` with a small Shiki integration stylesheet if necessary, for example:

```text
src/shiki.css
```

It should be responsible only for:

* applying `--shiki-light`
* applying `--shiki-dark`
* applying corresponding background variables
* system dark mode
* forced light mode
* forced dark mode
* font-style/font-weight/text-decoration variables where applicable
* basic Shiki structural styles

Preserve Nuvyn's existing code-block layout rules from `style.css`.

Do not duplicate generic `<pre>` layout styling unnecessarily.

---

# 12. Sanitizer compatibility

Keep the current sanitizer architecture.

The final Shiki HTML must survive DOMPurify without broadening the security boundary.

Verify that the generated Shiki structure only depends on already-safe HTML such as:

```text
pre
code
span
class
```

If Shiki produces incidental attributes such as:

```text
tabindex
```

either:

* explicitly remove them with a controlled Shiki transformer, or
* allow the existing sanitizer to strip them.

Do NOT expand `ALLOWED_ATTR` merely because Shiki generated an optional attribute unless Nuvyn genuinely needs it.

Security > preserving incidental Shiki attributes.

---

# 13. HTML contract

After migration, a normal highlighted code block should have a stable semantic outer structure:

```html
<pre class="shiki ...">
  <code>
    ...
  </code>
</pre>
```

Do not retain `hljs` compatibility classes merely to make old tests pass.

Tests must migrate to the new Shiki contract.

At completion:

```bash
grep -R "highlight.js" .
grep -R "hljs" src
```

should produce no application references except intentionally retained historical documentation if any.

Prefer removing all obsolete references entirely.

---

# 14. PDF export compatibility

This is mandatory.

Nuvyn has an existing HTML → PDF export pipeline with dedicated code-block pagination and printable styles.

The Shiki migration must not regress it.

PDF output must remain explicitly LIGHT regardless of:

* OS theme
* Nuvyn current theme
* `data-theme="dark"`

Add PDF-specific Shiki overrides where necessary.

Conceptually:

```css
.pdf-document .shiki,
.pdf-document .shiki span {
  color: var(--shiki-light) !important;
  background-color: var(--shiki-light-bg) !important;
}
```

Adjust the exact selectors to match the final architecture.

Requirements:

* PDF background stays white/light;
* syntax tokens use readable GitHub-light colors;
* dark-theme tokens must not leak into PDF;
* long lines continue wrapping correctly;
* `<pre>` blocks do not horizontally clip;
* pagination behavior remains intact;
* exporting code-heavy documents must not throw;
* Mermaid and MarkMap PDF behavior must remain unchanged.

Do not redesign PDF export in this task.

---

# 15. Performance requirements

Shiki is heavier than highlight.js, so performance is part of this migration.

Requirements:

### Singleton

Only one highlighter instance.

### Lazy initialization

Do not put Shiki's complete grammar/theme payload into the initial application path unnecessarily.

Keep syntax-highlighting implementation lazy where practical.

### Dynamic language loading

Load grammars only when they are needed.

Cache loaded grammars.

### No duplicate work

Rendering ten JavaScript fences must not initialize/load JavaScript ten times.

### No repeated stylesheet injection

Generated Shiki CSS must be deduplicated.

### No theme-triggered re-highlighting

Changing Nuvyn light/dark theme should only change CSS variables/styles.

It must not tokenize the code again.

---

# 16. Tests

Update existing Markdown tests and add dedicated Shiki regression coverage.

At minimum test:

## A. Basic highlighting

Input:

````markdown
```js
const x = 1
```
````

Assert:

* `.shiki` exists;
* `<pre><code>` structure remains valid;
* Shiki token classes exist;
* `hljs` does not exist;
* generated HTML contains no Shiki inline `style`.

---

## B. HTML escaping

Code such as:

```text
<script>alert(1)</script>
```

inside a code fence must display as code and never execute/render as HTML.

---

## C. Unknown language

Unknown fences render escaped plain code and do not reject `render()`.

---

## D. Alias handling

At minimum verify representative aliases such as:

```text
js
ts
py
sh
yml
```

---

## E. MarkMap regression

All current MarkMap tests remain green.

Shiki must never consume `markmap` fences.

---

## F. Mermaid regression

All current Mermaid tests remain green.

Shiki must never consume `mermaid` fences.

---

## G. Sanitizer regression

User Markdown such as:

```html
<span style="color:red" onclick="alert(1)">hello</span>
```

must NOT preserve:

```text
style
onclick
```

The Shiki migration must not weaken the sanitizer.

---

## H. Light/dark theme

Verify generated Shiki stylesheet has both:

```text
--shiki-light
--shiki-dark
```

where applicable.

Verify selectors support:

```text
system dark
data-theme="dark"
data-theme="light"
```

---

## I. Concurrent rendering

Existing concurrent Markdown rendering behavior must remain safe.

Rendering multiple documents simultaneously must not:

* create multiple highlighters;
* corrupt generated Shiki CSS;
* mix Markdown environments;
* race language loading.

---

## J. PDF regression

Add/update tests where practical to ensure Shiki code survives the PDF preparation pipeline.

At minimum verify printable Shiki markup is preserved and light-theme CSS wins in PDF context.

---

# 17. Existing functionality must not regress

Run the complete Markdown compatibility suite.

The following existing Markdown functionality must remain unchanged:

* standard Markdown
* task lists
* heading anchors
* footnotes
* definition lists
* `==mark==`
* WikiLinks
* standard `.md` links
* callouts
* KaTeX/math
* emoji
* tables
* Mermaid
* MarkMap
* sanitization
* concurrent resolver isolation
* PDF export

This migration is not permission to modify their behavior.

---

# 18. Dependency cleanup

After Shiki works:

Delete:

```text
src/hljs-dark.css
```

Remove:

```text
highlight.js
```

from dependencies and lockfile.

Remove:

```text
import('highlight.js')
import('highlight.js/styles/github.css')
import('../hljs-dark.css')
```

Remove stale comments referring to:

```text
hljs
highlight.js
github.css
```

Update comments to describe the Shiki implementation accurately.

---

# 19. Validation commands

Run at minimum:

```bash
npm run typecheck
npm run test:unit
npm run build
```

Then run the full relevant test suite if different from the above.

Also inspect the production Vite output.

Report any meaningful bundle-size change caused by Shiki.

Do not fail the task merely because Shiki introduces expected lazy chunks.

Verify that the initial JS bundle did not accidentally absorb every Shiki language/theme grammar.

---

# 20. Manual acceptance

Manually verify Markdown documents containing:

### JavaScript

````markdown
```js
const hello = "world"
console.log(hello)
```
````

### TypeScript

````markdown
```ts
interface User {
  id: number
  name: string
}
```
````

### Java

````markdown
```java
public class Hello {
    public static void main(String[] args) {
        System.out.println("Hello");
    }
}
```
````

### SQL

````markdown
```sql
SELECT *
FROM equipment
WHERE ClientNo = '100';
```
````

### Python

````markdown
```python
def hello(name: str):
    return f"Hello {name}"
```
````

### Unknown language

````markdown
```nuvyn-unknown-language
<hello> & world
```
````

Confirm each under:

* system light
* system dark
* forced light
* forced dark

Also export a document containing several code blocks to PDF.

---

# 21. Non-goals

Do NOT add in this task:

* line numbers
* copy-code button
* code block title bar
* filename display
* code folding
* diff annotations
* focus/highlight lines
* Twoslash
* Monaco integration
* editable code blocks
* new Markdown syntax
* theme selector specifically for code
* user-selectable Shiki themes

Those can be separate future enhancements.

This PR should establish a clean Shiki foundation first.

---

# 22. Definition of Done

The task is complete only when ALL of the following are true:

* [x] `highlight.js` dependency removed
* [x] Shiki 4.x installed
* [x] Shiki highlighter is singleton/cached
* [x] languages load without eagerly loading the entire catalog
* [x] GitHub Light + GitHub Dark themes work
* [x] Nuvyn system/forced theme behavior works
* [x] no Shiki inline styles survive into Markdown HTML
* [x] DOMPurify security policy is not weakened
* [x] `transformerStyleToClass` or equivalent safe class-based approach is used
* [x] generated Shiki CSS is deduplicated
* [x] unknown languages safely fall back to plain escaped code
* [x] MarkMap works exactly as before
* [x] Mermaid works exactly as before
* [x] PDF code blocks remain readable and printable
* [x] PDF always uses the light syntax palette
* [x] no `.hljs` application CSS remains
* [x] no `highlight.js` runtime imports remain
* [x] existing Markdown tests pass
* [x] new Shiki regression tests pass
* [x] `npm run typecheck` passes
* [x] `npm run test:unit` passes
* [x] `npm run build` passes

Implementation status:
COMPLETE

Release gate:
SHIKI-H8 — PASS

Evidence:
docs/design/syntax-highlighting-shiki-h8-release-gate.md

---

# 23. Implementation discipline

Keep the change focused.

Prefer a structure roughly like:

```text
src/
  lib/
    markdown.ts
    shiki.ts              # optional: highlighter/runtime management
  shiki.css               # optional: static light/dark integration
```

Do not force this exact file structure if a cleaner implementation fits the existing architecture better.

Do not introduce abstractions without a concrete need.

Do not change existing external APIs unless necessary.

Do not weaken security for convenience.

---

# 24. Final report

When implementation is complete, provide:

## Files changed

List every meaningful file changed/deleted.

## Architecture

Explain:

```text
Markdown
→ language preload
→ MarkdownIt
→ Shiki
→ style-to-class
→ DOMPurify
→ ReadingPane
```

## Security

Explain why Shiki does not require opening the sanitizer to arbitrary inline styles.

## Theme behavior

Explain how:

```text
system
forced light
forced dark
PDF light
```

are resolved.

## Performance

Report:

* singleton behavior;
* lazy language loading strategy;
* generated Vite chunks;
* meaningful bundle-size difference.

## Validation

Report the exact results of:

```bash
npm run typecheck
npm run test:unit
npm run build
```

and any other relevant test suite.

If anything cannot be verified, state it explicitly instead of assuming it works.

这里面我特意把 **“禁止直接放开 DOMPurify 的 style”** 写成了硬约束。这是这次迁移最容易被 Codex 偷懒做错的地方。Shiki 官方也建议 highlighter 做长生命周期 singleton，并支持初始化后按需 `loadLanguage()`，非常适合 Nuvyn 现在已经是异步 `render()` 的架构。([Shiki][3])

另外我建议这一轮**先不要加代码块复制按钮、行号、文件名、diff 高亮**。先把 Shiki 底座、安全、主题、PDF 和性能迁干净，后面这些能力借助 Shiki transformer 再单独做会漂亮很多。

[1]: https://www.npmjs.com/package/shiki?utm_source=chatgpt.com "shiki - npm"
[2]: https://shiki.style/packages/transformers?utm_source=chatgpt.com "@shikijs/transformers | Shiki"
[3]: https://shiki.style/guide/install?utm_source=chatgpt.com "Installation & Usage | Shiki"
