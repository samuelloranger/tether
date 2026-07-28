import { expect, test } from 'bun:test';
import { connectionRequestUrl } from './connectionUrl';

test('connectionRequestUrl keeps authenticated API requests scoped to the configured host', () => {
  expect(connectionRequestUrl('192.168.1.8', '8085', '/api/sessions')).toBe(
    'http://192.168.1.8:8085/api/sessions',
  );
});

test('connectionRequestUrl preserves a query string for authenticated session requests', () => {
  expect(connectionRequestUrl('tether.local', '9090', '/api/sessions?status=running')).toBe(
    'http://tether.local:9090/api/sessions?status=running',
  );
});
