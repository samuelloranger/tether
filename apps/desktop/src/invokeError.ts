/// Tauri rejects a failed command with the command's error payload — for our
/// `Result<_, String>` commands that is a plain STRING, not an Error. Every
/// `err instanceof Error` check downstream therefore missed, and the real
/// reason ("Unreachable — check the host and port.", "Wrong password.", …) was
/// replaced by a generic fallback. Normalise once, at the boundary.
export function normalizeInvokeError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  if (typeof raw === 'string') return new Error(raw);
  // Some Tauri failures arrive as `{ message }` or a serialised struct; prefer a
  // readable field over `String(object)`, which would yield "[object Object]".
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const key of ['message', 'msg', 'error']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return new Error(value);
    }
    try {
      return new Error(JSON.stringify(raw));
    } catch {
      return new Error('Unknown error');
    }
  }
  if (raw === null || raw === undefined) return new Error('Unknown error');
  return new Error(String(raw));
}
