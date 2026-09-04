import { describe, expect, test } from 'bun:test';
import { getNoiseRpcDispatch, setNoiseRpcDispatch } from './routes/noise';

describe('noise rpc dispatch injection', () => {
  test('dispatcher is settable and readable', () => {
    const fn = async () => new Response('ok');
    setNoiseRpcDispatch(fn);
    expect(getNoiseRpcDispatch()).toBe(fn);
  });
});
