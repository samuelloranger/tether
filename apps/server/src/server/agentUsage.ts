import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One rate-limit window as the Claude OAuth usage endpoint reports it. */
export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/** The 5-hour + 7-day windows Claude Code's `/usage` surfaces. */
export interface AgentUsageLimits {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Claude Code sends this beta header on the OAuth usage call.
const OAUTH_BETA = 'oauth-2025-04-20';
const TTL_MS = 60_000;

/** Pull one window ({utilization, resets_at}) out of the raw endpoint JSON. */
function toWindow(v: unknown): UsageWindow | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  if (typeof w.utilization !== 'number') return null;
  return {
    utilization: w.utilization,
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
  };
}

/** Pure parser for the usage endpoint body; null when neither window is present. */
export function parseUsageLimits(json: unknown): AgentUsageLimits | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const fiveHour = toWindow(o.five_hour);
  const sevenDay = toWindow(o.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

/** Read the Claude Code OAuth access token from `~/.claude/.credentials.json`.
 * Returns null on any failure — the caller degrades to "usage unavailable". */
export function readClaudeToken(): string | null {
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const d = JSON.parse(raw) as Record<string, unknown>;
    const o = (d.claudeAiOauth ?? d) as Record<string, unknown>;
    const t = o.accessToken ?? o.access_token;
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export interface UsageFetchDeps {
  now?: number;
  fetchImpl?: typeof fetch;
  readToken?: () => string | null;
}

let cache: { at: number; val: AgentUsageLimits | null } | null = null;

/** Reset the module cache — tests only. */
export function resetUsageCache(): void {
  cache = null;
}

/**
 * Fetch the account's 5h/7day usage via the same OAuth endpoint Claude Code's
 * `/usage` uses. Cached for {@link TTL_MS} so a chat that ends many turns does
 * not hammer the endpoint. Any failure (no token, non-2xx, network, bad body)
 * resolves to null rather than throwing — usage is advisory, never fatal to a
 * chat. The `deps` seam keeps it unit-testable without real I/O.
 */
export async function fetchAgentUsage(deps: UsageFetchDeps = {}): Promise<AgentUsageLimits | null> {
  const now = deps.now ?? Date.now();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readToken = deps.readToken ?? readClaudeToken;
  if (cache && now - cache.at < TTL_MS) return cache.val;

  const token = readToken();
  if (!token) {
    cache = { at: now, val: null };
    return null;
  }
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
    });
    const val = res.ok ? parseUsageLimits(await res.json()) : null;
    cache = { at: now, val };
    return val;
  } catch {
    cache = { at: now, val: null };
    return null;
  }
}
