// Why every *synchronous* child spawn carries a deadline.
//
// spawnSync blocks the JS thread, so nothing on the event loop can interrupt
// it — including bun:test's per-test timeout, which is itself a timer on that
// blocked loop. A child that never exits therefore has no ceiling short of the
// CI step's own cap, and it takes its whole `bun test --parallel` worker with
// it, stranding every file still queued to that worker and reporting nothing.
// Raising test timeouts cannot fix that shape of hang; only a spawn-level
// deadline can, and only node:child_process offers one (Bun.spawnSync has no
// timeout option).
//
// Generous on purpose — this is a liveness bound, not a performance budget. git
// on a large repository is allowed to be slow; it is not allowed to be
// infinite. Every call site treats `status === null` as a failure already, so a
// killed child surfaces as an error rather than truncated output parsed as if
// it were complete.
export const SPAWN_TIMEOUT_MS = 60_000;
