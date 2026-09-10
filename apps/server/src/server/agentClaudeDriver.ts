import type { AgentDriver, AgentEvent } from './agentDriver';

const MAX_TOOL_RESULT_CHARS = 4000;

interface ClaudeContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

/**
 * Pure translation of one NDJSON line from `claude --output-format
 * stream-json` into zero, one, or several AgentEvents. No I/O — kept
 * separate so the mapping is unit-testable without spawning the CLI.
 */
export function mapClaudeLine(line: string): AgentEvent | AgentEvent[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof msg !== 'object' || msg === null) return null;
  const obj = msg as Record<string, unknown>;

  switch (obj.type) {
    case 'system':
      // init carries session_id; the caller extracts it separately.
      return null;

    case 'stream_event': {
      const event = obj.event as Record<string, unknown> | undefined;
      if (
        event?.type === 'content_block_delta' &&
        (event.delta as Record<string, unknown> | undefined)?.type === 'text_delta'
      ) {
        const text = (event.delta as Record<string, unknown>).text;
        if (typeof text === 'string') return { t: 'delta', text };
      }
      return null;
    }

    case 'assistant': {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) return null;
      const events: AgentEvent[] = [];
      for (const block of content as ClaudeContentBlock[]) {
        if (block.type === 'tool_use') {
          events.push({ t: 'tool', name: block.name ?? '', input: block.input });
        }
      }
      return events.length > 0 ? events : null;
    }

    case 'user': {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) return null;
      const events: AgentEvent[] = [];
      for (const block of content as ClaudeContentBlock[]) {
        if (block.type !== 'tool_result') continue;
        const text = toolResultText(block.content);
        events.push({
          t: 'tool_result',
          text: text.slice(0, MAX_TOOL_RESULT_CHARS),
          isError: block.is_error === true,
        });
      }
      return events.length > 0 ? events : null;
    }

    case 'result': {
      const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0;
      const u = (obj.usage ?? {}) as Record<string, unknown>;
      const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
      // Everything that counted toward the context window this turn, so the
      // phone footer reflects real usage (cache reads/writes included), not just
      // fresh input.
      const inputTokens =
        n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
      const outputTokens = n(u.output_tokens);
      return {
        t: 'done',
        cost,
        usage: {
          duration_ms: obj.duration_ms,
          is_error: obj.is_error === true,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      };
    }

    default:
      return null;
  }
}

function toolResultText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => c.text ?? '')
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** True for the `stream_event` that opens a NEW assistant message (a reasoning
 * step boundary) — used by the driver loop to insert a paragraph break
 * between consecutive steps that emit no tool call in between. */
export function isMessageStartEvent(line: string): boolean {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type !== 'stream_event') return false;
    const event = obj.event as Record<string, unknown> | undefined;
    return event?.type === 'message_start';
  } catch {
    return false;
  }
}

function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
      return obj.session_id;
    }
  } catch {
    // not JSON / not init — ignore
  }
  return null;
}

/** The `model` the init line reports (e.g. "claude-opus-4-8"), or null. */
export function extractModel(line: string): string | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.model === 'string') {
      return obj.model;
    }
  } catch {
    // not JSON / not init — ignore
  }
  return null;
}

type ClaudeProc = ReturnType<typeof Bun.spawn>;

/** Wraps the `claude` CLI in headless streaming mode as the production AgentDriver. */
/** Assemble the `claude --print` argv. Pure so the flag logic is unit-tested
 * without spawning. `--dangerously-skip-permissions`: headless `--print`
 * otherwise auto-DENIES any tool needing approval (Write/Edit/Bash), so nothing
 * could mutate files. Real per-tool approval (canUseTool) is a later pass.
 * `--` terminates option parsing so a prompt starting with `-` can't be misread
 * as an option. */
export function buildClaudeArgs(opts: {
  text: string;
  sessionId: string | null;
  model: string | null;
}): string[] {
  const args = [
    'claude',
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  args.push('--', opts.text);
  return args;
}

export class AgentClaudeDriver implements AgentDriver {
  private cwd = '';
  private sessionId: string | null = null;
  private currentModel: string | null = null;
  private child: ClaudeProc | null = null;

  async start(cwd: string): Promise<void> {
    this.cwd = cwd;
  }

  getModel(): string | null {
    return this.currentModel;
  }

  /** Client-chosen model for this chat's next spawns (`/model`). */
  setModel(name: string | null): void {
    this.currentModel = name;
  }

  /** Resume a foreign Claude session id (`/resume`) — the first spawn passes it
   * to `--resume` and the CLI continues that conversation. */
  seedResume(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** Capture session id + model from a `system`/init line (both no-ops otherwise).
   * A user-set model wins: only adopt the CLI's reported model if none is set. */
  private captureInit(line: string): void {
    const sid = extractSessionId(line);
    if (sid) this.sessionId = sid;
    const model = extractModel(line);
    if (model && this.currentModel === null) this.currentModel = model;
  }

  async *prompt(text: string): AsyncIterable<AgentEvent> {
    const args = buildClaudeArgs({ text, sessionId: this.sessionId, model: this.currentModel });

    // Force the CLI's own subscription login (claude login), never API billing.
    // Both credential envs are stripped so a stray key/token in the daemon's
    // environment can't silently route agent turns to paid API usage — the CLI
    // then falls through to its stored OAuth login (apiKeySource: "none").
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const child = Bun.spawn(args, {
      cwd: this.cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.child = child;
    // Drain stderr concurrently with stdout: claude's own stdout loop below
    // can otherwise stall forever once the OS pipe buffer for stderr fills.
    const stderrText = new Response(child.stderr).text();
    stderrText.catch(() => {});

    // Claude emits several assistant messages per turn (reasoning steps). With
    // no tool call between two of them the text otherwise glues together with
    // no separator — insert a synthetic blank-line delta at each new message
    // that follows text we've already emitted.
    let hasEmittedText = false;
    let sawMessageStart = false;

    const handleLine = (line: string): AgentEvent[] => {
      this.captureInit(line);
      if (isMessageStartEvent(line)) {
        const events: AgentEvent[] = [];
        if (sawMessageStart && hasEmittedText) events.push({ t: 'delta', text: '\n\n' });
        sawMessageStart = true;
        return events;
      }
      const mapped = mapClaudeLine(line);
      if (mapped === null) return [];
      const events = Array.isArray(mapped) ? mapped : [mapped];
      for (const ev of events) {
        if (ev.t === 'delta') hasEmittedText = true;
      }
      return events;
    };

    try {
      let buf = '';
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf('\n');
        while (idx !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
          for (const ev of handleLine(line)) yield ev;
        }
      }
      if (buf.trim()) {
        for (const ev of handleLine(buf)) yield ev;
      }

      const exitCode = await child.exited;
      if (exitCode !== 0) {
        const stderr = await stderrText;
        yield { t: 'error', message: stderr.trim() || `claude exited with code ${exitCode}` };
      }
    } catch (err) {
      yield { t: 'error', message: err instanceof Error ? err.message : String(err) };
    } finally {
      if (this.child === child) this.child = null;
    }
  }

  interrupt(): void {
    this.child?.kill();
  }

  close(): void {
    this.child?.kill();
    this.child = null;
  }
}
