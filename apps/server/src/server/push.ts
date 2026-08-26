import type { Config } from './config';
import { logWarn } from './log';
import type { NotificationContext, NotificationEvent } from './notifications';
import { encryptPushContent, type PushContent } from './pushCrypto';
import { listPushDevices, markPushDeviceUsed, removePushDevice } from './pushDevices';
import { PUSH_RELAY_URL } from './pushRelay';

export interface RelayRequest {
  token: string;
  ciphertext: string;
  collapseId: string;
}

// The relay caps ciphertext at 3000 chars, and base64 of (nonce + plaintext +
// GCM tag) inflates by ~4/3, so plaintext must stay well under that or an
// otherwise valid long OSC notification is rejected and silently dropped.
// These budgets leave ample headroom for the JSON envelope and the link.
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 800;

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * The human-readable half of a push, before encryption. Kept pure and separate
 * from delivery so the wording is testable without a device, a relay, or Apple.
 */
export function buildPushContent(
  event: NotificationEvent,
  ctx: NotificationContext,
  cfg: Config,
): PushContent | null {
  if (!cfg.push.enabled || !cfg.triggers[event.type]) return null;
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
    title: truncate(title, MAX_TITLE_CHARS),
    body: truncate(body, MAX_BODY_CHARS),
    link: `tether://session/${encodeURIComponent(ctx.sessionId)}?host=${encodeURIComponent(
      cfg.identity.name,
    )}`,
  };
}

export function buildTestPushContent(cfg: Config): PushContent {
  return {
    title: `${cfg.identity.name} · Test`,
    body: 'Notifications from this Tether server are working.',
    link: 'tether://',
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Deliver one push. A 410 means the app was uninstalled: the relay holds no
 * state, so this server is the only place that can forget the token.
 *
 * Reports whether anything actually arrived. Pruning a dead token is a
 * successful bit of housekeeping but a failed delivery, and the test path has
 * to tell those apart — otherwise a server whose every token is stale answers
 * "Test notification sent." having sent nothing.
 */
async function deliverToDevice(request: RelayRequest, fetcher: Fetch): Promise<'sent' | 'gone'> {
  const response = await fetcher(`${PUSH_RELAY_URL.replace(/\/+$/, '')}/push`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response.status === 410) {
    removePushDevice(request.token);
    return 'gone';
  }
  if (!response.ok) throw new Error(`relay returned ${response.status}`);
  markPushDeviceUsed(request.token);
  return 'sent';
}

async function requestFor(
  device: { deviceToken: string; secretKey: string },
  content: PushContent,
  collapseId: string,
): Promise<RelayRequest> {
  return {
    token: device.deviceToken,
    ciphertext: await encryptPushContent(device.secretKey, content),
    collapseId,
  };
}

/**
 * Fan a notification out to every registered device. Failures are logged and
 * swallowed: notification delivery is advisory and must never block the PTY.
 */
export async function sendPush(
  content: PushContent,
  ctx: NotificationContext,
  fetcher: Fetch = fetch,
): Promise<void> {
  const devices = listPushDevices();
  if (devices.length === 0) return;
  await Promise.all(
    devices.map(async (device) => {
      try {
        await deliverToDevice(
          await requestFor(device, content, ctx.sessionId.slice(0, 64)),
          fetcher,
        );
      } catch (error) {
        logWarn('Push delivery failed:', error instanceof Error ? error.message : error);
      }
    }),
  );
}

/**
 * Deliver a test push, reporting failures instead of swallowing them — this is
 * the one path where the user is watching for an answer, so "no devices" and
 * "the relay refused" have to reach the UI rather than the server log.
 */
export async function sendTestPush(cfg: Config, fetcher: Fetch = fetch): Promise<void> {
  const devices = listPushDevices();
  if (devices.length === 0)
    throw new Error('No devices are registered for push on this server yet.');
  const content = buildTestPushContent(cfg);
  const results = await Promise.allSettled(
    devices.map(async (device) =>
      deliverToDevice(await requestFor(device, content, 'tether-test'), fetcher),
    ),
  );
  // One phone out of several failing still proves the path works, so success is
  // "at least one device actually received it" — not "nothing threw". A pruned
  // 410 resolves, so counting fulfilled promises would call an all-stale server
  // a success.
  if (results.some((result) => result.status === 'fulfilled' && result.value === 'sent')) return;
  const failure = results.find((result) => result.status === 'rejected');
  if (failure)
    throw new Error(
      failure.reason instanceof Error ? failure.reason.message : 'Push delivery failed.',
    );
  throw new Error(
    'Every registered device was rejected by Apple and has been removed. Reopen Tether on your phone to register it again.',
  );
}
