import type { Config } from './config';

export type NotificationEvent =
  | { type: 'waiting' }
  | { type: 'oscNotify'; title?: string; body?: string }
  | { type: 'exit'; exitCode?: number }
  | { type: 'longJob'; seconds: number };

export interface NotificationContext {
  sessionId: string;
  sessionTitle: string;
}

export interface NtfyPayload {
  topic: string;
  title: string;
  message: string;
  tags: string[];
  priority?: number;
  click: string;
}

export function buildTestNotification(): NtfyPayload {
  return {
    topic: '',
    title: 'Tether test notification',
    message: 'Notifications from this Tether server are working.',
    tags: ['tether'],
    click: 'tether://',
  };
}

export function buildNotification(
  event: NotificationEvent,
  ctx: NotificationContext,
  cfg: Config,
): NtfyPayload | null {
  if (!cfg.notify.enabled || !cfg.notify.topic || !cfg.triggers[event.type]) return null;
  const title = `${cfg.identity.name} · ${event.type === 'oscNotify' && event.title ? event.title : ctx.sessionTitle}`;
  const message =
    event.type === 'waiting'
      ? 'Waiting for input'
      : event.type === 'oscNotify'
        ? (event.body ?? event.title ?? 'Notification')
        : event.type === 'exit'
          ? `Session exited${event.exitCode === undefined ? '' : ` with code ${event.exitCode}`}`
          : `Job ran for ${event.seconds} seconds`;
  return {
    topic: cfg.notify.topic,
    title,
    message,
    tags: [event.type],
    ...(event.type === 'waiting' ? { priority: 4 } : {}),
    click: `tether://session/${encodeURIComponent(ctx.sessionId)}?host=${encodeURIComponent(cfg.identity.name)}`,
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function deliver(payload: NtfyPayload, cfg: Config, fetcher: Fetch = fetch): Promise<void> {
  const url = `${cfg.notify.url.replace(/\/+$/, '')}/${encodeURIComponent(payload.topic)}`;
  const post = () =>
    fetcher(url, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.notify.token ? { Authorization: `Bearer ${cfg.notify.token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  try {
    const first = await post();
    if (!first.ok) throw new Error(`ntfy returned ${first.status}`);
  } catch (error) {
    const retry = await post();
    if (!retry.ok) throw new Error(`ntfy returned ${retry.status}`);
  }
}

export async function send(
  payload: NtfyPayload,
  cfg: Config,
  fetcher: Fetch = fetch,
): Promise<void> {
  try {
    await deliver(payload, cfg, fetcher);
  } catch (error) {
    console.warn('Notification delivery failed:', error instanceof Error ? error.message : error);
  }
}

export async function sendTestNotification(cfg: Config, fetcher: Fetch = fetch): Promise<void> {
  if (!cfg.notify.topic) throw new Error('Notification topic is required');
  const payload = { ...buildTestNotification(), topic: cfg.notify.topic };
  await deliver(payload, cfg, fetcher);
}
