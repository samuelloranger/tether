/// Tauri rejects `Result<_, String>` commands with a plain STRING, not an
/// Error, so `err instanceof Error` checks downstream missed it. Normalise once, at the boundary.
export function normalizeInvokeError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  if (typeof raw === 'string') return new Error(raw);
  // Prefer a readable field over String(object), which yields "[object Object]".
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
