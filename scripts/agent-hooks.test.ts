import { expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

const geminiEvents: Record<string, string> = {
  BeforeAgent: 'working',
  BeforeTool: 'working',
  AfterTool: 'working',
  Notification: 'waiting',
  AfterAgent: 'done',
  SessionEnd: 'clear',
};

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
  for (const event of ['beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd']) {
    expect(cursor[event]).toHaveLength(1);
  }
  const gemini = JSON.parse(readFileSync(path.join(env.home, '.gemini/settings.json'), 'utf8')).hooks;
  for (const event of Object.keys(geminiEvents)) {
    expect(gemini[event]).toHaveLength(1);
  }
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

test('codex waiting uses tool_name when tool_input is not an object', () => {
  const env = install();
  hook(env, 'codex', 'waiting', {
    cwd: '/src/proj',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: 'x',
  });
  expect(calls(env.log)[0]).toContain('--body Bash');
});

test('codex permission body: description, else the command, argv joined', () => {
  const env = install();
  const ask = (tool_input: object) =>
    hook(env, 'codex', 'waiting', {
      cwd: '/src/proj',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input,
    });
  ask({ command: 'npm test', description: 'Run the test suite' });
  ask({ command: 'npm test' });
  ask({ command: ['npm', 'run', 'build'] });
  const log = calls(env.log);
  expect(log[0]).toContain('--body Run the test suite');
  expect(log[1]).toContain('--body npm test');
  expect(log[2]).toContain('--body npm run build');
});

test('gemini maps its events and always answers {}', () => {
  const env = install();
  const base = { cwd: '/src/proj', session_id: 's1', transcript_path: '' };
  const note = (details: object, message: string, notification_type = 'ToolPermission') =>
    hook(env, 'gemini', 'waiting', { ...base, hook_event_name: 'Notification', notification_type, message, details });
  const outs = [
    hook(env, 'gemini', 'working', { ...base, hook_event_name: 'BeforeAgent', prompt: 'go' }),
    note({ type: 'exec', title: 'Shell', command: 'npm test', rootCommand: 'npm' }, 'Tool Shell requires execution'),
    note(
      { type: 'edit', title: 'WriteFile', filePath: '/src/proj/a.ts', fileName: 'a.ts' },
      'Tool WriteFile requires editing',
    ),
    note({ type: 'ask_user', title: 'Ask User' }, 'Tool requires confirmation'),
    note({ type: 'exec', title: 'Shell' }, 'Something else', 'SomethingElse'),
    hook(env, 'gemini', 'done', {
      ...base,
      hook_event_name: 'AfterAgent',
      prompt: 'go',
      prompt_response: 'All tests pass.',
    }),
    hook(env, 'gemini', 'clear', { ...base, hook_event_name: 'SessionEnd', reason: 'exit' }),
  ];
  for (const out of outs) expect(out.trim()).toBe('{}');
  const log = calls(env.log);
  expect(log).toHaveLength(6);
  expect(log[0]).toStartWith('state --session work --agent gemini --state working');
  expect(log[1]).toContain('--state waiting');
  expect(log[1]).toContain('--title proj · needs you');
  expect(log[1]).toContain('--body npm test');
  expect(log[2]).toContain('--body /src/proj/a.ts');
  expect(log[3]).toContain('--body Has a question for you');
  expect(log[4]).toContain('--state done');
  expect(log[4]).toContain('--body All tests pass.');
  expect(log[5]).toStartWith('state --session work --agent gemini --state clear');
});

function writeTranscript(file: string, lines: object[]) {
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
}

const cursorTranscript = [
  { role: 'user', message: { content: [{ type: 'text', text: '<user_query>run tests</user_query>' }] } },
  {
    role: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Running them.' },
        { type: 'tool_use', name: 'Shell', input: { command: 'npm test' } },
      ],
    },
  },
  { role: 'assistant', message: { content: [{ type: 'text', text: 'All tests pass.\nNothing else changed.' }] } },
  { type: 'summary', status: null },
];

