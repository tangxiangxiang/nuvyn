# Hide Reading TOC when AI Panel is Open — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the AI panel is open in the vault's read mode, hide the right-side "页面导航" TOC and let the article flex-grow to fill the space the TOC used to occupy.

**Architecture:** Add an `ai-open` class to the `.vault` root element (sibling of the existing `is-read` class). Two new CSS rules in `style.css` hide the TOC and let the article expand. No new components, no new props, no new state — `aiOpen` is already a reactive ref in `useVaultLayout`.

**Tech Stack:** Vue 3 (template `:class` binding), CSS, vitest, vue-tsc, headless Chrome via `/tmp/cdp-drive.mjs` for visual verification.

**Spec:** [../specs/2026-06-12-hide-reading-toc-when-ai-open.md](../specs/2026-06-12-hide-reading-toc-when-ai-open.md)

---

## File map

| File | Change |
|---|---|
| [src/views/VaultView.vue](../../../src/views/VaultView.vue) | +1 — add `'ai-open': aiOpen` to the `.vault` `:class` binding at line 100 |
| [src/style.css](../../../src/style.css) | +~15 — two new rules under a comment block, appended after line 1549 (after the existing `.vault .reading-toc` rule closes) |

No new files, no test files modified, no other code touched.

---

### Task 1: Add `ai-open` class binding to the vault root

**Files:**
- Modify: [src/views/VaultView.vue:100](../../../src/views/VaultView.vue#L100) (one line)

- [ ] **Step 1: Edit the `:class` binding on the `.vault` div**

In [src/views/VaultView.vue](../../../src/views/VaultView.vue), change line 100 from:

```vue
    :class="{ 'is-read': isReadMode }"
```

to:

```vue
    :class="{ 'is-read': isReadMode, 'ai-open': aiOpen }"
```

`aiOpen` is already destructured from `useVaultLayout()` at line 40 of the same file, so no script-block changes are needed. The `is-read` class is the existing pattern we're mirroring.

- [ ] **Step 2: Verify the change reads correctly**

Open [src/views/VaultView.vue](../../../src/views/VaultView.vue) and confirm the `.vault` div's `:class` line is now:

```vue
    :class="{ 'is-read': isReadMode, 'ai-open': aiOpen }"
```

- [ ] **Step 3: Commit**

```bash
git add src/views/VaultView.vue
git commit -m "feat(vault): tag .vault with ai-open class when AI panel is open

Wires the existing aiOpen ref from useVaultLayout into a CSS
class on the .vault root, so style.css can react to AI panel
state without a new prop or component coupling. Mirrors the
existing is-read pattern.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add the two CSS rules that hide the TOC and expand the article

**Files:**
- Modify: [src/style.css:1549](../../../src/style.css#L1549) (append after the closing brace of `.vault .reading-toc`)

- [ ] **Step 1: Append the new rules to `style.css`**

In [src/style.css](../../../src/style.css), find the existing rule that ends at line 1549 (the closing `}` of `.vault .reading-toc { ... }` at lines 1532-1549). On a new line after that closing brace, add:

```css

/* AI panel open: hide the right-side "页面导航" TOC and let the
   article expand right into the space it used to occupy. The
   original reading-layout max-width (720 article + 32 gap + 220
   TOC = 972px) is unchanged — with the TOC removed, the article
   flex-grows to fill the same total width its row was already
   sized for. The 75ch readability cap is lifted while AI is open
   because the user has actively chosen to give up the right rail. */
.vault.ai-open .reading-toc {
  display: none;
}
.vault.ai-open .reading-layout .article.reading {
  /* flex: 0 1 720px → flex: 1 1 720px: allow growth into the
     freed 220 + 32 = 252px of horizontal space. */
  flex: 1 1 720px;
  /* Lift the 75ch cap so the article can actually fill the row
     (the cap is ~612px in English and would otherwise clip the
     article at its original width even with flex-grow set). */
  max-width: none;
}
```

The exact text above (including the leading blank line) is what gets inserted. The two selectors are placed adjacent to the existing `.vault .reading-toc` rule so a future reader scanning the reading-mode CSS can see all the AI-open overrides in one neighborhood.

- [ ] **Step 2: Verify the file still parses**

Open [src/style.css](../../../src/style.css) and confirm:

1. The `.vault .reading-toc` rule (lines 1532-1549) is unchanged
2. The new comment block and two rules are inserted directly after it
3. There is exactly one blank line between the existing closing `}` and the new comment block
4. There is no other content between the existing reading-mode rules and the new block

- [ ] **Step 3: Commit**

```bash
git add src/style.css
git commit -m "feat(style): hide reading-toc and expand article when .vault has ai-open

When the AI panel is open in read mode, the right-side
'页面导航' TOC is hidden and the article flex-grows into the
freed 220+32px slot. The reading-layout max-width (972px) is
unchanged — the article's flex-grow: 1 fills the slot the
TOC used to take. The 75ch readability cap is lifted in
this state because the user has traded the right rail for
the AI panel.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Run typecheck and tests

