import { expect, test } from 'bun:test';
import { closeDeviceChannels, trackDeviceChannel } from './deviceChannels';

test('closeDeviceChannels runs tracked closers and is idempotent', () => {
  const calls: string[] = [];
  const untrack = trackDeviceChannel('dev-a', () => calls.push('a'));
  trackDeviceChannel('dev-b', () => calls.push('b'));
  expect(closeDeviceChannels('dev-a')).toBe(1);
  expect(calls).toEqual(['a']);
  expect(closeDeviceChannels('dev-a')).toBe(0);
  untrack(); // already closed
  expect(calls).toEqual(['a']);
  closeDeviceChannels('dev-b');
  expect(calls).toEqual(['a', 'b']);
});
