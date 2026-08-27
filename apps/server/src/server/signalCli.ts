import { readFileSync } from 'node:fs';
import type { SignalState } from './sessionActivity';

export type SignalArgs =
  | { kind: 'send'; state: SignalState; title?: string; body?: string }
  | { kind: 'hooks' };

const STATES: readonly string[] = ['working', 'waiting', 'done'];

const USAGE =
  'Usage: tether signal <working|waiting|done> [--title T] [--body B] | tether signal hooks';

export function parseSignalArgs(argv: string[]): SignalArgs {
  if (argv[0] === 'hooks') {
    if (argv.length > 1) throw new Error(USAGE);
    return { kind: 'hooks' };
  }
  if (!argv[0] || !STATES.includes(argv[0])) throw new Error(USAGE);
  const out: Extract<SignalArgs, { kind: 'send' }> = {
    kind: 'send',
    state: argv[0] as SignalState,
  };
  for (let i = 1; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (!value || (argv[i] !== '--title' && argv[i] !== '--body')) throw new Error(USAGE);
    if (argv[i] === '--title') out.title = value;
    if (argv[i] === '--body') out.body = value;
  }
  return out;
}

export interface SignalDeps {
  /** Loopback origin of the running daemon, chosen by main.ts from the listener plan. */
  baseUrl: string;
  tokenFile: string;
  /** `TETHER_SESSION_ID`, exported into every session by pty.ts. */
  sessionId?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function runSignal(args: SignalArgs, deps: SignalDeps): Promise<void> {
  if (args.kind === 'hooks') {
    console.log(claudeHookSnippet());
    // Printed after the JSON, not inside it, so the block above stays pasteable.
    console.log(
      '\n# Paste the "hooks" block into ~/.claude/settings.json.\n' +
        '# Then remove "preferredNotifChannel": "ghostty" if you have it — the\n' +
        '# hooks replace it, and tether suppresses the duplicate OSC push anyway.',
    );
    return;
  }
  // Refuse rather than guess. There is no safe default session: signalling the
  // wrong tab is worse than not signalling at all, because it marks a shell you
  // are not looking at as finished.
  if (!deps.sessionId) {
    throw new Error('No TETHER_SESSION_ID — run this from inside a tether session.');
  }
  const token = readFileSync(deps.tokenFile, 'utf8').trim();
  const res = await (deps.fetch ?? fetch)(`${deps.baseUrl}/control/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Tether-Present-Control': token },
    body: JSON.stringify({
      sessionId: deps.sessionId,
      state: args.state,
      ...(args.title ? { title: args.title } : {}),
      ...(args.body ? { body: args.body } : {}),
    }),
    // Loopback to our own self-signed certificate. The control token, not the
    // certificate chain, is what authorises this call.
    tls: { rejectUnauthorized: false },
  } as RequestInit);
  if (!res.ok) throw new Error(`Tether signal failed (${res.status}). Is tether running?`);
}

/**
 * The Claude Code hook configuration, printed for the user to paste into
 * `~/.claude/settings.json`.
 *
 * Printed rather than written: this edits a file the user owns and may have
 * hand-tuned, and a merge this CLI gets wrong costs them their whole hook
 * setup. The two events are what make this worth doing at all — `Notification`
 * fires when Claude is blocked on permission or input, `Stop` when a turn ends,
 * and those are exactly the two things the OSC 777 stream cannot tell apart.
 */
export function claudeHookSnippet(): string {
  const hook = (state: 'waiting' | 'done') => [
    { hooks: [{ type: 'command', command: `tether signal ${state}` }] },
  ];
  return JSON.stringify({ hooks: { Notification: hook('waiting'), Stop: hook('done') } }, null, 2);
}
