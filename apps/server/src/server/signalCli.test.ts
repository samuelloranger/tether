import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeHookSnippet, parseSignalArgs, runSignal } from './signalCli';

function tokenFile(token = 'tok'): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'tether-signal-')), 'token');
  writeFileSync(file, `${token}\n`);
  return file;
}

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
  test('posts the session id from the environment with the control token', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    await runSignal(
      { kind: 'send', state: 'done', body: 'Tests pass' },
      {
        baseUrl: 'http://127.0.0.1:8085',
        tokenFile: tokenFile('secret'),
        sessionId: 'term-7',
        fetch: async (url, init) => {
          seen = { url: String(url), init };
          return new Response('{}', { status: 200 });
        },
      },
    );
    expect(seen!.url).toBe('http://127.0.0.1:8085/control/signal');
    expect((seen!.init!.headers as Record<string, string>)['X-Tether-Present-Control']).toBe(
      'secret',
    );
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
        {
          baseUrl: 'http://127.0.0.1:8085',
          tokenFile: tokenFile(),
          fetch: async () => new Response('{}'),
        },
      ),
    ).rejects.toThrow(/TETHER_SESSION_ID/);
  });

  test('reports a rejected request', async () => {
    await expect(
      runSignal(
        { kind: 'send', state: 'done' },
        {
          baseUrl: 'http://127.0.0.1:8085',
          tokenFile: tokenFile(),
          sessionId: 'term-7',
          fetch: async () => new Response('nope', { status: 401 }),
        },
      ),
    ).rejects.toThrow(/401/);
  });
});

describe('claudeHookSnippet', () => {
  test('maps the two distinct hook events to the two distinct states', () => {
    const snippet = JSON.parse(claudeHookSnippet());
    expect(JSON.stringify(snippet.hooks.Notification)).toContain('tether signal waiting');
    expect(JSON.stringify(snippet.hooks.Stop)).toContain('tether signal done');
  });

  test('is pure JSON a user can paste', () => {
    expect(() => JSON.parse(claudeHookSnippet())).not.toThrow();
  });
});