test('cursor stop reads the whole last reply, error is a failure, sessionEnd clears', () => {
  const env = install();
  const transcript = path.join(env.home, 'c1.jsonl');
  writeTranscript(transcript, cursorTranscript);
  const base = { conversation_id: 'c1', cursor_version: '2026.10.01', workspace_roots: ['/src/proj'] };
  expect(
    hook(env, 'cursor', 'done', {
      ...base,
      hook_event_name: 'stop',
      status: 'completed',
      transcript_path: transcript,
    }).trim(),
  ).toBe('{}');
  hook(env, 'cursor', 'done', { ...base, hook_event_name: 'stop', status: 'error', transcript_path: transcript });
  hook(env, 'cursor', 'clear', { ...base, hook_event_name: 'sessionEnd', reason: 'completed' });
  const log = calls(env.log);
  expect(log[0]).toContain('--state done');
  expect(log[0]).toContain('--title proj · done');
  expect(log[0]).toContain('--body All tests pass. Nothing else changed.');
  expect(log[1]).toContain('--state done');
  expect(log[1]).toContain('--body Stopped with an error');
  expect(log[2]).toStartWith('state --session work --agent cursor --state clear');
});

test('cursor stop falls back to CURSOR_TRANSCRIPT_PATH', () => {
  const env = install();
  const transcript = path.join(env.home, 'c2.jsonl');
  writeTranscript(transcript, cursorTranscript);
  hook(
    env,
    'cursor',
    'done',
    { cursor_version: '2026.10.01', workspace_roots: ['/src/proj'], hook_event_name: 'stop', status: 'completed' },
    'work',
    { CURSOR_TRANSCRIPT_PATH: transcript },
  );
  expect(calls(env.log)[0]).toContain('--body All tests pass. Nothing else changed.');
});

test('claude done keeps a multi-line last reply whole', () => {
  const env = install();
  const transcript = path.join(env.home, 't.jsonl');
  writeTranscript(transcript, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'First.' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done here.\nTwo files changed.' }] } },
  ]);
  hook(env, 'claude', 'done', { cwd: '/src/proj', transcript_path: transcript });
  expect(calls(env.log)[0]).toContain('--body Done here. Two files changed.');
});

test('installer wires gemini beside foreign hooks and settings, once', () => {
  const env = install((home) => {
    writeFileSync(
      path.join(home, '.gemini/settings.json'),
      JSON.stringify({
        model: { name: 'm' },
        hooks: { AfterAgent: [{ matcher: '*', hooks: [{ type: 'command', name: 'other', command: 'other-hook' }] }] },
      }),
    );
  });
  expect(reinstall(env).exitCode).toBe(0);
  const wrapper = path.join(env.home, '.local/bin/tether-notify-hook');
  const gemini = JSON.parse(readFileSync(path.join(env.home, '.gemini/settings.json'), 'utf8'));
  expect(gemini.model).toEqual({ name: 'm' });
  for (const [event, state] of Object.entries(geminiEvents)) {
    const ours = gemini.hooks[event].filter((g: { hooks: { command: string }[] }) =>
      g.hooks.some((h) => h.command.includes('tether-notify-hook')),
    );
    expect(ours).toEqual([
      { matcher: '*', hooks: [{ type: 'command', name: 'tether', command: `'${wrapper}' gemini ${state}` }] },
    ]);
  }
  expect(gemini.hooks.AfterAgent).toHaveLength(2);
  expect(gemini.hooks.AfterAgent[0].hooks[0].command).toBe('other-hook');
});

test('installer skips gemini when it is not set up', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-hooks-'));
  const run = Bun.spawnSync(['sh', 'scripts/install-agent-hooks.sh', 'devbox'], {
    env: { ...process.env, HOME: home },
  });
  expect(run.exitCode).toBe(0);
  expect(() => readFileSync(path.join(home, '.gemini/settings.json'))).toThrow();
});

test('a settings file jq cannot parse is left untouched and warned about once', () => {
  const original = '// user comment\n{"hooks": {}}\n';
  const env = install((home) => writeFileSync(path.join(home, '.gemini/settings.json'), original));
  const again = reinstall(env);
  expect(again.exitCode).toBe(0);
  expect(readFileSync(path.join(env.home, '.gemini/settings.json'), 'utf8')).toBe(original);
  expect(again.stderr.match(/not plain JSON/g)).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(env.home, '.cursor/hooks.json'), 'utf8')).hooks.stop).toHaveLength(1);
});

