import { afterEach, describe, expect, test } from 'bun:test';
import { resolveListenerPlan } from './tlsConfig';
import { getTlsReport, isSecureRequest, publishTlsReport, resetTlsReport } from './tlsRuntime';

afterEach(resetTlsReport);

describe('isSecureRequest', () => {
  test('reads the scheme of the listener the request landed on', () => {
    expect(isSecureRequest('https://192.168.1.50:8443/api/status')).toBe(true);
    expect(isSecureRequest('http://192.168.1.50:8085/api/status')).toBe(false);
  });

  test('a malformed URL is never treated as secure', () => {
    expect(isSecureRequest('not a url')).toBe(false);
    expect(isSecureRequest('')).toBe(false);
  });

  test('a scheme that merely looks like https does not pass', () => {
    expect(isSecureRequest('httpsx://host/api/status')).toBe(false);
    expect(isSecureRequest('ws://host/api/ws')).toBe(false);
  });
});

describe('the published report', () => {
  test('defaults to TLS off, which is what a socket-less test should see', () => {
    expect(getTlsReport()).toEqual({
      enabled: false,
      plaintext: true,
      port: null,
      fingerprint: null,
    });
  });

  test('serve() publishing a plan makes it visible to the routes', () => {
    publishTlsReport(resolveListenerPlan({ TETHER_TLS_PORT: '9443' }), 'ef'.repeat(32));
    expect(getTlsReport()).toEqual({
      enabled: true,
      plaintext: true,
      port: 9443,
      fingerprint: `sha256:${'ef'.repeat(32)}`,
    });
  });

  test('reset returns to the safe default', () => {
    publishTlsReport(resolveListenerPlan({}), 'ab'.repeat(32));
    resetTlsReport();
    expect(getTlsReport().enabled).toBe(false);
  });
});
