import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Installs the hooks into a throwaway $HOME and drives the real wrapper with recorded hook
// JSON; a stub tether-notify records each call so the mapping itself is what gets tested.
function install(setup?: (home: string) => void): { home: string; log: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-hooks-'));
  for (const dir of ['.codex', '.cursor', '.gemini']) mkdirSync(path.join(home, dir));
  setup?.(home);
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

function reinstall(env: { home: string }) {
  const run = Bun.spawnSync(['sh', 'scripts/install-agent-hooks.sh', 'devbox'], {
    env: { ...process.env, HOME: env.home },
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function hook(
  env: { home: string },
  agent: string,
  state: string,
  input: object,
  session: string | null = 'work',
  extraEnv: Record<string, string> = {},
) {
  const wrapper = path.join(env.home, '.local/bin/tether-notify-hook');
  const vars: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: env.home, ...extraEnv };
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
  expect(call).not.toContain('--collapse');
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
  reinstall(env);
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

test('claude hooks that Cursor runs from the Claude settings stay silent', () => {
  const env = install();
  const cursorPayload = { cursor_version: '2026.10.01', workspace_roots: ['/src/proj'] };
  expect(hook(env, 'claude', 'working', { ...cursorPayload, hook_event_name: 'postToolUse' })).toBe('');
  expect(hook(env, 'claude', 'done', { ...cursorPayload, hook_event_name: 'stop', status: 'completed' })).toBe('');
  expect(calls(env.log)).toHaveLength(0);
});

test('a claude prompt that merely mentions "cursor_version" is still recorded', () => {
  const env = install();
  hook(env, 'claude', 'working', {
    cwd: '/src/proj',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'rename "cursor_version"',
  });
  expect(calls(env.log)[0]).toStartWith('state --session work --agent claude --state working');
});

test('cursor postToolUse answers {} while beforeSubmitPrompt continues; gemini answers {}', () => {
  const env = install();
  const base = { cursor_version: '2026.10.01', workspace_roots: ['/src/proj'] };
  expect(hook(env, 'cursor', 'working', { ...base, hook_event_name: 'postToolUse', tool_name: 'Shell' }).trim()).toBe(
    '{}',
  );
  expect(JSON.parse(hook(env, 'cursor', 'working', { ...base, hook_event_name: 'beforeSubmitPrompt' }))).toEqual({
    continue: true,
  });
  expect(hook(env, 'gemini', 'working', { cwd: '/src/proj', hook_event_name: 'BeforeAgent' }).trim()).toBe('{}');
  expect(hook(env, 'gemini', 'clear', { cwd: '/src/proj', hook_event_name: 'SessionEnd' }).trim()).toBe('{}');
});
