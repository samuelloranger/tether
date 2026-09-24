import { describe, expect, test } from 'bun:test';
import type { ApnsResult, ApnsSendOptions } from './apnsClient';
import { sendToEitherEnvironment } from './environments';

class FakeApns {
  calls = 0;
  constructor(private readonly result: ApnsResult) {}
  async send(_opts: ApnsSendOptions): Promise<ApnsResult> {
    this.calls += 1;
    return this.result;
  }
}

const opts: ApnsSendOptions = { token: 'a'.repeat(64), payload: { aps: {} } as never, topic: 'app.example' };

describe('sendToEitherEnvironment', () => {
  test('a token the primary environment accepts never reaches the other', async () => {
    const primary = new FakeApns({ status: 200 });
    const other = new FakeApns({ status: 200 });
    expect(await sendToEitherEnvironment(primary, other, opts)).toEqual({ status: 200 });
    expect(other.calls).toBe(0);
  });

  test('BadDeviceToken is retried once on the other environment', async () => {
    const primary = new FakeApns({ status: 400, reason: 'BadDeviceToken' });
    const other = new FakeApns({ status: 200 });
    expect(await sendToEitherEnvironment(primary, other, opts)).toEqual({ status: 200 });
    expect(other.calls).toBe(1);
  });

  test('a token neither environment knows is still rejected', async () => {
    const primary = new FakeApns({ status: 400, reason: 'BadDeviceToken' });
    const other = new FakeApns({ status: 400, reason: 'BadDeviceToken' });
    expect(await sendToEitherEnvironment(primary, other, opts)).toEqual({ status: 400, reason: 'BadDeviceToken' });
  });

  test('other rejections are not retried', async () => {
    for (const result of [
      { status: 400, reason: 'PayloadTooLarge' },
      { status: 410, reason: 'Unregistered' },
      { status: 429, reason: 'TooManyRequests' },
    ]) {
      const other = new FakeApns({ status: 200 });
      expect(await sendToEitherEnvironment(new FakeApns(result), other, opts)).toEqual(result);
      expect(other.calls).toBe(0);
    }
  });
});
