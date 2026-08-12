import { describe, expect, test } from 'bun:test';
import { type Config, DEFAULT_CONFIG } from './config';
import { buildPushContent } from './push';

const CTX = { sessionId: 'term-7', sessionTitle: 'vim README.md' };

const cfg = (overrides: Partial<Config> = {}): Config => ({
  ...DEFAULT_CONFIG,
  push: { enabled: true, relayUrl: 'https://relay.test' },
  identity: { name: 'alpha', color: '#fff' },
  ...overrides,
});

describe('buildPushContent', () => {
  test('returns null when push is disabled, so ntfy-only servers send nothing', () => {
    const config = cfg({ push: { enabled: false, relayUrl: 'https://relay.test' } });
    expect(buildPushContent({ type: 'waiting' }, CTX, config)).toBeNull();
  });

  test('respects the per-event trigger toggles', () => {
    const config = cfg({ triggers: { ...DEFAULT_CONFIG.triggers, waiting: false } });
    expect(buildPushContent({ type: 'waiting' }, CTX, config)).toBeNull();
    expect(buildPushContent({ type: 'exit' }, CTX, config)).not.toBeNull();
  });

  test('titles combine host identity and session title', () => {
    expect(buildPushContent({ type: 'waiting' }, CTX, cfg())?.title).toBe('alpha · vim README.md');
  });

  test('an OSC notification title overrides the session title', () => {
    const content = buildPushContent({ type: 'oscNotify', title: 'Build done' }, CTX, cfg());
    expect(content?.title).toBe('alpha · Build done');
  });

  test.each([
    [{ type: 'waiting' } as const, 'Waiting for input'],
    [{ type: 'exit', exitCode: 1 } as const, 'Session exited with code 1'],
    [{ type: 'exit' } as const, 'Session exited'],
    [{ type: 'longJob', seconds: 300 } as const, 'Job ran for 300 seconds'],
    [{ type: 'oscNotify', body: 'Tests green' } as const, 'Tests green'],
  ])('renders %o as its body', (event, expected) => {
    expect(buildPushContent(event, CTX, cfg())?.body).toBe(expected);
  });

  test('deep link carries session and host so a tap opens the right tab', () => {
    // Mirrors the ntfy click URL; hostStore resolves `host` to a profile.
    expect(buildPushContent({ type: 'waiting' }, CTX, cfg())?.link).toBe(
      'tether://session/term-7?host=alpha',
    );
  });

  test('bounds long OSC bodies so the relay does not reject them', () => {
    // The relay caps ciphertext at 3000 chars and base64 inflates by ~4/3, so
    // an unbounded body would 400 and the notification would vanish silently.
    const content = buildPushContent({ type: 'oscNotify', body: 'x'.repeat(5000) }, CTX, cfg());
    expect(content?.body.length).toBeLessThanOrEqual(800);
    expect(content?.body.endsWith('…')).toBe(true);
  });

  test('bounds a very long session title too', () => {
    const content = buildPushContent(
      { type: 'waiting' },
      { ...CTX, sessionTitle: 'y'.repeat(900) },
      cfg(),
    );
    expect(content?.title.length).toBeLessThanOrEqual(200);
  });

  test('leaves short content untouched', () => {
    expect(buildPushContent({ type: 'waiting' }, CTX, cfg())?.body).toBe('Waiting for input');
  });

  test('a maximum-size payload still fits the relay ciphertext limit', () => {
    const content = buildPushContent(
      { type: 'oscNotify', title: 'z'.repeat(500), body: 'x'.repeat(5000) },
      { sessionId: 'a'.repeat(200), sessionTitle: 'y'.repeat(500) },
      cfg(),
    );
    // base64 of (12-byte nonce + plaintext + 16-byte tag), 4/3 expansion.
    const plaintext = Buffer.byteLength(JSON.stringify(content));
    expect(Math.ceil((plaintext + 28) / 3) * 4).toBeLessThan(3000);
  });

  test('returns null when no relay is configured, since there is nowhere to send', () => {
    expect(
      buildPushContent({ type: 'waiting' }, CTX, cfg({ push: { enabled: true, relayUrl: '' } })),
    ).toBeNull();
  });

  test('session ids and host names with URL-hostile characters are encoded', () => {
    const content = buildPushContent(
      { type: 'waiting' },
      { sessionId: 'a b/c', sessionTitle: 't' },
      cfg({ identity: { name: 'my host&x', color: '#fff' } }),
    );
    expect(content?.link).toBe('tether://session/a%20b%2Fc?host=my%20host%26x');
  });
});
