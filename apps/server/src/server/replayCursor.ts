/**
 * Opaque replay cursors — protocol v2's replacement for the integer `sinceId`.
 *
 * v1 hands the client `terminal_logs.id` and takes it back verbatim, which
 * welds the client to the log store's primary key: a ring-buffer file, log
 * compaction, or a per-session id space all become client-visible breaks. v2
 * hands out an opaque token instead. Today it happens to wrap a row id; that is
 * an implementation detail this module is the only place to know.
 *
 * The token is a base64url blob carrying a version, the session id it was
 * issued for, the position, and a checksum. It is NOT authenticated — the WS is
 * already token-authed, so this only has to stop a *stale or foreign* cursor
 * from being read as a valid position, not stop a forgery. A client that forges
 * one can replay its own session's scrollback, which it may do anyway.
 *
 * No migration: the position is derived from a column that already exists.
 */

export const CURSOR_VERSION = 1;

/** A fresh client with no cursor replays from the start of the retained tail. */
export const REPLAY_START = 0;

const SALT = 'tether/replay-cursor';

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function fromBase64Url(text: string): string | null {
  try {
    const decoded = Buffer.from(text, 'base64url').toString('utf8');
    // base64url decoding is lenient: it happily eats junk and returns
    // mojibake. Re-encoding is the cheap way to reject that.
    return Buffer.from(decoded, 'utf8').toString('base64url') === text ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Mints the cursor a v2 client should send back to resume after `logId`.
 *
 * `sessionId` is baked in so a cursor cannot be replayed against a different
 * session — session ids are client-chosen and reused, so a cursor leaking across
 * tabs would silently skip real output.
 */
export function encodeReplayCursor(sessionId: string, logId: number): string {
  const body = `${CURSOR_VERSION}.${Math.max(0, Math.trunc(logId))}.${sessionId}`;
  return toBase64Url(`${fnv1a32(SALT + body)}.${body}`);
}

/**
 * Reads a cursor back. Returns `null` for anything that is not a cursor this
 * server issued for this session — malformed, tampered, a different version, or
 * another session's. Callers treat null as "no cursor": replay the retained
 * tail, exactly as a first connect does.
 */
export function decodeReplayCursor(
  cursor: string | null | undefined,
  sessionId: string,
): number | null {
  if (!cursor) return null;
  const decoded = fromBase64Url(cursor);
  if (decoded === null) return null;
  const firstDot = decoded.indexOf('.');
  if (firstDot === -1) return null;
  const checksum = decoded.slice(0, firstDot);
  const body = decoded.slice(firstDot + 1);
  if (checksum !== fnv1a32(SALT + body)) return null;
  const parts = body.split('.');
  if (parts.length < 3) return null;
  const [version, position] = parts;
  if (Number(version) !== CURSOR_VERSION) return null;
  // The session id may itself contain dots — everything after the position is it.
  if (parts.slice(2).join('.') !== sessionId) return null;
  if (!/^\d+$/.test(position)) return null;
  const logId = Number(position);
  return Number.isSafeInteger(logId) ? logId : null;
}

/** Resolves the `?cursor=` query param to a log position for a v2 socket. */
export function replayPositionFromCursor(
  cursor: string | null | undefined,
  sessionId: string,
): number {
  return decodeReplayCursor(cursor, sessionId) ?? REPLAY_START;
}
