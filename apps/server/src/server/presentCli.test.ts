import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installAgentSkill, parsePresentArgs, runPresent } from './presentCli';

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

test('sends the local control token without using the mobile password', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tether-control-'));
  try {
    const tokenFile = path.join(root, 'token');
    await Bun.write(tokenFile, 'local-token');
    let request: Request | undefined;
    await runPresent(
      { kind: 'open', entry: 'index.html', project: 'creneau', title: 'UI' },
      {
        port: '8085',
        tokenFile,
        fetch: async (input, init) => {
          request = new Request(input, init);
          return new Response('{}');
        },
      },
    );
    expect(request?.url).toBe('http://127.0.0.1:8085/control/presentations');
    expect(request?.headers.get('X-Tether-Present-Control')).toBe('local-token');
    expect(await request?.json()).toEqual({
      entry: path.resolve('index.html'),
      project: 'creneau',
      title: 'UI',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