**Files:** none (verification only)

- [ ] **Step 1: Run typecheck**

Run: `pnpm exec vue-tsc -b --force`
Expected: no errors. The only change to a `.vue` file is a 1-line `:class` binding that uses an already-destructured ref (`aiOpen`), so no type issues are expected.

- [ ] **Step 2: Run the test suite**

Run: `pnpm test`
Expected: all 380+ existing tests pass. No new tests are required — `useVaultLayout.test.ts` already covers `aiOpen` toggling, and the `:class` binding is a one-liner vue-tsc verifies. The behavior is purely visual and is verified in Task 4.

- [ ] **Step 3: If either step fails, fix and re-run**

If typecheck fails: read the error, fix the offending file (likely a typo in the `:class` binding), commit the fix, re-run both steps.

If a test fails: read the failure, determine if the failure is caused by this change. If yes, fix the cause (likely a test that snapshots a `.vault` class list — search for `is-read` in tests/ and update the snapshot). Commit the fix, re-run.

---

### Task 4: Visual verification with headless Chrome

**Files:** none (verification only)

This is the load-bearing verification: CSS-only changes have no logic-level test, so we verify the behavior in a real browser.

**Prerequisite:** a dev server is already running on `http://localhost:5173` and a headless Chrome is reachable on `http://localhost:9222`. The dev script at `/tmp/cdp-drive.mjs` connects to the existing tab. If either is not running, start them with:

```bash
# in one terminal
pnpm dev

# in another terminal
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9222 --remote-allow-origins=* --no-first-run --no-default-browser-check --window-size=1280,800 http://localhost:5173
```

- [ ] **Step 1: Pick a long post to verify with**

We need a post that has at least 3 h2 headings so the TOC has multiple items to render. Run:

```bash
ls /Users/txx/nuvyn/src/content/archive/ /Users/txx/nuvyn/src/content/inbox/ /Users/txx/nuvyn/src/content/literature/ 2>/dev/null | head -40
```

Pick any `.md` file that has visible `## ` headings. For the rest of this task, replace `LONG_POST` with its path (e.g. `inbox/some-post`).

- [ ] **Step 2: Navigate to the post and switch to read mode**

```bash
node /tmp/cdp-drive.mjs eval "(() => { const r = location.origin + '/vault/inbox/some-post'; history.replaceState(null,'',r); location.assign(r); return 'navigated'; })()"
sleep 1500
node /tmp/cdp-drive.mjs click ".activity-bar button[title*='AI' i], .activity-bar button[aria-label*='AI' i]"
```

The activity-bar click may not exist; the AI panel can also be opened from the keyboard shortcut. Inspect the activity bar:

```bash
node /tmp/cdp-drive.mjs eval "Array.from(document.querySelectorAll('.activity-bar button')).map(b => b.title || b.getAttribute('aria-label') || b.textContent.trim())"
```

If there's no direct toggle, use the keyboard shortcut (typically `Cmd+J` or the read-mode toggle plus an AI shortcut — check the existing `useEditorTabs` shortcuts in [src/composables/vault/useEditorTabs.ts:274-302](../../../src/composables/vault/useEditorTabs.ts#L274-L302)). The shortcut for AI is wired through `useVaultLayout` — search the codebase for `toggleAi` callers.

The simplest reliable way: click the read-mode toggle, then click the AI toggle. If the toggle is not directly clickable, drive it from the layout's state:

```bash
node /tmp/cdp-drive.mjs eval "document.querySelector('.vault').classList.add('ai-open')"
```

(This forces the class on for visual verification only; the real toggle path is exercised in Step 6 below.)

- [ ] **Step 3: Confirm read mode is active and the TOC is visible**

```bash
node /tmp/cdp-drive.mjs eval "(() => { const r = document.querySelector('.vault'); const t = document.querySelector('.reading-toc'); return { aiOpen: r.classList.contains('ai-open'), isRead: r.classList.contains('is-read'), tocExists: !!t, tocVisible: t ? getComputedStyle(t).display !== 'none' : null }; })()"
```

Expected:

```json
{
  "aiOpen": false,
  "isRead": true,
  "tocExists": true,
  "tocVisible": true
}
```

If `isRead` is `false`, switch to read mode first (see Step 2).

- [ ] **Step 4: Screenshot the AI-closed baseline**

```bash
node /tmp/cdp-drive.mjs screenshot /tmp/ai-closed.png
```

Open `/tmp/ai-closed.png` and confirm:
- The TOC ("页面导航" with heading items) is visible on the right
- The article is centered with a visible gap to the TOC
- The AI panel is **not** visible

- [ ] **Step 5: Force the `ai-open` class on and screenshot**

