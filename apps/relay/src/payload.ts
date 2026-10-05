import { z } from 'zod';

// A push is either Phase 1 (cleartext) or Phase 2 (ciphertext the NSE decrypts);
// never both, or a caller leaked readable text alongside the encrypted copy.
export type PushLevel = 'urgent' | 'normal' | 'quiet';

export const pushRequestSchema = z
  .object({
    token: z.string().regex(/^[0-9a-fA-F]{64}$/, 'token must be a 64-char hex APNs device token'),
    title: z.string().min(1).max(100).optional(),
    body: z.string().min(1).max(300).optional(),
    ciphertext: z.string().min(1).max(3000).optional(),
    collapseId: z.string().min(1).max(64).optional(),
    deepLink: z.string().max(500).optional(),
    // Anything but urgent/quiet (absent, unknown, from an older caller) is normal.
    level: z
      .unknown()
      .optional()
      .transform((v): PushLevel => (v === 'urgent' || v === 'quiet' ? v : 'normal')),
    // Opaque hash of the session; the relay never sees the session name itself.
    threadKey: z
      .string()
      .regex(/^[0-9a-zA-Z]{1,64}$/)
      .optional()
      .catch(undefined),
  })
  .refine((v) => (v.ciphertext === undefined) !== (v.body === undefined), {
    message: 'provide exactly one of body (cleartext) or ciphertext (encrypted)',
  });

export type PushRequest = z.infer<typeof pushRequestSchema>;

export interface ApnsPayload {
  aps: Record<string, unknown>;
  [key: string]: unknown;
}

// APNs caps a payload at 4KB. Ciphertext is the only caller-sized field and the
// schema bounds it well under that, so this is a guard, not a limit callers hit.
export const APNS_MAX_PAYLOAD_BYTES = 4096;

const LEVEL_APS: Record<PushLevel, Record<string, unknown>> = {
  urgent: { 'interruption-level': 'time-sensitive', 'relevance-score': 1, sound: 'default' },
  normal: { 'interruption-level': 'active', sound: 'default' },
  quiet: { 'interruption-level': 'passive', 'relevance-score': 0 },
};

export function buildApnsPayload(req: Omit<PushRequest, 'level'> & { level?: PushLevel }): ApnsPayload {
  const tier = { ...LEVEL_APS[req.level ?? 'normal'], ...(req.threadKey ? { 'thread-id': req.threadKey } : {}) };
  if (req.ciphertext !== undefined) {
    return {
      aps: {
        // The NSE replaces this before the user ever sees it. It is only what
        // shows if decryption fails, so it must reveal nothing.
        alert: { title: 'Tether', body: 'New activity' },
        'mutable-content': 1,
        ...tier,
      },
      e: req.ciphertext,
      ...(req.deepLink ? { link: req.deepLink } : {}),
    };
  }
  return {
    aps: {
      alert: { title: req.title ?? 'Tether', body: req.body },
      ...tier,
    },
    ...(req.deepLink ? { link: req.deepLink } : {}),
  };
}

// APNs status codes the caller can act on. 410 = app uninstalled; the stateless
// relay reports it upstream so the Tether server prunes its own registration.
export function classifyApnsStatus(status: number): 'ok' | 'unregistered' | 'bad-request' | 'retry' {
  if (status === 200) return 'ok';
  if (status === 410) return 'unregistered';
  if (status === 429 || status >= 500) return 'retry';
  return 'bad-request';
}
