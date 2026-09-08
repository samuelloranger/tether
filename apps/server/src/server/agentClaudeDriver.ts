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
      return {
        t: 'done',
        cost,
        usage: { duration_ms: obj.duration_ms, is_error: obj.is_error === true },
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

type ClaudeProc = ReturnType<typeof Bun.spawn>;

/** Wraps the `claude` CLI in headless streaming mode as the production AgentDriver. */
export class AgentClaudeDriver implements AgentDriver {
  private cwd = '';
  private sessionId: string | null = null;
  private child: ClaudeProc | null = null;

  async start(cwd: string): Promise<void> {
    this.cwd = cwd;
  }

  async *prompt(text: string): AsyncIterable<AgentEvent> {
    const args = [
      'claude',
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (this.sessionId) args.push('--resume', this.sessionId);
    args.push('-p', text);

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

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
          const sid = extractSessionId(line);
          if (sid) this.sessionId = sid;
          const mapped = mapClaudeLine(line);
          if (mapped === null) continue;
          for (const ev of Array.isArray(mapped) ? mapped : [mapped]) yield ev;
        }
      }
      if (buf.trim()) {
        const sid = extractSessionId(buf);
        if (sid) this.sessionId = sid;
        const mapped = mapClaudeLine(buf);
        if (mapped !== null) {
          for (const ev of Array.isArray(mapped) ? mapped : [mapped]) yield ev;
        }
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
