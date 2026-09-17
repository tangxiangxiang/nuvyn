# Nuvyn Naive UI Foundation — Phase 2 Report

Date: 2026-09-08

## Status

Phase 2: IMPLEMENTED / AWAITING EXACT-HEAD CI

Ready for Phase 3: NO

This report records the Phase 2 implementation and local validation state.
Phase 3 is explicitly out of scope for this handoff.

## Baseline and commits

- Starting HEAD: `d8fdf68a8ec746cbfdd42c6446885f7eb338773f`
- Implementation commit: `6c80df6` (`refactor(ui): migrate global feedback overlays`)
- Report/evidence commit: pending at report creation
- `github/main` matched the starting HEAD before implementation.

## Scope completed

Migrated only the three global feedback Hosts to the Phase 1 Naive UI
provider foundation:

- `src/components/ToastHost.vue` bridges Nuvyn `useToast()` to Naive
  `useMessage()`.
- `src/components/ConfirmHost.vue` renders the Nuvyn confirm queue through
  declarative Naive `NModal` with the `preset="dialog"` primitive.
- `src/components/PromptHost.vue` renders the Nuvyn prompt queue through
  Naive `NModal`, `NInput`, and `NButton`.

The provider-independent public APIs remain unchanged:
`useToast`, `useConfirm`, `confirmCancellable`, and `usePrompt`. No business
call site was migrated to a Naive composable. Production `useMessage` usage is
limited to `ToastHost`; confirm and prompt remain Host-owned bridges so their
queue, Promise, cancellation, focus, and transform semantics stay under Nuvyn
authority.

No Phase 3 Primitive migration was started. No router, store, API, server,
domain, or unrelated product behavior was changed.

## Toast bridge

`ToastHost` keeps the Nuvyn queue and TTL as the semantic authority. Each Nuvyn
toast ID creates exactly one Naive message with `duration: 0`; queue removal
drives `MessageReactive.destroy()`, and the Naive close affordance calls back
to `dismiss(id)`. Default TTLs, custom positive TTLs, persistent `ttl <= 0`,
multiple messages, FIFO ordering, and cleanup are covered.

The Nuvyn API remains intentionally limited to `info`, `success`, and `error`;
no warning API was introduced. The legacy whole-message click-to-dismiss
behavior is not reproduced because Naive UI 2.45.3's supported
`MessageReactive` API exposes a close affordance and `destroy()` but no
content-click callback. Programmatic `dismiss(id)` and the visible close
button remain available.

## Confirm bridge

The confirm Host displays one request at a time in FIFO order and settles each
request exactly once. It preserves:

- normal and destructive variants, including the destructive icon and error
  button treatment;
- multiline detail text and custom translated action labels;
- `confirmCancellable.cancel()` removing the visible request and resolving
  `false`;
- safe Cancel focus on open, Escape and backdrop cancellation, and trigger
  focus restoration;
- stale callback/race protection, queued cancellation, and Host teardown
  resolution.

Naive `NModal` is used declaratively over its `NDialog` preset so the semantic
queue remains explicit and the provider stays lifecycle-safe. Naive UI 2.45.3
hardcodes the internal `NDialog` root role to `dialog` even when the modal is
passed `role="alertdialog"`; the bridge therefore asserts `role="dialog"`
with `aria-modal="true"` and the request message as the accessible label.
This is the equivalent accessible modal contract supported by the pinned
Naive version and is recorded in the regression tests.

The feedback modals use explicit `z-index: 10001` so they remain above the
existing Settings Teleport layer (`9997`) and the AI session picker layer
(`9996`), preserving nested overlay behavior.

## Prompt bridge

The prompt Host preserves initial values, placeholders, trim-on-submit, empty
submission as `null`, Enter, Escape, backdrop cancellation, FIFO isolation,
and trigger focus restoration. `NInput` owns the input surface and
`NButton` owns the transform/action affordance.

Async transforms retain busy/disabled state and double-submit prevention;
rejections are consumed while the prompt remains open and editable; stale
transform results cannot mutate a cancelled request or the next queued
prompt. Tests cover synchronous and asynchronous transforms, rejection, and
stale-resolution isolation.

## Theme, locale, Teleport, and visual acceptance

The production provider hierarchy remains the Phase 1 canonical hierarchy.
`useTheme()` and `useI18n()` remain the only Nuvyn authorities; Naive theme and
locale/date-locale mappings update without remounting the Hosts. The mounted
overlays use Naive Teleport, mask handling, scroll locking, and its single
focus-trap implementation. Vault and Ledger mode coexistence is covered by
the dedicated browser fixture.

I manually reviewed the overlay harness at desktop light and dark themes. The
browser suite covers the narrow `390x844` viewport, theme and locale changes
while an overlay is open, Vault/Ledger modes, external cancellation, and
cleanup.

## Bundle checkpoint

Measured from the Vite output at the Phase 1 baseline and after the final
Phase 2 implementation:

| Metric | Phase 1 | Phase 2 | Delta |
| --- | ---: | ---: | ---: |
| Entry JS | 505,584 B | 543,173 B | +37,589 B |
| Largest async JS | 2,629,634 B | 2,629,634 B | 0 B |
| Total JS | 20,858,054 B | 20,895,709 B | +37,655 B |
| Total CSS | 432,120 B | 430,085 B | -2,035 B |

The entry increase is the expected runtime cost of the three Host bridges and
the Naive feedback primitives. The largest async chunk is unchanged.

## Validation

- `npm ci`: passed; `package-lock.json` unchanged.
- `npm run typecheck`: passed (client and server).
- `npm run test:ui-foundation-spike`: passed, 27 tests.
- `npm run test:feedback-overlay`: passed, 18 tests.
- `npm test`: passed with 273 unit files / 3,968 tests and 9 skipped, plus
  history integration 178 passed and recovery integration 198 passed.
- `npm run build`: passed. Existing Rolldown `INVALID_ANNOTATION` and
  large-chunk warnings remain.
- `npm run test:e2e`: passed, 174 passed and 7 skipped. The six new Phase 2
  feedback-overlay browser tests passed; existing feedback-flow tests were
  updated only from removed legacy Host selectors to semantic Naive selectors.
- `git diff --check`: passed.

`npm run lint:icons` was also run. It reports the unchanged baseline of 8 hard
and 11 soft violations in pre-existing, untouched icon/PDF/Mermaid files. No
Phase 2 file introduced a new icon violation.

## Exact-head CI

Pending at report creation. The final handoff will push the implementation
and report commits to `github/main`, verify that the remote exactly matches
the final local SHA, locate the GitHub Actions run whose `head_sha` is that
SHA, and inspect every required job before changing the release status.

NAIVE UI FOUNDATION PHASE 2 IMPLEMENTATION COMPLETE
