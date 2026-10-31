# Markdown structural folding

## Scope

Folding is a view capability, with no new Markdown syntax, stored document
metadata, database fields or dependencies. Editor and Reader have independent
state. Saving, encrypted Diary access, draft recovery and export formats keep
their existing owners.

## Editor

`markdownFolding.ts` parses source with Markdown-it and the existing container,
code-group and math block rules. It consumes block maps rather than deriving
structure from indentation or regular expressions. Frontmatter is excluded
while retaining source line offsets. Heading ranges use their token scope and
the next same/higher heading. Only headings and fenced code produce custom
ranges. Existing container rules are used for parsing boundaries, not to add
container-level controls. Ranges are trimmed, bounded, deduplicated
by start line and filtered to legal nesting.

`monacoMarkdownProviders.ts` registers one native FoldingRangeProvider beside
the existing shared completion/hover providers. A WeakMap caches by model and
version; unbinding clears the cache and removes model ownership. Source parsing
does not render HTML, invoke Shiki, fetch Includes or run on scroll. The existing
500,000-character guard applies before parsing. Folding controls and commands
are Monaco's; selection-based search/anchor reveals let FoldingController
expand only the destination's collapsed ancestors.

The bundled Monaco Markdown language configuration provides indentation and
region markers, but no semantic heading/fenced-code provider. The small
provider supplies only those missing ranges. Lists, quotes, layouts and
Callouts have no dedicated folding implementation; existing Monaco behavior
is otherwise unchanged.

## Reader

`markdownReaderFolding.ts` enhances sanitized semantic DOM after rendering.
It reads only actual heading elements; it never parses
HTML using regular expressions or treats source-authored fold attributes as
commands. A WeakMap of programmatically-created buttons owns event authority.
The sanitizer allowlist and Markdown renderer are unchanged.

Heading sections are sibling ranges bounded by same/higher headings and their
own parent. A leading top-level H1 is treated as the document title and has
no folding control. Other H1–H6 headings with content can fold. Lists, quotes,
code, Callouts, layouts, images, tables, diagrams and Board previews receive
no independent controls. No wrappers or inline splits are introduced; mounted
components retain their identity and existing interactions.

Each collapsed fold owns a set of hidden target elements. Shared target
ownership prevents expanding a parent from resetting a child's collapsed
state. `hidden` removes content from layout and keyboard navigation. Generated
IDs connect controls via `aria-controls`; native buttons provide keyboard and
touch activation, `aria-expanded`, labels and focus outlines. On hover-capable
pointers, controls appear on hover; Reader keyboard focus also reveals them.
Controls are positioned outside the text flow, without reserving inline space
or changing line height. On touch devices expanded Reader controls are hidden
until focus; tapping a heading toggles its section, while collapsed controls
remain visible to signal hidden content. Interactive links inside headings
retain their normal behavior. Monaco folding gutters remain visibly
tappable on coarse pointers: hiding them behind hover would remove the only
discoverable native touch target. Desktop retains the hover behavior. One root
click listener serves all controls. Disposal restores hidden state, removes owned
controls/IDs and releases references. There is no folding MutationObserver.

Only Vault's ordinary Reader and the Markdown specimen opt into the default-off
`foldingEnabled` props. Draft Recovery and export surfaces retain the default.
Fresh HTML,
document identity changes and unmount dispose Reader state. Locale updates do
not duplicate buttons. Large documents skip DOM enhancement.

## Navigation and export

TOC and internal-anchor/Wiki-anchor navigation reveal enclosing collapsed
ranges before measuring the target. Native Details and Code Group panels can
also be exposed when a navigation target lies inside them. TOC retains its
complete H2–H4 list; scroll tracking filters hidden headings and reconnects
its observer after disclosure changes. Editor handoffs preserve their existing
stale-document checks and move the selection before revealing anchors.

PDF/HTML surfaces never opt in. Their existing isolated render/snapshot
pipelines receive complete content regardless of live Reader state, with no
fold buttons, hidden nodes, scripts or stored fold state. Markdown source
export is untouched.

## Deliberate boundaries

- Native Details keeps its disclosure; no duplicate summary control is added.
- Flex has no container-level control that could become an unwanted Flex item.
- Code Group keeps tab selection; no code/widget panel gets a fold control.
- Heading ranges never cross a DOM parent/container boundary.
- Include headings participate in Reader's final DOM; Editor folds source
  owned by its model and does not fetch expanded resource bodies.
- Reader state resets on a mode remount; no cross-document/Diary cache exists.
- One-line leaves with nothing to hide do not receive an item/quote control.

Browser tests exercise real native gutter behavior, nested Reader state,
navigation, mobile geometry/widget identity and independent PDF/HTML export
surfaces. Unit coverage owns source maps, lifetime/cache boundaries, hidden
ownership, source-authored lookalikes and component opt-in/cleanup.

## Changed files

