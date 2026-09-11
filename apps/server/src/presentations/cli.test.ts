import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installAgentSkill, parsePresentArgs, runPresent } from './cli';

test('parses documented present command forms', () => {
  expect(parsePresentArgs(['index.html', '--project', 'creneau', '--title', 'UI'])).toEqual({
    kind: 'open',
    entry: 'index.html',
    project: 'creneau',
    title: 'UI',
  });
  expect(parsePresentArgs(['reset'])).toEqual({ kind: 'reset' });
  expect(parsePresentArgs(['reset', 'creneau'])).toEqual({ kind: 'reset', project: 'creneau' });
  expect(parsePresentArgs(['agent-install', 'codex'])).toEqual({
    kind: 'agent-install',
    target: 'codex',
  });
  expect(() => parsePresentArgs(['agent-intsall'])).toThrow('Unknown present command');
});

test('installs the requested Claude skill idempotently', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tether-skill-'));
  try {
    const first = installAgentSkill('claude', { home, hasCommand: () => true });
    const second = installAgentSkill('claude', { home, hasCommand: () => true });

    expect(second).toBe(first);
    expect(first).toBe(path.join(home, '.claude/skills/tether-present/SKILL.md'));
    expect(await Bun.file(first).text()).toContain('tether present reset');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('posts over the control socket without any token header', async () => {
  // Developers often run this suite from inside a tether shell, where
  // TETHER_SESSION_ID is set and would add a sessionId field to the body.
  const originalSessionId = process.env.TETHER_SESSION_ID;
  try {
    delete process.env.TETHER_SESSION_ID;
    let call: { url: string; init: RequestInit } | undefined;
    await runPresent(
      { kind: 'open', entry: 'index.html', project: 'creneau', title: 'UI' },
      {
        sock: '/tmp/tether-control.sock',
        fetch: async (input, init) => {
          call = { url: String(input), init: init ?? {} };
          return new Response('{}');
        },
      },
    );
    if (!call) throw new Error('fetch was not called');
    expect(call.url).toBe('http://localhost/control/presentations');
    expect((call.init as { unix?: string }).unix).toBe('/tmp/tether-control.sock');
    expect(
      (call.init.headers as Record<string, string>)['X-Tether-Present-Control'],
    ).toBeUndefined();
    expect(JSON.parse(String(call.init.body))).toEqual({
      entry: path.resolve('index.html'),
      project: 'creneau',
      title: 'UI',
    });
  } finally {
    if (originalSessionId === undefined) delete process.env.TETHER_SESSION_ID;
    else process.env.TETHER_SESSION_ID = originalSessionId;
  }
});

test('includes the session id from TETHER_SESSION_ID when present, omits it when absent', async () => {
  const originalSessionId = process.env.TETHER_SESSION_ID;
  const bodyOf = async (): Promise<unknown> => {
    let body: string | undefined;
    await runPresent(
      { kind: 'open', entry: 'index.html' },
      {
        sock: '/tmp/tether-control.sock',
        fetch: async (_input, init) => {
          body = String(init?.body);
          return new Response('{}');
        },
      },
    );
    return JSON.parse(String(body));
  };
  try {
    process.env.TETHER_SESSION_ID = 'term-4';
    expect(await bodyOf()).toEqual({ entry: path.resolve('index.html'), sessionId: 'term-4' });

    delete process.env.TETHER_SESSION_ID;
    expect(await bodyOf()).toEqual({ entry: path.resolve('index.html') });
  } finally {
    if (originalSessionId === undefined) delete process.env.TETHER_SESSION_ID;
    else process.env.TETHER_SESSION_ID = originalSessionId;
  }
});