const codexSnake = ['user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'permission_request', 'stop', 'session_end'];

function trustAll(
  home: string,
  index: (event: string) => number = () => 0,
  handler: (event: string) => number = () => 0,
) {
  const hooksFile = path.join(home, '.codex/hooks.json');
  const body = codexSnake
    .map((e) => `[hooks.state."${hooksFile}:${e}:${index(e)}:${handler(e)}"]\ntrusted_hash = "sha256:00"\n`)
    .join('\n');
  writeFileSync(path.join(home, '.codex/config.toml'), `model = "m"\n\n[hooks.state]\n\n${body}`);
}

test('installer names the codex hooks that still need trust', () => {
  const env = install();
  const first = reinstall(env).stdout;
  expect(first).toContain('Codex skips untrusted hooks');
  for (const e of codexSnake) expect(first).toContain(e);
  trustAll(env.home);
  expect(reinstall(env).stdout).not.toContain('Codex skips untrusted hooks');
});

test('reinstall keeps a codex hook in place ahead of a foreign one', () => {
  const env = install((home) => {
    writeFileSync(
      path.join(home, '.codex/hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: '/old/tether-notify-hook codex done' }] },
            { hooks: [{ type: 'command', command: 'foreign-hook' }] },
          ],
        },
      }),
    );
  });
  reinstall(env);
  const stop = JSON.parse(readFileSync(path.join(env.home, '.codex/hooks.json'), 'utf8')).hooks.Stop;
  const wrapper = path.join(env.home, '.local/bin/tether-notify-hook');
  expect(stop).toHaveLength(2);
  expect(stop[0].hooks[0].command).toBe(`'${wrapper}' codex done`);
  expect(stop[1].hooks[0].command).toBe('foreign-hook');
});

test('reinstall keeps a cursor hook in place ahead of a foreign one', () => {
  const env = install((home) => {
    writeFileSync(
      path.join(home, '.cursor/hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: '/old/tether-notify-hook cursor done' }, { command: 'foreign-hook' }],
        },
      }),
    );
  });
  reinstall(env);
  const stop = JSON.parse(readFileSync(path.join(env.home, '.cursor/hooks.json'), 'utf8')).hooks.stop;
  const wrapper = path.join(env.home, '.local/bin/tether-notify-hook');
  expect(stop).toHaveLength(2);
  expect(stop[0].command).toBe(`'${wrapper}' cursor done`);
  expect(stop[1].command).toBe('foreign-hook');
});

test('reinstall collapses duplicate tether groups onto the first one', () => {
  const env = install((home) => {
    writeFileSync(
      path.join(home, '.codex/hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'before' }] },
            { hooks: [{ type: 'command', command: '/old/tether-notify-hook codex done' }] },
            { hooks: [{ type: 'command', command: 'between' }] },
            { hooks: [{ type: 'command', command: '/older/tether-notify-hook codex done' }] },
          ],
        },
      }),
    );
  });
  reinstall(env);
  const stop = JSON.parse(readFileSync(path.join(env.home, '.codex/hooks.json'), 'utf8')).hooks.Stop;
  const wrapper = path.join(env.home, '.local/bin/tether-notify-hook');
  expect(stop.map((g: { hooks: { command: string }[] }) => g.hooks[0].command)).toEqual([
    'before',
    `'${wrapper}' codex done`,
    'between',
  ]);
});

test('reinstall keeps a foreign handler that shares a claude group with ours', () => {
  const env = install((home) => {
    mkdirSync(path.join(home, '.claude'));
    writeFileSync(
      path.join(home, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: '/old/tether-notify-hook claude done' },
                { type: 'command', command: 'other-hook' },
              ],
            },
          ],
        },
      }),
    );
  });
  reinstall(env);
  const stop = JSON.parse(readFileSync(path.join(env.home, '.claude/settings.json'), 'utf8')).hooks.Stop;
  const wrapper = path.join(env.home, '.local/bin/tether-notify-hook');
  expect(stop).toHaveLength(1);
  expect(stop[0].hooks.map((h: { command: string }) => h.command)).toEqual([`'${wrapper}' claude done`, 'other-hook']);
});

test('reinstall updates a gemini hook in place, including matcher and name', () => {
  const env = install((home) => {
    writeFileSync(
      path.join(home, '.gemini/settings.json'),
      JSON.stringify({
        hooks: {
          AfterAgent: [
            {
              matcher: 'specific',
              hooks: [
                { type: 'command', name: 'old', command: '/old/tether-notify-hook gemini done' },
                { type: 'command', command: 'other-hook' },
              ],
            },
          ],
        },
      }),
    );
  });
  reinstall(env);
  const groups = JSON.parse(readFileSync(path.join(env.home, '.gemini/settings.json'), 'utf8')).hooks.AfterAgent;
  const wrapper = path.join(env.home, '.local/bin/tether-notify-hook');
  expect(groups).toHaveLength(1);
  expect(groups[0].matcher).toBe('*');
  expect(groups[0].hooks.map((h: { command: string; name?: string }) => h.command)).toEqual([
    `'${wrapper}' gemini done`,
    'other-hook',
  ]);
  expect(groups[0].hooks[0].name).toBe('tether');
});

