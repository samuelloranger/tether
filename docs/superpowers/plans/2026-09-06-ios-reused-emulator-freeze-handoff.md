# Handoff: iOS reused emulator freezes after next send

**Board:** [#1066](https://board) `iOS reused emulator freezes after next send` (in_progress)  
**Date:** 2026-09-06  
**Device build that showed this:** TestFlight **v4.0.7** (not 4.0.6)  
**Release:** https://github.com/samuelloranger/tether/releases/tag/v4.0.7  
**Predecessor:** #1064 (switch-back blank TUI) — user confirmed the *grid stays*. This is a new failure.

Do not ship a guess. Systematic debugging is unfinished: we have architecture and ranked hypotheses, **not** a confirmed root cause, **not** a failing test, **not** a patch.

---

## What the user saw

1. v4.0.6 (snapshot cache): still broken — composer at top, purple void, cannot scroll.
2. v4.0.7 (keep `FfiTerminalEmulator` per session): **“I do think it’s working!”** — switch-back keeps the last TUI.
3. Immediately after: **“the ui stays, but after I sent you my message, it was not updating.”**

So: last paint is preserved; **live bytes after the next prompt do not show**. Unknown whether the PTY got the input, whether Noise delivered output, or whether snapshots were produced and the surface dropped them.

Clarify with the user if needed:

- Did the composer show the typed text before Enter?
- After Enter: spinner / “working” / any cell change at all, or a frozen still of the pre-send screen?
- Sequence: switch away → switch back → send, or send without switching?
- Same Cursor Agent tab the whole time?

---

## What 4.0.6 vs 4.0.7 actually did

Noise `{t:"start"}` does **not** replay `terminal_logs`. Replay exists only on REST `GET /api/ws` (`hydrateTerminalSocket` in `apps/server/src/server/routes/sessions.ts`). iOS talks Noise (`runNoiseSession` in `apps/server/src/server/noiseSessionProtocol.ts`): `startSession` + `subscribeToSession`, then **live bytes only**.

v4.0.6 cached a TGRD blob. Switch-back showed it, then a fresh empty emulator ate Cursor’s sparse CUP (composer over a void). Cache was overwritten by that sparse live snapshot.

v4.0.7 (`b889cfc`, tagged as 4.0.7 via `64f2414`): `TerminalSessionGrids` keeps one `FfiTerminalEmulator` + `TerminalOutputBuffer` per host-qualified key. `connectNoise` reuses it and `publishSnapshot()` immediately. First attach this launch is still empty until the program redraws.

User confirmed reuse. Live follow-through is the remaining hole.

---

## Current connect / paint path (read these, do not re-discover)

| Piece | Where |
|---|---|
| Reuse + connect | `clients/apple/TetherKit/Sources/TetherKit/Terminal/TerminalPipeline.swift` `connectNoise`, `readLoopNoise`, `disconnect`, `applyOutput`, `publishSnapshot`, `applyLocalResize` |
| Grid pool | `TerminalSessionGrids.swift` |
| Byte buffer / rebuild | `TerminalOutputBuffer.swift` |
| Surface session switch | `TetherSurfaceRepresentable.swift` `updateUIView` → `prepareForSessionChange` / `forgetGeneration` |
| Worker skip | `TerminalRenderWorker.swift` (`header.generation == lastGeneration` → nil) |
| Store consume | `SessionStore.swift` `observePipeline` (`bufferingNewest(1)`), `selectSession`, `connectTerminalNoise` (**does not** `sendFocus(true)` after connect) |
| Noise start | `apps/server/src/server/noiseSessionProtocol.ts` `applyMessage` / `makeSubscriber` (only seals `output` and `exit`) |
| Decode | `NoiseSessionClient.swift` `NoiseServerMessage` — **unknown `t` throws** |
| Tests already in | `AgentTuiGridTests.swift`, `TerminalSessionGridsTests.swift`, `TerminalRenderWorkerSwitchTests.swift` |

`TerminalPipeline` is an **actor**. Snapshots are `bufferingNewest(1)`. Main actor only stores the newest `Data?`.

`connectNoise` outline:

1. `disconnect()` — `sendFocus(false)`, **`lastFocusSent = nil`**, cancel read task, close channel. **Keeps the emulator.**
2. `sessionGrids.attach` — reuse or fresh.
3. If reused: `lastRenderedGeneration = nil` then `publishSnapshot()`.
4. `resetMouseModes()`.
5. Handshake + `sendStart` + `sendResize`. Focus is sent **only if** `lastFocusSent` is non-nil — it is always nil here.
6. Start `readLoopNoise`. `applyOutput` → `outputBuffer.append` + `emulator.feed` + `publishSnapshot`.

`readLoopNoise`: any `receive()` / decode error that is not cancellation yields `.error("Connection closed")` and **breaks the loop**. Outbound pump can still have the channel, so typing can work while paint is dead.

`selectSession` awaits `sendFocus(false)` then `connectTerminal`. After `connectNoise` returns, **nobody sends `focused: true`** unless `resumeFromForeground` hits `.none`. Server `focused` stays false (push + `shouldKickPtyOnFocus` SIGWINCH kick). PTY broadcast does not gate on focus — this may be a real bug but it is **not proven** to be the freeze.

---

## Hypotheses (untested — pick one, write a failing test, then fix)

Ranked by how well they match “UI stays, then nothing new after send”:

1. **Read loop dies after connect or after send.** `NoiseServerMessage` `default:` throws. Today Noise only seals `output`/`exit`/`devices`/`auth.token`, so this is latent unless a new `t` appeared. Confirm by: unknown `t` must `continue`, not kill the loop. Easy hardening even if not the cause.

2. **Input dropped while handshake still in flight.** Reused snapshot is published *before* `reconnect()`. UI looks live; `handleOutbound` drops input when `noiseChannel == nil`. Composer would not echo if keys never hit the PTY — ask whether they saw their own typing.

3. **Focus never restored after switch-back.** No `sendFocus(true)` after `connectNoise`. Unlikely to freeze paint by itself; still wrong; Cursor/Ink only full-redraw on SIGWINCH (`kickPtySize`). `sendResize` after start should still SIGWINCH if size changed; same size may no-op in `recomputeSize`.

4. **Generation / surface skip.** Reuse publishes gen N; worker paints N; later feeds that do not change `visible_digest` do not publish. Agent “working” should change cells. `prepareForSessionChange` bumps `frameEpoch` and async `forgetGeneration` — in-flight commit discarded; `isRendering` cleared. Possible stuck frame if a later path sets `isRendering = true` and commit never matches epoch — not demonstrated.

5. **PTY moved on while unsubscribed; live CUP applied to a stale parser.** Would usually look *garbled*, not frozen. Missed bytes during the disconnect window are gone forever (no Noise replay). After a *new* send, new live bytes should still arrive if the loop is alive.

6. **Alt-screen row grow skips publish** (`TerminalResizePublish.shouldPublishAfterResize`) waiting for a program redraw that never comes. Keyboard hide is the usual trigger. A send should make the agent paint — unless SIGWINCH never fired and the agent is waiting.

7. **`outputBuffer` getter** is `currentGrid?.buffer ?? TerminalOutputBuffer()` — throwaway buffer if `currentGrid` is nil. Not the live-session case.

Do **not** pile these into one patch. Confirm where it breaks: bytes in → emulator gen bump → snapshot yield → `terminalSnapshot` assignment → `updateSnapshot` → commit.

---

## What not to do

- Do not treat 4.0.6 snapshot-cache work as related, except as the failed approach.
- Do not add Noise log replay in the same change unless that is the proven cause (larger, server + client).
- Do not hand-create GitHub releases. `./scripts/release.sh --patch` after CI green. Watch Release builds; TestFlight is the `ios` job.
- Do not claim the device bug is fixed until the user tries the next TestFlight.
- macbuild: `ssh macbuild`, repo `~/build/tether`, rsync TetherKit **excluding** `Frameworks` and `Sources/TetherFFIBindings`. Tests: `xcodebuild test -scheme TetherKit -destination 'id=36AE5B82-3F0F-4C17-88ED-908A861C50D2'`.

---

## Suggested first moves

1. `resume` board, take #1066.
2. One failing test that matches the *chosen* hypothesis (e.g. reuse emulator, feed more CUP/output, assert a new generation is published / worker paints; or decode of unknown `t` does not abort).
3. If the test cannot reach the actor/socket: smallest seam (`publishSnapshot` after `applyOutput` on a reused grid; `NoiseServerMessage` decode of unknown `t`).
4. Only then patch, run TetherKit on macbuild, then release if the user wants another TestFlight.

Prior conversation: agent transcript `edda6031-7d52-485c-b069-b6612852ccd7`.
