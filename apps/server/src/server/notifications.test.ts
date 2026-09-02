import { describe, expect, test } from 'bun:test';
import { pushesFromOutput, pushFromExit } from './notifications';

describe('pushesFromOutput', () => {
  test('an OSC notify is the only push even when a long job also finished', () => {
    expect(
      pushesFromOutput({ activity: 'waiting', notify: { body: 'Build done' }, longJob: true }, 300),
    ).toEqual([{ type: 'oscNotify', body: 'Build done' }]);
  });

  test('waiting is the only push even when a long job also finished', () => {
    expect(pushesFromOutput({ activity: 'waiting', notify: null, longJob: true }, 300)).toEqual([
      { type: 'waiting' },
    ]);
  });

  test('a long job alone still notifies', () => {
    expect(pushesFromOutput({ activity: 'idle', notify: null, longJob: true }, 300)).toEqual([
      { type: 'longJob', seconds: 300 },
    ]);
  });

  test('plain output with no long job is silent', () => {
    expect(pushesFromOutput({ activity: 'working', notify: null, longJob: false }, 300)).toEqual(
      [],
    );
  });
});

describe('pushFromExit', () => {
  test('an explicit kill is not an exit notification', () => {
    expect(pushFromExit(true, 0)).toBeNull();
    expect(pushFromExit(true, 137)).toBeNull();
    expect(pushFromExit(true)).toBeNull();
  });

  test('a natural exit still raises the event', () => {
    expect(pushFromExit(false, 1)).toEqual({ type: 'exit', exitCode: 1 });
    expect(pushFromExit(false)).toEqual({ type: 'exit' });
  });
});
