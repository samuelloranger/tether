import { expect, test } from 'bun:test';
import { pairQrPayload } from './pairQr';

test('pairQrPayload percent-encodes the host URL', () => {
  expect(pairQrPayload('7QF4KM9PX3TV', 'http://192.168.1.9:8085')).toBe(
    'tether://pair?code=7QF4-KM9P-X3TV&host=http%3A%2F%2F192.168.1.9%3A8085',
  );
});