```bash
node /tmp/cdp-drive.mjs eval "document.querySelector('.vault').classList.add('ai-open')"
sleep 200
node /tmp/cdp-drive.mjs eval "(() => { const t = document.querySelector('.reading-toc'); const a = document.querySelector('.reading-layout .article.reading'); return { tocDisplay: t ? getComputedStyle(t).display : 'no-element', articleFlex: a ? getComputedStyle(a).flex : null, articleMaxW: a ? getComputedStyle(a).maxWidth : null, articleW: a ? a.getBoundingClientRect().width : null }; })()"
```

Expected:

```json
{
  "tocDisplay": "none",
  "articleFlex": "... 1 1 720px ..." /* or "1 1 720px" depending on serialization */,
  "articleMaxW": "none",
  "articleW": /* some value larger than the baseline below */
}
```

```bash
node /tmp/cdp-drive.mjs screenshot /tmp/ai-open.png
```

Open `/tmp/ai-open.png` and confirm:
- The TOC is **gone** (no "页面导航" heading, no right-rail list)
- The article is visibly **wider** than in `/tmp/ai-closed.png`
- There is no large empty band on the right of the article

- [ ] **Step 6: Remove the forced class and confirm the toggle actually works**

To verify the real `aiOpen` state change path (not just the forced class), drive the layout:

```bash
node /tmp/cdp-drive.mjs eval "document.querySelector('.vault').classList.remove('ai-open')"
sleep 100
node /tmp/cdp-drive.mjs eval "document.querySelector('.vault').classList.contains('ai-open')"
```

Expected: `false`. (We're confirming the class was indeed removed and the visual reverts.)

Now drive the real toggle. Find the AI button (likely the bottom-most one in the activity bar):

```bash
node /tmp/cdp-drive.mjs eval "Array.from(document.querySelectorAll('.activity-bar button')).map((b,i) => ({i, title: b.title, label: b.getAttribute('aria-label')}))"
```

Click the AI button (replace `N` with the index from the previous output):

```bash
node /tmp/cdp-drive.mjs eval "document.querySelectorAll('.activity-bar button')[N].click()"
sleep 300
node /tmp/cdp-drive.mjs eval "document.querySelector('.vault').classList.contains('ai-open')"
```

Expected: `true`. Then:

```bash
node /tmp/cdp-drive.mjs eval "getComputedStyle(document.querySelector('.reading-toc')).display"
```

Expected: `"none"`. Screenshot one more time to confirm:

```bash
node /tmp/cdp-drive.mjs screenshot /tmp/ai-open-real.png
```

It should look the same as `/tmp/ai-open.png`.

Click the AI button again to close:

```bash
node /tmp/cdp-drive.mjs eval "document.querySelectorAll('.activity-bar button')[N].click()"
sleep 300
node /tmp/cdp-drive.mjs eval "getComputedStyle(document.querySelector('.reading-toc')).display"
```

Expected: a value other than `"none"` (e.g. `"block"` or `"flex"`). Screenshot:

```bash
node /tmp/cdp-drive.mjs screenshot /tmp/ai-closed-real.png
```

It should look the same as `/tmp/ai-closed.png`.

- [ ] **Step 7: If any assertion fails, fix and re-run**

If the TOC is still visible with `ai-open` on, the CSS selector or property is wrong — re-check [src/style.css](../../../src/style.css) lines 1549+ and ensure `.vault.ai-open .reading-toc` exists and is not overridden by a more specific rule. The `[ReadingPane.vue:204](../../../src/components/vault/ReadingPane.vue#L204)` template has `v-if="headings.length"` on the aside; if the chosen post has no headings, the aside is `v-if`'d out before the CSS rule runs. Pick a different post.

If the article does not widen, check that `flex: 1 1 720px` and `max-width: none` are applied (the `eval` in Step 5 prints both). The article's parent `.reading-layout` has `max-width: calc(720px + 32px + 220px) = 972px`, which bounds the article to ≤940px on the right.

---

### Task 5: Commit, push, and report

**Files:** none

- [ ] **Step 1: Confirm git state**

```bash
git status
git log --oneline -5
```

Expected: 2 unpushed commits on top of `main` (the `feat(vault)` and `feat(style)` commits from Tasks 1 and 2), with `docs(spec): hide reading-toc when AI panel is open` already pushed (committed in the brainstorming step).

- [ ] **Step 2: Push to remote**

```bash
git push origin main
```

Expected: 2 new commits land on `gitee/main` (or `origin/main`, depending on the configured remote — confirm with `git remote -v` first if unsure).

- [ ] **Step 3: Report back to the user**

Report:

- The two commits pushed (with their short hashes)
- Confirmation that AI-open now hides the TOC and the article visibly widens
- Paths to the verification screenshots (`/tmp/ai-closed.png`, `/tmp/ai-open.png`, `/tmp/ai-open-real.png`, `/tmp/ai-closed-real.png`) so the user can inspect them
- The post path used for verification, in case the user wants to re-test on a different file
