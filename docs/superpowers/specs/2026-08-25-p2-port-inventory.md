# P2 Port Inventory — What Moves Into `tether-core`

**Date:** 2026-08-25
**Status:** Reference. Input to the P2 plan; not itself a plan.
**Parent spec:** `2026-08-25-native-client-rewrite-design.md`

P2 of the native client rewrite is "core to the v1 feature line." Its real cost is not
line count — it is *how entangled each TypeScript module is with React and the platform*.
A module with no imports ports to Rust almost mechanically. A module that pulls in
`TerminalEngine`, the clipboard, and desktop notifications is a rewrite, not a port.

This is a measured inventory of `apps/mobile/src/tether/` (~7.0k lines across 41
non-test modules) classified by that axis, so the P2 plan can be sequenced by
difficulty instead of by guesswork.

## Method

Classification is by **value imports** — `import` statements that bring in a runtime
value, excluding type-only imports. A type-only import disappears at the Rust boundary;
a value import is a dependency that must either port too or be injected.

A first pass grepping only for direct `react` / `react-native` / `expo-` imports was
wrong and is worth recording as a trap: it labelled `sessionTransport.ts` pure, when it
pulls `TerminalEngine`, `clipboard`, `desktopNotify`, and `platform` in through relative
paths. Entanglement here is mostly transitive.

## Tier 1 — Free ports (0 value imports)

Fully self-contained. Dependencies arrive as parameters, so these become Rust structs
with no injection scaffolding. **~660 lines, and six of the nine already have tests.**

| Module | Lines | Has test | Notes |
|---|---|---|---|
| `pageControlState.ts` | 252 | yes | Type-only import of `SessionEntry`. |
| `hostStore.ts` | 200 | yes | Profiles + migration. **Zero imports at all** — storage is injected. |
| `pushRegistration.ts` | 91 | yes | |
| `hostHealth.ts` | 34 | yes | The 2s→30s backoff state machine. Zero imports. |
| `pushDeepLink.ts` | 32 | yes | |
| `types.ts` | 25 | — | Type-only; becomes Rust type definitions. |
| `notifications.web.ts` | 25 | yes | |
| `notifications.ts` | 6 | — | |
| `coreTransport.ts` | ~50 | yes | Created by P0; stays TypeScript (it *is* the boundary). |

**Do these first.** They are where the "logic written once" claim gets proven cheaply,
and `hostStore` + `hostHealth` are exactly the multi-host behavior the spec puts in v1.

## Tier 2 — Ports with injection (1–3 value imports)

Portable, but each needs one or two dependencies passed in rather than imported.

| Module | Lines | Value imports | Has test |
|---|---|---|---|
| `terminalSessionLogic.ts` | 248 | 2 | yes (via `useTerminalSessions.test.ts`) |
| `sessionHostOps.ts` | 141 | 2 | yes |
| `hostPolling.ts` | 129 | 1 | yes |
| `hostClient.ts` | 85 | 1 | yes |
| `tetherAppActions.ts` | 192 | 1 | — |
| `sessionPolling.ts` | 65 | 3 | — |

`terminalSessionLogic.ts` is the important one: it holds the `sinceId` / `lastAppliedId`
logic P0 already ported as `ReplayTracker`, plus frame dispatch. Its two value imports
are `SessionCache` (`src/sessionCache.ts`, the LRU tab cache) and `parseRepoStatus`
(`src/gitStatusModel.ts`) — so **`sessionCache.ts` is an implicit P2 dependency** and
should be added to the plan explicitly. `parseRepoStatus` is only reached by the `diff`
frame, which is P5 scope, so it can be stubbed in P2.

## Tier 3 — Rewrites, not ports (4+ value imports)

These are React composition and platform glue. They do not port; the equivalent behavior
gets written natively in each shell. Listing them matters so nobody budgets porting time
for them.

Deepest first: `tetherAppHooks.ts` (248 lines, **25 value imports** — pure composition,
replaced entirely by shell code), `sessionRuntime.ts` (200, 10), `terminalSessionEffects.ts`
(163, 8), `terminalSessionActions.ts` (170, 8), `sessionTransport.ts` (395, 7),
`usePushRegistration.ts`, `useDeepLinks.ts`, plus the `use*` hooks and
`desktopEffectBindings.ts` / `connectionConfig*`.

`sessionTransport.ts` (395 lines, 7 value imports) is the hard case and deserves its own
task: it is the largest module in the layer, it is genuinely v1 scope, and it mixes
portable connection logic with platform effects (clipboard writes, native notifications,
`isDesktop` branches, direct `TerminalEngine` calls). It needs splitting along that seam
before either half can move — the portable half joins Tier 2, the rest becomes shell code.

## Out of P2 scope entirely (P5 features)

`gitReviewOps.ts`, `gitReviewActions.ts`, `useGitReview.ts`, `useFileView.ts`,
`useSessionUpload.ts`, `usePresentations.ts`, `transcriptTools.ts` — git review, file
viewing, upload, presentations. Roughly 1.1k lines that stay TypeScript until P5, along
with `src/diffModel.ts`.

## Suggested P2 sequencing

1. Tier 1, all nine modules, with their existing tests translated. Cheap, high signal.
2. `sessionCache.ts` (the implicit dependency), then Tier 2 in ascending import count.
3. Split `sessionTransport.ts` along the portable/platform seam; port the portable half.
4. Leave Tier 3 in place. It is deleted, not ported, when each shell reaches parity.

## Caveat

Value-import count is a proxy for entanglement, not a measurement of it. A module with
one import of something deeply platform-bound is harder than one with three imports of
pure helpers. Treat the tiers as a starting order to be corrected by reading, not as an
estimate. Line counts are as of 2026-08-25 and will drift.
