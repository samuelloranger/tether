import { z } from 'zod';

// A push is either Phase 1 (cleartext generic text, no NSE required) or Phase 2
// (ciphertext the Notification Service Extension decrypts on-device). The relay
// must never be handed both — that would mean a caller leaked readable text
// alongside the encrypted copy it was supposed to replace.
export const pushRequestSchema = z
  .object({
    token: z.string().regex(/^[0-9a-fA-F]{64}$/, 'token must be a 64-char hex APNs device token'),
    title: z.string().min(1).max(100).optional(),
    body: z.string().min(1).max(300).optional(),
    ciphertext: z.string().min(1).max(3000).optional(),
    collapseId: z.string().min(1).max(64).optional(),
    deepLink: z.string().max(500).optional(),
  })
  .refine((v) => (v.ciphertext === undefined) !== (v.body === undefined), {
    message: 'provide exactly one of body (cleartext) or ciphertext (encrypted)',
  });

export type PushRequest = z.infer<typeof pushRequestSchema>;

export interface ApnsPayload {
  aps: Record<string, unknown>;
  [key: string]: unknown;
}

// APNs caps a notification payload at 4KB. Ciphertext is the only caller-sized
// field, and the schema bounds it well under that, so this is a guard rather
// than a limit callers are expected to hit.
export const APNS_MAX_PAYLOAD_BYTES = 4096;

export function buildApnsPayload(req: PushRequest): ApnsPayload {
  if (req.ciphertext !== undefined) {
    return {
      aps: {
        // The NSE replaces this before the user ever sees it. It is only what
        // shows if decryption fails, so it must reveal nothing.
        alert: { title: 'Tether', body: 'New activity' },
        'mutable-content': 1,
        sound: 'default',
      },
      e: req.ciphertext,
      ...(req.deepLink ? { link: req.deepLink } : {}),
    };
  }
  return {
    aps: {
      alert: { title: req.title ?? 'Tether', body: req.body },
      sound: 'default',
    },
    ...(req.deepLink ? { link: req.deepLink } : {}),
  };
}

// APNs status codes the caller can act on. 410 means the app was uninstalled;
// the relay is stateless, so it reports that upstream and the Tether server
// prunes its own registration.
export function classifyApnsStatus(
  status: number,
): 'ok' | 'unregistered' | 'bad-request' | 'retry' {
  if (status === 200) return 'ok';
  if (status === 410) return 'unregistered';
  if (status === 429 || status >= 500) return 'retry';
  return 'bad-request';
}
