import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  parseTlsMode,
  resolveListenerPlan,
  tlsReport,
} from './tlsConfig';

const plan = (env: Record<string, string | undefined>) => resolveListenerPlan(env);

describe('parseTlsMode', () => {
  test('defaults to both, so an unattended update changes nothing', () => {
    const warnings: string[] = [];
    expect(parseTlsMode(undefined, warnings)).toBe('both');
    expect(parseTlsMode('', warnings)).toBe('both');
    expect(warnings).toEqual([]);
  });

  test('accepts the spellings a human types', () => {
    const w: string[] = [];
    for (const v of ['both', 'on', '1', 'true', 'YES']) expect(parseTlsMode(v, w)).toBe('both');
    for (const v of ['only', 'https', 'https-only', 'STRICT'])
      expect(parseTlsMode(v, w)).toBe('only');
    for (const v of ['off', '0', 'false', 'no', 'none', 'http'])
      expect(parseTlsMode(v, w)).toBe('off');
    expect(w).toEqual([]);
  });

  test('falls back to both — never to off — on garbage, and says so', () => {
    const warnings: string[] = [];
    expect(parseTlsMode('maybe', warnings)).toBe('both');
    expect(warnings[0]).toContain('maybe');
  });
});

describe('resolveListenerPlan', () => {
  test('an untouched environment serves plaintext on 8085 exactly as before', () => {
    const p = plan({});
    expect(p.mode).toBe('both');
    expect(p.httpPort).toBe(DEFAULT_HTTP_PORT);
    expect(p.httpsPort).toBe(DEFAULT_HTTPS_PORT);
    expect(p.warnings).toEqual([]);
  });

  test('honours custom ports', () => {
    const p = plan({ TETHER_PORT: '9000', TETHER_TLS_PORT: '9443' });
    expect(p.httpPort).toBe(9000);
    expect(p.httpsPort).toBe(9443);
  });

  test('only mode closes the plaintext listener', () => {
    const p = plan({ TETHER_TLS: 'only' });
    expect(p.httpPort).toBeNull();
    expect(p.httpsPort).toBe(DEFAULT_HTTPS_PORT);
  });

  test('off mode keeps plaintext and opens no TLS listener', () => {
    const p = plan({ TETHER_TLS: 'off' });
    expect(p.httpPort).toBe(DEFAULT_HTTP_PORT);
    expect(p.httpsPort).toBeNull();
  });

  test('a colliding TLS port drops TLS, not the port existing clients use', () => {
    const p = plan({ TETHER_PORT: '8443' });
    expect(p.httpPort).toBe(8443);
    expect(p.httpsPort).toBeNull();
    expect(p.mode).toBe('off');
    expect(p.warnings.join(' ')).toContain('equals TETHER_PORT');
  });

  test('only mode with a colliding port still leaves a reachable listener', () => {
    const p = plan({ TETHER_TLS: 'only', TETHER_PORT: '8443' });
    expect(p.httpPort).toBe(8443);
    expect(p.httpsPort).toBeNull();
  });

  test('an unusable port value warns and falls back rather than crashing', () => {
    const p = plan({ TETHER_PORT: 'banana', TETHER_TLS_PORT: '99999' });
    expect(p.httpPort).toBe(DEFAULT_HTTP_PORT);
    expect(p.httpsPort).toBe(DEFAULT_HTTPS_PORT);
    expect(p.warnings).toHaveLength(2);
  });
});

describe('tlsReport', () => {
  test('reports the fingerprint prefixed, and the plaintext port state', () => {
    const report = tlsReport(plan({}), 'ab'.repeat(32));
    expect(report).toEqual({
      enabled: true,
      plaintext: true,
      port: DEFAULT_HTTPS_PORT,
      fingerprint: `sha256:${'ab'.repeat(32)}`,
    });
  });

  test('no fingerprint means TLS is reported off, whatever the plan said', () => {
    const report = tlsReport(plan({}), null);
    expect(report.enabled).toBe(false);
    expect(report.port).toBeNull();
    expect(report.fingerprint).toBeNull();
  });

  test('only mode reports plaintext closed', () => {
    expect(tlsReport(plan({ TETHER_TLS: 'only' }), 'cd'.repeat(32)).plaintext).toBe(false);
  });
});
