import { appendFileSync } from 'node:fs';

// Structured event log for the E2E harness. Off unless TETHER_TEST_LOG names a
// file; when set, each call appends one JSON line the iOS XCUITest suite reads
// back and asserts on. The env is read per-call so a server started with it set
// (or not) needs no import-order care. Never enabled in production.
export function testEvent(ev: string, fields: Record<string, unknown> = {}): void {
  const sink = process.env.TETHER_TEST_LOG;
  if (!sink) return;
  try {
    appendFileSync(sink, `${JSON.stringify({ ts: Date.now(), ev, ...fields })}\n`);
  } catch {}
}
