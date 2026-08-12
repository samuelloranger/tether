import { describe, expect, test } from 'bun:test';
import { RateLimiter } from './rateLimit';

describe('RateLimiter', () => {
  test('allows a burst up to capacity then refuses', () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 }, () => 0);
    expect([limiter.take('k'), limiter.take('k'), limiter.take('k')]).toEqual([true, true, true]);
    expect(limiter.take('k')).toBe(false);
  });

  test('refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, () => now);
    limiter.take('k');
    limiter.take('k');
    expect(limiter.take('k')).toBe(false);
    now = 1000;
    expect(limiter.take('k')).toBe(true);
  });

  test('never refills past capacity, so a long idle cannot bank a flood', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, () => now);
    now = 60_000;
    expect([limiter.take('k'), limiter.take('k')]).toEqual([true, true]);
    expect(limiter.take('k')).toBe(false);
  });

  test('keys are independent, so one noisy device cannot starve another', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 }, () => 0);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
  });

  test('sweep drops fully-refilled buckets so the map cannot grow forever', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, () => now);
    limiter.take('a');
    expect(limiter.size).toBe(1);
    now = 10_000;
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });

  test('sweep keeps buckets that are still throttled', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, () => now);
    limiter.take('a');
    limiter.take('a');
    now = 500;
    limiter.sweep();
    expect(limiter.size).toBe(1);
  });
});