test('a symlinked codex hooks file keeps its target and mode', () => {
  let target = '';
  const env = install((home) => {
    target = path.join(home, 'codex-hooks.json');
    writeFileSync(target, '{}\n');
    chmodSync(target, 0o644);
    symlinkSync(target, path.join(home, '.codex/hooks.json'));
  });
  const link = path.join(env.home, '.codex/hooks.json');
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(target);
  expect(statSync(target).mode & 0o777).toBe(0o644);
  const hooks = JSON.parse(readFileSync(target, 'utf8')).hooks;
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd']) {
    expect(hooks[event]).toHaveLength(1);
  }
});

test('empty gemini and cursor configs receive our hooks', () => {
  const env = install((home) => {
    writeFileSync(path.join(home, '.gemini/settings.json'), '');
    writeFileSync(path.join(home, '.cursor/hooks.json'), ' \n\t');
  });
  const gemini = JSON.parse(readFileSync(path.join(env.home, '.gemini/settings.json'), 'utf8'));
  const cursor = JSON.parse(readFileSync(path.join(env.home, '.cursor/hooks.json'), 'utf8'));
  for (const event of Object.keys(geminiEvents)) {
    expect(gemini.hooks[event]).toHaveLength(1);
  }
  for (const event of ['beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd']) {
    expect(cursor.hooks[event]).toHaveLength(1);
  }
});

test('a claude prompt hook is kept and every tether event is registered', () => {
  const env = install((home) => {
    mkdirSync(path.join(home, '.claude'));
    writeFileSync(
      path.join(home, '.claude/settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] } }),
    );
  });
  const settings = JSON.parse(readFileSync(path.join(env.home, '.claude/settings.json'), 'utf8'));
  for (const event of [
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Notification',
    'Stop',
    'StopFailure',
    'SessionEnd',
  ]) {
    const ours = settings.hooks[event].filter((g: { hooks: { command?: string }[] }) =>
      g.hooks.some((h) => (h.command ?? '').includes('tether-notify-hook')),
    );
    expect(ours).toHaveLength(1);
  }
  const stopHooks = settings.hooks.Stop.flatMap((g: { hooks: { type?: string; prompt?: string }[] }) => g.hooks);
  expect(stopHooks).toContainEqual({ type: 'prompt', prompt: 'x' });
});

test('jsonc gemini settings stay unwired', () => {
  const original = '// user comment\n{"hooks": {}}\n';
  const env = install((home) => writeFileSync(path.join(home, '.gemini/settings.json'), original));
  const again = reinstall(env);
  expect(again.stdout).not.toContain('Registered Gemini CLI hooks.');
  const wired = (again.stdout.match(/^Agents wired: (.*)\.$/m) ?? ['', ''])[1];
  expect(wired.split(' ')).not.toContain('gemini');
  expect(readFileSync(path.join(env.home, '.gemini/settings.json'), 'utf8')).toBe(original);
});

test('codex trust key uses our handler index within the group', () => {
  const env = install((home) => {
    writeFileSync(
      path.join(home, '.codex/hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'foreign-hook' },
                { type: 'command', command: '/old/tether-notify-hook codex done' },
              ],
            },
          ],
        },
      }),
    );
  });
  const hooksFile = path.join(env.home, '.codex/hooks.json');
  trustAll(env.home);
  const missed = reinstall(env).stdout;
  expect(missed).toContain('Codex skips untrusted hooks');
  expect(missed).toMatch(/\(stop\)/);
  trustAll(
    env.home,
    () => 0,
    (event) => (event === 'stop' ? 1 : 0),
  );
  expect(reinstall(env).stdout).not.toContain('Codex skips untrusted hooks');
  expect(readFileSync(path.join(env.home, '.codex/config.toml'), 'utf8')).toContain(
    `[hooks.state."${hooksFile}:stop:0:1"]`,
  );
});

test('codex trust is checked at our position, after a foreign hook group', () => {
  const env = install((home) => {
    writeFileSync(
      path.join(home, '.codex/hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-hook' }] }] } }),
    );
  });
  trustAll(env.home); // every key at index 0, but our Stop entry sits at index 1
  const out = reinstall(env).stdout;
  expect(out).toContain('Codex skips untrusted hooks');
  expect(out).toMatch(/\(stop\)/);
  trustAll(env.home, (e) => (e === 'stop' ? 1 : 0));
  expect(reinstall(env).stdout).not.toContain('Codex skips untrusted hooks');
});
