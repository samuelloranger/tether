import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Installs the hooks into a throwaway $HOME and drives the real wrapper with recorded hook
// JSON; a stub tether-notify records each call so the mapping itself is what gets tested.
function install(): { home: string; log: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-hooks-'));
  mkdirSync(path.join(home, '.codex'));
  mkdirSync(path.join(home, '.cursor'));
  const run = Bun.spawnSync(['sh', 'scripts/install-agent-hooks.sh', 'devbox'], {
    env: { ...process.env, HOME: home },
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  const log = path.join(home, 'calls.log');
  const stub = path.join(home, '.local/bin/tether-notify');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(stub, 0o755);
  return { home, log };
}

function hook(env: { home: string }, agent: string, state: string, input: object, session: string | null = 'work') {
  const wrapper = path.join(env.home, '.local/bin/tether-notify-hook');
  const vars: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: env.home };
  if (session) vars.ZMX_SESSION = session;
  const run = Bun.spawnSync(['sh', wrapper, agent, state], { env: vars, stdin: Buffer.from(JSON.stringify(input)) });
  expect(run.exitCode).toBe(0);
  return run.stdout.toString();
}

function calls(log: string): string[] {
  try {
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test('claude working records state without reading the transcript', () => {
  const env = install();
  hook(env, 'claude', 'working', { cwd: '/src/proj', hook_event_name: 'PreToolUse' });
  const [call] = calls(env.log);
  expect(call).toStartWith('state --session work --agent claude --state working');
});

test('claude permission prompt is waiting; idle reminder changes nothing', () => {
  const env = install();
  hook(env, 'claude', 'waiting', { cwd: '/src/proj', notification_type: 'permission_prompt', message: 'Allow Bash?' });
  hook(env, 'claude', 'waiting', { cwd: '/src/proj', notification_type: 'idle_prompt', message: 'Still there?' });
  const log = calls(env.log);
  expect(log).toHaveLength(1);
  expect(log[0]).toContain('--state waiting');
  expect(log[0]).toContain('--body Allow Bash?');
  expect(log[0]).toContain('--link tether://session/work?host=devbox');
});

test('claude failure is recorded as done with an error body', () => {
  const env = install();
  hook(env, 'claude', 'failed', { cwd: '/src/proj' });
  expect(calls(env.log)[0]).toContain('--state done');
  expect(calls(env.log)[0]).toContain('--body Stopped with an error');
});

test('outside zmx: waiting/done fall back to a plain push, working does nothing', () => {
  const env = install();
  hook(env, 'claude', 'working', { cwd: '/src/proj' }, null);
  hook(env, 'claude', 'done', { cwd: '/src/proj' }, null);
  const log = calls(env.log);
  expect(log).toHaveLength(1);
  expect(log[0]).toStartWith('notify --title proj · done');
});

test('codex always answers {} and cursor answers per event', () => {
  const env = install();
  expect(hook(env, 'codex', 'working', { cwd: '/src/proj' }).trim()).toBe('{}');
  expect(hook(env, 'codex', 'waiting', { cwd: '/src/proj', tool_name: 'shell' }).trim()).toBe('{}');
  expect(JSON.parse(hook(env, 'cursor', 'working', { workspace_roots: ['/src/proj'] }))).toEqual({ continue: true });
  expect(hook(env, 'cursor', 'done', { workspace_roots: ['/src/proj'] }).trim()).toBe('{}');
});

test('clear records clear', () => {
  const env = install();
  hook(env, 'claude', 'clear', { cwd: '/src/proj', reason: 'prompt_input_exit' });
  expect(calls(env.log)[0]).toStartWith('state --session work --agent claude --state clear');
});

test('installer registers every event once, and re-running does not duplicate', () => {
  const env = install();
  Bun.spawnSync(['sh', 'scripts/install-agent-hooks.sh', 'devbox'], { env: { ...process.env, HOME: env.home } });
  const claude = JSON.parse(readFileSync(path.join(env.home, '.claude/settings.json'), 'utf8')).hooks;
  for (const event of [
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'Stop',
    'StopFailure',
    'SessionEnd',
  ]) {
    expect(claude[event]).toHaveLength(1);
  }
  const codex = JSON.parse(readFileSync(path.join(env.home, '.codex/hooks.json'), 'utf8')).hooks;
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd']) {
    expect(codex[event]).toHaveLength(1);
  }
  const cursor = JSON.parse(readFileSync(path.join(env.home, '.cursor/hooks.json'), 'utf8')).hooks;
  expect(cursor.beforeSubmitPrompt).toHaveLength(1);
  expect(cursor.stop).toHaveLength(1);
});
