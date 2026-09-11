import { describe, expect, it } from 'bun:test';
import { createReplayGate } from './replayGate';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createReplayGate', () => {
  it('starts closed, because a fresh connection always replays first', () => {
    const gate = createReplayGate();
    expect(gate.isReplaying()).toBe(true);
    gate.dispose();
  });

  it('opens once replayed output goes quiet', async () => {
    const gate = createReplayGate(20, 5000);
    gate.onConnect();
    gate.onOutput();
    expect(gate.isReplaying()).toBe(true);
    await sleep(60);
    expect(gate.isReplaying()).toBe(false);
    gate.dispose();
  });

  // Guards the bug where re-arming per output frame with no ceiling keeps the gate
  // shut on a busy live session, so a TUI's cursor-position query never gets answered.
  it('opens despite continuous output once the absolute window elapses', async () => {
    const gate = createReplayGate(1000, 40);
    gate.onConnect();
    for (let i = 0; i < 6; i++) {
      gate.onOutput();
      await sleep(10);
    }
    gate.onOutput();
    expect(gate.isReplaying()).toBe(false);
    gate.dispose();
  });

  it('re-closes on a server reset, which is itself a replay', async () => {
    const gate = createReplayGate(20, 5000);
    gate.onConnect();
    gate.onOutput();
    await sleep(60);
    expect(gate.isReplaying()).toBe(false);

    gate.onReset();
    expect(gate.isReplaying()).toBe(true);
    gate.dispose();
  });

  it('ignores output once open, so a settled session never re-gates', async () => {
    const gate = createReplayGate(20, 5000);
    gate.onConnect();
    gate.onOutput();
    await sleep(60);
    expect(gate.isReplaying()).toBe(false);

    gate.onOutput();
    expect(gate.isReplaying()).toBe(false);
    gate.dispose();
  });
});
