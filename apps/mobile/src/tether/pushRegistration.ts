// Pure registration logic. Deliberately free of Expo imports so it can be
// tested without a device: the hook supplies the token, the key, and the host
// clients, and this decides what to send where and what to remember.

export interface PushRegistrationTarget {
  hostId: string;
  post: (
    path: string,
    init?: { body?: string; headers?: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
  }>;
}

export interface PushRegistrationResult {
  hostId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * APNs hands out tokens as either a hex string or, on some paths, a bracketed
 * `<xxxx xxxx>` description. Normalise to bare lowercase hex — the server and
 * relay both validate a strict 64-char hex token.
 */
export function normalizeDeviceToken(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 64 ? hex : null;
}

/**
 * A registration is only worth re-sending when something actually changed.
 * Devices re-register on every launch, and without this every cold start would
 * write to every configured host.
 */
export function needsRegistration(
  previous: { deviceToken: string; secretKey: string } | null,
  next: { deviceToken: string; secretKey: string },
): boolean {
  if (!previous) return true;
  return previous.deviceToken !== next.deviceToken || previous.secretKey !== next.secretKey;
}

/**
 * Tell a host to forget this device. Must be called BEFORE the host profile is
 * removed locally: once its credentials are gone the app can no longer reach
 * it, and the server would keep the encryption key and keep pushing forever
 * with no way for the user to revoke it from the app.
 */
export async function unregisterFromHost(
  target: PushRegistrationTarget,
  deviceToken: string,
): Promise<boolean> {
  try {
    const response = await target.post('/api/push/unregister', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceToken }),
    });
    return response.ok;
  } catch {
    // Best effort — an unreachable host must not block removing it locally.
    return false;
  }
}

export async function registerWithHosts(
  targets: PushRegistrationTarget[],
  payload: { deviceToken: string; secretKey: string; label?: string },
): Promise<PushRegistrationResult[]> {
  // Hosts are independently failable — one unreachable server must not stop
  // the others from registering.
  return Promise.all(
    targets.map(async (target) => {
      try {
        const response = await target.post('/api/push/register', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { hostId: target.hostId, ok: response.ok, status: response.status };
      } catch (error) {
        return {
          hostId: target.hostId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