| Files | Responsibility |
| --- | --- |
| `src/lib/markdownFolding.ts` | Source-token ranges and size protection |
| `src/components/vault/monacoMarkdownProviders.ts` | Shared native provider, version cache and release |
| `src/components/vault/EditorPane.vue` | Native folding contribution/options and anchor selection reveal |
| `src/lib/markdownReaderFolding.ts` | DOM enhancement, ownership, accessibility, navigation and disposal |
| `src/components/vault/RenderedMarkdown.vue` | Opt-in, render cancellation, lifecycle, labels and internal anchors |
| `src/components/vault/ReadingPane.vue` | TOC reveal, visibility-aware scroll tracking and observer refresh |
| `src/views/VaultView.vue`, `src/views/MarkdownTestView.vue` | Opt in ordinary interactive reading surfaces |
| `src/style.css` | Non-displacing controls, hidden layout state and touch/focus styles |
| `src/lib/__tests__/markdownFolding.test.ts`, `markdownReaderFolding.test.ts` | Structure maps, DOM ownership, resources and native containers |
| `src/components/vault/__tests__/monacoMarkdownProviders.test.ts` | Registration, version cache, cancellation and unbinding |
| `src/components/vault/__tests__/MonacoEditorPane.test.ts`, `RenderedMarkdown.test.ts`, `ReadingPane.test.ts` | Wiring, copying, isolation, document changes and scroll tracking |
| `e2e/markdown-folding.spec.ts`, `e2e/markdown-folding-diary.spec.ts` | Real Monaco commands/input, Reader, mobile, exports and Diary lock |
| `playwright.pdf-compat.config.ts` | Reuse WebKit/high-DPI infrastructure for folding |
| `e2e/markdown-visual.spec.ts-snapshots/markdown-reading-{light,dark}-chromium-darwin.png` | Reviewed baselines for the added controls |
| `docs/user-guide/markdown.md`, this document | User behavior, architecture, boundaries and verification |

## Earlier implementation verification (2026-10-20)

These results describe the earlier, broader implementation, before the
heading-only Reader simplification. Current verification is recorded below.

| Command / scope | Result |
| --- | --- |
| `npm run typecheck` | Passed, browser and server |
| `npm run build` | Passed |
| `npm run test:unit -- --maxWorkers=2` | 354 files; 5,265 passed, 9 existing skips |
| `npm run test:history-integration` | 5 files; 185 passed |
| `npm run test:recovery-integration` | 5 files; 198 passed |
| Chromium: folding, folding Diary, Markdown visual, Document Export Diary | 16 passed |
| WebKit: folding + folding Diary | 6 passed |
| Chromium high-DPI: folding + folding Diary | 6 passed |
| `git diff --check` | Passed |

Browser commands use the existing infrastructure:

```sh
npx playwright test e2e/markdown-folding.spec.ts e2e/markdown-folding-diary.spec.ts e2e/markdown-visual.spec.ts e2e/document-export-diary.spec.ts --project=chromium
npx playwright test e2e/markdown-folding.spec.ts e2e/markdown-folding-diary.spec.ts --config=playwright.pdf-compat.config.ts --project=webkit --project=chromium-dpi2
```

The initial sandbox blocked local Playwright listening and tsx IPC pipes
(`listen EPERM`). The unchanged commands passed with those local permissions.
The two expected visual baseline changes were inspected and updated, then
the full visual suite passed without snapshot updates. No new skips, retries
or timeouts were introduced.

Phone Reader geometry is checked with the existing side panels collapsed.
WebKit automation does not replace physical iPhone/iPad Safari acceptance.
WebKit also logs a Monaco clipboard cancellation around scripted downloads;
the actual HTML/PDF downloads and completeness assertions pass. This change
does not modify the clipboard implementation or the existing mobile shell.

## Heading-only simplification (2026-10-20)

The initial broader implementation was deliberately reduced: Reader now only
adds section controls, omitting the leading document H1. Dedicated list, quote,
container, code and widget disclosure plans, inline paragraph splitting, code
summaries and unused translation keys have been removed. The editor provider
only supplements headings and fenced code; token parsing still recognizes
container boundaries so sections cannot consume unrelated content.

The ordinary Reader top padding is 24px (previously 40px); side/bottom spacing
and Zen Mode spacing remain unchanged. Visual baselines were reviewed after
this expected 16px difference. Desktop controls still appear only on hover or
keyboard focus and do not reserve inline space.

Current verification:

- TypeScript checks and production build passed.
- Focused component/provider/structure tests: 88 passed before the final
  H2–H6 boundary case; final Reader suite: 7 passed including that case.
- Chromium combined folding, Diary, Markdown visual, export Diary and Board
  Embed regression: 17 passed. After adding an explicit native fenced-code
  fold/unfold assertion, folding + Diary were rerun: 6 passed.
- WebKit folding + Diary with native fenced-code fold/unfold: 6 passed.
- Full unit suite (`npm run test:unit -- --maxWorkers=2`): 354 files,
  5,262 passed and 9 existing skips. The initial restricted run had 21
  failures from local HTTP/tsx IPC `listen EPERM`; the unchanged command
  passed with local service/process permissions.
- `git diff --check` passed.
- No skips, retries or timeout increases were added.
- Physical iPhone/iPad Safari interaction still needs manual acceptance.
