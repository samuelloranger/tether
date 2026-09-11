import { expect, test } from 'bun:test';
import { advertisePairUrl } from './pairAdvertise';

test('advertisePairUrl both/off is http on plaintext port', () => {
  expect(
    advertisePairUrl({
      mode: 'both',
      httpPort: 8085,
      httpsPort: 8443,
      hosts: ['10.0.0.5'],
    }),
  ).toBe('http://10.0.0.5:8085');
});

test('advertisePairUrl only is https on TLS port', () => {
  expect(
    advertisePairUrl({
      mode: 'only',
      httpPort: null,
      httpsPort: 8443,
      hosts: ['10.0.0.5'],
    }),
  ).toBe('https://10.0.0.5:8443');
});

test('advertisePairUrl empty hosts is null', () => {
  expect(
    advertisePairUrl({
      mode: 'both',
      httpPort: 8085,
      httpsPort: 8443,
      hosts: [],
    }),
  ).toBeNull();
});
