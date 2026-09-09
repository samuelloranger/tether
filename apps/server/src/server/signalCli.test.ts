import { describe, expect, test } from 'bun:test';
import { claudeHookSnippet, parseSignalArgs, runSignal } from './signalCli';

const SOCK = '/tmp/tether-control.sock';

describe('parseSignalArgs', () => {
  test('reads a bare state', () => {
    expect(parseSignalArgs(['done'])).toEqual({ kind: 'send', state: 'done' });
  });

  test('reads the optional words', () => {
    expect(parseSignalArgs(['done', '--title', 'Claude', '--body', 'Tests pass'])).toEqual({
      kind: 'send',
      state: 'done',
      title: 'Claude',
      body: 'Tests pass',
    });
  });

  test('rejects a state it does not model', () => {
    expect(() => parseSignalArgs(['idle'])).toThrow();
  });

  test('rejects a flag with no value', () => {
    expect(() => parseSignalArgs(['done', '--title'])).toThrow();
  });

  test('reads the hooks subcommand', () => {
    expect(parseSignalArgs(['hooks'])).toEqual({ kind: 'hooks' });
  });
});

describe('runSignal', () => {
  test('posts the session id over the control socket without a token header', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    await runSignal(
      { kind: 'send', state: 'done', body: 'Tests pass' },
      {
        sock: SOCK,
        sessionId: 'term-7',
        fetch: async (url, init) => {
          seen = { url: String(url), init };
          return new Response('{}', { status: 200 });
        },
      },
    );
    expect(seen!.url).toBe('http://localhost/control/signal');
    expect((seen!.init as { unix?: string }).unix).toBe(SOCK);
    expect(
      (seen!.init!.headers as Record<string, string>)['X-Tether-Present-Control'],
    ).toBeUndefined();
    expect(JSON.parse(String(seen!.init!.body))).toEqual({
      sessionId: 'term-7',
      state: 'done',
      body: 'Tests pass',
    });
  });

  test('refuses to guess when there is no session id', async () => {
    await expect(
      runSignal(
        { kind: 'send', state: 'done' },
        { sock: SOCK, fetch: async () => new Response('{}') },
      ),
    ).rejects.toThrow(/TETHER_SESSION_ID/);
  });

  test('reports a rejected request', async () => {
    await expect(
      runSignal(
        { kind: 'send', state: 'done' },
        {
          sock: SOCK,
          sessionId: 'term-7',
          fetch: async () => new Response('nope', { status: 500 }),
        },
      ),
    ).rejects.toThrow(/500/);
  });
});

describe('claudeHookSnippet', () => {
  test('maps each distinct hook event to its own state', () => {
    const snippet = JSON.parse(claudeHookSnippet());
    expect(JSON.stringify(snippet.hooks.Notification)).toContain('tether signal waiting');
    expect(JSON.stringify(snippet.hooks.Stop)).toContain('tether signal done');
    // Without this one an agent-driven session can never return to `working`:
    // the byte heuristics no longer move it, so nothing else would.
    expect(JSON.stringify(snippet.hooks.UserPromptSubmit)).toContain('tether signal working');
  });

  test('is pure JSON a user can paste', () => {
    expect(() => JSON.parse(claudeHookSnippet())).not.toThrow();
  });
});
