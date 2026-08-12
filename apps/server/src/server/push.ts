import type { Config } from './config';
import type { NotificationContext, NotificationEvent } from './notifier';
import { encryptPushContent, type PushContent } from './pushCrypto';
import { listPushDevices, markPushDeviceUsed, removePushDevice } from './pushDevices';

export interface RelayRequest {
  token: string;
  ciphertext: string;
  collapseId: string;
}

/**
 * The human-readable half of a push, before encryption. Kept pure and separate
 * from delivery so the wording is testable without a device, a relay, or Apple
 * — the same split `notifier.ts` uses for ntfy.
 */
export function buildPushContent(
  event: NotificationEvent,
  ctx: NotificationContext,
  cfg: Config,
): PushContent | null {
  // No relay configured means no delivery path — bail before building content
  // rather than failing per-device later.
  if (!cfg.push.enabled || !cfg.push.relayUrl || !cfg.triggers[event.type]) return null;
  const title = `${cfg.identity.name} · ${
    event.type === 'oscNotify' && event.title ? event.title : ctx.sessionTitle
  }`;
  const body =
    event.type === 'waiting'
      ? 'Waiting for input'
      : event.type === 'oscNotify'
        ? (event.body ?? event.title ?? 'Notification')
        : event.type === 'exit'
          ? `Session exited${event.exitCode === undefined ? '' : ` with code ${event.exitCode}`}`
          : `Job ran for ${event.seconds} seconds`;
  return {
    title,
    body,
    link: `tether://session/${encodeURIComponent(ctx.sessionId)}?host=${encodeURIComponent(
      cfg.identity.name,
    )}`,
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Deliver one push. A 410 means the app was uninstalled: the relay holds no
 * state, so this server is the only place that can forget the token.
 */
async function deliverToDevice(
  relayUrl: string,
  request: RelayRequest,
  fetcher: Fetch,
): Promise<void> {
  const response = await fetcher(`${relayUrl.replace(/\/+$/, '')}/push`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response.status === 410) {
    removePushDevice(request.token);
    return;
  }
  if (!response.ok) throw new Error(`relay returned ${response.status}`);
  markPushDeviceUsed(request.token);
}

/**
 * Fan a notification out to every registered device. Failures are logged and
 * swallowed: notification delivery is advisory and must never block the PTY.
 */
export async function sendPush(
  content: PushContent,
  ctx: NotificationContext,
  cfg: Config,
  fetcher: Fetch = fetch,
): Promise<void> {
  const devices = listPushDevices();
  if (devices.length === 0) return;
  await Promise.all(
    devices.map(async (device) => {
      try {
        await deliverToDevice(
          cfg.push.relayUrl,
          {
            token: device.deviceToken,
            ciphertext: await encryptPushContent(device.secretKey, content),
            collapseId: ctx.sessionId.slice(0, 64),
          },
          fetcher,
        );
      } catch (error) {
        console.warn('Push delivery failed:', error instanceof Error ? error.message : error);
      }
    }),
  );
}
